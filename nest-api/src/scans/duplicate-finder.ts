import type { HostDriver } from "@hosts/drivers/host-driver";
import type { DuplicateCandidate } from "@scans/scan-aggregator";
import {
  HASH_BUDGET_BYTES,
  MAX_ARGS_PER_CALL,
  MAX_ARGV_BYTES,
  MAX_DUP_GROUPS,
  MAX_HASH_BYTES,
  SCAN_NICE,
} from "@scans/scan-limits";

/**
 * Which same-size groups are actually the same file (TRE-32 §3).
 *
 * The shape of the problem is that hashing is expensive and being the same size
 * is free. Two files of different sizes cannot be copies of each other, so the
 * walk's size index already excludes almost everything; what is left is a
 * handful of groups, and only those are read. Hashing a filesystem to find
 * duplicates is not viable at any size — hashing the twelve groups that share a
 * size is a few seconds.
 *
 * **Every bound is reported, none is silent.** The answer distinguishes groups
 * that share a size (`candidates`) from groups a hash confirmed (`confirmed`)
 * from groups the budget never reached (`skipped`). "Eight duplicate groups" on
 * its own would read as the whole truth about the disk when it is the part we
 * could afford to check, and the difference is what somebody decides to delete
 * things on.
 *
 * `sha256sum` takes many paths in one argv, which is exactly why it is on the
 * allowlist and why no shell loop, `xargs` or `find -exec` appears anywhere
 * here. The chunking below is about `ARG_MAX`, not about the absence of a shell.
 */

export interface DuplicateReport {
  /** Groups sharing a size, before any hashing. */
  candidates: number;
  /** Groups a hash proved identical. */
  confirmed: number;
  /** Candidate groups no hash was spent on, for any reason. */
  skipped: number;
  /** Each confirmed group's size, counted once less than its member count. */
  reclaimableBytes: bigint;
}

export const NO_DUPLICATES: DuplicateReport = Object.freeze({
  candidates: 0,
  confirmed: 0,
  skipped: 0,
  reclaimableBytes: 0n,
});

/**
 * GNU `sha256sum` prints `<64 hex><two spaces><path>`, and escapes the path
 * when it contains a backslash or a newline: the line is then prefixed with a
 * backslash and those two characters appear as `\\` and `\n`.
 */
const SUM_LINE = /^(\\?)([0-9a-f]{64})\s{2}(.+)$/;

export interface DuplicateFinderDeps {
  driver: HostDriver;
  signal: AbortSignal;
  /** Told which group is being read, for the progress feed. */
  onProgress?: (hashedBytes: bigint) => void;
}

/**
 * Confirm what can be afforded, and say what could not be.
 *
 * Never throws for anything a host did: a group whose `sha256sum` failed —
 * a vanished file, a directory that came through as a file record, a permission
 * denied — is counted as skipped and the pass carries on. A scan that reports
 * no duplicates because one file disappeared mid-walk would be a worse answer
 * than one that reports the rest.
 */
export async function confirmDuplicates(
  candidates: readonly DuplicateCandidate[],
  droppedByBounds: number,
  deps: DuplicateFinderDeps,
): Promise<DuplicateReport> {
  const total = candidates.length;
  if (total === 0) {
    return { candidates: 0, confirmed: 0, skipped: droppedByBounds, reclaimableBytes: 0n };
  }

  // Already ranked by what confirming them could give back, so the budget is
  // spent on the groups worth reading.
  const affordable = candidates.slice(0, MAX_DUP_GROUPS);
  let skipped = droppedByBounds + (total - affordable.length);
  let confirmed = 0;
  let reclaimable = 0n;
  let spent = 0n;

  for (const group of affordable) {
    if (deps.signal.aborted) {
      skipped += 1;
      continue;
    }
    // A single file too large to be worth reading twice. The group stays a
    // candidate rather than becoming a claim we did not check.
    if (group.bytes > MAX_HASH_BYTES) {
      skipped += 1;
      continue;
    }

    const cost = group.bytes * BigInt(group.paths.length);
    if (spent + cost > HASH_BUDGET_BYTES) {
      skipped += 1;
      continue;
    }

    const digests = await hashGroup(group.paths, deps);
    if (digests === null) {
      skipped += 1;
      continue;
    }
    spent += cost;
    deps.onProgress?.(spent);

    // One size group can hold two different pairs of duplicates. Counting by
    // digest rather than per group is what makes "eight copies of one file" and
    // "two copies each of four files" different answers.
    const byDigest = new Map<string, number>();
    for (const digest of digests.values()) {
      byDigest.set(digest, (byDigest.get(digest) ?? 0) + 1);
    }

    let confirmedHere = false;
    for (const count of byDigest.values()) {
      if (count < 2) continue;
      confirmedHere = true;
      // Keep one of each: what deleting the copies gives back.
      reclaimable += group.bytes * BigInt(count - 1);
    }
    if (confirmedHere) confirmed += 1;
  }

  return { candidates: total, confirmed, skipped, reclaimableBytes: reclaimable };
}

/**
 * One group's digests, or null when the host could not give them.
 *
 * Chunked by argument count *and* argv bytes, because either can bite first:
 * sixty-four short paths are nothing and sixty-four very long ones exceed what
 * a command line will carry — and over SSH the argv also has to survive being
 * rendered as a shell string.
 */
async function hashGroup(paths: readonly string[], deps: DuplicateFinderDeps): Promise<Map<string, string> | null> {
  const digests = new Map<string, string>();

  for (const chunk of chunkPaths(paths)) {
    if (deps.signal.aborted) return null;

    const output = await runSum(chunk, deps);
    if (output === null) return null;

    for (const line of output.split("\n")) {
      const fields = SUM_LINE.exec(line.trimEnd());
      if (!fields) continue;
      digests.set(unescapePath(fields[3], fields[1] === "\\"), fields[2]);
    }
  }

  return digests;
}

/**
 * `sha256sum` over one chunk, streamed.
 *
 * Streamed rather than buffered, and the reason is cancellation rather than
 * volume: the output is sixty-five bytes a file. A buffered `exec` would make
 * the cancel latency one whole chunk, and a chunk of sixty-four files at up to
 * two gigabytes each is minutes — which fails the same "stops within a few
 * seconds" the walk itself satisfies.
 */
async function runSum(chunk: readonly string[], deps: DuplicateFinderDeps): Promise<string | null> {
  // A driver that cannot stream cannot confirm anything, and every group is
  // then reported as a candidate nobody checked rather than as no duplicates.
  if (!deps.driver.execStream) return null;

  try {
    const running = await deps.driver.execStream("sha256sum", ["--", ...chunk], {
      signal: deps.signal,
      nice: SCAN_NICE,
    });

    let out = "";
    for await (const piece of running.stdout) {
      out += (piece as Buffer).toString("utf8");
    }
    const result = await running.done;
    // A non-zero exit still prints the files it could read, exactly as `du`
    // does. What it could not read simply has no line, and a member with no
    // digest cannot match another — so a partly-readable group under-reports
    // rather than claiming a match it did not verify.
    return result.code === 0 || out.length > 0 ? out : null;
  } catch {
    // A host that refused the command, a channel that dropped. One group's
    // problem, not the scan's.
    return null;
  }
}

/** Bounded by both the argument count and the total argv size. */
export function chunkPaths(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;

  for (const path of paths) {
    // Quoting can nearly double a path's rendered length, so the estimate is
    // deliberately pessimistic — running out of command line is a failure the
    // caller sees as "this host cannot hash", which is not what happened.
    const cost = path.length * 2 + 4;
    if (current.length > 0 && (current.length >= MAX_ARGS_PER_CALL || bytes + cost > MAX_ARGV_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(path);
    bytes += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Undo `sha256sum`'s own escaping, which it applies only to the flagged lines. */
function unescapePath(path: string, escaped: boolean): string {
  if (!escaped) return path;
  return path.replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}
