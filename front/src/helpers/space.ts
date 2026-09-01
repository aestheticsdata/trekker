/**
 * Whether the destination has room, and whether it will still have any
 * afterwards (TRE-144).
 *
 * Pure and its own file so the thresholds are readable in one place rather than
 * inline in a `className`. The three verdicts are three different sentences —
 * one blocks, one warns, one says nothing — and getting the boundary between
 * them right matters more on a small volume than a large one, which is exactly
 * where a fixed number would be wrong.
 */

export interface DiskSpace {
  /** Bytes free, or null when `df` could not be asked. Never zero for null. */
  free: number | null;
  /** The volume's size, or null. Zero when `df` answered but not legibly. */
  total: number | null;
}

export type Room =
  /** No answer from the host. Say nothing; block nothing. */
  | "unknown"
  /** Fits, and leaves the machine room to work. */
  | "ok"
  /** Fits, and should not. */
  | "tight"
  /** Does not fit. */
  | "full";

/**
 * What a volume should still have after an upload, whatever else happens.
 *
 * A machine with nothing free stops doing things that have nothing to do with
 * the upload — logs, a package index, a database's own temporary files. So the
 * warning is not about the transfer failing; the transfer succeeds, and that is
 * the problem.
 */
const FLOOR_MIN = 1024 ** 3;
const FLOOR_MAX = 16 * 1024 ** 3;

/**
 * A twentieth of the volume, between those two.
 *
 * A fixed number is wrong at both ends: a gigabyte is nearly a fifth of a small
 * VPS and a rounding error on a four-terabyte array. The fraction reads the
 * same on both, and the clamp keeps it from warning about a hundred gigabytes
 * on a disk where a hundred gigabytes is nothing to worry about.
 */
const FLOOR_FRACTION = 0.05;

export function floorFor(total: number | null): number {
  return Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, (total ?? 0) * FLOOR_FRACTION));
}

export function roomFor(bytes: number, space: DiskSpace): Room {
  // Null is "could not ask", and it has to stay distinct from zero all the way
  // to here: reading it as no space would refuse every upload to a host without
  // a usable `df`, turning a check against a full disk into an outage.
  if (space.free === null) return "unknown";
  if (bytes > space.free) return "full";

  return space.free - bytes < floorFor(space.total) ? "tight" : "ok";
}

/** What would be free afterwards. Never negative — `full` covers that case. */
export function remainingAfter(bytes: number, space: DiskSpace): number {
  return Math.max(0, (space.free ?? 0) - bytes);
}
