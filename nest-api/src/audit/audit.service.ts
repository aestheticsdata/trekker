import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { redact, redactDetail } from "@audit/redact";
import { PrismaService } from "../prisma/prisma.service";

import type { Request } from "express";

export type AuditOutcome = "pending" | "success" | "failure" | "refused";

export interface AuditOpening {
  userId: string;
  sessionId?: string;
  kind: string;
  summary: string;
  tag?: string;
  hostId?: string;
  elevated?: boolean;
  /** Which surface started it, from the request header. Null means a button. */
  origin?: string;
  /** Carried from the route's `@Audited` spec. Decides the retention window. */
  destructive?: boolean;
  payload?: Record<string, unknown>;
}

/** What the handler learned that the request could not say in advance. */
export interface AuditAnnotation {
  summary?: string;
  tag?: string;
  hostId?: string;
  bytes?: bigint | number;
  elevated?: boolean;
  payload?: Record<string, unknown>;
}

/**
 * Where the interceptor stashes the open row id and any annotations. A symbol
 * so it cannot collide with an Express or middleware property, and so it never
 * appears in a `JSON.stringify(request)` anywhere.
 */
const AUDIT_STATE = Symbol.for("trekker:audit-state");

interface AuditState {
  rowId: string | null;
  annotation: AuditAnnotation;
}

function stateOf(request: Request): AuditState {
  const carrier = request as Request & { [AUDIT_STATE]?: AuditState };
  carrier[AUDIT_STATE] ??= { rowId: null, annotation: {} };
  return carrier[AUDIT_STATE];
}

/**
 * Writes the audit trail (TRE-30).
 *
 * Two writes per operation and no more: `open` before the handler, `settle`
 * after. Nothing else in the application updates or deletes a row — the prune
 * job is the single exception and it only deletes whole rows past the
 * retention window.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes the `pending` row and returns its id.
   *
   * **Fails closed.** If the row cannot be written the operation does not run.
   * That looks severe for a log, and it is deliberate: this app's whole claim
   * is that every action against a fleet of machines is recorded, and an
   * unrecorded `rm -rf` is worse than a refused one. It costs nothing in
   * practice — MySQL is already load-bearing for hosts, credentials and roots,
   * so a database that cannot take this row cannot serve the request either.
   */
  async open(opening: AuditOpening): Promise<string> {
    try {
      const row = await this.prisma.activityLog.create({
        data: {
          userId: opening.userId,
          sessionId: opening.sessionId ?? null,
          hostId: opening.hostId ?? null,
          kind: opening.kind.slice(0, 32),
          summary: opening.summary.slice(0, 255),
          tag: opening.tag?.slice(0, 32) ?? null,
          elevated: opening.elevated ?? false,
          origin: opening.origin ?? null,
          destructive: opening.destructive ?? false,
          outcome: "pending",
          payload: (redact(opening.payload) ?? undefined) as never,
        },
        select: { id: true },
      });
      return row.id;
    } catch (error) {
      this.logger.error(`Audit pre-write failed for ${opening.kind}: ${(error as Error).message}`);
      throw new ServiceUnavailableException("The action was not attempted: it could not be recorded in the audit log.");
    }
  }

  /**
   * Closes the row.
   *
   * Never throws. By the time this runs the operation has already happened, and
   * turning a successful `chmod` into a 500 because the log update failed would
   * report the opposite of the truth. A row stuck at `pending` is the honest
   * record of exactly this case, and `outcome` is indexed so they are findable.
   */
  async settle(
    rowId: string,
    outcome: Exclude<AuditOutcome, "pending">,
    durationMs: number,
    annotation: AuditAnnotation = {},
    detail?: string,
  ): Promise<void> {
    try {
      await this.prisma.activityLog.update({
        where: { id: rowId },
        data: {
          outcome,
          durationMs,
          detail: redactDetail(detail) ?? null,
          ...(annotation.summary ? { summary: annotation.summary.slice(0, 255) } : {}),
          ...(annotation.tag ? { tag: annotation.tag.slice(0, 32) } : {}),
          ...(annotation.hostId ? { hostId: annotation.hostId } : {}),
          ...(annotation.elevated === undefined ? {} : { elevated: annotation.elevated }),
          ...(annotation.bytes === undefined ? {} : { bytes: BigInt(annotation.bytes) }),
          ...(annotation.payload ? { payload: (redact(annotation.payload) ?? undefined) as never } : {}),
        },
      });
    } catch (error) {
      this.logger.error(`Audit settle failed for row ${rowId}: ${(error as Error).message}`);
    }
  }

  /**
   * One row for something that never reached a handler — a rate limit, a
   * rejected path. Refusals are audited on purpose: a burst of them is the
   * signal that something is wrong, and a limit that drops requests silently
   * teaches nobody anything (TRE-30 §3).
   *
   * Never throws, for the same reason `settle` does not: the caller is already
   * refusing the request and has a better message to return than this one.
   */
  async refused(opening: AuditOpening, detail: string): Promise<void> {
    try {
      await this.prisma.activityLog.create({
        data: {
          userId: opening.userId,
          sessionId: opening.sessionId ?? null,
          hostId: opening.hostId ?? null,
          kind: opening.kind.slice(0, 32),
          summary: opening.summary.slice(0, 255),
          tag: opening.tag?.slice(0, 32) ?? null,
          elevated: opening.elevated ?? false,
          destructive: opening.destructive ?? false,
          outcome: "refused",
          detail: redactDetail(detail) ?? null,
          durationMs: 0,
          payload: (redact(opening.payload) ?? undefined) as never,
        },
      });
    } catch (error) {
      this.logger.error(`Audit refusal write failed for ${opening.kind}: ${(error as Error).message}`);
    }
  }

  // ---- request-scoped plumbing, used by the interceptor and by handlers ----

  /** Called by a handler to add what only it knows. Merges, never replaces. */
  annotate(request: Request, annotation: AuditAnnotation): void {
    const state = stateOf(request);
    state.annotation = {
      ...state.annotation,
      ...annotation,
      payload: { ...(state.annotation.payload ?? {}), ...(annotation.payload ?? {}) },
    };
  }

  /** @internal — the interceptor's handle on the open row. */
  bindRow(request: Request, rowId: string): void {
    stateOf(request).rowId = rowId;
  }

  /** @internal */
  annotationOf(request: Request): AuditAnnotation {
    return stateOf(request).annotation;
  }

  /** @internal — the id `bindRow` gave this request, or null before one is bound. */
  rowIdOf(request: Request): string | null {
    return stateOf(request).rowId;
  }
}
