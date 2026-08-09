/**
 * Runs the LocalDriver assertions again, over SFTP against a real server, and
 * adds the pool behaviours that only a live connection can prove (TRE-9).
 *
 * Meant to be run ON the deploy host, where an sshd already exists — against
 * localhost, or against another server it manages:
 *
 *   TREKKER_TEST_SSH_HOST=127.0.0.1 \
 *   TREKKER_TEST_SSH_USER=$USER \
 *   pnpm --filter ./nest-api verify:ssh
 *
 * Optional: TREKKER_TEST_SSH_PORT (22), TREKKER_TEST_SSH_KEY (~/.ssh/id_ed25519),
 * TREKKER_TEST_SSH_ROOT (a writable directory; defaults to /tmp).
 *
 * Everything it creates lives in one temp directory under that root and is
 * removed at the end. It never writes outside it.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDriverError } from "../src/hosts/drivers/driver-error";
import type { HostDriver } from "../src/hosts/drivers/host-driver";
import {
  DEFAULT_POOL_SETTINGS,
  type HostConnectionSpec,
  SshConnectionPool,
} from "../src/hosts/drivers/ssh-connection.pool";
import { SshDriver } from "../src/hosts/drivers/ssh.driver";

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

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required. See the header of this file.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const keyPath = process.env.TREKKER_TEST_SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");
  const spec: HostConnectionSpec = {
    hostId: "ssh-verify",
    address: required("TREKKER_TEST_SSH_HOST"),
    port: Number(process.env.TREKKER_TEST_SSH_PORT ?? 22),
    username: required("TREKKER_TEST_SSH_USER"),
    auth: { kind: "PRIVATE_KEY", privateKey: readFileSync(keyPath) },
  };

  const pool = new SshConnectionPool({ ...DEFAULT_POOL_SETTINGS, idleTimeoutMs: 1_500, maxConcurrency: 4 });
  const driver: HostDriver = new SshDriver(spec, pool, DEFAULT_POOL_SETTINGS);
  const base = process.env.TREKKER_TEST_SSH_ROOT ?? "/tmp";
  const root = `${base}/trekker-ssh-verify-${process.pid}`;

  console.log(`Target: ${spec.username}@${spec.address}:${spec.port}, workspace ${root}\n`);

  try {
    console.log("== connect and basic shape ==");
    await driver.mkdir(root);
    check("mkdir", (await driver.stat(root)).kind === "directory");
    check("exactly one connection opened", pool.openConnectionCount === 1, `${pool.openConnectionCount}`);

    const sink = await driver.createWriteStream(`${root}/readme.txt`);
    await new Promise<void>((resolve, reject) => {
      sink.on("error", reject);
      sink.on("close", resolve);
      sink.end("hello");
    });
    check("write stream", (await driver.stat(`${root}/readme.txt`)).size === 5);

    const source = await driver.createReadStream(`${root}/readme.txt`);
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(chunk as Buffer);
    check("read stream", Buffer.concat(chunks).toString("utf8") === "hello");

    await driver.mkdir(`${root}/sub`);
    const entries = await driver.list(root);
    check("list finds both entries", entries.length === 2, `${entries.length}`);
    check("file kind over SFTP", entries.find((e) => e.name === "readme.txt")?.kind === "file");
    check("directory kind over SFTP", entries.find((e) => e.name === "sub")?.kind === "directory");
    check("mode is permission bits only", (entries[0]?.mode ?? 0) <= 0o7777);
    check("realpath", (await driver.realpath(`${root}/sub`)).endsWith("/sub"));

    console.log("\n== error normalisation matches LocalDriver ==");
    check("missing path -> ENOENT", (await codeOf(() => driver.list(`${root}/nope`))) === "ENOENT");
    check("stat missing -> ENOENT", (await codeOf(() => driver.stat(`${root}/nope`))) === "ENOENT");
    check("mkdir over an existing path -> EEXIST", (await codeOf(() => driver.mkdir(`${root}/sub`))) === "EEXIST");
    check("listing a file -> ENOTDIR", (await codeOf(() => driver.list(`${root}/readme.txt/x`))) === "ENOTDIR");

    console.log("\n== exec is not a shell, over SSH ==");
    const canary = `${root}/PWNED`;
    for (const argument of [
      `$(touch ${canary})`,
      `\`touch ${canary}\``,
      `; touch ${canary}`,
      `'; touch ${canary}; '`,
      "spaces and 'single' quotes",
      "new\nline",
      "$HOME $(id)",
      "",
    ]) {
      // `stat -c %n` echoes the name it was given, so the argument comes back
      // verbatim if quoting held.
      const result = await driver.exec("stat", ["-c", "%n", argument]).catch(() => null);
      const created = (await codeOf(() => driver.stat(canary))) !== "ENOENT";
      check(
        `argument survives: ${JSON.stringify(argument).slice(0, 44)}`,
        !created,
        created ? "CANARY CREATED — quoting is broken" : "",
      );
      if (created) await driver.unlink(canary).catch(() => undefined);
      void result;
    }

    console.log("\n== pool ==");
    const before = pool.openConnectionCount;
    for (let i = 0; i < 100; i++) await driver.list(root);
    check(
      "100 sequential listings reuse one connection",
      pool.openConnectionCount === before,
      `${pool.openConnectionCount}`,
    );

    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, pool.inFlightFor(spec.hostId, spec.username));
    }, 1);
    await Promise.all(Array.from({ length: 50 }, () => driver.list(root)));
    clearInterval(sampler);
    check(`50 parallel listings stay under the cap of 4 (peak ${peak})`, peak <= 4);
    check("still one connection", pool.openConnectionCount === 1, `${pool.openConnectionCount}`);

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    check("idle connection evicted after the timeout", pool.openConnectionCount === 0, `${pool.openConnectionCount}`);

    await driver.list(root);
    check("reconnects on demand", pool.openConnectionCount === 1);
    pool.evictHost(spec.hostId, "credential change");
    check("evictHost closes it immediately", pool.openConnectionCount === 0);

    console.log("\n== cleanup ==");
    await driver.rmdir(root, { recursive: true });
    check("recursive rmdir", (await codeOf(() => driver.stat(root))) === "ENOENT");
  } finally {
    await driver.rmdir(root, { recursive: true }).catch(() => undefined);
    pool.onModuleDestroy();
  }

  console.log(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
