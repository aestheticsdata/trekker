import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { isDriverError } from "@hosts/drivers/driver-error";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { toHttp } from "@fs/driver-http";
import { walkTree } from "@fs/tree-walk";
import { MAX_FILES_PER_JOB, MAX_JOB_BYTES } from "@hashes/hash-limits";
import { HashQueueService } from "@hashes/hash-queue.service";
import type { HashTarget } from "@hashes/hash-runner.service";
import type { StartHashDto } from "@hashes/dto/start-hash.dto";
import { PrismaService } from "../prisma/prisma.service";

import type { HostDriver } from "@hosts/drivers/host-driver";

/**
 * The checksum routes' service (TRE-27): accept a job, serve a cached digest,
 * stop a job.
 *
 * Nothing long-running happens here. Hashing twenty gigabytes is minutes, so
 * the POST resolves the selection, refuses it or hands it to the queue, and
 * returns — a request that waited for the digests would die to a proxy timeout
 * with a `sha256sum` still running on somebody's server behind it.
 *
 * What *does* happen here is the expansion: a directory in the selection is
 * walked into its files before the job is accepted, so the bounds are checked
 * against the real number and the refusal can name it. The walk is ceilinged,
 * so a selection far over the bound costs a walk that stops rather than a walk
 * of the whole tree followed by a refusal.
 */

export interface HashView {
  hostId: string;
  path: string;
  digest: string;
  method: "REMOTE" | "STREAMED";
  /** The size and mtime the digest was taken against, for the reader to judge. */
  size: string;
  mtimeMs: string;
  computedAt: Date;
}

export interface HashJobView {
  id: string;
  hostId: string;
  files: number;
  bytesTotal: string;
  /** In line rather than reading anything yet. */
  queued: boolean;
}

export interface HashStateView {
  /**
   * The cached digest, **only when it still describes the file that is there**.
   * A row whose size or mtime no longer match is not returned at all: a stale
   * hash presented as current is worse than no hash, because it is the one
   * thing somebody would act on without checking.
   */
  hash: HashView | null;
  /**
   * A digest was cached and has been invalidated by a change to the file. Sent
   * so the panel can say "the file changed since it was last hashed" rather
   * than the flat "not computed" that is true but says less.
   */
  superseded: boolean;
  /** A job of this account, on this host, that would cover this path. */
  running: HashJobView | null;
}

@Injectable()
export class HashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly queue: HashQueueService,
  ) {}

  /**
   * Accept a job, or refuse it with the numbers.
   *
   * Every path goes through the guard with `read` intent, like every other path
   * in the application — which is also what turns the client's path into the
   * real one, so a symlinked selection cannot walk out of the allowlist.
   *
   * Symlinks *inside* a selected directory are never followed and never hashed.
   * The guard validated what the client sent; a link discovered three levels
   * down was validated by nobody, and hashing it would read whatever it points
   * at. This matches what the recursive chmod and the transfer walk already do.
   */
  async start(userId: string, dto: StartHashDto): Promise<HashJobView> {
    const driver = await this.run(() => this.factory.forHost(dto.hostId, userId));

    let targets: HashTarget[];
    try {
      targets = await this.expand(driver, userId, dto.paths);
    } finally {
      // Released before the job runs. The runner opens its own — a job that
      // waits in line for a minute must not hold a pooled SSH channel while it
      // does nothing.
      await driver.dispose().catch(() => undefined);
    }

    if (targets.length === 0) {
      throw new BadRequestException("Nothing in this selection is a file that can be hashed.");
    }

    const bytesTotal = targets.reduce((sum, target) => sum + target.size, 0n);
    if (bytesTotal > MAX_JOB_BYTES) {
      throw new BadRequestException(
        `This selection holds ${describeBytes(bytesTotal)}; a checksum job takes at most ` +
          `${describeBytes(MAX_JOB_BYTES)}. Hash a smaller part of it.`,
      );
    }

    const job = { id: randomUUID(), hostId: dto.hostId, userId, targets, bytesTotal };
    const accepted = this.queue.enqueue(job);

    return {
      id: accepted.id,
      hostId: accepted.hostId,
      files: accepted.files,
      bytesTotal: accepted.bytesTotal.toString(),
      // Whether it is actually waiting, which the queue decides — with a free
      // slot it started reading before this line ran.
      queued: accepted.queued,
    };
  }

  /**
   * The inspector's payload for one path: what is cached, and what is running.
   *
   * The file is statted rather than trusted, because the cache's whole
   * correctness argument is that a row is only usable while the size and mtime
   * it was taken against still hold. Answering from the row alone would make
   * "the cache invalidates itself" a claim with nothing behind it.
   */
  async state(userId: string, hostId: string, path: string): Promise<HashStateView> {
    const driver = await this.run(() => this.factory.forHost(hostId, userId));

    let realPath: string;
    let size: bigint;
    let mtimeMs: bigint;
    try {
      const validated = await this.guard.validate({ driver, userId, path, intent: "read" });
      realPath = validated.realPath;
      const stat = await this.run(() => driver.stat(realPath));
      size = BigInt(stat.size);
      mtimeMs = BigInt(Math.trunc(stat.mtimeMs));
    } finally {
      await driver.dispose().catch(() => undefined);
    }

    const row = await this.prisma.fileHashes.findUnique({
      where: { hostId_path: { hostId, path: realPath } },
    });
    const usable = row !== null && row.size === size && row.mtimeMs === mtimeMs;

    const running = this.queue.covering(userId, hostId, realPath);

    return {
      hash:
        usable && row
          ? {
              hostId,
              path: realPath,
              digest: row.digest,
              method: row.method,
              size: row.size.toString(),
              mtimeMs: row.mtimeMs.toString(),
              computedAt: row.computedAt,
            }
          : null,
      superseded: row !== null && !usable,
      running: running
        ? {
            id: running.id,
            hostId: running.hostId,
            files: running.files,
            bytesTotal: running.bytesTotal.toString(),
            queued: running.queued,
          }
        : null,
    };
  }

  /**
   * Stop one.
   *
   * A job that is not this account's is a 404 and never a 403 — the response
   * must not confirm the id exists. The queue makes that decision, because the
   * queue is the only thing that knows a job at all.
   */
  cancel(userId: string, jobId: string): { id: string; stopped: boolean } {
    const outcome = this.queue.cancel(userId, jobId);
    if (outcome === "unknown") throw new NotFoundException("No such checksum job is running.");
    return { id: jobId, stopped: true };
  }

  /**
   * Every file the selection names, with `..`-free real paths and the size and
   * mtime the cache will be keyed on.
   *
   * Deduplicated by real path: selecting a directory and one file inside it is
   * an ordinary gesture, and hashing that file twice would double its bytes in
   * the total and its progress in the feed.
   */
  private async expand(driver: HostDriver, userId: string, paths: readonly string[]): Promise<HashTarget[]> {
    const found = new Map<string, HashTarget>();

    for (const path of paths) {
      const validated = await this.guard.validate({ driver, userId, path, intent: "read" });
      const stat = await this.run(() => driver.stat(validated.realPath));

      if (stat.kind === "directory") {
        // Ceilinged at the bound, so a tree over it stops early and this
        // refuses in seconds rather than after walking the whole thing.
        const walked = await this.run(() => walkTree(driver, validated.realPath, MAX_FILES_PER_JOB));
        if (walked.exceeded) throw this.tooManyFiles();

        for (const entry of walked.details) {
          if (entry.kind !== "file") continue;
          found.set(entry.path, {
            path: entry.path,
            size: BigInt(entry.size),
            mtimeMs: BigInt(Math.trunc(entry.mtimeMs)),
          });
        }
      } else if (stat.kind === "file") {
        found.set(validated.realPath, {
          path: validated.realPath,
          size: BigInt(stat.size),
          mtimeMs: BigInt(Math.trunc(stat.mtimeMs)),
        });
      }
      // Anything else — a fifo, a socket, a device — is left out rather than
      // refused. A selection of forty files that happens to include a socket is
      // a selection of forty files.

      if (found.size > MAX_FILES_PER_JOB) throw this.tooManyFiles();
    }

    return [...found.values()];
  }

  /**
   * The refusal, with the number in it.
   *
   * "More than", not an exact count, and that is not vagueness: the walk stops
   * as soon as it passes the ceiling, which is what makes this answer arrive in
   * seconds. An exact count would mean walking a tree we have already decided
   * not to hash.
   */
  private tooManyFiles(): BadRequestException {
    return new BadRequestException(
      `This selection holds more than ${MAX_FILES_PER_JOB} files; a checksum job takes at most ` +
        `${MAX_FILES_PER_JOB}. Hash a subdirectory at a time.`,
    );
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
 * Bytes as a refusal says them: the binary unit somebody recognises, and the
 * exact figure beside it because the whole point of this message is the number.
 */
function describeBytes(bytes: bigint): string {
  const GiB = 1024n * 1024n * 1024n;
  if (bytes < GiB) return `${bytes} bytes`;
  // Through Number only for the label; the comparison that decided the refusal
  // was made in BigInt and is exact.
  return `${(Number(bytes) / Number(GiB)).toFixed(1)} GiB (${bytes} bytes)`;
}
