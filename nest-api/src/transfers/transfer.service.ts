import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { isDriverError } from "@hosts/drivers/driver-error";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { toHttp } from "@fs/driver-http";
import { readFreeBytes } from "@fs/mount-table";
import { entryCeiling } from "@fs/permissions.service";
import { walkTree } from "@fs/tree-walk";
import {
  basename,
  commonParent,
  CONFLICT_STRATEGIES,
  type ConflictStrategy,
  decisionFor,
  destinationInsideSource,
  type EntryFacts,
  freeName,
  itemFrom,
  joinPath,
  type LandingNames,
  landingFor,
  MAX_KEEP_BOTH_ATTEMPTS,
  type PlannedItem,
  type TransferOperation,
  undecided,
} from "@transfers/transfer-plan";
import { TransferQueueService } from "@transfers/transfer-queue.service";
import { PrismaService } from "../prisma/prisma.service";

import type { FileEntry, HostDriver } from "@hosts/drivers/host-driver";

/**
 * Deciding a transfer, and owning the jobs that come out of it (TRE-23).
 *
 * The division of labour with `TransferRunnerService` is the same one
 * `DeleteService` draws between planning and removing, and for the same reason:
 * everything that can refuse must refuse before anything moves. A destination
 * outside the roots, a selection that is too large, a disk with no room, a
 * conflict nobody answered — all of them are decided here, synchronously, in
 * the request that asked. Past this file a job is a thing that runs, and the
 * only questions left are about individual files.
 */

/** How many item rows go into one INSERT. Ten thousand in one statement is not a query. */
const ITEM_BATCH = 500;

/** Jobs the queue widget is shown on a cold load. Older ones are in the activity log. */
const RECENT_JOBS = 30;

export interface TransferPlan {
  operation: TransferOperation;
  sameHost: boolean;
  source: { hostId: string; path: string };
  destination: { hostId: string; path: string; freeBytes: number | null };
  items: PlannedItem[];
  /** Bytes that will cross the wire — files only, directories contribute none. */
  bytes: number;
  files: number;
  directories: number;
  conflicts: number;
  /**
   * Symlinks under the selection, which are counted and not copied. There is no
   * `symlink` on the driver interface and TRE-23 does not ask for one; the walk
   * has always refused to descend through a link, and copying one without
   * descending would mean writing a link whose target this application never
   * validated. Named here so a short total is explained rather than noticed.
   */
  skippedLinks: number;
  /** True when the selection is larger than the walk's ceiling; nothing may be queued. */
  truncated: boolean;
  ceiling: number;
  /**
   * What each selected entry is called on arrival (TRE-69 §2). Empty unless the
   * request asked to duplicate, in which case every entry lands under a free
   * name and the plan says which — so a modal, or a toast, can name it before
   * the job runs.
   */
  landAs: LandingNames;
}

export interface TransferView {
  id: string;
  operation: TransferOperation;
  status: string;
  srcHostId: string | null;
  srcPath: string;
  dstHostId: string | null;
  dstPath: string;
  bytesTotal: number;
  bytesDone: number;
  itemsTotal: number;
  itemsDone: number;
  failed: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly queue: TransferQueueService,
  ) {}

  // ------------------------------------------------------------------- plan

  /**
   * What this transfer would do, walked on both sides rather than estimated.
   *
   * Read-only and validated as the transfer itself is: the source for read, the
   * destination for write. Asking as two reads would show a plan for something
   * the transfer would refuse, and a modal full of decisions about an operation
   * that cannot happen is worse than the refusal.
   */
  async plan(userId: string, input: PlanInput): Promise<TransferPlan> {
    const { srcDriver, dstDriver, sourceRoot, destination, sameHost } = await this.endpoints(userId, input);
    const ceiling = entryCeiling();

    const items: PlannedItem[] = [];
    let truncated = false;
    let skippedLinks = 0;

    const landAs = await this.landingNames(userId, srcDriver, dstDriver, destination, input);
    // Keyed by where each item will *land*, which for an ordinary transfer is
    // where it is called now. A duplicate asks about `logs (2)/app.log`, and
    // asking about `logs/app.log` instead would report a conflict with the file
    // it is being copied from.
    const targets = await this.destinationFacts(
      dstDriver,
      destination,
      input.srcPaths.map((path) => landingFor(basename(path), landAs)),
      ceiling,
    );

    for (const path of input.srcPaths) {
      const validated = await this.guard.validate({ driver: srcDriver, userId, path, intent: "read" });
      const top = basename(validated.realPath);

      const walked = await this.run(() => walkTree(srcDriver, validated.realPath, ceiling));
      if (walked.exceeded) {
        truncated = true;
        break;
      }
      skippedLinks += walked.skippedLinks;

      for (const entry of walked.details) {
        // The walk hands back absolute paths on the source; the item's name is
        // relative to the *selection*, so `top` is re-attached rather than the
        // source root being stripped — the two agree, and this way round works
        // for the root entry itself, whose relative path is the empty string.
        const suffix = entry.path.slice(validated.realPath.length).replace(/^\//, "");
        const name = suffix === "" ? top : `${top}/${suffix}`;
        items.push(itemFrom(entry, name, targets.get(landingFor(name, landAs)) ?? null));
      }
    }

    const files = items.filter((item) => item.kind !== "directory").length;

    return {
      operation: input.operation,
      sameHost,
      source: { hostId: input.srcHostId, path: sourceRoot },
      destination: {
        hostId: input.dstHostId,
        path: destination,
        freeBytes: await readFreeBytes(dstDriver, destination),
      },
      items,
      bytes: items.reduce((total, item) => total + item.bytes, 0),
      files,
      directories: items.length - files,
      conflicts: items.filter((item) => item.conflict).length,
      skippedLinks,
      truncated,
      ceiling,
      landAs,
    };
  }

  /**
   * What each selected entry will be called at the destination (TRE-69 §2).
   *
   * Empty — and free — for every transfer that did not ask to duplicate, which
   * is the shape this has to have: `landingFor` is then the identity function
   * and nothing about an ordinary copy changes.
   *
   * The names are chosen against one listing of the destination, and each one
   * is added to the set as it is taken, so two entries duplicated in the same
   * request cannot both be handed `report (2).txt`. They are chosen *early*,
   * before the walk, because everything underneath a renamed directory is
   * named relative to it — the decision has to be made once, at the top, or it
   * cannot be made at all.
   *
   * Racy against another writer, unavoidably, and the runner is what makes that
   * safe rather than this: a file whose landing name has been taken by the time
   * the bytes arrive meets `settleName` and its conflict decision, exactly as
   * any other item does.
   */
  private async landingNames(
    userId: string,
    srcDriver: HostDriver,
    dstDriver: HostDriver,
    destination: string,
    input: PlanInput,
  ): Promise<LandingNames> {
    if (input.duplicate !== true) return {};
    if (input.operation !== "copy") {
      throw new BadRequestException("A duplicate is a copy. Moving an entry beside itself is a rename.");
    }

    const taken = new Set((await dstDriver.list(destination).catch((): FileEntry[] => [])).map((entry) => entry.name));
    const landing: LandingNames = {};

    for (const path of input.srcPaths) {
      // Resolved, not taken from the request: the walk below names its items
      // after `basename(realPath)`, and a map keyed any other way would simply
      // never match. A selected symlink resolves to its target, which is the
      // entry that actually gets copied.
      const validated = await this.guard.validate({ driver: srcDriver, userId, path, intent: "read" });
      const top = basename(validated.realPath);

      const free = freeName(top, taken);
      if (free === null) {
        throw new BadRequestException(
          `There are already ${MAX_KEEP_BOTH_ATTEMPTS} copies of ${top} in this directory.`,
        );
      }
      taken.add(free);
      landing[top] = free;
    }

    return landing;
  }

  // ----------------------------------------------------------------- create

  /**
   * Queue one, with the conflicts already answered.
   *
   * The walk is done again rather than carried from the plan, exactly as
   * `DeleteService.remove` re-walks: minutes may have passed, and the tree that
   * is transferred should be the tree that is there. What the client sends back
   * is the *policy* — a strategy and a set of overrides — which survives a tree
   * that changed in a way a list of per-item decisions would not.
   */
  async create(userId: string, input: CreateInput): Promise<TransferView> {
    for (const [name, choice] of Object.entries(input.overrides ?? {})) {
      if (!CONFLICT_STRATEGIES.includes(choice)) {
        throw new BadRequestException(`"${choice}" is not a conflict answer (for ${name}).`);
      }
    }

    const plan = await this.plan(userId, input);

    if (plan.truncated) {
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          code: "ETOOMANY",
          message: `This selection holds more than ${plan.ceiling.toLocaleString("en-GB")} entries. Narrow it, or raise the ceiling on the server.`,
          ceiling: plan.ceiling,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (plan.items.length === 0) {
      throw new BadRequestException("There is nothing to transfer.");
    }

    const decisions = plan.items.map((item) =>
      decisionFor(input.strategy, input.overrides?.[item.name], item.conflict),
    );

    const unanswered = undecided(plan.items, decisions);
    if (unanswered.length > 0) {
      // Refused rather than started and stalled. A job that pauses for an answer
      // is a job sitting half-done in a tab nobody has open, and every decision
      // it would wait for is one the modal was already showing.
      throw new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          code: "ECONFLICT",
          message: `${unanswered.length} ${unanswered.length === 1 ? "entry is" : "entries are"} already at the destination and no answer was given for ${unanswered.length === 1 ? "it" : "them"}.`,
          names: unanswered.slice(0, 20).map((item) => item.name),
        },
        HttpStatus.CONFLICT,
      );
    }

    // Only the bytes that will actually be written: a skipped item moves none,
    // and an overwrite frees what it replaces. Being approximately right in the
    // safe direction is the point — a refusal here is cheap and a transfer that
    // fills somebody's root partition is not.
    const writing = plan.items.reduce(
      (total, item, index) => (decisions[index] === "SKIP" ? total : total + item.bytes),
      0,
    );
    if (plan.destination.freeBytes !== null && writing > plan.destination.freeBytes) {
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          code: "ENOSPC",
          message: "There is not enough free space at the destination for this transfer.",
          needBytes: writing,
          freeBytes: plan.destination.freeBytes,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const job = await this.prisma.transferJobs.create({
      data: {
        userId,
        srcHostId: input.srcHostId,
        srcPath: plan.source.path,
        dstHostId: input.dstHostId,
        dstPath: plan.destination.path,
        operation: input.operation === "move" ? "MOVE" : "COPY",
        // `landAs` is written down rather than recomputed by the runner, and
        // that is the same reason the items are: the job may be picked up
        // minutes later, or after a restart, and a name chosen again then would
        // be a different name. What was decided is what runs.
        options: { strategy: input.strategy, landAs: plan.landAs },
        status: "QUEUED",
        bytesTotal: BigInt(writing),
        itemsTotal: plan.items.length,
      },
    });

    for (let start = 0; start < plan.items.length; start += ITEM_BATCH) {
      await this.prisma.transferItems.createMany({
        data: plan.items.slice(start, start + ITEM_BATCH).map((item, offset) => ({
          jobId: job.id,
          name: item.name,
          kind: item.kind,
          bytes: BigInt(item.bytes),
          mode: item.mode,
          mtimeMs: item.mtimeMs === null ? null : BigInt(Math.round(item.mtimeMs)),
          conflict: decisions[start + offset],
          status: "PENDING" as const,
        })),
      });
    }

    this.queue.enqueue(job.id, [input.srcHostId, input.dstHostId]);
    return toView({ ...job, failedItems: 0 });
  }

  // ------------------------------------------------------------------ reads

  async list(userId: string): Promise<TransferView[]> {
    const jobs = await this.prisma.transferJobs.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: RECENT_JOBS,
    });

    const failures = await this.prisma.transferItems.groupBy({
      by: ["jobId"],
      where: { jobId: { in: jobs.map((job) => job.id) }, status: "FAILED" },
      _count: { _all: true },
    });
    const failedBy = new Map(failures.map((row) => [row.jobId, row._count._all]));

    return jobs.map((job) => toView({ ...job, failedItems: failedBy.get(job.id) ?? 0 }));
  }

  /**
   * One job with its items. The items are what a failed job's retry is aimed
   * at, and what the UI lists when somebody asks why a transfer went amber.
   */
  async get(userId: string, id: string): Promise<TransferView & { items: TransferItemView[] }> {
    const job = await this.prisma.transferJobs.findFirst({
      where: { id, userId },
      include: { items: { orderBy: { name: "asc" } } },
    });
    // Scoped by user, and absent rather than forbidden: a job id from another
    // account must read as "no such job", never as a refusal that confirms it.
    if (!job) throw new NotFoundException("No such transfer.");

    return {
      ...toView({ ...job, failedItems: job.items.filter((item) => item.status === "FAILED").length }),
      items: job.items.map((item) => ({
        name: item.name,
        kind: item.kind,
        bytes: Number(item.bytes),
        status: item.status,
        conflict: item.conflict,
        finalName: item.finalName,
        error: item.error,
      })),
    };
  }

  // ---------------------------------------------------------------- control

  /**
   * Stop one.
   *
   * The queue is told first and the row second. A job running in this process
   * gets its abort signal immediately — which is what makes "cancel stops
   * within a second" true — and the runner writes the `CANCELLED` row itself
   * when it unwinds. A job that is only queued has no runner to do that, so the
   * row is written here.
   */
  async cancel(userId: string, id: string): Promise<TransferView> {
    const job = await this.prisma.transferJobs.findFirst({ where: { id, userId } });
    if (!job) throw new NotFoundException("No such transfer.");

    if (job.status === "DONE" || job.status === "FAILED" || job.status === "CANCELLED") {
      throw new BadRequestException("That transfer has already finished.");
    }

    const where = this.queue.cancel(id);
    if (where !== "running") {
      const updated = await this.prisma.transferJobs.update({
        where: { id },
        data: { status: "CANCELLED", finishedAt: new Date(), error: "Cancelled." },
      });
      return toView({ ...updated, failedItems: 0 });
    }

    return toView({ ...job, failedItems: 0 });
  }

  /**
   * Re-run only what failed (TRE-23 §5).
   *
   * `FAILED` items go back to `PENDING` and nothing else is touched — the
   * hundreds that succeeded keep their `DONE`, and the runner skips them. A
   * retry that re-ran the whole job would move gigabytes to fix one unreadable
   * file, which is why the item is the unit of failure in the first place.
   */
  async retry(userId: string, id: string): Promise<TransferView> {
    const job = await this.prisma.transferJobs.findFirst({ where: { id, userId } });
    if (!job) throw new NotFoundException("No such transfer.");
    if (job.status === "QUEUED" || job.status === "RUNNING") {
      throw new BadRequestException("That transfer is still going.");
    }

    const { count } = await this.prisma.transferItems.updateMany({
      where: { jobId: id, status: "FAILED" },
      data: { status: "PENDING", error: null },
    });
    if (count === 0) throw new BadRequestException("Nothing in that transfer failed.");

    const updated = await this.prisma.transferJobs.update({
      where: { id },
      data: { status: "QUEUED", finishedAt: null, error: null, itemsDone: job.itemsTotal - count },
    });

    this.queue.enqueue(id, [job.srcHostId, job.dstHostId]);
    return toView({ ...updated, failedItems: 0 });
  }

  // --------------------------------------------------------------- internals

  /**
   * Both ends, validated, plus everything that is decided about the pair rather
   * than about either side.
   */
  private async endpoints(
    userId: string,
    input: PlanInput,
  ): Promise<{
    srcDriver: HostDriver;
    dstDriver: HostDriver;
    sourceRoot: string;
    destination: string;
    sameHost: boolean;
  }> {
    const sourceRoot = commonParent(input.srcPaths);
    if (sourceRoot === null) {
      throw new BadRequestException("Everything in one transfer has to come from the same directory.");
    }

    const srcDriver = await this.driverFor(input.srcHostId, userId);
    const dstDriver = input.srcHostId === input.dstHostId ? srcDriver : await this.driverFor(input.dstHostId, userId);

    // Independently, and with the intents that differ: a READ root is enough to
    // copy *from* and is not enough to copy *into*. Validating one and assuming
    // the other is the mistake this pair of calls exists to make impossible.
    const source = await this.guard.validate({ driver: srcDriver, userId, path: sourceRoot, intent: "read" });
    const destination = await this.guard.validate({ driver: dstDriver, userId, path: input.dstPath, intent: "write" });

    const stat = await this.run(() => dstDriver.stat(destination.realPath));
    if (stat.kind !== "directory") {
      throw new BadRequestException(`${input.dstPath} is not a directory.`);
    }

    if (input.srcHostId === input.dstHostId) {
      for (const path of input.srcPaths) {
        const entry = await this.guard.validate({ driver: srcDriver, userId, path, intent: "read" });
        if (destinationInsideSource(entry.realPath, destination.realPath)) {
          throw new BadRequestException(
            `${input.dstPath} is inside ${path}. A transfer cannot write into the tree it is reading.`,
          );
        }
      }
    }

    return {
      srcDriver,
      dstDriver,
      sourceRoot: source.realPath,
      destination: destination.realPath,
      sameHost: input.srcHostId === input.dstHostId,
    };
  }

  /**
   * What is already at the destination, keyed the way items are named.
   *
   * One listing of the destination directory, and then a walk only of the
   * top-level names that actually collide. A stat per item would be a round
   * trip per entry — ten thousand of them over SSH is several minutes of a
   * modal saying "planning…" — and the entries under a directory that is not
   * there cannot conflict with anything.
   */
  private async destinationFacts(
    driver: HostDriver,
    destination: string,
    topNames: readonly string[],
    ceiling: number,
  ): Promise<Map<string, EntryFacts>> {
    const facts = new Map<string, EntryFacts>();

    // An unreadable destination is not a planning failure: the guard already
    // said the path is allowed, and a directory this account cannot list is one
    // where nothing can conflict as far as anybody here can tell. The transfer
    // itself will refuse when it tries to write.
    const present = await driver.list(destination).catch((): FileEntry[] => []);
    const byName = new Map(present.map((entry) => [entry.name, entry] as const));

    for (const name of topNames) {
      const entry = byName.get(name);
      if (!entry) continue;
      facts.set(name, { size: entry.size, mtimeMs: entry.mtimeMs, kind: entry.kind });

      if (entry.kind !== "directory") continue;
      const under = joinPath(destination, name);
      const walked = await walkTree(driver, under, ceiling).catch(() => null);
      if (walked === null || walked.exceeded) continue;

      for (const detail of walked.details) {
        const suffix = detail.path.slice(under.length).replace(/^\//, "");
        if (suffix === "") continue;
        facts.set(`${name}/${suffix}`, { size: detail.size, mtimeMs: detail.mtimeMs, kind: detail.kind });
      }
    }

    return facts;
  }

  private async driverFor(hostId: string, userId: string): Promise<HostDriver> {
    return this.run(() => this.factory.forHost(hostId, userId));
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

export interface PlanInput {
  srcHostId: string;
  srcPaths: string[];
  dstHostId: string;
  dstPath: string;
  operation: TransferOperation;
  /** Land every entry under a free name instead of merging (TRE-69 §2). */
  duplicate?: boolean;
}

export interface CreateInput extends PlanInput {
  strategy: ConflictStrategy;
  overrides?: Record<string, ConflictStrategy>;
}

export interface TransferItemView {
  name: string;
  kind: string;
  bytes: number;
  status: string;
  /**
   * Typed as a plain string rather than as `ConflictDecision`: this comes out
   * of the database, and the column is a MySQL enum that a migration could
   * widen without this file noticing. Narrowing it here would be a claim the
   * type system cannot check on a value it never constructed.
   */
  conflict: string;
  finalName: string | null;
  error: string | null;
}

interface JobRow {
  id: string;
  operation: string;
  status: string;
  srcHostId: string | null;
  srcPath: string;
  dstHostId: string | null;
  dstPath: string;
  bytesTotal: bigint;
  bytesDone: bigint;
  itemsTotal: number;
  itemsDone: number;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  failedItems: number;
}

/**
 * A row as the browser sees it. BigInt is the whole reason this exists: a job's
 * byte counts are BigInt in Prisma and `JSON.stringify` throws on one rather
 * than rounding it, so every route that returns a job has to narrow them — once,
 * here, instead of at four call sites.
 */
function toView(job: JobRow): TransferView {
  return {
    id: job.id,
    operation: job.operation === "MOVE" ? "move" : "copy",
    status: job.status,
    srcHostId: job.srcHostId,
    srcPath: job.srcPath,
    dstHostId: job.dstHostId,
    dstPath: job.dstPath,
    bytesTotal: Number(job.bytesTotal),
    bytesDone: Number(job.bytesDone),
    itemsTotal: job.itemsTotal,
    itemsDone: job.itemsDone,
    failed: job.failedItems,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
