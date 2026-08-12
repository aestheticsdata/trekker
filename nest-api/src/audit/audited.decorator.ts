import { SetMetadata } from "@nestjs/common";

import type { LimitRule } from "@audit/limits";
import type { Request } from "express";

export const AUDIT_SPEC = "trekker:audit-spec";
export const AUDIT_EXEMPT = "trekker:audit-exempt";

/**
 * What the interceptor writes BEFORE the handler runs. Derived from the
 * request alone, because at that point nothing else exists yet — that is the
 * whole point of pre-writing (TRE-30 §1).
 */
export interface AuditIntent {
  /** One line, for the activity strip. Never a path list — see `paths`. */
  summary: string;
  /** Short badge: "3 files", "412 MB". */
  tag?: string;
  hostId?: string;
  /** What the operation was aimed at. Redacted and stored in `payload`. */
  paths?: readonly string[];
  payload?: Record<string, unknown>;
}

export interface AuditSpec {
  /**
   * The vocabulary. Dotted, `subject.verb`, and stable — the activity strip
   * and every future filter key off it, so renaming one silently reclassifies
   * history. Max 32 chars (the column).
   */
  kind: string;

  /**
   * Builds the pre-row from the request. Must be pure and must not throw: it
   * runs before the handler, and an exception here would turn a working
   * operation into a 500. Anything that needs the result belongs in
   * `AuditService.annotate` instead.
   */
  describe?: (request: Request) => AuditIntent;

  /**
   * Destroys or moves data, or grants privilege. Two consequences: the row is
   * kept for the longer retention window, and `audit-coverage.spec.ts` requires
   * the route to carry a `limit` (TRE-30 §3). Marking a route destructive is
   * cheap; missing one is not.
   */
  destructive?: boolean;

  /**
   * The rate limit this route spends from, out of `limits.ts`. Enforced by the
   * same interceptor that writes the row, so a destructive route cannot be
   * limited "later" any more than it can be audited later — there is one place
   * both happen and it is not optional.
   *
   * Several routes deliberately share one rule. A per-route counter lets a
   * stolen session cycle between equivalent capabilities and stay under all of
   * them.
   */
  limit?: LimitRule;
}

/**
 * Marks a route for the audit log. Required on every mutating route —
 * `audit-coverage.spec.ts` fails the build otherwise, which is what makes this
 * a mechanism rather than a habit.
 */
export const Audited = (spec: AuditSpec) => SetMetadata(AUDIT_SPEC, spec);

/**
 * The deliberate exception, with the reason recorded at the route rather than
 * in a list somewhere else. The reason is not decoration: the coverage spec
 * rejects an empty one, so exempting a route costs a sentence explaining
 * yourself to the next reader.
 *
 * Reach for this when a row would be noise with no security value. If you are
 * writing "it is not important", it is probably destructive.
 */
export const NotAudited = (reason: string) => SetMetadata(AUDIT_EXEMPT, reason);
