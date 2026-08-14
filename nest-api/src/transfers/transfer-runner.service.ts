import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Injectable, Logger } from "@nestjs/common";
import { AuditService } from "@audit/audit.service";
import { isDriverError } from "@hosts/drivers/driver-error";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { mountPointFor, readFreeBytes, readMountPoints } from "@fs/mount-table";
import { partialName } from "@fs/upload-name";
import {
  basename,
  creationOrder,
  joinPath,
  landingFor,
  MAX_KEEP_BOTH_ATTEMPTS,
  numberedName,
  type PlannedItem,
  readLandingNames,
  settlementOrder,
} from "@transfers/transfer-plan";
import { TransferEventsService } from "@transfers/transfer-events.service";
import { isShutdown } from "@transfers/transfer-signals";
import { PrismaService } from "../prisma/prisma.service";

import type { HostDriver } from "@hosts/drivers/host-driver";
import type { Writable } from "node:stream";

/**
 * The part that moves bytes (TRE-23 §3, §4, §5).
 *
 * Everything difficult about a transfer is arranged around three sentences:
 *
 * **Nothing partial is ever called the real name.** Each file is written under a
 * hidden `.part` in the destination directory and renamed into place when the
 * stream has ended cleanly. A kill mid-copy leaves litter, never a truncated
 * file under the name somebody is about to open — which is what makes the
 * restart in `TransferQueueService` safe to do at all.
 *
 * **A move never deletes before the destination is verified.** Not "after the
 * copy returned", which is a promise about control flow: the destination is
 * statted and its size compared before the source is unlinked, and a mismatch
 * leaves the source exactly where it was. This is the paragraph the ticket
 * exists to enforce and the one the tests deliberately break the write to check.
 *
 * **A failure is per item.** One unreadable file among a thousand records its
 * own reason and the other nine hundred and ninety-nine still move. The two
 * exceptions are cancellation and a full destination, where continuing is not
 * resilience, it is nine hundred more failures.
 */

/** How often progress is written down and pushed out. */
const TICK_MS = 700;

/** Bytes moved between cancellation checks — about a second of a fast link. */
const CHUNK_CHECKS = 64 * 1024;

export function bandwidthLimit(): number | null {
  const override = Number.parseInt(process.env.TREKKER_TRANSFER_MAX_BYTES_PER_SEC ?? "", 10);
  return Number.isNaN(override) || override < 1 ? null : override;
}

/** Raised to end the whole job rather than the item that met it. */
class JobRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JobRefused";
  }
}

interface ItemRow {
  id: string;
  name: string;
  kind: string;
  bytes: bigint;
  mode: number | null;
  mtimeMs: bigint | null;
  conflict: string;
  status: string;
}

@Injectable()
export class TransferRunnerService {
  private readonly logger = new Logger(TransferRunnerService.name);

  /**
   * The last progress tick per running job, so the rate the UI shows is
   * measured rather than guessed. Cleared when the job stops — a map that only
   * ever grows is a leak with a very slow fuse.
   */
  private readonly marks = new Map<string, { at: number; bytes: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly events: TransferEventsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One job, start to finish. Never throws: a job that fails is a job with a
   * `FAILED` row and an explanation, and the queue behind this has another one
   * waiting.
   */
  async run(jobId: string, signal: AbortSignal): Promise<void> {
    const job = await this.prisma.transferJobs.findUnique({ where: { id: jobId }, include: { items: true } });
    if (!job) return;
    if (!job.srcHostId || !job.dstHostId) {
      await this.fail(jobId, job.userId, "A host this transfer used has been deleted.");
      return;
    }

    // Written before the first byte and settled at the end, which is the same
    // shape `LinkService` uses for work that outlives its request. The route
    // that queued this job wrote its own row; this one records the outcome,
    // minutes later, with the bytes that actually moved.
    const rowId = await this.audit
      .open({
        userId: job.userId,
        hostId: job.dstHostId,
        kind: "transfer.run",
        summary: `${job.operation.toLowerCase()} ${job.itemsTotal} entries into ${job.dstPath}`,
        tag: `${job.itemsTotal} entries`,
        destructive: true,
        payload: { jobId, srcPath: job.srcPath, dstPath: job.dstPath, operation: job.operation },
      })
      .catch(() => null);
    const startedAt = Date.now();

    await this.prisma.transferJobs.update({
      where: { id: jobId },
      data: { status: "RUNNING", startedAt: job.startedAt ?? new Date(), error: null },
    });

    // Counted from the items rather than carried over from the job's own
    // columns, and the difference only shows up on a run that is not the first.
    // A reclaimed job re-runs its interrupted item *from the top* — the `.part`
    // it left is discarded, not resumed — so the bytes the crashed run had
    // counted for it are about to be moved again. Trusting the stored counter
    // adds them twice: a 755 MB transfer killed and restarted finished at
    // 819 MB, which is not a rounding error, it is a total that describes
    // nothing. The items are the record of what actually landed.
    const state = {
      bytesDone: job.items.reduce((total, item) => (item.status === "DONE" ? total + Number(item.bytes) : total), 0),
      itemsDone: job.items.filter((item) => item.status === "DONE" || item.status === "SKIPPED").length,
      failed: 0,
    };
    let outcome: "DONE" | "FAILED" | "CANCELLED" = "DONE";
    let failure: string | null = null;

    try {
      await this.execute(job, state, signal);
    } catch (error) {
      // A shutdown is not an outcome. The row stays `RUNNING` on purpose, which
      // is the state `TransferQueueService.onApplicationBootstrap` looks for —
      // see transfer-signals.ts. Everything already written is already durable:
      // the items that finished are `DONE`, and the one that was in flight left
      // a `.part` rather than a truncated file under a real name.
      if (isShutdown(signal)) {
        await this.prisma.transferJobs
          .update({ where: { id: jobId }, data: { bytesDone: BigInt(state.bytesDone), itemsDone: state.itemsDone } })
          .catch(() => undefined);
        return;
      }

      if (signal.aborted) {
        outcome = "CANCELLED";
        failure = "Cancelled.";
      } else if (error instanceof JobRefused) {
        outcome = "FAILED";
        failure = error.message;
      } else {
        outcome = "FAILED";
        failure = isDriverError(error) ? error.message : "The transfer did not complete.";
        this.logger.warn(`Transfer ${jobId} failed: ${(error as Error).message}`);
      }
    }

    const [failed, moved] = await Promise.all([
      this.prisma.transferItems.count({ where: { jobId, status: "FAILED" } }),
      this.prisma.transferItems.count({ where: { jobId, status: "DONE" } }),
    ]);
    state.failed = failed;

    // A job whose items all ran but some of which failed is not a successful
    // job. Saying DONE over nine hundred moved files and one that did not is
    // how a transfer quietly loses something.
    if (outcome === "DONE" && failed > 0) {
      outcome = "FAILED";
      failure = `${failed} ${failed === 1 ? "entry" : "entries"} could not be transferred.`;
    }

    await this.prisma.transferJobs.update({
      where: { id: jobId },
      data: {
        status: outcome,
        finishedAt: new Date(),
        bytesDone: BigInt(state.bytesDone),
        itemsDone: state.itemsDone,
        error: failure,
      },
    });

    if (rowId !== null) {
      await this.audit.settle(
        rowId,
        outcome === "DONE" ? "success" : outcome === "CANCELLED" ? "refused" : "failure",
        Date.now() - startedAt,
        {
          bytes: state.bytesDone,
          // The count of entries that actually landed, not the count of entries
          // the runner got round to. They differ by exactly the failures, and
          // that difference is the whole reason to read this row.
          summary: `${job.operation.toLowerCase()} ${moved} of ${job.itemsTotal} into ${job.dstPath}`,
          tag: `${moved} entries`,
          payload: { jobId, moved, failed, processed: state.itemsDone, outcome },
        },
        failure ?? undefined,
      );
    }

    this.publish(job.userId, jobId, outcome, job, state, failure);
  }

  // ---------------------------------------------------------------- execution

  private async execute(
    job: {
      id: string;
      userId: string;
      srcHostId: string | null;
      dstHostId: string | null;
      srcPath: string;
      dstPath: string;
      operation: string;
      options: unknown;
      bytesTotal: bigint;
      itemsTotal: number;
      items: ItemRow[];
    },
    state: { bytesDone: number; itemsDone: number; failed: number },
    signal: AbortSignal,
  ): Promise<void> {
    const srcDriver = await this.factory.forHost(job.srcHostId as string, job.userId);
    const dstDriver = await this.factory.forHost(job.dstHostId as string, job.userId);

    // Validated again, now, rather than trusted from the plan. Minutes may have
    // passed and the roots are editable: a job queued against a WRITE root that
    // has since been narrowed must refuse here, not run on the strength of a
    // check made when it was queued.
    const source = await this.guard.validate({
      driver: srcDriver,
      userId: job.userId,
      path: job.srcPath,
      intent: "read",
    });
    const destination = await this.guard.validate({
      driver: dstDriver,
      userId: job.userId,
      path: job.dstPath,
      intent: "write",
    });

    const items = job.items.filter((item) => item.status !== "DONE" && item.status !== "SKIPPED");
    const planned = items.map(toPlanned);
    const byName = new Map(planned.map((item, index) => [item.name, items[index]]));

    /**
     * Where an item lands, which is where it came from unless the job was
     * queued as a duplicate (TRE-69 §2). Every destination path below goes
     * through this and every *source* path deliberately does not: an item's
     * name is what it is called at the source, and only the arrival changes.
     */
    const landing = readLandingNames(job.options);
    const land = (name: string): string => landingFor(name, landing);

    if (
      job.operation === "MOVE" &&
      job.srcHostId === job.dstHostId &&
      // A duplicate is a copy, so this branch is never reached with a landing
      // map — stated rather than assumed, because the fast path renames each
      // top-level entry by the name it already has.
      Object.keys(landing).length === 0 &&
      (await this.renameInPlace(dstDriver, source.realPath, destination.realPath, planned, items, state))
    ) {
      return;
    }

    const ticker = setInterval(() => {
      void this.flush(job, state);
    }, TICK_MS);
    // Nothing should keep the process alive for a progress timer.
    ticker.unref();

    try {
      // Directories first and shallowest first, so a file never arrives before
      // the directory holding it. Their modes and times are stamped at the end
      // — writing a file into a directory changes that directory's mtime, so
      // stamping on the way down would be undone on the way back up.
      for (const item of creationOrder(planned)) {
        this.checkCancelled(signal);
        await this.settleItem(byName.get(item.name) as ItemRow, () =>
          dstDriver.mkdir(joinPath(destination.realPath, land(item.name)), { recursive: true }),
        );
        state.itemsDone += 1;
      }

      for (const item of planned) {
        if (item.kind === "directory") continue;
        this.checkCancelled(signal);

        await this.copyOne(
          srcDriver,
          dstDriver,
          source.realPath,
          destination.realPath,
          item,
          land(item.name),
          byName.get(item.name) as ItemRow,
          state,
          signal,
        );
        state.itemsDone += 1;
      }

      for (const item of settlementOrder(planned)) {
        this.checkCancelled(signal);
        await this.stamp(dstDriver, joinPath(destination.realPath, land(item.name)), item);
      }

      if (job.operation === "MOVE") {
        await this.removeSources(srcDriver, dstDriver, source.realPath, destination.realPath, job.id, land, signal);
      }
    } finally {
      clearInterval(ticker);
      await this.flush(job, state);
    }
  }

  /**
   * The move that is not a copy at all (TRE-23 §4).
   *
   * Same host, same filesystem, nothing in the way: `rename` moves the whole
   * tree by rewriting one directory entry, in microseconds, with no bytes
   * crossing anything. A gigabyte directory moved between two folders on one
   * disk should not take a minute, and through the general path it would.
   *
   * Three conditions, and each one is load-bearing:
   *
   * **Same filesystem**, or `rename` fails with EXDEV — the mount table is read
   * to find out rather than the failure being caught, because a failed rename
   * on some systems is not free and the answer is one command for the whole job.
   *
   * **No conflicts anywhere.** `rename` over an existing file replaces it
   * silently and over an existing directory fails; neither is a conflict answer
   * anybody gave. A job with one conflicting item takes the general path
   * entirely, which is slower and correct.
   *
   * **Nothing already done**, which a retry or a reclaimed job may have. Those
   * have a half-built destination tree and renaming onto it would be exactly
   * the conflict case above.
   *
   * Returns false when any of those does not hold, and the caller carries on.
   */
  private async renameInPlace(
    driver: HostDriver,
    sourceRoot: string,
    destinationRoot: string,
    planned: readonly PlannedItem[],
    rows: readonly ItemRow[],
    state: { bytesDone: number; itemsDone: number },
  ): Promise<boolean> {
    if (planned.length === 0 || planned.some((item) => item.conflict)) return false;
    if (rows.length !== planned.length) return false;

    const mounts = await readMountPoints(driver);
    if (mounts === null) return false;
    if (mountPointFor(sourceRoot, mounts) !== mountPointFor(destinationRoot, mounts)) return false;

    // The entries the operator actually selected. Everything under them travels
    // with the directory entry that names them.
    const tops = planned.filter((item) => !item.name.includes("/"));
    const under = new Map<string, ItemRow[]>(tops.map((item) => [item.name, []]));
    for (const [index, item] of planned.entries()) {
      const top = item.name.split("/")[0];
      under.get(top)?.push(rows[index]);
    }

    for (const top of tops) {
      try {
        await driver.rename(joinPath(sourceRoot, top.name), joinPath(destinationRoot, top.name));
      } catch (error) {
        // Half of the selection may already have moved. That is a correct
        // partial move — those entries really are at the destination — so the
        // ones that made it keep their `DONE` and this one records why it did
        // not, rather than the whole job pretending nothing happened.
        for (const row of under.get(top.name) ?? []) {
          await this.markFailed(row, describeFailure(error));
        }
        continue;
      }

      for (const row of under.get(top.name) ?? []) {
        await this.prisma.transferItems.update({ where: { id: row.id }, data: { status: "DONE", error: null } });
        state.itemsDone += 1;
        state.bytesDone += Number(row.bytes);
      }
    }

    return true;
  }

  /**
   * One file, source socket to destination socket, never through memory.
   *
   * The name is settled as late as possible — after the bytes are down, before
   * the rename — for the reason `UploadService` settles its own late: a
   * `keepBoth` that picked its number before the transfer would be answering a
   * question about a directory as it was several minutes ago.
   *
   * `state.bytesDone` is advanced **per chunk rather than per file**, which
   * matters more than it sounds: a job that is one 4 GB file would otherwise
   * sit at 0% for its whole life and jump to 100% at the end, and a progress
   * bar that only moves when there is nothing left to wait for is not one. The
   * counter is a field on an object the caller owns precisely so the tick that
   * writes it down can read it mid-file. A failed item gives its bytes back —
   * they did not land, and the `.part` they were in is already gone.
   */
  private async copyOne(
    srcDriver: HostDriver,
    dstDriver: HostDriver,
    sourceRoot: string,
    destinationRoot: string,
    item: PlannedItem,
    /** The item's name at the destination — its own, unless this is a duplicate. */
    landed: string,
    row: ItemRow,
    state: { bytesDone: number },
    signal: AbortSignal,
  ): Promise<void> {
    const from = joinPath(sourceRoot, item.name);
    const directory = joinPath(destinationRoot, parentOfName(landed));
    const name = basename(landed);
    const partial = joinPath(directory, partialName(randomBytes(9).toString("hex")));

    let target: Writable | null = null;
    let moved = 0;

    try {
      // The decision, applied now that the destination is the destination it
      // will actually be. `ASK` here means the plan found nothing in the way;
      // finding something anyway means the destination changed underneath, and
      // the ticket's answer to that is to skip it and say so rather than guess.
      const final = await this.settleName(dstDriver, directory, name, row.conflict);
      if (final === null) {
        await this.markSkipped(
          row,
          row.conflict === "ASK" ? "changed at the destination after planning" : "already there",
        );
        return;
      }

      const limit = bandwidthLimit();
      const source = await srcDriver.createReadStream(from);
      target = await dstDriver.createWriteStream(partial);

      let sinceCheck = 0;
      let windowStart = Date.now();
      let windowBytes = 0;

      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            moved += chunk.length;
            state.bytesDone += chunk.length;
            sinceCheck += chunk.length;
            if (sinceCheck >= CHUNK_CHECKS) {
              sinceCheck = 0;
              if (signal.aborted) throw new Error("cancelled");
            }

            if (limit !== null) {
              windowBytes += chunk.length;
              const elapsed = Date.now() - windowStart;
              const owed = (windowBytes / limit) * 1000 - elapsed;
              if (owed > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(owed, 1000)));
              if (elapsed >= 1000) {
                windowStart = Date.now();
                windowBytes = 0;
              }
            }

            yield chunk;
          }
        },
        target,
        { signal },
      );

      await dstDriver.rename(partial, final);
      await this.stamp(dstDriver, final, item);

      await this.prisma.transferItems.update({
        where: { id: row.id },
        data: {
          status: "DONE",
          error: null,
          finalName: basename(final) === name ? null : basename(final),
        },
      });
      return;
    } catch (error) {
      // Handed back before anything else: whatever this item counted is not at
      // the destination, and a total that kept it would drift upwards by the
      // size of every failure until the bar passed 100%.
      state.bytesDone -= moved;
      await discard(dstDriver, target, partial);
      if (signal.aborted) throw error;

      // A write that fails on a destination with nothing left is not this
      // file's problem, it is the job's. Asked only here, on the failure path,
      // because SFTP has no ENOSPC on the wire — a full remote disk arrives as
      // a generic failure and this one round trip is what tells them apart.
      if (isDriverError(error) && error.code === "ENOSPC") {
        throw new JobRefused("ENOSPC", "No space left at the destination.");
      }
      if (isDriverError(error) && error.code === "EIO") {
        const free = await readFreeBytes(dstDriver, directory);
        if (free !== null && free < item.bytes) {
          throw new JobRefused("ENOSPC", `No space left at the destination — ${item.name} needs more than is free.`);
        }
      }

      await this.markFailed(row, describeFailure(error));
    }
  }

  /**
   * The name this item will actually take, or null for "do not write it".
   *
   * `OVERWRITE` returns the path as it is: the copy lands on a `.part` and the
   * rename replaces the old file in one step, so a reader sees the old file or
   * the new one and never a half of either. That is the whole reason the
   * temporary name is in the destination directory rather than in /tmp.
   */
  private async settleName(
    driver: HostDriver,
    directory: string,
    name: string,
    decision: string,
  ): Promise<string | null> {
    const path = joinPath(directory, name);
    const present = await exists(driver, path);

    if (!present) return path;
    if (decision === "OVERWRITE") return path;
    if (decision === "SKIP") return null;
    // Undecided and something is there: the destination changed after planning.
    if (decision === "ASK") return null;

    for (let attempt = 2; attempt < MAX_KEEP_BOTH_ATTEMPTS; attempt += 1) {
      const candidate = joinPath(directory, numberedName(name, attempt));
      if (!(await exists(driver, candidate))) return candidate;
    }
    return null;
  }

  /**
   * Mode and mtime, from the walk that planned the item.
   *
   * Never fatal. A destination filesystem that will not take a timestamp — a
   * FAT-formatted USB disk, a read-only-ish mount — has still received the
   * bytes, and failing an item that arrived intact because its clock could not
   * be set would be reporting the wrong thing entirely.
   */
  private async stamp(driver: HostDriver, path: string, item: PlannedItem): Promise<void> {
    if (item.mode !== null) {
      await driver.chmod(path, item.mode).catch(() => undefined);
    }
    if (item.mtimeMs !== null) {
      await driver.utimes(path, item.mtimeMs, item.mtimeMs).catch(() => undefined);
    }
  }

  /**
   * A move's second half (TRE-23 §4).
   *
   * Post-order, and only for items that reached `DONE`. Each file is verified at
   * the destination — statted, and its size compared — before its source is
   * unlinked. That is what "never delete the source before the destination is
   * verified" has to mean to be worth anything: a copy that returned without
   * throwing is a claim about this process, and a file that is there and the
   * right length is a claim about the other machine.
   *
   * A directory whose child failed is left standing, because its `rmdir` fails
   * — which is the truth, and better than a check that would say the same thing
   * one round trip earlier.
   */
  private async removeSources(
    srcDriver: HostDriver,
    dstDriver: HostDriver,
    sourceRoot: string,
    destinationRoot: string,
    jobId: string,
    /** Where each item landed, for the verification below. Identity for a move. */
    land: (name: string) => string,
    signal: AbortSignal,
  ): Promise<void> {
    const done = await this.prisma.transferItems.findMany({
      where: { jobId, status: "DONE" },
      select: { id: true, name: true, kind: true, bytes: true, finalName: true },
    });

    // Deepest first, so a directory is only reached once its contents are gone.
    const ordered = [...done].sort((left, right) => right.name.split("/").length - left.name.split("/").length);

    for (const item of ordered) {
      this.checkCancelled(signal);
      const from = joinPath(sourceRoot, item.name);

      try {
        if (item.kind === "directory") {
          await srcDriver.rmdir(from);
          continue;
        }

        const landed = land(item.name);
        const landedAs = item.finalName ?? basename(landed);
        const to = joinPath(joinPath(destinationRoot, parentOfName(landed)), landedAs);
        const there = await dstDriver.stat(to).catch(() => null);

        if (there === null || there.size !== Number(item.bytes)) {
          await this.prisma.transferItems.update({
            where: { id: item.id },
            data: {
              status: "FAILED",
              error: "The copy could not be verified at the destination, so the source was left alone.",
            },
          });
          continue;
        }

        await srcDriver.unlink(from);
      } catch (error) {
        await this.prisma.transferItems.update({
          where: { id: item.id },
          data: { status: "FAILED", error: `Copied, but the source could not be removed: ${describeFailure(error)}` },
        });
      }
    }
  }

  // ---------------------------------------------------------------- plumbing

  private checkCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("cancelled");
  }

  private async settleItem(row: ItemRow, work: () => Promise<void>): Promise<void> {
    try {
      await work();
      await this.prisma.transferItems.update({ where: { id: row.id }, data: { status: "DONE", error: null } });
    } catch (error) {
      await this.markFailed(row, describeFailure(error));
    }
  }

  private async markFailed(row: ItemRow, message: string): Promise<void> {
    await this.prisma.transferItems.update({ where: { id: row.id }, data: { status: "FAILED", error: message } });
  }

  private async markSkipped(row: ItemRow, reason: string): Promise<void> {
    await this.prisma.transferItems.update({ where: { id: row.id }, data: { status: "SKIPPED", error: reason } });
  }

  /** Counters to the database and to whoever is watching, on the tick. */
  private async flush(
    job: { id: string; userId: string; bytesTotal: bigint; itemsTotal: number },
    state: { bytesDone: number; itemsDone: number; failed: number },
  ): Promise<void> {
    await this.prisma.transferJobs
      .update({
        where: { id: job.id },
        data: { bytesDone: BigInt(state.bytesDone), itemsDone: state.itemsDone },
      })
      .catch(() => undefined);

    this.publish(job.userId, job.id, "RUNNING", job, state, null);
  }

  private publish(
    userId: string,
    jobId: string,
    status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED",
    job: { bytesTotal: bigint; itemsTotal: number },
    state: { bytesDone: number; itemsDone: number; failed: number },
    error: string | null,
  ): void {
    const previous = this.marks.get(jobId);
    const now = Date.now();
    const rate =
      previous && now > previous.at
        ? Math.round(((state.bytesDone - previous.bytes) * 1000) / (now - previous.at))
        : null;
    this.marks.set(jobId, { at: now, bytes: state.bytesDone });
    if (status !== "RUNNING") this.marks.delete(jobId);

    const remaining = Number(job.bytesTotal) - state.bytesDone;
    this.events.emit(userId, {
      id: jobId,
      status,
      bytesTotal: Number(job.bytesTotal),
      bytesDone: state.bytesDone,
      itemsTotal: job.itemsTotal,
      itemsDone: state.itemsDone,
      rate,
      etaSeconds: rate !== null && rate > 0 && remaining > 0 ? Math.round(remaining / rate) : null,
      error,
      failed: state.failed,
    });
  }

  private async fail(jobId: string, userId: string, message: string): Promise<void> {
    await this.prisma.transferJobs.update({
      where: { id: jobId },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    });
    this.events.emit(userId, {
      id: jobId,
      status: "FAILED",
      bytesTotal: 0,
      bytesDone: 0,
      itemsTotal: 0,
      itemsDone: 0,
      rate: null,
      etaSeconds: null,
      error: message,
      failed: 0,
    });
  }
}

function toPlanned(row: ItemRow): PlannedItem {
  const size = Number(row.bytes);
  const mtimeMs = row.mtimeMs === null ? null : Number(row.mtimeMs);
  return {
    name: row.name,
    kind: row.kind,
    bytes: size,
    mode: row.mode,
    mtimeMs,
    source: { size, mtimeMs: mtimeMs ?? 0 },
    target: null,
    conflict: row.conflict !== "ASK",
    note: "",
  };
}

/** The directory part of a relative name; "" when the item is at the top. */
function parentOfName(name: string): string {
  const cut = name.lastIndexOf("/");
  return cut === -1 ? "" : name.slice(0, cut);
}

async function exists(driver: HostDriver, path: string): Promise<boolean> {
  return driver.stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Remove the partial, after making sure nothing is still going to write it.
 *
 * The same wait `UploadService.discard` makes, for the same reason and against
 * the same bug: `createWriteStream` opens lazily, so destroying a stream whose
 * `open(O_CREAT)` is still in flight lets that open land *after* the unlink and
 * recreate the file. One empty `.part` per failed item, in every directory a
 * transfer touched.
 */
async function discard(driver: HostDriver, target: Writable | null, path: string): Promise<void> {
  if (target !== null && !target.closed) {
    target.destroy();
    await new Promise<void>((resolve) => {
      target.once("close", resolve);
      target.once("error", () => resolve());
    });
  }
  await driver.unlink(path).catch(() => undefined);
}

function describeFailure(error: unknown): string {
  if (isDriverError(error)) {
    switch (error.code) {
      case "EACCES":
      case "EPERM":
        return "Permission denied on the host.";
      case "ENOENT":
        return "No longer there.";
      case "ENOTEMPTY":
        return "Directory was not empty — something under it could not be moved.";
      case "ENOSPC":
        return "No space left at the destination.";
      default:
        return `The host refused with ${error.code}.`;
    }
  }
  return "The host refused.";
}
