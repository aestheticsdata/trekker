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

/**
 * Which filesystem a path is on, named by the mount point holding it (TRE-23 §4).
 *
 * The longest mount point that is an ancestor wins: `/` and `/var` are both
 * ancestors of `/var/log/app`, and the answer is `/var`. Getting that backwards
 * would report every path on the machine as being on the root filesystem, which
 * turns a cross-device move into a `rename` that fails with EXDEV — the failure
 * this function exists to see coming.
 *
 * Returns null when nothing contains the path, which cannot happen on a machine
 * whose `df` was readable: `/` is always there. Null is the honest answer for
 * the case where it was not.
 */
export function mountPointFor(path: string, points: ReadonlySet<string>): string | null {
  const target = normalise(path);
  let best: string | null = null;

  for (const point of points) {
    if (target !== point && !target.startsWith(point === "/" ? "/" : `${point}/`)) continue;
    if (best === null || point.length > best.length) best = point;
  }

  return best;
}

/**
 * `-k` on top of `-P`, so the fourth column is kibibytes on every system this
 * runs on. Plain `-P` is 512-byte blocks by POSIX and 1024 on some GNU builds
 * that honour `POSIXLY_CORRECT` differently — a factor of two in the number a
 * transfer is refused against is not a thing to leave to the host's mood.
 */
const DF_FREE_ARGS = ["-Pk"] as const;

/**
 * Bytes available at a path, or null when `df` could not answer (TRE-23 §5).
 *
 * Null rather than zero, and the caller must tell them apart: zero means the
 * disk is full and the transfer is refused, null means the question could not
 * be asked and the transfer proceeds. Collapsing the two would either block
 * every transfer to a host without `df` or start every transfer onto a full one.
 *
 * The path is passed to `df` rather than parsed out of the whole table, so the
 * kernel resolves which filesystem holds it. That is the same answer
 * `mountPointFor` computes and it is arrived at by a different route, which is
 * worth having: `df` with no argument omits filesystems it cannot stat.
 */
export async function readFreeBytes(driver: HostDriver, path: string): Promise<number | null> {
  return (await readSpace(driver, path))?.freeBytes ?? null;
}

export interface DiskSpace {
  /** Bytes a non-privileged write may still use. */
  freeBytes: number;
  /** The filesystem's size, for saying how much of it that is (TRE-144). */
  totalBytes: number;
}

/**
 * The same `df` line, read whole (TRE-144).
 *
 * `readFreeBytes` was enough while the only question was "does this fit". An
 * upload also has to answer "and what will be left", which is a fraction and
 * therefore needs the denominator: 900 MB free is comfortable on a laptop and
 * an emergency on the 50 GB volume this feature exists for, and the difference
 * is not visible from the numerator.
 *
 * Null, and never zero, when `df` could not answer — the callers must tell
 * those apart, or a host without `df` refuses every upload and a full one
 * accepts them all.
 */
export async function readSpace(driver: HostDriver, path: string): Promise<DiskSpace | null> {
  try {
    const result = await driver.exec("df", [...DF_FREE_ARGS, path], { timeoutMs: DF_TIMEOUT_MS });

    for (const line of result.stdout.split("\n")) {
      const fields = DF_LINE.exec(line.trimEnd());
      // The header's sixth field is "Mounted on", which does not start with `/`.
      if (!fields || !fields[6].startsWith("/")) continue;

      const total = Number.parseInt(fields[2], 10);
      const free = Number.parseInt(fields[4], 10);
      if (Number.isNaN(free) || free < 0) return null;
      // A total that will not parse is not a reason to withhold the free space;
      // it only costs the fraction, and the fit check is the important half.
      const totalBytes = Number.isNaN(total) || total < 0 ? 0 : total * 1024;

      return { freeBytes: free * 1024, totalBytes };
    }
    return null;
  } catch {
    return null;
  }
}
