import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ActivityController } from "@audit/activity.controller";
import { ActivityService } from "@audit/activity.service";
import { AuditInterceptor } from "@audit/audit.interceptor";
import { AuditService } from "@audit/audit.service";
import { RateLimitService } from "@audit/rate-limit.service";
import { RetentionService } from "@audit/retention.service";

/**
 * The audit log and its limits (TRE-30).
 *
 * `@Global` and the interceptor bound with `APP_INTERCEPTOR`, both on purpose.
 * M2 adds seven modules that mutate things, and the one design goal here is
 * that none of them can be built without their operations being recorded and
 * bounded. A per-module `imports: [AuditModule]` and a per-controller
 * `@UseInterceptors(...)` would both be things a future ticket can leave out
 * and nothing would notice — which is how an audit trail ends up with holes in
 * exactly the routes nobody thought about.
 *
 * So the mechanism is: recording and rate limiting are automatic, and the only
 * per-route decisions are which `kind` the row carries and which limit it
 * spends from. `audit-coverage.spec.ts` makes both mandatory by failing the
 * build on any mutating route that has not made them.
 *
 * One module owns the table end to end — the writer, the reader and the prune.
 * The strip and the audit trail are the same rows read two ways, and splitting
 * them across modules is how they drift apart.
 */
@Global()
@Module({
  controllers: [ActivityController],
  providers: [
    AuditService,
    ActivityService,
    RateLimitService,
    RetentionService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService, RateLimitService],
})
export class AuditModule {}
