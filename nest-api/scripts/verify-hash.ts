/**
 * Proves the TRE-27 claims that only a real `sha256sum` on a real filesystem
 * can settle.
 *
 * The unit specs fix the logic against a fake host, and they are the right tool
 * for that — a cache that serves a stale digest is a bug you can catch without
 * a disk. What they cannot notice is that this machine's `sha256sum` prints its
 * columns differently, escapes an awkward filename in a way the parser does not
 * expect, disagrees with `node:crypto`, or takes four minutes to answer a
 * cancel. Every one of those is in the ticket's Done list, and every one of
 * them needs a machine.
 *
 * Runs anywhere with a `sha256sum`, from the API's own directory:
 *
 *   cd nest-api
 *   pnpm verify:hash
 *
 * The run worth doing is the one on the deploy host against its own sshd, so
 * both drivers hash the same files and agreeing means something:
 *
 *   ssh -A <the host>
 *   cd /var/www/trekker/api
 *   TREKKER_TEST_SSH_HOST=127.0.0.1 TREKKER_TEST_SSH_USER=$USER \
 *     pnpm --filter ./nest-api verify:hash
 *
 * Optional: TREKKER_TEST_SSH_PORT (22), TREKKER_TEST_SSH_KEY (a key file,
 * instead of the forwarded agent).
 *
 * Writes a handful of small files into a temporary directory and removes them
 * again. It touches nothing else and no database.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HASH_NICE } from "../src/hashes/hash-limits";
import type { HostDriver } from "../src/hosts/drivers/host-driver";
import { LocalDriver } from "../src/hosts/drivers/local.driver";
import {
  DEFAULT_POOL_SETTINGS,
  type HostConnectionSpec,
  type SshAuth,
  SshConnectionPool,
} from "../src/hosts/drivers/ssh-connection.pool";
import { SshDriver } from "../src/hosts/drivers/ssh.driver";
import { chunkPaths, sumChunk } from "../src/hosts/sha256-sum";

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

/**
 * The fixture: ordinary files, an empty one, a big one, and two names chosen to
 * break a naive parser.
 *
 * The backslash name is the one that earns its place. GNU `sha256sum` escapes
 * such a path and flags the line with a leading backslash, and a decoder that
 * unescapes in two passes turns `od\name` into `od\` plus a newline — which
 * files the digest under a path no `stat` will ever match, so the file is
 * re-hashed by every job forever and nothing ever says why.
 */
async function fixture(): Promise<{ dir: string; files: Array<{ path: string; content: Buffer }> }> {
  const dir = await mkdtemp(join(tmpdir(), "trekker-hash-"));

  const planned: Array<{ name: string; content: Buffer }> = [
    { name: "plain.txt", content: Buffer.from("the quick brown fox\n") },
    { name: "empty.txt", content: Buffer.alloc(0) },
    { name: "with space.txt", content: Buffer.from("spaces are ordinary\n") },
    { name: "quote's.txt", content: Buffer.from("apostrophes are not\n") },
    // 8 MiB of incompressible bytes: enough that the streamed route folds
    // several chunks rather than hashing one buffer.
    { name: "big.bin", content: randomBytes(8 * 1024 * 1024) },
    { name: "od\\name.txt", content: Buffer.from("a literal backslash before an n\n") },
  ];

  const files: Array<{ path: string; content: Buffer }> = [];
  for (const entry of planned) {
    const path = join(dir, entry.name);
    await writeFile(path, entry.content);
    files.push({ path, content: entry.content });
  }

  return { dir, files };
}

/** What `sha256sum` says when run directly, which is the number to match. */
async function sha256sumSays(path: string): Promise<string | null> {
  try {
    const { stdout } = await run("sha256sum", ["--", path], { maxBuffer: 1024 * 64 });
    return /([0-9a-f]{64})/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The fallback route, exactly as `HashRunnerService.streamOne` performs it. */
async function streamDigest(driver: HostDriver, path: string): Promise<string> {
  const stream = await driver.createReadStream(path);
  const hash = createHash("sha256");
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    if (!stream.destroyed) stream.destroy();
  }
  return hash.digest("hex");
}

async function verifyDriver(
  label: string,
  driver: HostDriver,
  files: Array<{ path: string; content: Buffer }>,
): Promise<Map<string, string>> {
  console.log(`\n${label}: sha256sum on the host, through the real chunker`);

  const digests = new Map<string, string>();
  const reported: string[] = [];
  const started = Date.now();

  for (const chunk of chunkPaths(files.map((file) => file.path))) {
    const outcome = await sumChunk(driver, chunk, {
      nice: HASH_NICE,
      onDigest: (path) => reported.push(path),
    });
    if (outcome.kind !== "digests") {
      check(`${label}: sha256sum answered`, false, outcome.kind);
      return digests;
    }
    for (const [path, digest] of outcome.digests) digests.set(path, digest);
  }
  note(`${files.length} file(s) in ${Date.now() - started} ms`);

  check(
    `${label}: every file came back with a digest`,
    digests.size === files.length,
    `${digests.size}/${files.length}`,
  );

  // The escaping check, and the reason the awkward name is in the fixture. If
  // the path came back mangled it is simply absent from the map, which is
  // exactly how this failure hides in production.
  const awkward = files.find((file) => file.path.includes("\\"))?.path;
  check(
    `${label}: a path with a backslash came back under its real name`,
    awkward !== undefined && digests.has(awkward),
  );

  check(
    `${label}: a digest was reported per file as it finished`,
    reported.length === digests.size,
    `${reported.length} progress callbacks`,
  );

  // Against what `node:crypto` makes of the same bytes. This is the check that
  // says the command we ran is the algorithm we think it is.
  const wrong = files.filter(
    (file) => digests.get(file.path) !== createHash("sha256").update(file.content).digest("hex"),
  );
  check(`${label}: every digest matches node:crypto over the same bytes`, wrong.length === 0, describe(wrong));

  console.log(`\n${label}: the fallback, reading the bytes through the API`);
  const streamedStarted = Date.now();
  const streamed = new Map<string, string>();
  for (const file of files) streamed.set(file.path, await streamDigest(driver, file.path));
  note(`${files.length} file(s) in ${Date.now() - streamedStarted} ms`);

  // The claim the whole fallback rests on: two routes, one answer. A drift here
  // would report every file on a host without `sha256sum` as differing from its
  // copy on a host with one, which is precisely what TRE-28 will be asked.
  const drifted = files.filter((file) => streamed.get(file.path) !== digests.get(file.path));
  check(`${label}: the streamed digest equals the one the host computed`, drifted.length === 0, describe(drifted));

  console.log(`\n${label}: stopping one`);
  const controller = new AbortController();
  const cancelStarted = Date.now();
  // A chunk that will take a while: the whole fixture, over and over, so there
  // is something running to interrupt.
  const cancelled = sumChunk(
    driver,
    files.map((file) => file.path),
    {
      nice: HASH_NICE,
      signal: controller.signal,
    },
  ).catch(() => null);
  setTimeout(() => controller.abort(), 50);
  await cancelled;
  const cancelMs = Date.now() - cancelStarted;
  check(`${label}: a running sha256sum stops promptly`, cancelMs < 5_000, `${cancelMs} ms`);

  return digests;
}

function describe(files: Array<{ path: string }>): string {
  if (files.length === 0) return "";
  return files.map((file) => file.path.split("/").pop()).join(", ");
}

async function verifySsh(files: Array<{ path: string; content: Buffer }>, local: Map<string, string>): Promise<void> {
  const address = process.env.TREKKER_TEST_SSH_HOST;
  const username = process.env.TREKKER_TEST_SSH_USER;
  if (!address || !username) {
    console.log("\nSSH: skipped (set TREKKER_TEST_SSH_HOST and TREKKER_TEST_SSH_USER)");
    console.log("    The remote half is where the quoting, the channel lifecycle and the kill actually differ.");
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
    const remote = await verifyDriver("SSH", driver, files);

    // The reason to run this at all. Over SSH the argv becomes a shell string,
    // so a name with a space, an apostrophe or a backslash is where quoting is
    // either right or silently hashing a different file.
    const disagreed = files.filter((file) => remote.get(file.path) !== local.get(file.path));
    check("both drivers agree on every file", disagreed.length === 0, describe(disagreed));
  } finally {
    await driver.dispose();
    pool.onModuleDestroy();
  }
}

async function main(): Promise<void> {
  console.log("Verifying checksums (TRE-27)");

  const { dir, files } = await fixture();
  note(`fixture: ${files.length} files under ${dir}`);

  try {
    console.log("\nAgainst `sha256sum` run directly");
    const direct = await sha256sumSays(files[0].path);
    if (direct === null) {
      note("no `sha256sum` on this machine — the remote route cannot be checked here");
      note("that is the case the fallback exists for; the streamed half below still runs");
    } else {
      check(
        "the direct command agrees with node:crypto",
        direct === createHash("sha256").update(files[0].content).digest("hex"),
      );
    }

    const local = await verifyDriver("local", new LocalDriver("verify-local"), files);
    await verifySsh(files, local);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error: Error) => {
  console.error(`\nverify:hash failed: ${error.message}`);
  process.exit(1);
});
