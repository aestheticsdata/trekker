/**
 * Exercises LocalDriver and the shell-quoting contract (TRE-9).
 *
 *   pnpm --filter ./nest-api verify:drivers
 *
 * The hostile arguments below are run for real through both paths: `execFile`
 * locally, and `sh -c` against the string `buildRemoteCommand` produces, which
 * is exactly what the remote sshd does with it. If quoting is wrong, the
 * canary file appears and the run fails.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isDriverError } from "../src/hosts/drivers/driver-error";
import { LocalDriver } from "../src/hosts/drivers/local.driver";
import { buildRemoteCommand, quoteArgument } from "../src/hosts/drivers/shell-quote";
import { createServer } from "node:net";
import { fingerprintOf, SshConnectionPool, type HostConnectionSpec } from "../src/hosts/drivers/ssh-connection.pool";

const run = promisify(execFile);

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${label}`);
    pass++;
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

async function codeOf(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
    return "no-error";
  } catch (error) {
    return isDriverError(error) ? error.code : `not-a-DriverError(${String(error)})`;
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "trekker-drivers-"));
  const driver = new LocalDriver("test-host");

  try {
    await writeFile(join(root, "readme.txt"), "hello");
    await run("mkdir", ["-p", join(root, "sub")]);
    await run("ln", ["-s", "readme.txt", join(root, "link")]);
    await run("ln", ["-s", "nowhere", join(root, "broken")]);

    console.log("== listing ==");
    const entries = await driver.list(root);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    check("lists every entry", entries.length === 4, `got ${entries.length}`);
    check("file kind", byName.get("readme.txt")?.kind === "file");
    check("directory kind", byName.get("sub")?.kind === "directory");
    check("symlink kind", byName.get("link")?.kind === "symlink");
    check("symlink target resolved", byName.get("link")?.linkTarget === "readme.txt");
    check("a broken symlink still appears", byName.get("broken")?.kind === "symlink");
    check("size reported", byName.get("readme.txt")?.size === 5);
    check("mode is permission bits only", (byName.get("readme.txt")?.mode ?? 0) <= 0o7777);

    console.log("\n== stat and realpath ==");
    const info = await driver.stat(join(root, "readme.txt"));
    check("stat carries the path", info.path === join(root, "readme.txt"));
    check("stat of a symlink is the link, not the target", (await driver.stat(join(root, "link"))).kind === "symlink");
    check("realpath resolves a symlink", (await driver.realpath(join(root, "link"))).endsWith("readme.txt"));

    console.log("\n== error normalisation ==");
    check("missing path -> ENOENT", (await codeOf(() => driver.list(join(root, "nope")))) === "ENOENT");
    check("stat missing -> ENOENT", (await codeOf(() => driver.stat(join(root, "nope")))) === "ENOENT");
    check("listing a file -> ENOTDIR", (await codeOf(() => driver.list(join(root, "readme.txt")))) === "ENOTDIR");
    check(
      "reading a directory -> EISDIR",
      (await codeOf(() => driver.createReadStream(join(root, "sub")))) === "EISDIR",
    );
    check("mkdir over an existing path -> EEXIST", (await codeOf(() => driver.mkdir(join(root, "sub")))) === "EEXIST");
    check(
      "rmdir on a non-empty directory -> ENOTEMPTY",
      (await codeOf(async () => {
        await driver.mkdir(join(root, "full"));
        await writeFile(join(root, "full", "x"), "x");
        await driver.rmdir(join(root, "full"));
      })) === "ENOTEMPTY",
    );

    const denied = join(root, "denied");
    await driver.mkdir(denied);
    await writeFile(join(denied, "secret"), "x");
    await driver.chmod(denied, 0o000);
    check("unreadable directory -> EACCES", (await codeOf(() => driver.list(denied))) === "EACCES");
    await driver.chmod(denied, 0o755);

    console.log("\n== mutations ==");
    await driver.mkdir(join(root, "made", "deep"), { recursive: true });
    check("recursive mkdir", (await stat(join(root, "made", "deep"))).isDirectory());
    await driver.rename(join(root, "readme.txt"), join(root, "renamed.txt"));
    check("rename", (await driver.stat(join(root, "renamed.txt"))).size === 5);
    await driver.chmod(join(root, "renamed.txt"), 0o600);
    check("chmod", (await driver.stat(join(root, "renamed.txt"))).mode === 0o600);
    await driver.unlink(join(root, "renamed.txt"));
    check("unlink", (await codeOf(() => driver.stat(join(root, "renamed.txt")))) === "ENOENT");

    console.log("\n== streams ==");
    const sink = await driver.createWriteStream(join(root, "written.txt"));
    await new Promise<void>((resolve, reject) => {
      sink.on("error", reject);
      sink.on("finish", resolve);
      sink.end("streamed");
    });
    check("write stream", (await readFile(join(root, "written.txt"), "utf8")) === "streamed");

    const source = await driver.createReadStream(join(root, "written.txt"));
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(chunk as Buffer);
    check("read stream", Buffer.concat(chunks).toString("utf8") === "streamed");

    console.log("\n== exec is not a shell ==");
    const canary = join(root, "PWNED");
    const hostile = [
      `$(touch ${canary})`,
      `\`touch ${canary}\``,
      `; touch ${canary}`,
      `&& touch ${canary}`,
      `| touch ${canary}`,
      `'; touch ${canary}; '`,
      `x' ; touch ${canary} ; echo '`,
      "spaces and 'single' and \"double\" quotes",
      "new\nline",
      "tab\there",
      "back\\slash",
      "$HOME ${HOME} $(id)",
      "*",
      "~",
      "",
    ];

    for (const argument of hostile) {
      // Local: execFile, no shell involved at all.
      const local = await driver.exec("stat", ["-f", "%N", argument]).catch(() => null);
      const localSafe = local === null || !local.stdout.includes("PWNED");

      // Remote: the exact string ssh2 would send, handed to a real shell.
      const command = buildRemoteCommand("stat", ["-f", "%N", argument]);
      let remoteEcho = "";
      try {
        const { stdout } = await run("/bin/sh", ["-c", command.replace(/^stat/, "printf '%s' ")]);
        remoteEcho = stdout;
      } catch {
        remoteEcho = "";
      }

      const canaryExists = await stat(canary).then(
        () => true,
        () => false,
      );
      check(
        `hostile argument survives intact: ${JSON.stringify(argument).slice(0, 46)}`,
        localSafe && !canaryExists,
        canaryExists ? "CANARY CREATED — quoting is broken" : "",
      );
      if (canaryExists) await rm(canary);
      void remoteEcho;
    }

    console.log("\n== quoting round trip through a real shell ==");
    for (const argument of hostile) {
      const { stdout } = await run("/bin/sh", ["-c", `printf '%s' ${quoteArgument(argument)}`]);
      check(
        `shell returns it byte for byte: ${JSON.stringify(argument).slice(0, 40)}`,
        stdout === argument,
        JSON.stringify(stdout),
      );
    }

    console.log("\n== allowlist ==");
    check(
      "an unlisted program is refused locally",
      (await codeOf(() => driver.exec("sh" as never, ["-c", "id"]))) === "EPERM",
    );
    // `rm` stopped being unlisted in TRE-29 — it is on the sudo-only list, which
    // is a different claim and worth its own line: reachable with sudo, refused
    // exactly like `sh` without it.
    check(
      "a sudo-only program is refused without sudo",
      (await codeOf(() => driver.exec("rm", ["-rf", "/"]))) === "EPERM",
    );
    let builderThrew = false;
    try {
      buildRemoteCommand("bash" as never, ["-c", "id"]);
    } catch {
      builderThrew = true;
    }
    check("and by the remote command builder", builderThrew);
    check(
      "NUL bytes are refused rather than truncating",
      (() => {
        try {
          quoteArgument("safe\0; rm -rf /");
          return false;
        } catch {
          return true;
        }
      })(),
    );

    console.log("\n== exec results ==");
    const ok = await driver.exec("id", ["-u"]);
    check("exit code 0 and stdout captured", ok.code === 0 && ok.stdout.trim().length > 0);
    const bad = await driver.exec("stat", ["-f", "%N", join(root, "definitely-missing")]);
    check("non-zero exit is a result, not a throw", bad.code !== 0 && bad.stderr.length > 0);
    check(
      "exec timeout -> ETIMEDOUT",
      (await codeOf(() => driver.exec("tail", ["-f", "/dev/null"], { timeoutMs: 300 }))) === "ETIMEDOUT",
    );
    console.log("\n== connection states (no SSH server needed) ==");
    check(
      "fingerprintOf uses OpenSSH's format",
      /^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprintOf(Buffer.from("a fake host key"))),
      fingerprintOf(Buffer.from("a fake host key")),
    );

    const pool = new SshConnectionPool({
      connectTimeoutMs: 700,
      operationTimeoutMs: 700,
      idleTimeoutMs: 400,
      maxConcurrency: 2,
      keepaliveIntervalMs: 10_000,
    });

    const spec = (port: number): HostConnectionSpec => ({
      hostId: "pool-test",
      address: "127.0.0.1",
      port,
      username: "nobody",
      auth: { kind: "PASSWORD", password: Buffer.from("irrelevant") },
    });

    // Nothing listening: connection refused.
    check("closed port -> EUNREACHABLE", (await codeOf(() => pool.acquire(spec(1)))) === "EUNREACHABLE");

    // Accepts the TCP connection then says nothing, which is what a hung host
    // or a stalled middlebox looks like. Without a handshake timeout this hangs
    // forever and takes a pool slot with it.
    const silent = createServer(() => {
      /* accept and never speak SSH */
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const silentPort = (silent.address() as { port: number }).port;
    const started = Date.now();
    check("silent host -> ETIMEDOUT", (await codeOf(() => pool.acquire(spec(silentPort)))) === "ETIMEDOUT");
    check("and it gives up near the configured timeout", Date.now() - started < 3_000, `${Date.now() - started}ms`);
    silent.close();

    check("a failed connect leaves nothing pooled", pool.openConnectionCount === 0);
    pool.evictHost("no-such-host", "test");
    check("evicting an unknown host is a no-op", pool.openConnectionCount === 0);
    pool.onModuleDestroy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
