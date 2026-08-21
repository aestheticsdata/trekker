import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

import type { ListActivityDto } from "@audit/dto/list-activity.dto";

/** What the sidebar strip asks for when it does not say. */
const DEFAULT_LIMIT = 20;
/** Above this a caller wants an export, not a page. */
const MAX_LIMIT = 100;

export interface ActivityView {
  id: string;
  kind: string;
  summary: string;
  tag: string | null;
  hostId: string | null;
  outcome: "pending" | "success" | "failure" | "refused";
  detail: string | null;
  elevated: boolean;
  /** Which surface started it — "terminal" (TRE-35), or null for a button. */
  origin: string | null;
  /**
   * A string, not a number. The column is a BigInt — `JSON.stringify` throws
   * outright on one, and `Number()` would silently lose precision on a large
   * transfer. The client formats it; nothing here needs to do arithmetic.
   */
  bytes: string | null;
  durationMs: number | null;
  createdAt: string;
  payload: unknown;
}

export interface ActivityPage {
  items: ActivityView[];
  /** Null when this is the last page. Feed it back as `cursor`. */
  nextCursor: string | null;
}

/**
 * Reading the audit trail (TRE-30 §4).
 *
 * One endpoint, two readers: the sidebar's activity strip asks for a handful
 * of recent rows, an audit view asks for a filtered page. That is deliberate —
 * a log the product uses is a log that stays correct, because a bug in it is a
 * bug someone sees rather than a gap discovered during an incident.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: ListActivityDto): Promise<ActivityPage> {
    const requested = Number.parseInt(query.limit ?? "", 10);
    const limit = Number.isNaN(requested) ? DEFAULT_LIMIT : Math.min(Math.max(requested, 1), MAX_LIMIT);

    const createdAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };

    // One row more than asked for. Its existence is the answer to "is there
    // another page", which beats a second COUNT query that can disagree with
    // the first by the time it runs.
    const rows = await this.prisma.activityLog.findMany({
      where: {
        // Always first and never from the query: the session owns the scope.
        userId,
        ...(query.hostId ? { hostId: query.hostId } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: "desc" },
      take: limit + 1,
      select: {
        id: true,
        kind: true,
        summary: true,
        tag: true,
        hostId: true,
        outcome: true,
        detail: true,
        elevated: true,
        origin: true,
        bytes: true,
        durationMs: true,
        createdAt: true,
        payload: true,
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: items.map((row) => ({
        id: row.id,
        kind: row.kind,
        summary: row.summary,
        tag: row.tag,
        hostId: row.hostId,
        outcome: row.outcome,
        detail: row.detail,
        elevated: row.elevated,
        origin: row.origin,
        bytes: row.bytes === null ? null : row.bytes.toString(),
        durationMs: row.durationMs,
        createdAt: row.createdAt.toISOString(),
        payload: row.payload,
      })),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }
}
