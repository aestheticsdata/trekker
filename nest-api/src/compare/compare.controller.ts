import { AuditService } from "@audit/audit.service";
import { Audited } from "@audit/audited.decorator";
import { LIMITS } from "@audit/limits";
// A value import, and it must stay that way: `import type` erases the token
// from `design:paramtypes`, so `@Body()` arrives as `Function`, the global
// ValidationPipe strips every property under `whitelist: true`, and the handler
// runs against an empty object. It fails as a 200 with nothing done, and
// neither tsc nor the linter says a word. See HostsController.
import { CompareDto } from "@compare/dto/compare.dto";
import { type CompareView, CompareService } from "@compare/compare.service";
import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";

import type { Request } from "express";

/**
 * Comparing two directories (TRE-28), as one route.
 *
 * One route and no stream, unlike the two modules it sits next to. A scan and a
 * checksum job are minutes long and need a feed and a cancel; a comparison is
 * bounded before it starts and answers in the request. Adding a queue to it
 * would be machinery guarding against a wait that cannot happen.
 *
 * **A POST that changes nothing.** It is audited all the same, for the reason
 * `host.scan` and `host.test` are: it reaches out to two machines under stored
 * credentials and spends their IO, and a burst of them is worth a record even
 * though no individual one alters a byte. 200 rather than 202 — there is no job
 * to accept, only an answer.
 */
@Controller("compare")
@UseGuards(SessionAuthGuard)
export class CompareController {
  constructor(
    private readonly compare: CompareService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `describe` deliberately does not set `hostId`. It runs before the handler,
   * so neither id in the body has been ownership-checked yet, and writing one
   * to a foreign key there would let anyone mint a row pointing at a host they
   * do not own — an existence oracle in a table they can read. Both ids go into
   * the payload as text and the real `hostId` is annotated after the service
   * has proven the hosts are theirs. Same shape as `ScansController`.
   */
  @Post()
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.compare",
    limit: LIMITS.compare,
    describe: (request) => {
      const body = request.body as { a?: { hostId?: string; path?: string }; b?: { hostId?: string; path?: string } };
      return {
        summary: `Compared ${body.a?.path ?? "?"} with ${body.b?.path ?? "?"}`,
        tag: body.a?.hostId === body.b?.hostId ? "same host" : "across hosts",
        paths: [body.a?.path, body.b?.path].filter((path): path is string => typeof path === "string"),
        payload: { requestedHostA: body.a?.hostId, requestedHostB: body.b?.hostId },
      };
    },
  })
  async run(@Req() req: Request, @Body() dto: CompareDto): Promise<CompareView> {
    const result = await this.compare.compare(userIdOf(req), dto);
    // The left side, because the row holds one host and a comparison has two.
    // The other is in the payload, where the pair can be read together.
    this.audit.annotate(req, { hostId: result.a.hostId });
    return result;
  }
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}
