import { AuditService } from "@audit/audit.service";
import { Audited } from "@audit/audited.decorator";
import { LIMITS } from "@audit/limits";
// Value imports, and they must stay that way: `import type` erases the token
// from `design:paramtypes`, so `@Body()`/`@Query()` arrive as `Function`, the
// global ValidationPipe strips every property under `whitelist: true`, and the
// handler runs against an empty object. It fails as a 200 with nothing done,
// and neither tsc nor the linter says a word. See HostsController.
import { HashQueryDto } from "@hashes/dto/hash-query.dto";
import { StartHashDto } from "@hashes/dto/start-hash.dto";
import { HashEventsService } from "@hashes/hash-events.service";
import { type HashJobView, type HashStateView, HashService } from "@hashes/hash.service";
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";

import type { Request, Response } from "express";

/**
 * Checksums (TRE-27), as three routes and a stream.
 *
 * Its own prefix rather than a route under `fs`, because a checksum is not an
 * operation on a path the way a chmod is — it is a job with a lifetime, a feed
 * and a cancel, and the answer outlives the request that asked for it. Same
 * reasoning that put scans under their own module beside `hosts`.
 *
 * The POST is audited and is not destructive: it writes nothing on the host.
 * It is audited for the reason `host.scan` and `host.test` are — it reaches out
 * to another machine under a stored credential and spends minutes of its IO,
 * and a burst of them is worth a record even though every individual one is
 * harmless.
 */
@Controller("hash")
@UseGuards(SessionAuthGuard)
export class HashesController {
  constructor(
    private readonly hashes: HashService,
    private readonly events: HashEventsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What is known about one path: the cached digest if it is still current, and
   * the job that is about to produce one. A read, so no CSRF and nothing
   * audited.
   */
  @Get()
  state(@Req() req: Request, @Query() query: HashQueryDto): Promise<HashStateView> {
    return this.hashes.state(userIdOf(req), query.hostId, query.path);
  }

  /**
   * The live progress feed.
   *
   * Server-sent events, for the reasons `TransfersController` gives: one-way,
   * text, and `EventSource` reconnects on its own. Declared before `POST` in
   * this file only for reading order — `hash/stream` is a GET and collides with
   * nothing.
   *
   * Per user rather than per host or per job, because a browser should open one
   * of these and not one per pane. Filtering to the job being watched is the
   * client's, and it is a comparison of two strings.
   */
  @Get("stream")
  stream(@Req() req: Request, @Res() res: Response): void {
    const userId = userIdOf(req);

    res.writeHead(HttpStatus.OK, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx buffers a response by default and would hold the whole stream
      // until the job ended, which is the opposite of a progress feed.
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const unsubscribe = this.events.subscribe(userId, (progress) => {
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
   * Queue one. 202: the job exists and none of the reading has happened.
   *
   * `describe` names the host id as text in the payload and never sets
   * `hostId`. It runs before the handler, so the id in the body has not been
   * ownership-checked yet, and writing it to a foreign key there would let
   * anyone mint an audit row pointing at a host they do not own — an existence
   * oracle in a table they can read. The real `hostId` is annotated after the
   * service has proven the host is theirs. Same shape as `ScansController`.
   */
  @Post()
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @Audited({
    kind: "file.hash",
    limit: LIMITS.hashJobs,
    describe: (request) => {
      const body = request.body as { hostId?: string; paths?: string[] };
      const paths = body.paths ?? [];
      return {
        summary: `Queued sha256 for ${paths.length} path(s)`,
        tag: `${paths.length} path(s)`,
        paths,
        payload: { requestedHostId: body.hostId },
      };
    },
  })
  async start(@Req() req: Request, @Body() dto: StartHashDto): Promise<HashJobView> {
    const job = await this.hashes.start(userIdOf(req), dto);
    this.audit.annotate(req, { hostId: job.hostId });
    return job;
  }

  /**
   * Stop one. Audited, not destructive, and not rate limited: it is the route
   * that makes a job stop costing a host anything, and a budget on it is a
   * budget on stopping.
   */
  @Post(":id/cancel")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.hash.cancel",
    describe: (request) => ({
      summary: "Stopped a checksum job",
      payload: { jobId: request.params.id },
    }),
  })
  cancel(@Req() req: Request, @Param("id") id: string): { id: string; stopped: boolean } {
    return this.hashes.cancel(userIdOf(req), id);
  }
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}
