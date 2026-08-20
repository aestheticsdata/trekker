import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { isDriverError } from "@hosts/drivers/driver-error";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { chunkPaths, sumChunk } from "@hosts/sha256-sum";
import { type HashMethod, type HashStatus, HashEventsService } from "@hashes/hash-events.service";
import { HASH_NICE, PROGRESS_TICK_MS } from "@hashes/hash-limits";
import { isShutdown } from "@hashes/hash-signals";
import { PrismaService } from "../prisma/prisma.service";

import type { HostDriver } from "@hosts/drivers/host-driver";

/**
 * One checksum job, end to end (TRE-27).
 *
 * **It never throws.** The queue calls it and forgets it; anything that escaped
 * would be an unhandled rejection with a job stuck in the running set and a
 * slot never released.
 *
 * **Every digest is written the moment it is earned**, one row at a time, and
 * this is the decision the rest of the design follows from. A scan writes its
 * result in a single terminal transaction because a half-walked filesystem is
 * not a partial answer, it is no answer. A half-hashed selection *is* a partial
 * answer, and a perfectly good one: forty-one of a hundred files have their
 * true sha256, and the fact that the other fifty-nine were interrupted takes
 * nothing away from them. So a cancel keeps what it had, a restart keeps what
 * it had, and re-queueing the same selection reads the cache and does the
 * remaining work only.
 *
 * The consequence worth stating is the one that is not a consequence: there is
 * no partial-result problem to defend against, because a `FileHashes` row is
 * about one file and is either right or absent.
 */

/** One file the job was accepted with, as the walk described it. */
export interface HashTarget {
  path: string;
  size: bigint;
  /** What the walk saw. Written to the row so the cache can invalidate itself. */
  mtimeMs: bigint;
}

export interface HashJob {
  id: string;
  hostId: string;
  userId: string;
  targets: readonly HashTarget[];
  bytesTotal: bigint;
}

/** Live figures, held in one place so the tick has one place to read. */
interface Live {
  path: string | null;
  method: HashMethod | null;
  filesDone: number;
  filesCached: number;
  filesFailed: number;
  bytesDone: bigint;
}

@Injectable()
export class HashRunnerService {
  private readonly logger = new Logger(HashRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: HostDriverFactory,
    private readonly events: HashEventsService,
  ) {}

  async run(job: HashJob, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const live: Live = {
      path: null,
      method: null,
      filesDone: 0,
      filesCached: 0,
      filesFailed: 0,
      bytesDone: 0n,
    };

    const tick = setInterval(() => this.emit(job, "RUNNING", live, startedAt, null), PROGRESS_TICK_MS);
    tick.unref();

    let driver: HostDriver | null = null;
    let status: HashStatus = "DONE";
    let error: string | null = null;

    try {
      const outstanding = await this.uncached(job, live);

      if (outstanding.length > 0) {
        driver = await this.factory.forHost(job.hostId, job.userId);
        // The host's own `sha256sum` first, and the network only if it has
        // none: reading twenty gigabytes across a link to hash it here is
        // absurd when the machine holding it can do it in place (TRE-27 §1).
        const remaining = await this.hashOnHost(driver, job, outstanding, signal, live);
        if (remaining !== null && remaining.length > 0) {
          await this.hashByStreaming(driver, job, remaining, signal, live);
        }
      }

      if (signal.aborted) status = "CANCELLED";
    } catch (failure) {
      if (signal.aborted) {
        status = "CANCELLED";
      } else {
        status = "FAILED";
        error = describeFailure(failure);
        this.logger.warn(`Hash job ${job.id} failed: ${(failure as Error).message}`);
      }
    } finally {
      clearInterval(tick);
      await driver?.dispose().catch(() => undefined);
    }

    // A shutdown reads as a cancellation with a sentence, because that is what
    // it is from the operator's side. Nothing is left for a boot sweep: the
    // digests that were earned are in the table already, and the job itself was
    // never a row.
    if (isShutdown(signal)) {
      status = "CANCELLED";
      error = "The API stopped while this job was running.";
    }

    live.path = null;
    this.emit(job, status, live, startedAt, error);
  }

  /**
   * Drop the files the cache already answers for, and count them as done.
   *
   * The cache is keyed on (host, path) and is only usable when the size and the
   * mtime still match what was read — see `FileHashes`. A file that has changed
   * simply has no usable row and is hashed again, overwriting it.
   *
   * Counted into `filesDone` rather than reported separately as "skipped",
   * because from the asking side they are done: the digest is available. The
   * separate `filesCached` is what lets the UI say a job of four hundred files
   * finished instantly without implying it read forty gigabytes to do it.
   */
  private async uncached(job: HashJob, live: Live): Promise<HashTarget[]> {
    const rows = await this.prisma.fileHashes.findMany({
      where: { hostId: job.hostId, path: { in: job.targets.map((target) => target.path) } },
      select: { path: true, size: true, mtimeMs: true },
    });
    const cached = new Map(rows.map((row) => [row.path, row]));

    const outstanding: HashTarget[] = [];
    for (const target of job.targets) {
      const row = cached.get(target.path);
      if (row && row.size === target.size && row.mtimeMs === target.mtimeMs) {
        live.filesDone += 1;
        live.filesCached += 1;
        live.bytesDone += target.size;
        continue;
      }
      outstanding.push(target);
    }

    return outstanding;
  }

  /**
   * `sha256sum` on the host, chunk by chunk.
   *
   * Returns the targets it could not do this way — every one of them when the
   * host has no `sha256sum`, and none of them otherwise. Note what it does
   * *not* return: a file the command tried and could not read is a failure of
   * that file, not evidence that this route is unavailable, so it is counted
   * and left behind rather than handed to the fallback to fail again slowly.
   *
   * Null means the job was cancelled mid-chunk and there is nothing more to do.
   */
  private async hashOnHost(
    driver: HostDriver,
    job: HashJob,
    targets: readonly HashTarget[],
    signal: AbortSignal,
    live: Live,
  ): Promise<HashTarget[] | null> {
    const byPath = new Map(targets.map((target) => [target.path, target]));

    for (const chunk of chunkPaths(targets.map((target) => target.path))) {
      if (signal.aborted) return null;

      // The first path of the chunk, so the panel has something to name while a
      // long chunk runs. `onDigest` moves it on per file from there.
      live.path = chunk[0] ?? null;

      const done = new Set<string>();
      const outcome = await sumChunk(driver, chunk, {
        signal,
        nice: HASH_NICE,
        // The digest itself is not needed here — `sumChunk` collects it, and
        // `save` writes the map afterwards. What this is for is the counter.
        onDigest: (path) => {
          const target = byPath.get(path);
          if (!target) return;
          done.add(path);
          live.path = path;
          live.filesDone += 1;
          live.bytesDone += target.size;
        },
      });

      // No `sha256sum` on this machine. Everything still outstanding — this
      // chunk included — goes across the network instead. Detected on the first
      // chunk in practice, and handled generally anyway: a host that loses the
      // binary mid-job is not a case worth a different answer.
      if (outcome.kind === "absent") {
        this.logger.log(`Host ${job.hostId} has no sha256sum; hashing ${targets.length} file(s) through the API`);
        return targets.filter((target) => !done.has(target.path));
      }

      if (outcome.kind === "failed") {
        // The whole chunk, because there is no output to say which of them the
        // command got to. Counted rather than retried: whatever refused it will
        // refuse it again.
        live.filesFailed += chunk.length;
        continue;
      }

      live.method = "REMOTE";
      await this.save(job, chunk, outcome.digests, byPath, "REMOTE", live);
    }

    return [];
  }

  /**
   * The fallback: read the bytes here and hash them here (TRE-27 §1).
   *
   * One file at a time and one chunk at a time, hashed as it flows. The whole
   * point is that nothing is buffered — a 20 GB file that arrived as a `Buffer`
   * before being hashed would take the API down, which is the failure the
   * download route learned the hard way (TRE-68).
   */
  private async hashByStreaming(
    driver: HostDriver,
    job: HashJob,
    targets: readonly HashTarget[],
    signal: AbortSignal,
    live: Live,
  ): Promise<void> {
    live.method = "STREAMED";

    for (const target of targets) {
      if (signal.aborted) return;
      live.path = target.path;

      let digest: string;
      try {
        digest = await this.streamOne(driver, target, signal, live);
      } catch (error) {
        if (signal.aborted) return;
        // One file's problem. A selection of four hundred must not be lost to
        // the one that vanished between the walk and the read.
        live.filesFailed += 1;
        this.logger.warn(`Could not hash ${target.path}: ${(error as Error).message}`);
        continue;
      }

      await this.save(
        job,
        [target.path],
        new Map([[target.path, digest]]),
        new Map([[target.path, target]]),
        "STREAMED",
        live,
      );
      live.filesDone += 1;
    }
  }

  /**
   * One file, read in chunks and folded into a digest as it goes.
   *
   * `for await` rather than `pipeline` into the hash, and that is the
   * backpressure: the loop body is the update, so nothing reads ahead of what
   * has been hashed. It is also where the cancel is checked, which a pipeline
   * would have to be handed a signal to do.
   */
  private async streamOne(driver: HostDriver, target: HashTarget, signal: AbortSignal, live: Live): Promise<string> {
    const stream = await driver.createReadStream(target.path);
    const hash = createHash("sha256");

    try {
      for await (const chunk of stream) {
        if (signal.aborted) {
          stream.destroy();
          throw new Error("cancelled");
        }
        const buffer = chunk as Buffer;
        hash.update(buffer);
        live.bytesDone += BigInt(buffer.length);
      }
    } finally {
      // A stream abandoned mid-read holds an SFTP handle open until the
      // connection is disposed of, and a job of four hundred files would hold
      // four hundred.
      if (!stream.destroyed) stream.destroy();
    }

    return hash.digest("hex");
  }

  /**
   * Write what a call produced.
   *
   * Upsert on (host, path): a file hashed before and changed since replaces its
   * row rather than adding one, which is what keeps this table the size of the
   * filesystem instead of the size of its history.
   *
   * A path in the chunk with no line in the output is a file `sha256sum` could
   * not read — vanished, unreadable, a directory that reached the walk as a
   * file. It is counted as failed here rather than being silently absent from
   * the total.
   */
  private async save(
    job: HashJob,
    chunk: readonly string[],
    digests: ReadonlyMap<string, string>,
    targets: ReadonlyMap<string, HashTarget>,
    method: HashMethod,
    live: Live,
  ): Promise<void> {
    for (const path of chunk) {
      const digest = digests.get(path);
      const target = targets.get(path);
      if (digest === undefined || target === undefined) {
        if (digest === undefined) live.filesFailed += 1;
        continue;
      }

      const row = {
        digest,
        size: target.size,
        mtimeMs: target.mtimeMs,
        method,
        computedAt: new Date(),
      };

      try {
        await this.prisma.fileHashes.upsert({
          where: { hostId_path: { hostId: job.hostId, path } },
          create: { hostId: job.hostId, path, ...row },
          update: row,
        });
      } catch (error) {
        // The digest is correct and the database would not take it. Worth a
        // line in the log and nothing else: the answer is still on the feed,
        // and failing the whole job over a cache write would be the wrong
        // trade for something whose entire purpose is to avoid work later.
        this.logger.warn(`Could not cache the hash of ${path}: ${(error as Error).message}`);
      }
    }
  }

  private emit(job: HashJob, status: HashStatus, live: Live, startedAt: number, error: string | null): void {
    this.events.emit(job.userId, {
      id: job.id,
      hostId: job.hostId,
      status,
      path: live.path,
      method: live.method,
      files: job.targets.length,
      filesDone: live.filesDone,
      filesCached: live.filesCached,
      filesFailed: live.filesFailed,
      bytesTotal: job.bytesTotal.toString(),
      bytesDone: live.bytesDone.toString(),
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      error,
    });
  }
}

/**
 * Fixed English chosen from the error's class. The remote message is never
 * repeated: it is another machine's text, it can carry a path the reader has no
 * business seeing, and it is not written for them.
 */
function describeFailure(error: unknown): string {
  if (isDriverError(error)) {
    switch (error.code) {
      case "EACCES":
      case "EPERM":
        return "Permission denied on the host.";
      case "ENOENT":
        return "The path is gone.";
      case "EUNREACHABLE":
        return "The connection to the host dropped while the job was running.";
      case "EAUTH":
        return "The host refused the stored credential.";
      case "EHOSTKEY":
        return "The host key does not match the pinned one.";
      case "ETIMEDOUT":
        return "The host stopped responding.";
      default:
        return `The host refused with ${error.code}.`;
    }
  }
  return "The checksums could not be computed.";
}
