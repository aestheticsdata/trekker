import { AuditService } from "@audit/audit.service";
import { Audited } from "@audit/audited.decorator";
import { LIMITS } from "@audit/limits";
// Value imports, and they must stay that way: `import type` erases the token
// from `design:paramtypes`, so `@Body()`/`@Query()` arrive as `Function`, the
// global ValidationPipe strips every property under `whitelist: true`, and the
// handler runs against an empty object. It fails as a 200 with nothing done,
// and neither tsc nor the linter says a word. See HostsController.
import { ScanQueryDto } from "@scans/dto/scan-query.dto";
import { StartScanDto } from "@scans/dto/start-scan.dto";
import { ScanEventsService } from "@scans/scan-events.service";
import { type ScanStateView, type ScanView, ScanService } from "@scans/scan.service";
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";

import type { Request, Response } from "express";

/**
 * Disk scans (TRE-32), as three routes and a stream.
 *
 * Mounted under `hosts` because a scan is a fact about one host, and lives in
 * its own module because it is a queue, a runner, an events bus and an abort
 * protocol — the same weight as TransfersModule, which is its own module for
 * exactly these reasons. HostsModule is `@Global()`, and a boot hook that
 * reaches into the database does not belong in a module every other one
 * imports for free.
 *
 * Both POSTs are audited and neither is destructive. A scan writes nothing on
 * the host and cancel destroys nothing — but a scan reaches out to another
 * machine under a stored credential and spends minutes of its IO, which is the
 * same reason `host.test` is audited despite changing nothing either.
 */
@Controller("hosts")
@UseGuards(SessionAuthGuard)
export class ScansController {
  constructor(
    private readonly scans: ScanService,
    private readonly events: ScanEventsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The panel's payload: the newest finished scan of a root, anything running,
   * and one treemap level. A read, so no CSRF and nothing audited.
   */
  @Get(":id/scan")
  state(@Req() req: Request, @Param("id") id: string, @Query() query: ScanQueryDto): Promise<ScanStateView> {
    return this.scans.state(userIdOf(req), id, query.root, query.at);
  }

  /**
   * The live progress feed.
   *
   * Server-sent events for the reasons TransfersController gives: one-way,
   * text, and `EventSource` reconnects on its own. Declared before nothing —
   * `:id/scan/stream` has more segments than `:id/scan`, so Nest's declaration
   * order does not decide between them.
   *
   * Per host rather than per user, because the panel is per host. The events
   * service still fans out per user — a scan started in another tab has to
   * reach this one — so the filter is here.
   */
  @Get(":id/scan/stream")
  stream(@Req() req: Request, @Param("id") id: string, @Res() res: Response): void {
    const userId = userIdOf(req);

    res.writeHead(HttpStatus.OK, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx buffers a response by default and would hold the whole stream
      // until the scan ended, which is the opposite of a progress feed.
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const unsubscribe = this.events.subscribe(userId, (progress) => {
      if (progress.hostId !== id) return;
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
    });

    // An idle stream is indistinguishable from a dead one to every proxy
    // between here and the browser.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
    heartbeat.unref();

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }

  /**
   * Start one. 202: the row exists and the walk has not.
   *
   * `describe` deliberately does not set `hostId`. It runs before the handler,
   * so the id in the URL has not been ownership-checked yet, and writing it to
   * a foreign key there would let anyone mint a row pointing at a host they do
   * not own — an existence oracle in a table they can read. The id goes in the
   * payload as text and the real `hostId` is annotated after the service has
   * proven the host is theirs.
   */
  @Post(":id/scan")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @Audited({
    kind: "host.scan",
    limit: LIMITS.diskScan,
    describe: (request) => {
      const body = request.body as { root?: string; depth?: number };
      return {
        summary: `Scanned disk usage under ${body.root ?? "?"}`,
        tag: body.root,
        payload: { requestedHostId: request.params.id, root: body.root, depth: body.depth },
      };
    },
  })
  async start(@Req() req: Request, @Param("id") id: string, @Body() dto: StartScanDto): Promise<ScanView> {
    const scan = await this.scans.start(userIdOf(req), id, dto);
    this.audit.annotate(req, { hostId: scan.hostId });
    return scan;
  }

  /**
   * Stop the one that is running. Audited but not destructive, and not rate
   * limited: it is the route that makes a scan stop costing a host anything,
   * and a budget on it is a budget on stopping.
   */
  @Post(":id/scan/cancel")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "host.scan.cancel",
    describe: (request) => ({
      summary: "Stopped a disk scan",
      payload: { requestedHostId: request.params.id },
    }),
  })
  async cancel(@Req() req: Request, @Param("id") id: string): Promise<ScanView> {
    const scan = await this.scans.cancel(userIdOf(req), id);
    this.audit.annotate(req, { hostId: scan.hostId });
    return scan;
  }
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}
