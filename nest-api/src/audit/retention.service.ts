import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** Everyday rows: bookmarks moved, a connection tested, a sign-out. */
const ORDINARY_DAYS = Number.parseInt(process.env.TREKKER_AUDIT_RETENTION_DAYS ?? "", 10) || 90;

/**
 * Rows that destroyed or moved data, or granted privilege. Kept four times as
 * long because they are the ones someone comes looking for, and they are
 * always found long after the fact — "when did this host key change" is not a
 * question anyone asks the same week.
 */
const DESTRUCTIVE_DAYS = Number.parseInt(process.env.TREKKER_AUDIT_RETENTION_DESTRUCTIVE_DAYS ?? "", 10) || 365;

/** Deleted per statement, so one prune never holds a long row-lock sweep. */
const BATCH = 1_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = DAY_MS;
/** Long enough after boot that a deploy's first requests are not competing. */
const FIRST_RUN_MS = 5 * 60 * 1000;

/**
 * Keeps `ActivityLog` from growing without bound (TRE-30 §2).
 *
 * An in-process timer rather than a cron entry or `@nestjs/schedule`. The
 * dependency is not installed, and a server-side cron is a step in `DEPLOY.md`
 * that someone has to perform on every new machine — which is exactly the
 * class of instruction TRE-46 exists because we keep getting wrong. This runs
 * wherever the API runs, with nothing to set up.
 *
 * Safe under PM2 because the API is `instances: 1`, `exec_mode: fork`. If that
 * ever becomes a cluster, two nodes pruning at once is harmless — the deletes
 * are idempotent and bounded — but it is worth knowing rather than discovering.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // `unref` on both: a pending timer must never be the reason the process
    // refuses to exit during a deploy's reload.
    this.first = setTimeout(() => void this.prune(), FIRST_RUN_MS);
    this.first.unref();

    this.timer = setInterval(() => void this.prune(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Deletes past the retention window, in batches.
   *
   * The only place in the application that deletes an audit row — the
   * append-only rule in `audit-coverage.spec.ts` names this file and
   * `audit.service.ts` and nothing else.
   */
  async prune(now: Date = new Date()): Promise<{ ordinary: number; destructive: number }> {
    const ordinary = await this.pruneClass(false, new Date(now.getTime() - ORDINARY_DAYS * DAY_MS));
    const destructive = await this.pruneClass(true, new Date(now.getTime() - DESTRUCTIVE_DAYS * DAY_MS));

    if (ordinary + destructive > 0) {
      this.logger.log(`Audit prune removed ${ordinary} ordinary and ${destructive} destructive rows`);
    }
    return { ordinary, destructive };
  }

  private async pruneClass(destructive: boolean, before: Date): Promise<number> {
    let removed = 0;

    try {
      for (;;) {
        // Selected then deleted by id rather than one `deleteMany` on the
        // date: an unbounded delete on a table this size takes locks for as
        // long as it takes, and this runs on a box that is also serving.
        const doomed = await this.prisma.activityLog.findMany({
          where: { destructive, createdAt: { lt: before } },
          select: { id: true },
          take: BATCH,
        });
        if (doomed.length === 0) break;

        const { count } = await this.prisma.activityLog.deleteMany({
          where: { id: { in: doomed.map((row) => row.id) } },
        });
        removed += count;

        if (doomed.length < BATCH) break;
      }
    } catch (error) {
      // Never fatal. A prune that cannot run leaves rows that should have gone,
      // which is a disk problem; a prune that crashes the API turns a disk
      // problem into an outage.
      this.logger.error(`Audit prune failed: ${(error as Error).message}`);
    }

    return removed;
  }
}
