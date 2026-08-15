/**
 * Proves the TRE-32 claims that only a real `du` on a real filesystem can
 * settle.
 *
 * The unit specs fix the arithmetic against synthetic records, and they are the
 * right tool for that — a treemap that does not sum is a bug you can catch
 * without a disk. What they cannot notice is that this host's `du` writes its
 * columns somewhere else, reports 512-byte blocks, has no `--time`, refuses
 * `nice`, or takes four minutes to answer a cancel. Every one of those is in
 * the ticket's Done list, and every one of them needs a machine.
 *
 * Runs anywhere with a `du`, from the API's own directory:
 *
 *   cd nest-api
 *   pnpm verify:scan
 *
 * Scans the API's own directory by default, which is small and certainly
 * readable. Point it somewhere bigger to exercise the cancel and the nice:
 *
 *   TREKKER_SCAN_ROOT=/usr pnpm verify:scan
 *
 * The run worth doing is the one on the deploy host against its own sshd, so
 * both drivers walk the same filesystem and agreeing means something:
 *
 *   ssh -A <the host>
 *   cd /var/www/trekker/api
 *   TREKKER_TEST_SSH_HOST=127.0.0.1 TREKKER_TEST_SSH_USER=$USER \
 *     pnpm --filter ./nest-api verify:scan
 *
 * Optional: TREKKER_TEST_SSH_PORT (22), TREKKER_TEST_SSH_KEY (a key file,
 * instead of the forwarded agent).
 *
 * Reads only. It runs `du` and `sha256sum` and nothing else, writes nothing
 * anywhere, and touches no database.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
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
import { DU_RUNGS, firstRung, probeFlavour, shouldDemote } from "../src/scans/du-flavour";
import { countUnreadable, DuParser } from "../src/scans/du-parse";
import { ScanAggregator } from "../src/scans/scan-aggregator";
import { SCAN_NICE } from "../src/scans/scan-limits";

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

function human(bytes: bigint): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** One full walk through the real pipeline: probe, stream, parse, aggregate. */
async function walk(
  driver: HostDriver,
  root: string,
  options: { nice?: number; signal?: AbortSignal } = {},
): Promise<{
  total: bigint | null;
  inodes: bigint | null;
  entries: number;
  largest: { path: string; bytes: bigint } | null;
  oldCount: bigint;
  candidates: number;
  unreadable: number;
  rung: number;
  elapsedMs: number;
}> {
  const probe = await probeFlavour(driver);
  const started = Date.now();

  for (let index = firstRung(probe); index < DU_RUNGS.length; index += 1) {
    const rung = DU_RUNGS[index];
    const aggregator = new ScanAggregator({
      root,
      depth: 3,
      hasTime: rung.hasTime,
      hasFiles: rung.hasFiles,
      now: Date.now(),
    });
    const parser = new DuParser(rung);

    if (!driver.execStream) throw new Error("driver cannot stream");
    const running = await driver.execStream("du", [...rung.args, root], {
      nice: options.nice,
      signal: options.signal,
    });

    let sawStdout = false;
    for await (const chunk of running.stdout) {
      const buffer = chunk as Buffer;
      if (buffer.length > 0) sawStdout = true;
      for (const record of parser.push(buffer)) aggregator.add(record);
    }
    for (const record of parser.end()) aggregator.add(record);

    const result = await running.done;
    const aggregate = aggregator.finish();

    if (
      !options.signal?.aborted &&
      shouldDemote({ code: result.code, stdout: sawStdout ? "x" : "", stderr: result.stderr })
    ) {
      continue;
    }

    return {
      total: aggregate.totalBytes,
      inodes: aggregate.inodes,
      entries: aggregate.entries.length,
      largest: aggregate.largest,
      oldCount: aggregate.oldFileCount,
      candidates: aggregate.duplicateCandidates.length,
      unreadable: countUnreadable(result.stderr),
      rung: index,
      elapsedMs: Date.now() - started,
    };
  }

  throw new Error("no rung produced a readable result");
}

/** What `du -s` says on its own, which is the number the panel has to match. */
async function duSays(root: string): Promise<bigint | null> {
  try {
    const { stdout } = await run("du", ["-s", "-x", "-k", "--", root], { maxBuffer: 1024 * 1024 });
    const kib = /^(\d+)/.exec(stdout.trim());
    return kib ? BigInt(kib[1]) * 1024n : null;
  } catch {
    return null;
  }
}

async function verifyLocal(root: string): Promise<void> {
  const driver = new LocalDriver("verify-local");

  console.log("\nThe walk, through the real pipeline");
  const result = await walk(driver, root, { nice: SCAN_NICE });
  note(`rung ${result.rung} (${DU_RUNGS[result.rung].flavour}), ${result.elapsedMs} ms`);

  check("the walk reached the root", result.total !== null, result.total === null ? "" : human(result.total));
  check("it counted inodes", (result.inodes ?? 0n) > 0n, `${result.inodes ?? 0n}`);
  check("it produced treemap rows", result.entries > 0, `${result.entries} entries`);

  if (result.largest) note(`largest file: ${result.largest.path} (${human(result.largest.bytes)})`);
  note(`files older than a year: ${result.oldCount}`);
  note(`duplicate candidate groups: ${result.candidates}`);
  if (result.unreadable > 0) note(`directories du could not read: ${result.unreadable}`);

  console.log("\nAgainst `du -s` run directly");
  const direct = await duSays(root);
  if (direct === null || result.total === null) {
    check("du -s answered", false, "could not compare");
  } else {
    // Not equality: the pipeline asks for bytes where the rung allows it and
    // `du -s -k` answers in KiB, so the two agree only to a block. Anything
    // wider than that is a unit bug — which is exactly what `-B 1` on BSD is.
    const drift = result.total > direct ? result.total - direct : direct - result.total;
    const tolerance = direct / 100n + 4096n;
    check(
      "the total matches du -s within rounding",
      drift <= tolerance,
      `${human(result.total)} vs ${human(direct)} (drift ${human(drift)})`,
    );
  }

  console.log("\nThe treemap's arithmetic, on this machine's real tree");
  const aggregate = await walkEntries(driver, root);
  let levelsChecked = 0;
  let levelsClosed = 0;
  for (const parent of aggregate.filter((entry) => entry.kind === "DIRECTORY")) {
    const children = aggregate.filter((entry) => entry.parentPath === parent.path);
    if (children.length === 0) continue;
    levelsChecked += 1;
    const sum = children.reduce((total, child) => total + child.bytes, 0n);
    if (sum === parent.bytes) levelsClosed += 1;
  }
  check(
    "every level sums to its parent",
    levelsChecked > 0 && levelsChecked === levelsClosed,
    `${levelsClosed}/${levelsChecked} levels`,
  );

  console.log("\nCancellation");
  const controller = new AbortController();
  const cancelStarted = Date.now();
  const cancelled = walk(driver, "/", { nice: SCAN_NICE, signal: controller.signal }).catch(() => null);
  setTimeout(() => controller.abort(), 300);
  await cancelled;
  const cancelMs = Date.now() - cancelStarted;
  // The ticket asks for "within a few seconds". It is bought by `-a`: a `du`
  // that prints constantly takes SIGPIPE the moment the channel closes, while
  // a `du -s` would write nothing for minutes and notice nothing.
  check("a scan of / stops within a few seconds", cancelMs < 5_000, `${cancelMs} ms`);

  console.log("\nNiceness");
  const niced = await walk(driver, root, { nice: SCAN_NICE });
  check("the walk still completes when de-prioritised", niced.total !== null);
  note("os.setPriority locally; a `nice -n` prefix over SSH — see shell-quote.ts");
}

/** The entries themselves, for the level-sum check. */
async function walkEntries(driver: HostDriver, root: string) {
  const probe = await probeFlavour(driver);
  const rung = DU_RUNGS[firstRung(probe)];
  const aggregator = new ScanAggregator({
    root,
    depth: 3,
    hasTime: rung.hasTime,
    hasFiles: rung.hasFiles,
    now: Date.now(),
  });
  const parser = new DuParser(rung);

  if (!driver.execStream) throw new Error("driver cannot stream");
  const running = await driver.execStream("du", [...rung.args, root], { nice: SCAN_NICE });
  for await (const chunk of running.stdout) {
    for (const record of parser.push(chunk as Buffer)) aggregator.add(record);
  }
  for (const record of parser.end()) aggregator.add(record);
  await running.done;

  return aggregator.finish().entries;
}

async function verifySsh(root: string): Promise<void> {
  const address = process.env.TREKKER_TEST_SSH_HOST;
  const username = process.env.TREKKER_TEST_SSH_USER;
  if (!address || !username) {
    console.log("\nSSH: skipped (set TREKKER_TEST_SSH_HOST and TREKKER_TEST_SSH_USER)");
    console.log("    The remote half is where `nice`, the channel lifecycle and the kill actually differ.");
    return;
  }

  const keyFile = process.env.TREKKER_TEST_SSH_KEY;
  const auth: SshAuth = keyFile
    ? { kind: "PRIVATE_KEY", privateKey: readFileSync(keyFile) }
    : { kind: "AGENT", agentSocket: process.env.SSH_AUTH_SOCK ?? "" };

  const pool = new SshConnectionPool(DEFAULT_POOL_SETTINGS);
  const spec: HostConnectionSpec = {
    hostId: "verify-ssh",
    address,
    port: Number.parseInt(process.env.TREKKER_TEST_SSH_PORT ?? "22", 10),
    username,
    auth,
    pins: [],
  };
  const driver = new SshDriver(spec, pool, DEFAULT_POOL_SETTINGS);

  try {
    console.log("\nSSH: the same walk over a channel");
    const remote = await walk(driver, root, { nice: SCAN_NICE });
    note(`rung ${remote.rung} (${DU_RUNGS[remote.rung].flavour}), ${remote.elapsedMs} ms`);
    check("the remote walk reached the root", remote.total !== null, remote.total === null ? "" : human(remote.total));

    const local = await walk(new LocalDriver("verify-local"), root, { nice: SCAN_NICE });
    check(
      "both drivers agree on the same filesystem",
      remote.total === local.total,
      `${human(remote.total ?? 0n)} vs ${human(local.total ?? 0n)}`,
    );

    console.log("\nSSH: cancelling a remote walk");
    const controller = new AbortController();
    const started = Date.now();
    const cancelled = walk(driver, "/", { nice: SCAN_NICE, signal: controller.signal }).catch(() => null);
    setTimeout(() => controller.abort(), 300);
    await cancelled;
    const elapsed = Date.now() - started;
    // The one that matters. OpenSSH's sshd ignores the RFC 4254 signal request,
    // so the kill is `close()` plus the SIGPIPE the next write earns — which
    // only arrives promptly because `-a` makes `du` write constantly.
    check("a remote scan of / stops within a few seconds", elapsed < 5_000, `${elapsed} ms`);

    console.log("\nSSH: browsing while a scan runs");
    const scanController = new AbortController();
    const scanning = walk(driver, "/", { nice: SCAN_NICE, signal: scanController.signal }).catch(() => null);
    const listStarted = Date.now();
    await driver.list(root);
    const listMs = Date.now() - listStarted;
    scanController.abort();
    await scanning;
    // Two of the six per-host pool slots are reserved for interactive work, so
    // a listing must never queue behind the scan holding one.
    check("a listing answers promptly under a running scan", listMs < 3_000, `${listMs} ms`);
  } finally {
    await driver.dispose();
    pool.onModuleDestroy();
  }
}

async function main(): Promise<void> {
  const root = process.env.TREKKER_SCAN_ROOT ?? process.cwd();
  console.log(`Verifying disk scans (TRE-32) against ${root}`);

  await verifyLocal(root);
  await verifySsh(root);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error: Error) => {
  console.error(`\nverify:scan failed: ${error.message}`);
  process.exit(1);
});
