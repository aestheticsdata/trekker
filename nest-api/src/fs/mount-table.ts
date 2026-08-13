import type { HostDriver } from "@hosts/drivers/host-driver";

/**
 * Where one filesystem ends and another begins (TRE-25 §2).
 *
 * A recursive delete that walks into a mounted share because a directory
 * happened to be a mount point is a very bad afternoon, so the walk has to know
 * where the boundaries are. The textbook check compares `st_dev` against the
 * parent — and it is not available here. `FileStat` carries no `dev`, and it
 * cannot: SFTP v3 has no such attribute, which is the same reason `inode` is
 * optional on a remote host.
 *
 * So the mount table is read instead, once per delete. `df` is already in
 * `ALLOWED_PROGRAMS` and its last column is precisely the list of boundaries.
 * One round trip covers the whole tree however deep it goes, it behaves the
 * same on a local host and over SSH, and it hits no argument-length limit.
 *
 * A batched `stat -c %d` over the directories was the alternative, and it is
 * the more precise check. It was not chosen because `-c` is GNU-only where
 * `df -P` is POSIX, and a `stat` flag that means something else on BSD has
 * already cost this repository once — see the note in `verify-permissions.ts`.
 */

/**
 * `-P` is what makes this parseable: POSIX output format guarantees one line
 * per filesystem, so a long device name cannot wrap onto a second line and
 * shift every field.
 */
const DF_ARGS = ["-P"] as const;

/** Long enough for a slow remote mount to answer, short enough not to hang a delete. */
const DF_TIMEOUT_MS = 10_000;

/**
 * The six POSIX columns. The mount point is everything after the fifth, not the
 * sixth word: `/mnt/My Backup Drive` is one path and splitting on whitespace
 * would keep only `/mnt/My`, which matches no walked path and silently reports
 * that a real boundary is not one.
 */
const DF_LINE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S.*)$/;

/**
 * Every mount point `df` reports, normalised for comparison against a walked
 * path.
 *
 * The header line is dropped by shape rather than by counting lines: `df` on
 * some systems prints a warning above it, and skipping "the first line" would
 * then drop a real filesystem and keep the header.
 */
export function parseMountPoints(output: string): string[] {
  const points: string[] = [];

  for (const line of output.split("\n")) {
    const fields = DF_LINE.exec(line.trimEnd());
    if (!fields) continue;

    const mountedOn = fields[6];
    // The header matches the shape too — "Mounted on" is a valid sixth field.
    // An absolute path is the discriminator: no header column starts with `/`.
    if (!mountedOn.startsWith("/")) continue;

    points.push(normalise(mountedOn));
  }

  return points;
}

/**
 * The host's mount points, or an empty set when `df` cannot be run.
 *
 * Empty is the dangerous answer, so the caller is told which it got rather than
 * being handed a set that cannot be distinguished from a machine with one
 * filesystem. See `DeleteService`, which refuses instead of guessing.
 */
export async function readMountPoints(driver: HostDriver): Promise<Set<string> | null> {
  try {
    const result = await driver.exec("df", DF_ARGS, { timeoutMs: DF_TIMEOUT_MS });
    // A non-zero exit with usable output still happens — `df` reports a stale
    // NFS mount on stderr and carries on describing every other filesystem —
    // so the output is judged rather than the code.
    const points = parseMountPoints(result.stdout);
    return points.length === 0 ? null : new Set(points);
  } catch {
    return null;
  }
}

/**
 * Trailing slashes removed so `/mnt/data/` and `/mnt/data` compare equal, with
 * `/` kept as itself — it is the one mount point that is entirely a slash.
 */
function normalise(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** Whether a walked path is itself a boundary. */
export function isMountPoint(path: string, points: ReadonlySet<string>): boolean {
  return points.has(normalise(path));
}
