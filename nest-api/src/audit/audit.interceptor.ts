import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { catchError, concatMap, from, switchMap, throwError } from "rxjs";
import { AUDIT_EXEMPT, AUDIT_SPEC } from "@audit/audited.decorator";
import { AuditService } from "@audit/audit.service";
import { RateLimitService } from "@audit/rate-limit.service";

import type { AuditIntent, AuditSpec } from "@audit/audited.decorator";
import type { AuditOutcome } from "@audit/audit.service";
import type { Request } from "express";
import type { Observable } from "rxjs";

/**
 * The methods that change something. GET and HEAD are not audited: the log is
 * a record of decisions, and burying the one `DELETE` that mattered under ten
 * thousand directory listings is how an audit trail stops being read.
 */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The header a client may use to say which surface an action came from, and the
 * only values it may say (TRE-35).
 *
 * A closed list rather than a length cap, because this is a column in the audit
 * log and a client that can write free text into one can write a sentence that
 * reads like somebody else's entry. Anything unrecognised is dropped silently
 * and the row reads as a button, which is the honest default: the header is a
 * label on a request that had the same permissions either way, so a forged or
 * malformed one must not be able to fail the operation.
 */
export const ORIGIN_HEADER = "x-trekker-origin";
const ORIGINS = new Set(["terminal"]);

/** Exported for `audit.spec.ts`: a client-writable audit field needs a test. */
export function originOf(request: { header(name: string): string | undefined }): string | undefined {
  const claimed = request.header(ORIGIN_HEADER);
  return claimed !== undefined && ORIGINS.has(claimed) ? claimed : undefined;
}

/**
 * A refusal is the request being told no before it did anything — the wrong
 * credentials, a rate limit, a path outside the roots. A failure is the
 * operation running and not working. Worth separating: a burst of refusals is
 * a security signal, a burst of failures is an outage.
 */
const REFUSAL_STATUSES = new Set([401, 403, 409, 422, 429]);

function outcomeFor(error: unknown): Exclude<AuditOutcome, "pending"> {
  if (error instanceof HttpException && REFUSAL_STATUSES.has(error.getStatus())) return "refused";
  return "failure";
}

/**
 * The route pattern rather than the resolved URL — `/hosts/:id`, not
 * `/hosts/9f2c...`. Grouping every row for one route together is what makes the
 * log queryable, and the concrete id is already in the payload.
 *
 * Cast through `unknown` rather than intersected with `Request`: Express
 * declares `route` as `any`, and an intersection with `any` is still `any`, so
 * the narrowing would read correctly and do nothing.
 */
function routePath(request: Request): string {
  const { route } = request as unknown as { route?: { path?: string } };
  return route?.path ?? request.path;
}

/**
 * Writes the audit trail around every mutating route (TRE-30 §1).
 *
 * Registered globally in `AuditModule` rather than applied per controller.
 * That is the mechanism: a new module cannot forget to opt in, because there
 * is nothing to opt into — the only decision left is which `kind` the route
 * carries, and `audit-coverage.spec.ts` fails the build if that is missing.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    if (!MUTATING.has(request.method)) return next.handle();

    const handler = context.getHandler();
    if (this.reflector.get<string>(AUDIT_EXEMPT, handler)) return next.handle();

    const spec = this.reflector.get<AuditSpec>(AUDIT_SPEC, handler);

    // The session, not just `request.user`. SessionAuthGuard sets `user`, but
    // not every mutating route uses it — `POST /users/logout` runs on CSRF
    // alone — and a log that quietly skips whichever routes happen to be
    // guarded differently is the kind of gap this ticket exists to close.
    const userId =
      (request as Request & { user?: { id: string } }).user?.id ??
      (request.session as { userId?: string } | undefined)?.userId;

    // Belt and braces. The coverage spec stops an undecorated mutating route
    // reaching main, so this branch should be unreachable — but if one ever
    // does, a row under a placeholder kind and a loud log beats no record at
    // all. The failure mode of an audit log is silence, so it must not have a
    // quiet path.
    if (!spec) {
      this.logger.error(
        `${request.method} ${request.path} mutates and carries no @Audited — recording as "unaudited.route".`,
      );
    }

    // No user means no row: `ActivityLog.userId` is a foreign key, and the
    // pre-session routes have nobody to attribute the action to until their
    // handler has run. Those routes are `@NotAudited` with that reason and are
    // caught above; this is the guard for anything that slips past a missing
    // SessionAuthGuard, where refusing to record silently would be worse than
    // saying so.
    if (!userId) {
      this.logger.error(`${request.method} ${request.path} mutates with no session user — not recorded.`);
      return next.handle();
    }

    const intent = this.describe(spec, request);
    const started = Date.now();

    return from(this.admit(spec, request, userId, intent)).pipe(
      switchMap((rowId) => {
        this.audit.bindRow(request, rowId);

        // The outcome is written BEFORE the response is sent, rather than
        // fired off and forgotten. One extra UPDATE on the request path buys
        // the guarantee the log is for: if the client was told it worked, the
        // record that it worked is already durable.
        return next.handle().pipe(
          concatMap(async (value) => {
            await this.audit.settle(rowId, "success", Date.now() - started, this.audit.annotationOf(request));
            return value;
          }),
          catchError((error: unknown) =>
            from(
              this.audit.settle(
                rowId,
                outcomeFor(error),
                Date.now() - started,
                this.audit.annotationOf(request),
                error instanceof Error ? error.message : String(error),
              ),
            ).pipe(switchMap(() => throwError(() => error))),
          ),
        );
      }),
    );
  }

  /**
   * The whole pre-phase: spend the rate limit, then open the row.
   *
   * In that order. Checking the limit second would mean a refused request
   * still wrote a `pending` row it never settles, and those rows are supposed
   * to mean "this crashed mid-flight" — filling them with routine refusals
   * would destroy the one signal that column exists to carry.
   *
   * The refusal still gets a row of its own, written as `refused`. A limit
   * that silently drops requests teaches nobody anything, least of all the
   * operator wondering why a burst stopped (TRE-30 §3).
   */
  private async admit(
    spec: AuditSpec | undefined,
    request: Request,
    userId: string,
    intent: AuditIntent,
  ): Promise<string> {
    const payload = {
      ...(intent.payload ?? {}),
      ...(intent.paths ? { paths: intent.paths } : {}),
      route: `${request.method} ${routePath(request)}`,
    };

    const opening = {
      userId,
      sessionId: request.sessionID,
      kind: spec?.kind ?? "unaudited.route",
      summary: intent.summary,
      tag: intent.tag,
      hostId: intent.hostId,
      origin: originOf(request),
      destructive: spec?.destructive ?? false,
      payload,
    };

    if (spec?.limit) {
      // Scoped to the user, not the session. A limit per session is no limit
      // at all when signing in again mints a new one.
      const verdict = await this.limits.consume(spec.limit, userId);
      if (!verdict.allowed) {
        const message = RateLimitService.describe(spec.limit, verdict.resetSeconds);
        await this.audit.refused({ ...opening, hostId: undefined }, message);
        throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
      }
    }

    return this.audit.open(opening);
  }

  /**
   * `describe` is author-supplied and runs before the handler, so a throw here
   * would turn a working operation into a 500 raised by its own audit log.
   * Caught, logged, and degraded to a summary built from the route.
   */
  private describe(spec: AuditSpec | undefined, request: Request): AuditIntent {
    const fallback: AuditIntent = { summary: `${request.method} ${routePath(request)}` };
    if (!spec?.describe) return fallback;

    try {
      return spec.describe(request);
    } catch (error) {
      this.logger.error(`describe() threw for ${spec.kind}: ${(error as Error).message}`);
      return fallback;
    }
  }
}
