/**
 * Proves the TRE-34 claims that only a real file on a real filesystem can
 * settle.
 *
 * The unit specs fix the framing and the registry's bookkeeping against
 * synthetic input, and they are the right tool for that — a ring buffer that
 * replays the wrong lines is a bug you can catch without a disk. What they
 * cannot notice is that a `logrotate` on this host renames rather than
 * truncates, that a poller misses the head of the replacement file, that a
 * `tail -F` child outlives the abort, or that a line takes four seconds to
 * arrive. Every one of those is in the ticket's Done list, and every one of
 * them needs a machine.
 *
 * Runs anywhere, from the API's own directory:
 *
 *   cd nest-api
 *   pnpm verify:tail
 *
 * Writes to a temporary directory it creates and removes. It never touches a
 * real log, never reads outside that directory, and touches no database.
 *
 * The run worth doing is the one on the deploy host against its own sshd, so
 * the SSH path — the one every real deployment takes — is exercised against a
 * genuine SFTP rather than against the local driver:
 *
 *   ssh -A <the host>
 *   cd /var/www/trekker/api
 *   TREKKER_TEST_SSH_HOST=127.0.0.1 TREKKER_TEST_SSH_USER=$USER \
 *     pnpm --filter ./nest-api verify:tail
 *
 * Optional: TREKKER_TEST_SSH_PORT (22), TREKKER_TEST_SSH_KEY (a key file,
 * instead of the forwarded agent).
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HostDriver } from "../src/hosts/drivers/host-driver";
import { LocalDriver } from "../src/hosts/drivers/local.driver";
import {
  DEFAULT_POOL_SETTINGS,
  type HostConnectionSpec,
  type SshAuth,
  SshConnectionPool,
} from "../src/hosts/drivers/ssh-connection.pool";
import { SshDriver } from "../src/hosts/drivers/ssh.driver";
import { ExecTailSource, PollTailSource, type TailSink, type TailSource } from "../src/fs/tail-source";

const run = promisify(execFile);

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
    return;
  }
  fail += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

function note(text: string): void {
  console.log(`    ${text}`);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything one source said, in the order it said it. */
class Recorder implements TailSink {
  lines: string[] = [];
  rotations = 0;
  errors: string[] = [];

  onLines = (lines: string[]): void => {
    this.lines.push(...lines);
  };
  onRotated = (): void => {
    this.rotations += 1;
  };
  onError = (message: string): void => {
    this.errors.push(message);
  };

  /** Wait until `predicate` holds, or give up. Returns how long it took. */
  async until(predicate: () => boolean, timeoutMs = 6_000): Promise<number> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return Date.now() - started;
      await wait(50);
    }
    return -1;
  }
}

/**
 * The four lifecycle claims, plus rotation and latency, against one driver.
 *
 * `kind` decides which source is built, so the same battery runs over the
 * poller and over a real `tail -F` and any disagreement between them is
 * visible rather than assumed.
 */
async function verifySource(
  label: string,
  driver: HostDriver,
  directory: string,
  kind: "poll" | "tail",
): Promise<void> {
  console.log(`\n${label}`);

  const path = join(directory, "access.log");
  writeFileSync(path, "first\nsecond\n");

  const build = (sink: TailSink, signal: AbortSignal, resumeFrom: number | null = null): TailSource => {
    const args = { driver, realPath: path, initialLines: 200, resumeFrom, signal, sink };
    return kind === "tail" ? new ExecTailSource(args) : new PollTailSource(args);
  };

  // ---- the opening screenful, and a line appearing while we watch
  {
    const controller = new AbortController();
    const recorder = new Recorder();
    build(recorder, controller.signal).start();

    const backfilled = await recorder.until(() => recorder.lines.length >= 2);
    check("the opening lines arrive", backfilled >= 0, `${recorder.lines.length} line(s) in ${backfilled} ms`);

    const before = recorder.lines.length;
    appendFileSync(path, "third\n");
    const latency = await recorder.until(() => recorder.lines.length > before);
    // The ticket's own bar, and the number this whole design was chosen
    // against: one poll interval plus a round trip has to fit inside it.
    check("an appended line arrives in under two seconds", latency >= 0 && latency < 2_000, `${latency} ms`);
    check("it is the line that was written", recorder.lines.at(-1) === "third", recorder.lines.at(-1) ?? "(nothing)");

    controller.abort();
  }

  // ---- rotation, both modes
  {
    const controller = new AbortController();
    const recorder = new Recorder();
    build(recorder, controller.signal).start();
    await recorder.until(() => recorder.lines.length > 0);

    // `copytruncate`: same inode, emptied in place. Caught by the size rule,
    // since a running log's offset is far past what the fresh file starts with.
    truncateSync(path, 0);
    appendFileSync(path, "after truncate\n");
    const sawTruncate = await recorder.until(() => recorder.lines.includes("after truncate"));
    check("a copytruncate rotation keeps the tail alive", sawTruncate >= 0, `${sawTruncate} ms`);

    // `create`: rename away, new file in its place. The one the classic bug is
    // about — a tail following the unlinked inode goes quiet forever.
    const rotated = `${path}.1`;
    writeFileSync(rotated, readFileSync(path));
    unlinkSync(path);
    await wait(200);
    writeFileSync(path, "after rotate\n");
    const sawRotate = await recorder.until(() => recorder.lines.includes("after rotate"));
    check("a create-mode rotation reconnects to the new file", sawRotate >= 0, `${sawRotate} ms`);
    // Waited for rather than asserted outright: the exec path notices a
    // rotation on its own `stat` cadence, which is allowed to lag the line
    // that provoked it. What must not happen is never noticing.
    const announced = await recorder.until(() => recorder.rotations > 0, 4_000);
    check("the rotation was announced", announced >= 0, `${recorder.rotations} announced after ${announced} ms`);

    rmSync(rotated, { force: true });
    controller.abort();
  }

  // ---- the headline: nothing left behind
  {
    const before = await tailProcesses(directory);
    const controllers: AbortController[] = [];

    for (let index = 0; index < 50; index += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      build(new Recorder(), controller.signal).start();
    }
    await wait(500);
    // Measured while they are running, because "none afterwards" is also what a
    // source that never started would report — and a vacuous pass on the one
    // check this whole design exists to satisfy would be the worst possible
    // place to have one.
    const peak = await tailProcesses(directory);
    if (kind === "tail") {
      check("the fifty were actually running", peak > 0, `${peak} tail process(es) at peak`);
    } else {
      check("the poll path started no process at all", peak === 0, `${peak} tail process(es) at peak`);
      note("which is the point of it: there is nothing on the host to leave behind");
    }

    for (const controller of controllers) controller.abort();
    // Generous: a SIGTERM'd child is reaped by the kernel, not instantly.
    await wait(1_500);

    const after = await tailProcesses(directory);
    check(
      "fifty opened and closed leave no process behind",
      after <= before,
      `${before} before, ${peak} at peak, ${after} after`,
    );
  }

  // ---- a resume does not re-deliver what the client already has
  {
    const controller = new AbortController();
    const recorder = new Recorder();
    writeFileSync(path, "one\ntwo\nthree\n");
    const source = build(recorder, controller.signal);
    source.start();
    await recorder.until(() => recorder.lines.length >= 3);
    const offset = source.offset;
    controller.abort();

    const resumeController = new AbortController();
    const resumed = new Recorder();
    build(resumed, resumeController.signal, offset).start();
    appendFileSync(path, "four\n");
    await resumed.until(() => resumed.lines.includes("four"));

    check(
      "a resume sends only what is new",
      !resumed.lines.includes("one") && resumed.lines.includes("four"),
      `${resumed.lines.length} line(s): ${resumed.lines.join(", ") || "(none)"}`,
    );
    resumeController.abort();
  }
}

/**
 * `tail` processes following a file under `directory`, and only those.
 *
 * Counting every `tail` this account owns was the first attempt, and it counts
 * the developer's own `tail -f` in another terminal — which is how a run that
 * leaks nothing reports one more process than it started with. Matching the
 * full argv against our own temporary directory is what makes the number mean
 * "left behind by this script".
 */
async function tailProcesses(directory: string): Promise<number> {
  try {
    const { stdout } = await run("ps", ["-o", "args=", "-u", String(process.getuid?.() ?? 0)]);
    return stdout.split("\n").filter((line) => /(^|\/)tail\s/.test(line.trim()) && line.includes(directory)).length;
  } catch {
    return 0;
  }
}

async function verifySsh(directory: string): Promise<void> {
  const host = process.env.TREKKER_TEST_SSH_HOST;
  const user = process.env.TREKKER_TEST_SSH_USER;

  if (host === undefined || user === undefined) {
    console.log("\nSSH — skipped");
    note("set TREKKER_TEST_SSH_HOST and TREKKER_TEST_SSH_USER to run the path every deployment takes");
    return;
  }

  const keyPath = process.env.TREKKER_TEST_SSH_KEY;
  const auth: SshAuth = keyPath
    ? { kind: "PRIVATE_KEY", privateKey: readFileSync(keyPath) }
    : { kind: "AGENT", agentSocket: process.env.SSH_AUTH_SOCK ?? "" };

  const pool = new SshConnectionPool(DEFAULT_POOL_SETTINGS);
  const spec: HostConnectionSpec = {
    hostId: "verify-tail",
    address: host,
    port: Number.parseInt(process.env.TREKKER_TEST_SSH_PORT ?? "22", 10),
    username: user,
    auth,
    pins: [],
  };
  const driver = new SshDriver(spec, pool, DEFAULT_POOL_SETTINGS);

  try {
    // The poller is what an SSH host gets, and the reason is in tail-source.ts.
    await verifySource("SSH — the polling source", driver, directory, "poll");
  } finally {
    await driver.dispose();
    pool.onModuleDestroy();
  }
}

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "trekker-tail-"));
  console.log(`Verifying live tails (TRE-34) in ${directory}`);

  try {
    const local = new LocalDriver("verify-tail-local");
    await verifySource("LOCAL — a real tail -F", local, directory, "tail");
    await verifySource("LOCAL — the polling source", local, directory, "poll");
    await verifySsh(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error: Error) => {
  console.error(`\nverify:tail failed: ${error.message}`);
  process.exit(1);
});
