import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { AuditService } from "@audit/audit.service";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { type DownloadPlan, DownloadService } from "@fs/download.service";
import { type LinkClaims, refusalMessage, signLink, verifyLink } from "@fs/download-link";
import { LinkKeyService } from "@secrets/link-key";

/**
 * Handing one file to somebody with no account (TRE-66).
 *
 * This is the download route with a token where the session was, and that is
 * the whole design: the streaming, the headers, the filename sanitising and the
 * `attachment` disposition are `DownloadService`'s and are not re-implemented
 * here. What this file adds is the one thing that differs — deciding, without a
 * session, whether this request is allowed.
 *
 * **Everything else is therefore narrow.** One path, never a directory tree.
 * Read only. A short default life. No session means no CSRF, no cookie and no
 * way to tell who is on the other end, so the grant has to be small enough that
 * not knowing does not matter.
 *
 * The link is checked against the *issuer's* roots, not the visitor's — there
 * is no visitor to have any — which is what makes "exactly one path" true:
 * `DownloadService.plan` runs with the issuing user's id and refuses anything
 * that account could not have downloaded itself, then the claim's own path is
 * the only thing it is ever asked about.
 */

/** Fifteen minutes. Short enough that a forwarded link is a small mistake. */
const DEFAULT_TTL_SECONDS = 15 * 60;

/** A day. Past this the grant stops being a link and becomes an account. */
const MAX_TTL_SECONDS = 24 * 60 * 60;

export function defaultLinkTtl(): number {
  const override = Number.parseInt(process.env.TREKKER_LINK_TTL_SECONDS ?? "", 10);
  if (Number.isNaN(override) || override < 1) return DEFAULT_TTL_SECONDS;
  return Math.min(override, MAX_TTL_SECONDS);
}

export interface MintedLink {
  url: string;
  /** ISO 8601, so the UI can say when rather than in how long. */
  expiresAt: string;
  expiresInSeconds: number;
  /** What the recipient will see it called. */
  filename: string;
}

@Injectable()
export class LinkService {
  private readonly logger = new Logger(LinkService.name);

  constructor(
    private readonly download: DownloadService,
    private readonly keys: LinkKeyService,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Issue one.
   *
   * The plan runs first, and not only to name the file: it is the whole access
   * check. A link may only be minted for something the issuing account could
   * download right now, so a path outside their roots, a denylisted one or a
   * directory is refused here — before a token exists that would have to be
   * refused later, by which time it may have been forwarded.
   */
  async mint(userId: string, hostId: string, path: string, ttlSeconds?: number): Promise<MintedLink> {
    const plan = await this.download.plan(userId, hostId, path);
    if (plan.kind !== "file") {
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          code: "ENOTAFILE",
          message: "A signed link grants one file. Directories are downloadable while signed in, not by link.",
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const ttl = Math.min(ttlSeconds && ttlSeconds > 0 ? ttlSeconds : defaultLinkTtl(), MAX_TTL_SECONDS);
    const expiry = Math.floor(Date.now() / 1000) + ttl;

    // The resolved path, not the requested one. The token has to name what was
    // actually checked, or a symlink repointed after minting would carry the
    // grant somewhere the guard never agreed to.
    const claims: LinkClaims = { v: this.keys.current().version, h: hostId, p: plan.realPath, e: expiry, u: userId };
    const token = signLink(claims, this.keys.current());

    return {
      // Read from the environment rather than through ConfigService, matching
      // every other service in this directory: none of them take one, which is
      // what lets each be constructed in a spec with four arguments and no Nest
      // container. `FRONTEND_URL` is validated at boot either way.
      url: `${process.env.FRONTEND_URL ?? ""}/api/link/${token}`,
      expiresAt: new Date(expiry * 1000).toISOString(),
      expiresInSeconds: ttl,
      filename: plan.filename,
    };
  }

  /**
   * Redeem one.
   *
   * Rate limited by IP rather than by account, because there is no account —
   * and that makes this the one counter in the application scoped to something
   * the caller controls. It is a bound on a stranger hammering a URL, not an
   * identity check, and it is written down as such.
   */
  async redeem(token: string, ip: string): Promise<{ plan: DownloadPlan; claims: LinkClaims }> {
    const verdict = await this.limits.consume(LIMITS.signedLink, ip);
    if (!verdict.allowed) {
      throw new HttpException(
        RateLimitService.describe(LIMITS.signedLink, verdict.resetSeconds),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const checked = verifyLink(token, this.keys.current(), Math.floor(Date.now() / 1000));
    if (!checked.ok) {
      // Logged with the IP, which is the only thing known about whoever sent
      // it. A burst of these is somebody guessing, and the row is the only
      // place that would ever be visible.
      this.logger.warn(`Signed link refused (${checked.reason}) from ${ip}`);
      throw new ForbiddenException(refusalMessage(checked.reason));
    }

    // Re-planned every time, with the issuer's id. The token is a grant, not a
    // cached answer: the file may have been deleted, the roots may have been
    // narrowed, the account may have been removed. All three must refuse now
    // rather than at the moment the link was signed.
    const plan = await this.download.plan(checked.claims.u, checked.claims.h, checked.claims.p, { charge: false });
    return { plan, claims: checked.claims };
  }

  /**
   * The row for a use, attributed to whoever issued the link.
   *
   * There is nobody else to attribute it to — `ActivityLog.userId` is a foreign
   * key and the visitor has no account — and it is also the right answer: the
   * account that handed the URL out is the one accountable for where it went.
   * The IP is what distinguishes one use from another, so it is in the payload.
   */
  async record(claims: LinkClaims, ip: string, userAgent: string | undefined): Promise<string> {
    return this.audit.open({
      userId: claims.u,
      hostId: claims.h,
      kind: "link.used",
      summary: `signed link used for ${basename(claims.p)}`,
      tag: "link",
      destructive: false,
      payload: { paths: [claims.p], ip, userAgent: userAgent?.slice(0, 120) },
    });
  }

  settle(
    rowId: string,
    bytes: number,
    outcome: "success" | "failure",
    startedAt: number,
    detail?: string,
  ): Promise<void> {
    return this.audit.settle(rowId, outcome, Date.now() - startedAt, { bytes }, detail);
  }
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
