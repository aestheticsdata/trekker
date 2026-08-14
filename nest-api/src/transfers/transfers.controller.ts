import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Audited, NotAudited } from "@audit/audited.decorator";
import { LIMITS } from "@audit/limits";
import { CreateTransferDto } from "@transfers/dto/create-transfer.dto";
import { PlanTransferDto } from "@transfers/dto/plan-transfer.dto";
import { TransferEventsService } from "@transfers/transfer-events.service";
import {
  type TransferItemView,
  type TransferPlan,
  type TransferView,
  TransferService,
} from "@transfers/transfer.service";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";

import type { Request, Response } from "express";

/**
 * Transfers (TRE-23), as five routes and a stream.
 *
 * The shape worth noticing is that only two of them do anything: `plan` asks a
 * question and `POST /transfers` answers it by creating a row. Everything the
 * transfer then does happens outside any request, which is the point — a copy
 * takes minutes, and a request that waited for it would be a request that dies
 * to a proxy timeout with a job still running behind it.
 *
 * `cancel` and `retry` are audited but not destructive: one stops work and the
 * other resumes it, and neither destroys or grants anything. The transfer they
 * govern was audited when it was queued and is audited again when it ends.
 */
@Controller("transfers")
@UseGuards(SessionAuthGuard)
export class TransfersController {
  constructor(
    private readonly transfers: TransferService,
    private readonly events: TransferEventsService,
  ) {}

  @Get()
  list(@Req() req: Request): Promise<TransferView[]> {
    return this.transfers.list(userIdOf(req));
  }

  /**
   * The live progress feed (TRE-23 §1).
   *
   * Server-sent events rather than a websocket: this is one-way, it is text,
   * and `EventSource` reconnects on its own — three things a websocket would
   * make the client responsible for. It is a GET, so no CSRF, and it carries
   * the session guard like every other read here.
   *
   * The two headers below the content type are the ones that make it work
   * through a proxy at all. Nginx buffers a response by default and would hold
   * the whole stream until the job ended, which is the opposite of a progress
   * feed; `X-Accel-Buffering: no` is how a response asks it not to. TRE-45
   * verifies the server block that agrees.
   */
  @Get("stream")
  stream(@Req() req: Request, @Res() res: Response): void {
    const userId = userIdOf(req);

    res.writeHead(HttpStatus.OK, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Flushed immediately so the browser's `EventSource` fires `open` now
    // rather than when the first transfer happens to start.
    res.write(": connected\n\n");

    const unsubscribe = this.events.subscribe(userId, (progress) => {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
    });

    // A comment line every twenty seconds. It carries nothing, and that is its
    // job: an idle stream is indistinguishable from a dead one to every proxy
    // between here and the browser, and the shortest read timeout in that chain
    // is what decides how often this has to happen.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
    heartbeat.unref();

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }

  @Get(":id")
  get(@Req() req: Request, @Param("id") id: string): Promise<TransferView & { items: TransferItemView[] }> {
    return this.transfers.get(userIdOf(req), id);
  }

  /**
   * What this transfer would do (TRE-23 §2). A POST for its body, like
   * `rename/preview` and `delete/plan`, and exempt for the same reason.
   */
  @Post("plan")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @NotAudited(
    "Walks both trees and reports. It moves nothing and creates nothing — the transfer that follows is the " +
      "audited event, and the modal issues one of these every time it opens, so a row here would bury it.",
  )
  plan(@Req() req: Request, @Body() dto: PlanTransferDto): Promise<TransferPlan> {
    return this.transfers.plan(userIdOf(req), dto);
  }

  /**
   * Queue one.
   *
   * Destructive, and for a move that is uncontroversial — it removes the source.
   * A copy earns the flag too: `overwrite` replaces a file at the destination
   * with no undo and no trash, which is the same act `POST /fs/upload` is
   * marked destructive for. The retention window follows, and so does the rate
   * limit that `audit-coverage.spec.ts` requires beside it.
   */
  @Post()
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "transfer.queue",
    destructive: true,
    limit: LIMITS.transferJobs,
    describe: (request) => {
      const body = request.body as {
        operation?: string;
        srcPaths?: string[];
        dstPath?: string;
        strategy?: string;
        dstHostId?: string;
      };
      const paths = body.srcPaths ?? [];
      return {
        summary: `${body.operation ?? "copy"} ${count(paths.length, "entry", "entries")} → ${body.dstPath ?? "?"}`,
        tag: count(paths.length, "entry", "entries"),
        // The destination host, not the source: this row records where data
        // arrived, and "what was written to this machine" is the question the
        // log is read with.
        hostId: body.dstHostId,
        paths,
        payload: { operation: body.operation, strategy: body.strategy, destination: body.dstPath },
      };
    },
  })
  create(@Req() req: Request, @Body() dto: CreateTransferDto): Promise<TransferView> {
    return this.transfers.create(userIdOf(req), dto);
  }

  @Post(":id/cancel")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "transfer.cancel",
    describe: (request) => ({ summary: `cancel transfer ${(request.params as { id?: string }).id ?? "?"}` }),
  })
  cancel(@Req() req: Request, @Param("id") id: string): Promise<TransferView> {
    return this.transfers.cancel(userIdOf(req), id);
  }

  /**
   * Re-run the failures.
   *
   * Destructive and limited, where `cancel` above is neither: this route starts
   * writing to another machine again, and the fact that it is writing the same
   * things a moment ago's job was writing makes no difference to what a stolen
   * session could do with it. It spends the same budget a fresh transfer does,
   * which is what `limits.ts` means by "copies, moves and retries on one".
   */
  @Post(":id/retry")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "transfer.retry",
    destructive: true,
    limit: LIMITS.transferJobs,
    describe: (request) => ({ summary: `retry transfer ${(request.params as { id?: string }).id ?? "?"}` }),
  })
  retry(@Req() req: Request, @Param("id") id: string): Promise<TransferView> {
    return this.transfers.retry(userIdOf(req), id);
  }
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
