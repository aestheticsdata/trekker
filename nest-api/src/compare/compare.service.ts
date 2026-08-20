import { posix } from "node:path";
import { Injectable } from "@nestjs/common";
import { DEFAULT_DEPTH, MAX_DEPTH, MAX_ENTRIES } from "@compare/compare-limits";
import { type CompareEntry, compareTrees, hashablePaths, needsHash } from "@compare/compare-tree";
import { isDriverError } from "@hosts/drivers/driver-error";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { toHttp } from "@fs/driver-http";
import type { CompareDto } from "@compare/dto/compare.dto";
import { PrismaService } from "../prisma/prisma.service";

import type { HostDriver } from "@hosts/drivers/host-driver";

/**
 * The comparison route's service (TRE-28).
 *
 * **This is a read, and it answers in the request.** That is a deliberate
 * difference from the two things it sits beside: a disk scan and a checksum
 * job are minutes of work and are therefore jobs, with a queue, a feed and a
 * cancel. A comparison is bounded at eight levels and two thousand rows before
 * it starts, which is seconds of listing — machinery for watching it finish
 * would cost more than the thing it watched.
 *
 * What keeps it from blocking anybody: `list()` is an interactive borrower of
 * the SSH pool, held for milliseconds and released, so a comparison running on
 * a host leaves five of its six channels to the panes. The expensive level does
 * not happen here at all — see below.
 *
 * **Level 3 is not run from here.** The walk marks the rows only a checksum
 * could settle, this fills in whatever `FileHashes` already knows, and the
 * client queues the rest through TRE-27's own route. Queueing them here would
 * spend somebody's disk on the far side of a route whose own rate limit never
 * saw the request, which is the kind of shortcut that is invisible until
 * somebody scripts it.
 */

export interface CompareSideView {
  hostId: string;
  /** The resolved root, which is what every path in `entries` hangs off. */
  path: string;
}

export interface CompareSummaryView {
  total: number;
  onlyA: number;
  onlyB: number;
  differs: number;
  identical: number;
  inconclusive: number;
  /** Rows a checksum would settle. A subset of `inconclusive`. */
  hashable: number;
}

export interface CompareView {
  a: CompareSideView;
  b: CompareSideView;
  depth: number;
  /** The ceiling that was in force, so the client need not hardcode it. */
  maxEntries: number;
  /** A bound bit: the row ceiling, or a shared directory left unopened. */
  truncated: boolean;
  /** Directories one side would not list. Named up to a cap, counted in full. */
  unreadable: string[];
  unreadableCount: number;
  entries: CompareEntry[];
  summary: CompareSummaryView;
  /**
   * The absolute paths a checksum pass would ask for, one list per side and in
   * the same order. Handed over rather than left for the client to rebuild:
   * the rule about *which* rows are worth hashing is the walk's, and a second
   * copy of it in the browser is a second place for it to drift.
   */
  hashable: { a: string[]; b: string[] };
}

/** A cached digest, only as far as it is still usable. */
interface Digest {
  digest: string;
  size: bigint;
  mtimeMs: bigint;
}

@Injectable()
export class CompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
  ) {}

  /**
   * Compare two directories.
   *
   * Both roots go through the guard with `read` intent, on their own host and
   * under this account — which is what makes "a pane on a host the user does
   * not own is impossible" a property of the code rather than of the UI. The
   * guard also resolves each root, so the paths every row hangs off are the
   * real ones and a symlinked root cannot walk out of the allowlist.
   */
  async compare(userId: string, dto: CompareDto): Promise<CompareView> {
    const depth = clampDepth(dto.depth);

    const drivers = await this.open(userId, dto);
    try {
      const rootA = await this.resolve(drivers.a, userId, dto.a.path);
      const rootB = await this.resolve(drivers.b, userId, dto.b.path);

      const walk = await compareTrees({
        rootA,
        rootB,
        listA: (path) => drivers.a.list(path),
        listB: (path) => drivers.b.list(path),
        depth,
        ceiling: MAX_ENTRIES,
      });

      await this.applyDigests(dto.a.hostId, dto.b.hostId, rootA, rootB, walk.entries);

      return {
        a: { hostId: dto.a.hostId, path: rootA },
        b: { hostId: dto.b.hostId, path: rootB },
        depth,
        maxEntries: MAX_ENTRIES,
        truncated: walk.truncated,
        unreadable: walk.unreadable,
        unreadableCount: walk.unreadableCount,
        entries: walk.entries,
        summary: summarise(walk.entries),
        hashable: hashablePaths(walk.entries, rootA, rootB),
      };
    } finally {
      await drivers.a.dispose().catch(() => undefined);
      // Two panes on one host are two drivers on this side of the code; both
      // are released, and the pool is what makes that one connection.
      await drivers.b.dispose().catch(() => undefined);
    }
  }

  /**
   * Settle what the cache can, and leave the rest inconclusive.
   *
   * A row is only settled by two digests that are both still current — the same
   * rule `HashService` serves a single digest under, and for the same reason: a
   * checksum of bytes that have since been overwritten is the one output
   * somebody would act on without checking.
   *
   * Two queries, not two per row. A comparison can carry two thousand rows and
   * a round trip each would be the slowest part of the whole feature.
   */
  private async applyDigests(
    hostA: string,
    hostB: string,
    rootA: string,
    rootB: string,
    entries: CompareEntry[],
  ): Promise<void> {
    const pending = entries.filter(needsHash);
    if (pending.length === 0) return;

    const [digestsA, digestsB] = await Promise.all([
      this.digestsFor(
        hostA,
        pending.map((entry) => posix.join(rootA, entry.path)),
      ),
      this.digestsFor(
        hostB,
        pending.map((entry) => posix.join(rootB, entry.path)),
      ),
    ]);

    for (const entry of pending) {
      const a = usable(digestsA.get(posix.join(rootA, entry.path)), entry.a);
      const b = usable(digestsB.get(posix.join(rootB, entry.path)), entry.b);
      if (a === null || b === null) continue;

      entry.verdict = a === b ? "identical" : "differs";
      entry.reason = "hash";
    }
  }

  private async digestsFor(hostId: string, paths: readonly string[]): Promise<Map<string, Digest>> {
    const rows = await this.prisma.fileHashes.findMany({
      where: { hostId, path: { in: [...new Set(paths)] } },
      select: { path: true, digest: true, size: true, mtimeMs: true },
    });
    return new Map(rows.map((row) => [row.path, row]));
  }

  /**
   * Both drivers, opened together.
   *
   * Two panes on the same host are two `forHost` calls and one pooled
   * connection, so the common case costs nothing extra and the cross-host case
   * needs no branch anywhere below this line — which is the whole point of the
   * driver interface (TRE-9).
   */
  private async open(userId: string, dto: CompareDto): Promise<{ a: HostDriver; b: HostDriver }> {
    const a = await this.run(() => this.factory.forHost(dto.a.hostId, userId));
    try {
      const b = await this.run(() => this.factory.forHost(dto.b.hostId, userId));
      return { a, b };
    } catch (error) {
      // The second host refused. The first one is already open and nothing
      // else will ever release it.
      await a.dispose().catch(() => undefined);
      throw error;
    }
  }

  private async resolve(driver: HostDriver, userId: string, path: string): Promise<string> {
    const validated = await this.guard.validate({ driver, userId, path, intent: "read" });
    return validated.realPath;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }
}

/**
 * A cached digest, or null when it no longer describes what the walk saw.
 *
 * The comparison of `size` and `mtimeMs` is against the listing this walk just
 * made, not against a second `stat`: the row and the facts were read moments
 * apart, and a file changing between them changes the answer either way.
 */
function usable(row: Digest | undefined, facts: { size: number; mtimeMs: number } | null): string | null {
  if (!row || !facts) return null;
  if (row.size !== BigInt(facts.size)) return null;
  if (row.mtimeMs !== BigInt(Math.trunc(facts.mtimeMs))) return null;
  return row.digest;
}

function summarise(entries: readonly CompareEntry[]): CompareSummaryView {
  const summary: CompareSummaryView = {
    total: entries.length,
    onlyA: 0,
    onlyB: 0,
    differs: 0,
    identical: 0,
    inconclusive: 0,
    hashable: 0,
  };

  for (const entry of entries) {
    summary[entry.verdict] += 1;
    if (needsHash(entry)) summary.hashable += 1;
  }

  return summary;
}

/**
 * Depth is clamped rather than refused. The DTO already rejects a value outside
 * the range, so this is the default path and the belt-and-braces one at once.
 */
function clampDepth(depth: number | undefined): number {
  if (depth === undefined) return DEFAULT_DEPTH;
  return Math.min(MAX_DEPTH, Math.max(1, Math.trunc(depth)));
}
