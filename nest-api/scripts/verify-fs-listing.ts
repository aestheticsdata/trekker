/**
 * Proves the two TRE-13 claims that only a live SFTP connection can settle:
 * that `LocalDriver` and `SshDriver` describe the same tree identically, and
 * that a listing costs one `readdir` plus one `readlink` per symlink — never a
 * stat per entry.
 *
 * Meant to be run ON the deploy host, against its own sshd, so both drivers
 * read the *same* directory and deep equality means something.
 *
 * It needs to authenticate to that host as that user, and the tidiest way is
 * the agent you already connected with — no keypair has to exist on the server,
 * and nothing is added to its `authorized_keys`:
 *
 *   ssh -A <the host>
 *   cd /var/www/trekker/api
 *   TREKKER_TEST_SSH_HOST=127.0.0.1 TREKKER_TEST_SSH_USER=$USER \
 *     pnpm --filter ./nest-api verify:fs
 *
 * With `-A`, SSH_AUTH_SOCK points at your forwarded agent and this uses it.
 * Set TREKKER_TEST_SSH_KEY instead to authenticate with a key file on the box.
 *
 * Optional: TREKKER_TEST_SSH_PORT (22), TREKKER_TEST_SSH_ROOT (a writable
 * directory; defaults to /tmp), TREKKER_TEST_ENTRIES (files to create;
 * defaults to 10000).
 *
 * Everything it creates lives in one temp directory under that root and is
 * removed at the end. It never writes outside it.
 */
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalDriver } from "../src/hosts/drivers/local.driver";
import type { FileEntry } from "../src/hosts/drivers/host-driver";
import {
  DEFAULT_POOL_SETTINGS,
  type HostConnectionSpec,
  type SshAuth,
  SshConnectionPool,
} from "../src/hosts/drivers/ssh-connection.pool";
import { SshDriver } from "../src/hosts/drivers/ssh.driver";
import { toRow } from "../src/fs/file-row";

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

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See the header of this file for the invocation.`);
    process.exit(1);
  }
  return value;
}

/**
 * A key file if one is named, otherwise the forwarded agent. Preferring the
 * agent is what lets this run without a keypair on the server: `ssh -A` already
 * carries a key the host trusts, so nothing has to be created or authorised
 * there just to measure a listing.
 */
function resolveAuth(): SshAuth {
  const keyPath = process.env.TREKKER_TEST_SSH_KEY;
  if (keyPath) return { kind: "PRIVATE_KEY", privateKey: readFileSync(keyPath) };

  const agentSocket = process.env.SSH_AUTH_SOCK;
  if (agentSocket) return { kind: "AGENT", agentSocket };

  console.error(
    "No way to authenticate. Either reconnect with `ssh -A` so SSH_AUTH_SOCK is set,\n" +
      "or point TREKKER_TEST_SSH_KEY at a private key this host accepts for this user.",
  );
  process.exit(1);
}

/** Rows, minus what legitimately differs between two readings of one tree. */
function comparable(entries: FileEntry[]): unknown[] {
  return entries
    .map((entry) => toRow(entry, { owner: null, group: null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function main(): Promise<void> {
  const host = required("TREKKER_TEST_SSH_HOST");
  const username = required("TREKKER_TEST_SSH_USER");
  const port = Number(process.env.TREKKER_TEST_SSH_PORT ?? 22);
  const root = process.env.TREKKER_TEST_SSH_ROOT ?? tmpdir();
  const count = Number(process.env.TREKKER_TEST_ENTRIES ?? 10_000);

  const workspace = await mkdtemp(join(root, "trekker-fs-verify-"));
  const pool = new SshConnectionPool(DEFAULT_POOL_SETTINGS);
  const spec: HostConnectionSpec = {
    hostId: "verify-fs",
    address: host,
    port,
    username,
    auth: resolveAuth(),
  };
  const ssh = new SshDriver(spec, pool, DEFAULT_POOL_SETTINGS);
  const local = new LocalDriver("verify-fs-local");

  try {
    console.log(`Fixture: ${workspace} (${count} files, 3 symlinks)`);
    await Promise.all(Array.from({ length: count }, (_, i) => writeFile(join(workspace, `entry-${i}.dat`), String(i))));
    await symlink(join(workspace, "entry-0.dat"), join(workspace, "link-inside"));
    await symlink("/etc", join(workspace, "link-outside"));
    await symlink("/nowhere-at-all", join(workspace, "link-broken"));

    console.log("\n== the two drivers describe one tree identically ==");
    const [localEntries, sshEntries] = await Promise.all([local.list(workspace), ssh.list(workspace)]);
    check(
      `both list ${count + 3} entries`,
      localEntries.length === sshEntries.length,
      `${localEntries.length} vs ${sshEntries.length}`,
    );

    const localRows = comparable(localEntries);
    const sshRows = comparable(sshEntries);
    const same = JSON.stringify(localRows) === JSON.stringify(sshRows);
    if (!same) {
      const firstDiff = localRows.findIndex((row, i) => JSON.stringify(row) !== JSON.stringify(sshRows[i]));
      check(
        "rows are deeply equal",
        false,
        `first difference at ${firstDiff}: ${JSON.stringify(localRows[firstDiff])} vs ${JSON.stringify(sshRows[firstDiff])}`,
      );
    } else {
      check("rows are deeply equal across LocalDriver and SshDriver", true);
    }

    console.log("\n== cost: one readdir, no stat per entry ==");
    // Counted at the SFTP layer, which is where a round trip actually happens.
    const lease = await pool.acquire(spec);
    const counts: Record<string, number> = {};
    const sftp = lease.sftp as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of ["readdir", "lstat", "stat", "readlink", "realpath"]) {
      const original = sftp[method].bind(sftp);
      sftp[method] = (...args: unknown[]) => {
        counts[method] = (counts[method] ?? 0) + 1;
        return original(...args);
      };
    }
    lease.release();

    const started = Date.now();
    const listed = await ssh.list(workspace);
    const tookMs = Date.now() - started;
    console.log(`  listed ${listed.length} entries over SFTP in ${tookMs}ms`);
    console.log(`  SFTP requests: ${JSON.stringify(counts)}`);

    check("exactly one readdir", counts.readdir === 1, String(counts.readdir));
    check(
      `no lstat/stat per entry (${count} files)`,
      (counts.lstat ?? 0) === 0 && (counts.stat ?? 0) === 0,
      JSON.stringify(counts),
    );
    check("one readlink per symlink (3)", counts.readlink === 3, String(counts.readlink));
    check(`a ${count}-entry listing is under 500ms`, tookMs < 500, `${tookMs}ms`);
    console.log(`\n  RECORD THIS NUMBER: ${listed.length} entries over SFTP in ${tookMs}ms`);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await ssh.dispose();
    pool.onModuleDestroy();
  }

  console.log(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((error: Error) => {
  console.error(`\nverify:fs failed: ${error.message}`);
  process.exit(1);
});
