import { AuditService } from "@audit/audit.service";
import { Audited } from "@audit/audited.decorator";
import { LIMITS } from "@audit/limits";
import type { HostProbeResult } from "@hosts/drivers/ssh-connection.pool";
// The DTOs are value imports, and must stay that way: `import type` erases the
// token from `design:paramtypes`, so `@Body()` arrives as `Function`, the
// global ValidationPipe strips every property under `whitelist: true`, and the
// handler is called with an empty object and no validation. It fails silently —
// a 201 with nothing saved — and neither tsc nor the linter says a word.
import { AcceptHostKeyDto } from "@hosts/dto/accept-host-key.dto";
import { CreateHostDto } from "@hosts/dto/create-host.dto";
import { DisksQueryDto } from "@hosts/dto/disks-query.dto";
import { OpenSudoDto } from "@hosts/dto/open-sudo.dto";
import { TestHostDto } from "@hosts/dto/test-host.dto";
import { UpdateHostDto } from "@hosts/dto/update-host.dto";
import type { DiskMount } from "@hosts/host-disks.service";
import { HostKeyService } from "@hosts/host-key.service";
import type { HostMetrics } from "@hosts/host-metrics.service";
import type { HostSummary } from "@hosts/host-summary.service";
import { HostsService, type HostView, type SudoRequirementView, type SudoWindowView } from "@hosts/hosts.service";
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
  Query,
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
 *
 * Every mutating route carries `@Audited` (TRE-30). Note what the `describe`
 * callbacks deliberately do NOT do: none of them sets `hostId`. They run before
 * the handler, so the id in the URL or the body has not been ownership-checked
 * yet, and writing it to a foreign key there would let anyone mint a row
 * pointing at a host they do not own — an existence oracle in a table they can
 * read. The id goes in the payload as plain text, and the real `hostId` is
 * annotated after the service call has proven the host is theirs.
 */
@Controller("hosts")
@UseGuards(SessionAuthGuard)
export class HostsController {
  constructor(
    private readonly hosts: HostsService,
    private readonly hostKeys: HostKeyService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Req() req: Request): Promise<HostView[]> {
    return this.hosts.list(userIdOf(req), req.sessionID);
  }

  /**
   * Declared before `:id`, or "test" would be read as a host id — Nest matches
   * routes in declaration order.
   */
  @Post("test")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "host.test",
    // Audited even though it changes nothing here: it opens an SSH connection
    // to an arbitrary address using a stored credential. "Who made this box
    // reach out, and where to" is the question this row answers.
    describe: (request) => {
      const body = request.body as { label?: string; address?: string; hostId?: string };
      return {
        summary: `Tested a connection to ${body.label ?? body.address ?? "a host"}`,
        payload: { requestedHostId: body.hostId },
      };
    },
  })
  async test(@Req() req: Request, @Body() dto: TestHostDto): Promise<HostProbeResult> {
    const result = await this.hosts.test(dto, userIdOf(req));
    if (dto.hostId) this.audit.annotate(req, { hostId: dto.hostId });
    return result;
  }

  @Get(":id")
  get(@Req() req: Request, @Param("id") id: string): Promise<HostView> {
    return this.hosts.get(userIdOf(req), id, req.sessionID);
  }

  @Get(":id/summary")
  summary(@Req() req: Request, @Param("id") id: string): Promise<HostSummary> {
    return this.hosts.summary(userIdOf(req), id);
  }

  /**
   * What the host is doing right now (TRE-73). Slower than `/summary` by design:
   * cpu and io are rates, so answering means reading the counters twice a second
   * apart. The service coalesces, so a burst of tabs still costs one sample.
   */
  @Get(":id/metrics")
  metrics(@Req() req: Request, @Param("id") id: string): Promise<HostMetrics> {
    return this.hosts.hostMetrics(userIdOf(req), id);
  }

  /**
   * How full every filesystem on the host is (TRE-31), for the sidebar's disk
   * panel. A read, so no CSRF and nothing audited — and no path parameter, by
   * design: `df` takes what it is given, and a path here would be a path to
   * validate.
   */
  @Get(":id/disks")
  disks(@Req() req: Request, @Param("id") id: string, @Query() query: DisksQueryDto): Promise<DiskMount[]> {
    return this.hosts.hostDisks(userIdOf(req), id, { includePseudo: isTrue(query.pseudo) });
  }

  @Post()
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.CREATED)
  @Audited({
    kind: "host.create",
    destructive: true,
    limit: LIMITS.hostMutation,
    describe: (request) => {
      const body = request.body as { label?: string; transport?: string };
      return {
        summary: `Added the host ${body.label ?? "(unnamed)"}`,
        tag: body.transport,
      };
    },
  })
  async create(@Req() req: Request, @Body() dto: CreateHostDto): Promise<HostView> {
    const host = await this.hosts.create(userIdOf(req), dto);
    this.audit.annotate(req, { hostId: host.id });
    return host;
  }

  @Patch(":id")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "host.update",
    // Destructive: this route can rewrite the credential and the roots, which
    // is what decides where Trekker may write on that machine.
    destructive: true,
    limit: LIMITS.hostMutation,
    describe: (request) => ({
      summary: "Edited a host",
      payload: {
        requestedHostId: request.params.id,
        fields: Object.keys((request.body ?? {}) as Record<string, unknown>),
      },
    }),
  })
  async update(@Req() req: Request, @Param("id") id: string, @Body() dto: UpdateHostDto): Promise<HostView> {
    const host = await this.hosts.update(userIdOf(req), id, dto, req.sessionID);
    this.audit.annotate(req, { hostId: host.id, summary: `Edited the host ${host.label}` });
    return host;
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
  @Audited({
    kind: "host.acceptkey",
    // The single most security-relevant row in this controller. Re-pinning a
    // host key is the action a man-in-the-middle needs the user to take, so the
    // fingerprint goes in the payload verbatim: "which key did we start
    // trusting, and when" has to be answerable afterwards (TRE-10).
    destructive: true,
    limit: LIMITS.hostMutation,
    describe: (request) => {
      const body = request.body as { algorithm?: string; fingerprint?: string };
      return {
        summary: "Pinned a new host key",
        tag: body.algorithm,
        payload: { requestedHostId: request.params.id, fingerprint: body.fingerprint },
      };
    },
  })
  async acceptKey(@Req() req: Request, @Param("id") id: string, @Body() dto: AcceptHostKeyDto): Promise<void> {
    await this.hostKeys.accept(userIdOf(req), id, dto.algorithm, dto.fingerprint);
    this.audit.annotate(req, { hostId: id });
  }

  @Delete(":id")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "host.delete",
    destructive: true,
    limit: LIMITS.hostMutation,
    describe: (request) => ({
      summary: "Removed a host",
      payload: { requestedHostId: request.params.id },
    }),
  })
  async remove(@Req() req: Request, @Param("id") id: string): Promise<{ ok: true }> {
    await this.hosts.remove(userIdOf(req), id);
    // `hostId` stays null here, and that is the correct record rather than a
    // gap: the row it would point at no longer exists, so the foreign key
    // cannot be satisfied. The schema already anticipates this — deleting a
    // host nulls the reference on its activity rows and keeps their story. The
    // id itself is in the payload, which is what an operator actually needs.
    return { ok: true };
  }

  /**
   * What opening a sudo window here would take, before anything is typed.
   *
   * The client reads this to decide whether to render a password field or a
   * plain confirm button. On a host whose account has `NOPASSWD` — most cloud
   * images — a password field would accept anything at all, because sudo never
   * reads what it is sent. Asking first is what keeps the prompt honest.
   *
   * A GET, unaudited and unlimited: it runs `sudo -n id -u`, which changes
   * nothing, and it is read on the way into a modal the person may then close.
   */
  @Get(":id/sudo")
  sudoRequirement(@Req() req: Request, @Param("id") id: string): Promise<SudoRequirementView> {
    return this.hosts.sudoRequirement(userIdOf(req), id);
  }

  /**
   * Open a sudo window on this host (TRE-29).
   *
   * **The password reaches `SudoService` and nothing else.** It is not stored,
   * not logged, and not in the audit payload — note that `describe` below names
   * the host and says nothing about the body, which is deliberate rather than
   * an omission. `redact.ts` would catch the key on the way to a row anyway;
   * this route does not rely on it.
   *
   * Rate limited hard, because this is the one route on the application that
   * takes a guessable secret belonging to the *machine*. See `LIMITS.sudo`.
   *
   * The window is verified before it is opened: a password that `sudo` refuses
   * must not leave a window behind that appears open and fails on first use.
   */
  @Post(":id/sudo")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "host.sudo.open",
    // Granting privilege, which is the category the retention rules keep four
    // times as long. "Who became root, on what, and when" is exactly the
    // question somebody comes back to this table for.
    destructive: true,
    limit: LIMITS.sudo,
    describe: (request) => ({
      summary: "Opened a sudo window",
      payload: { requestedHostId: request.params.id },
    }),
  })
  async openSudo(@Req() req: Request, @Param("id") id: string, @Body() dto: OpenSudoDto): Promise<SudoWindowView> {
    const window = await this.hosts.openSudo(userIdOf(req), req.sessionID, id, dto.password);
    this.audit.annotate(req, { hostId: id, summary: `Opened a sudo window on ${window.hostLabel}` });
    return window;
  }

  /**
   * Close it early. Idempotent: closing a window that is not open is a no-op
   * reported as one, not a 404 — the button is allowed to lose a race with the
   * expiry timer.
   */
  @Post(":id/sudo/drop")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "host.sudo.drop",
    describe: (request) => ({
      summary: "Closed a sudo window",
      payload: { requestedHostId: request.params.id },
    }),
  })
  async dropSudo(@Req() req: Request, @Param("id") id: string): Promise<{ ok: true; wasOpen: boolean }> {
    const wasOpen = await this.hosts.dropSudo(userIdOf(req), req.sessionID, id);
    this.audit.annotate(req, { hostId: id });
    return { ok: true, wasOpen };
  }
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}

/**
 * A query flag, read where it is used. The pipe validates the shape and does not
 * transform, so this is where the four characters become a boolean.
 */
function isTrue(value: string | undefined): boolean {
  return value === "true" || value === "1";
}
