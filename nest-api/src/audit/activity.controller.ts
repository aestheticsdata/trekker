import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { type ActivityPage, ActivityService } from "@audit/activity.service";
// Value import, not `import type`: erasing the token leaves `design:paramtypes`
// holding `Object`, the global ValidationPipe strips every property under
// `whitelist: true`, and the handler runs with an empty filter set — a 200 that
// quietly ignored every parameter. `di-metadata.audit.spec.ts` enforces this.
import { ListActivityDto } from "@audit/dto/list-activity.dto";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";

/**
 * Reading the audit trail (TRE-30 §4).
 *
 * A read, so the session guard without CSRF — the shape FsController set. It
 * is not itself audited: `GET` never is, and a log that recorded every read of
 * itself would bury the rows worth finding under the act of looking for them.
 */
@Controller("activity")
@UseGuards(SessionAuthGuard)
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  list(@Req() req: Request, @Query() query: ListActivityDto): Promise<ActivityPage> {
    return this.activity.list((req as AuthenticatedRequest).user.id, query);
  }
}
