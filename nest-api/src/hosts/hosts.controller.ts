import type { HostProbeResult } from "@hosts/drivers/ssh-connection.pool";
// The DTOs are value imports, and must stay that way: `import type` erases the
// token from `design:paramtypes`, so `@Body()` arrives as `Function`, the
// global ValidationPipe strips every property under `whitelist: true`, and the
// handler is called with an empty object and no validation. It fails silently —
// a 201 with nothing saved — and neither tsc nor the linter says a word.
import { AcceptHostKeyDto } from "@hosts/dto/accept-host-key.dto";
import { CreateHostDto } from "@hosts/dto/create-host.dto";
import { TestHostDto } from "@hosts/dto/test-host.dto";
import { UpdateHostDto } from "@hosts/dto/update-host.dto";
import { HostKeyService } from "@hosts/host-key.service";
import type { HostSummary } from "@hosts/host-summary.service";
import { HostsService, type HostView } from "@hosts/hosts.service";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";
import type { Request } from "express";

/**
 * Hosts management (TRE-12). Every route is behind the session guard, and every
 * mutating one behind CSRF as well — the convention set by UsersController.
 *
 * Ownership is enforced in the service by scoping each query to the session
 * user, so another account's host id reads as 404 rather than 403.
 */
@Controller("hosts")
@UseGuards(SessionAuthGuard)
export class HostsController {
  constructor(
    private readonly hosts: HostsService,
    private readonly hostKeys: HostKeyService,
  ) {}

  @Get()
  list(@Req() req: Request): Promise<HostView[]> {
    return this.hosts.list(userIdOf(req));
  }

  /**
   * Declared before `:id`, or "test" would be read as a host id — Nest matches
   * routes in declaration order.
   */
  @Post("test")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  test(@Req() req: Request, @Body() dto: TestHostDto): Promise<HostProbeResult> {
    return this.hosts.test(dto, userIdOf(req));
  }

  @Get(":id")
  get(@Req() req: Request, @Param("id") id: string): Promise<HostView> {
    return this.hosts.get(userIdOf(req), id);
  }

  @Get(":id/summary")
  summary(@Req() req: Request, @Param("id") id: string): Promise<HostSummary> {
    return this.hosts.summary(userIdOf(req), id);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: Request, @Body() dto: CreateHostDto): Promise<HostView> {
    return this.hosts.create(userIdOf(req), dto);
  }

  @Patch(":id")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  update(@Req() req: Request, @Param("id") id: string, @Body() dto: UpdateHostDto): Promise<HostView> {
    return this.hosts.update(userIdOf(req), id, dto);
  }

  /**
   * Replace the pinned host key, deliberately (TRE-10 §3).
   *
   * Its own route rather than a field on PATCH: a host key change is a security
   * decision, and folding it into the save that also renames the host is how it
   * becomes one careless click on a form the user opened for another reason.
   */
  @Post(":id/known-keys")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async acceptKey(@Req() req: Request, @Param("id") id: string, @Body() dto: AcceptHostKeyDto): Promise<void> {
    await this.hostKeys.accept(userIdOf(req), id, dto.algorithm, dto.fingerprint);
  }

  @Delete(":id")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  async remove(@Req() req: Request, @Param("id") id: string): Promise<{ ok: true }> {
    await this.hosts.remove(userIdOf(req), id);
    return { ok: true };
  }
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}
