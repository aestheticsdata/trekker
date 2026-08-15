/**
 * Proves the TRE-31 claims that only a real `df` can settle: that the disk
 * panel's table is the machine's own, mount for mount, and that ten tabs
 * looking at one host cost one reading.
 *
 * The unit spec fixes the parsing against captured output. What it cannot do is
 * notice that this host's `df` puts its columns somewhere else, reports 512-byte
 * blocks, or refuses `-T` — so this runs the service against the machine it is
 * on and compares it with what `df` itself says.
 *
 * Runs anywhere with a `df`, from the API's own directory:
 *
 *   cd nest-api
 *   pnpm verify:disks
 *
 * The two drivers are only compared when an SSH host is named, which is the run
 * worth doing on the deploy host — against its own sshd, so both drivers read
 * the same filesystems and equality means something:
 *
 *   ssh -A <the host>
 *   cd /var/www/trekker/api
 *   TREKKER_TEST_SSH_HOST=127.0.0.1 TREKKER_TEST_SSH_USER=$USER \
 *     pnpm --filter ./nest-api verify:disks
 *
 * Optional: TREKKER_TEST_SSH_PORT (22), TREKKER_TEST_SSH_KEY (a key file,
 * instead of the forwarded agent).
 *
 * Reads only. It runs `df` and nothing else, and writes nothing anywhere.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { ExecOptions, ExecResult, HostDriver } from "../src/hosts/drivers/host-driver";
import type { AllowedProgram } from "../src/hosts/drivers/shell-quote";
import { LocalDriver } from "../src/hosts/drivers/local.driver";
import {
  DEFAULT_POOL_SETTINGS,
  type HostConnectionSpec,
  type SshAuth,
  SshConnectionPool,
} from "../src/hosts/drivers/ssh-connection.pool";
import { SshDriver } from "../src/hosts/drivers/ssh.driver";
import { type DiskMount, HostDisksService } from "../src/hosts/host-disks.service";

const run = promisify(execFile);

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Counts what the service asks the host, without changing the answers. */
function counting(driver: HostDriver): { driver: HostDriver; calls: string[][] } {
  const calls: string[][] = [];
  const wrapper = {
    ...driver,
    hostId: driver.hostId,
    exec: (program: AllowedProgram, args: readonly string[], options?: ExecOptions): Promise<ExecResult> => {
      calls.push([program, ...args]);
      return driver.exec(program, args, options);
    },
  };
  return { driver: wrapper, calls };
}

/** What `df` itself says, read straight from the machine rather than the service. */
async function dfSays(): Promise<Map<string, { totalKib: number; usedKib: number; capacity: string }>> {
  const { stdout } = await run("df", ["-P", "-k"]);
  const table = new Map<string, { totalKib: number; usedKib: number; capacity: string }>();

  for (const line of stdout.split("\n")) {
    const fields = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\/.*)$/.exec(line.trim());
    if (!fields) continue;
    const totalKib = Number(fields[2]);
    if (totalKib <= 0) continue;
    table.set(fields[6].trimEnd(), { totalKib, usedKib: Number(fields[3]), capacity: fields[5] });
  }

  return table;
}

function show(disks: DiskMount[]): void {
  for (const disk of disks) {
    const size = (disk.totalBytes / 1024 ** 3).toFixed(1);
    const used = (disk.usedBytes / 1024 ** 3).toFixed(1);
    const inodes = disk.inodes ? `${disk.inodes.percent}% inodes` : "no inode count";
    // The flag rather than the number, because the flag is what the panel draws
    // and what a reader of this output is checking against their own `df`.
    const warn = disk.warn ? " ⚠" : "  ";
    console.log(
      `  ${disk.mountPoint.padEnd(24)} ${(disk.type ?? "?").padEnd(10)} ${used}/${size} GiB  ${disk.percent}%${warn} ${inodes}  ${disk.device}`,
    );
  }
}

/**
 * A key file if one is named, otherwise the forwarded agent — and null when
 * there is neither.
 *
 * Null rather than `process.exit`: the SSH comparison is the optional half of
 * this script, and killing the run for the want of an agent throws away the
 * eight local checks that already passed and reports the whole thing red. A
 * half that cannot run is a skip, which is what the missing environment
 * variables are already treated as.
 */
function resolveAuth(): SshAuth | null {
  const keyPath = process.env.TREKKER_TEST_SSH_KEY;
  if (keyPath) return { kind: "PRIVATE_KEY", privateKey: readFileSync(keyPath) };

  const agentSocket = process.env.SSH_AUTH_SOCK;
  return agentSocket ? { kind: "AGENT", agentSocket } : null;
}

async function main(): Promise<void> {
  const service = new HostDisksService();
  const local = new LocalDriver("verify-disks-local");

  console.log("== a host nobody is looking at ==");
  const idle = counting(local);
  await new Promise((resolve) => setTimeout(resolve, 200));
  check("is not polled: no df until somebody asks", idle.calls.length === 0, `${idle.calls.length} calls`);

  console.log("\n== the table this machine reports ==");
  const everything = await service.forHost(local, { includePseudo: true });
  show(everything);

  console.log("\n== mount for mount, against df itself ==");
  const truth = await dfSays();
  const missing = [...truth.keys()].filter((point) => !everything.some((disk) => disk.mountPoint === point));
  check(`every filesystem df lists is here (${truth.size})`, missing.length === 0, missing.join(", "));

  const wrong: string[] = [];
  for (const disk of everything) {
    const actual = truth.get(disk.mountPoint);
    if (!actual) continue;
    if (disk.totalBytes !== actual.totalKib * 1024 || disk.usedBytes !== actual.usedKib * 1024) {
      wrong.push(
        `${disk.mountPoint}: ${disk.totalBytes}/${disk.usedBytes} vs df ${actual.totalKib}k/${actual.usedKib}k`,
      );
    }
  }
  check("every size and used figure is df's own", wrong.length === 0, wrong.join("; "));

  const inconsistent = everything.filter(
    (disk) => disk.percent !== Math.round((disk.usedBytes / disk.totalBytes) * 100),
  );
  check("every percentage follows from the used and total beside it", inconsistent.length === 0);

  // Not a failure — the disagreement is the reason the percentage is computed.
  for (const disk of everything) {
    const capacity = truth.get(disk.mountPoint)?.capacity;
    if (capacity && capacity !== `${disk.percent}%`) {
      console.log(`  note: ${disk.mountPoint} — df's Capacity says ${capacity}, used/total says ${disk.percent}%`);
    }
  }

  console.log("\n== what the default view leaves out ==");
  const shown = await service.forHost(local);
  const hidden = everything.filter((disk) => !shown.some((kept) => kept.mountPoint === disk.mountPoint));
  console.log(
    `  hiding ${hidden.length}: ${hidden.map((disk) => `${disk.mountPoint} (${disk.type})`).join(", ") || "—"}`,
  );
  check(
    "the root filesystem is never hidden",
    shown.some((disk) => disk.mountPoint === "/"),
  );
  check(
    "everything hidden is a pseudo-filesystem",
    hidden.every((disk) => disk.pseudo),
    hidden
      .filter((disk) => !disk.pseudo)
      .map((disk) => disk.mountPoint)
      .join(", "),
  );

  console.log("\n== cost: ten tabs, one reading ==");
  // Against what one caller costs, not against a fixed number: a host whose
  // `df` refuses `-T` pays for the retry, and the claim is that ten callers pay
  // it once between them rather than that a reading is always two calls.
  const alone = counting(local);
  await new HostDisksService().forHost(alone.driver);

  const burst = counting(local);
  const fresh = new HostDisksService();
  const answers = await Promise.all(Array.from({ length: 10 }, () => fresh.forHost(burst.driver)));
  console.log(`  one caller: ${alone.calls.map((call) => call.join(" ")).join(", ")}`);
  check(
    `ten concurrent requests cost what one costs (${burst.calls.length} calls, not ${alone.calls.length * 10})`,
    burst.calls.length === alone.calls.length,
  );
  check(
    "and every caller got the same table",
    answers.every((answer) => JSON.stringify(answer) === JSON.stringify(answers[0])),
  );

  const sshHost = process.env.TREKKER_TEST_SSH_HOST;
  const sshUser = process.env.TREKKER_TEST_SSH_USER;
  const auth = resolveAuth();
  if (!sshHost || !sshUser) {
    console.log("\n== local and SSH ==\n  skipped: set TREKKER_TEST_SSH_HOST and TREKKER_TEST_SSH_USER to compare");
  } else if (!auth) {
    console.log(
      "\n== local and SSH ==\n" +
        "  skipped: an SSH host was named but there is no way to authenticate.\n" +
        "  Reconnect with `ssh -A` so SSH_AUTH_SOCK is forwarded, or point\n" +
        "  TREKKER_TEST_SSH_KEY at a private key this host accepts for this user.",
    );
  } else {
    console.log("\n== the two drivers describe the same filesystems ==");
    const pool = new SshConnectionPool(DEFAULT_POOL_SETTINGS);
    const spec: HostConnectionSpec = {
      hostId: "verify-disks-ssh",
      address: sshHost,
      port: Number(process.env.TREKKER_TEST_SSH_PORT ?? 22),
      username: sshUser,
      auth,
    };
    const ssh = new SshDriver(spec, pool, DEFAULT_POOL_SETTINGS);

    try {
      const remote = await new HostDisksService().forHost(ssh, { includePseudo: true });
      show(remote);
      // Sizes, not used bytes: the two readings are seconds apart on a live
      // machine, and a byte written between them is not a parsing difference.
      const shape = (disks: DiskMount[]) =>
        disks.map((disk) => `${disk.mountPoint}|${disk.device}|${disk.type}|${disk.totalBytes}`);
      check(
        "same mounts, devices, types and sizes over SSH",
        JSON.stringify(shape(remote)) === JSON.stringify(shape(everything)),
      );
    } finally {
      await ssh.dispose();
      pool.onModuleDestroy();
    }
  }

  console.log(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((error: Error) => {
  console.error(`\nverify:disks failed: ${error.message}`);
  process.exit(1);
});
