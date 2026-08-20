import { chunkPaths, sumChunk } from "@hosts/sha256-sum";

import type { HostDriver } from "@hosts/drivers/host-driver";
import type { DuplicateCandidate } from "@scans/scan-aggregator";
import { HASH_BUDGET_BYTES, MAX_DUP_GROUPS, MAX_HASH_BYTES, SCAN_NICE } from "@scans/scan-limits";

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
 * Running `sha256sum` and reading its output is `@hosts/sha256-sum`, shared with
 * TRE-27's checksum jobs. What is left here is the part that is about
 * duplicates rather than about digests: which groups are worth the read, what
 * the budget stops, and how a group of digests becomes a count of copies.
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
 * Chunked because either bound can bite first — see `chunkPaths`. A host with
 * no `sha256sum` is treated exactly as a host that refused: the pass reports
 * the group as unchecked and moves on. Falling back to reading every candidate
 * across the network, which is what TRE-27 does for a checksum somebody
 * actually asked for, is the wrong trade here — this is a side pass of a disk
 * scan, and nobody asked for it hard enough to spend a filesystem's worth of
 * bandwidth on it.
 */
async function hashGroup(paths: readonly string[], deps: DuplicateFinderDeps): Promise<Map<string, string> | null> {
  const digests = new Map<string, string>();

  for (const chunk of chunkPaths(paths)) {
    if (deps.signal.aborted) return null;

    const outcome = await sumChunk(deps.driver, chunk, { signal: deps.signal, nice: SCAN_NICE });
    if (outcome.kind !== "digests") return null;

    for (const [path, digest] of outcome.digests) digests.set(path, digest);
  }

  return digests;
}
