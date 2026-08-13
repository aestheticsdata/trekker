import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Audited } from "@audit/audited.decorator";
import { LIMITS } from "@audit/limits";
import { contentDisposition, DOWNLOAD_CONTENT_TYPE, DOWNLOAD_CSP } from "@fs/download-headers";
import { sendDownload } from "@fs/download-response";
import { DownloadService } from "@fs/download.service";
import { MintLinkDto } from "@fs/dto/mint-link.dto";
import { type MintedLink, LinkService } from "@fs/link.service";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";

import type { Request, Response } from "express";

/**
 * Signed links (TRE-66), in a controller of their own.
 *
 * Separate from `FsController` for one structural reason: that class carries
 * `@UseGuards(SessionAuthGuard)` on the class, and the whole point of the GET
 * below is that it has no session. An exemption on one route inside a guarded
 * class is a thing the next reader has to notice; a controller whose guards are
 * written per route says it out loud.
 *
 * The two routes are opposites and sit together so the asymmetry is visible.
 * Minting is an authenticated, audited, rate-limited write. Redeeming is
 * anonymous, and everything that makes it safe is in the token it carries and
 * in how little that token grants.
 */
@Controller("link")
export class LinkController {
  constructor(
    private readonly links: LinkService,
    private readonly download: DownloadService,
  ) {}

  /**
   * Issue a link (TRE-66).
   *
   * Destructive in the sense the audit log means by it: nothing is deleted, but
   * this is the route that *grants* — it hands a readable copy of a file to
   * whoever holds a URL, with no account and no further check. The decorator's
   * own definition is "destroys or moves data, **or grants privilege**", and
   * this is the clearest case of the third in the application. The long
   * retention window is the consequence, and it is the right one: "who shared
   * what, with a link, and when" is a question asked months later.
   */
  @Post("mint")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "link.minted",
    destructive: true,
    limit: LIMITS.signedLink,
    describe: (request) => {
      const body = request.body as { path?: string; ttlSeconds?: number };
      return {
        summary: `signed link for ${basename(body.path ?? "?")}`,
        tag: "link",
        paths: body.path ? [body.path] : [],
        payload: { ttlSeconds: body.ttlSeconds },
      };
    },
  })
  mint(@Req() req: Request, @Body() dto: MintLinkDto): Promise<MintedLink> {
    return this.links.mint((req as AuthenticatedRequest).user.id, dto.hostId, dto.path, dto.ttlSeconds);
  }

  /**
   * Redeem one. No guards, which is the feature.
   *
   * No session, so no CSRF (there is nothing to forge against) and no cookie
   * (the browser sends none to a stranger's tab). The headers are the download
   * route's, imported rather than repeated: `attachment` always, an opaque type
   * always, sanitised filename, restrictive CSP. That sharing is the reason
   * TRE-26 put them in a file of their own — a link handed to someone outside
   * this application is precisely where an HTML file rendering inline would
   * stop being a theoretical problem.
   *
   * No ranges. A resumable anonymous download is a nicer thing to have and a
   * second code path through the one route with no authentication on it; the
   * grant is one small file for fifteen minutes, and it can be re-fetched.
   */
  @Get(":token")
  async redeem(@Req() req: Request, @Res() res: Response, @Param("token") token: string): Promise<void> {
    const ip = clientIp(req);
    const { plan, claims } = await this.links.redeem(token, ip);

    // Written before the first byte, and attributed to whoever issued the link.
    const rowId = await this.links.record(claims, ip, req.headers["user-agent"]);
    const started = Date.now();

    const stream = await this.download.stream(plan);
    return sendDownload(
      res,
      {
        stream,
        settle: (bytes, outcome, detail) => this.links.settle(rowId, bytes, outcome, started, detail),
      },
      {
        status: HttpStatus.OK,
        // The link route always serves one whole file, so the length is always
        // known — see `sendDownload` for why that number is what tells a
        // finished download from an abandoned one.
        expectBytes: plan.size ?? 0,
        headers: {
          "Content-Type": DOWNLOAD_CONTENT_TYPE,
          "Content-Disposition": contentDisposition(plan.filename),
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": DOWNLOAD_CSP,
          "Content-Length": String(plan.size ?? 0),
          "Accept-Ranges": "none",
          // `no-store` matters more here than on the session route: this URL is
          // shareable, so a proxy that cached it would be serving the file
          // after the link it came from had expired.
          "Cache-Control": "private, no-store",
          // The link is not a page and must never be treated as one by anything
          // that indexes URLs it was forwarded.
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
  }
}

/**
 * The address a request came from.
 *
 * `trust proxy` is set, so Express has already resolved `req.ip` from
 * `X-Forwarded-For` — but this is the one route with no session behind it, and
 * a rate limit keyed on a header is worth reading through the framework's own
 * accessor rather than off the header directly, which is where the spoofing
 * mistakes live.
 */
function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? "unknown";
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
