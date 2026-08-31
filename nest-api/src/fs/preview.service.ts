import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { DownloadService } from "@fs/download.service";

import type { DownloadPlan, OpenedDownload } from "@fs/download.service";

/**
 * Reading a file to look at it (TRE-138), which is not downloading it.
 *
 * The distinction is the whole service. A download is a decision — it takes a
 * copy of somebody's data off the fleet, which is why `DownloadService` opens
 * an audit row that fails closed and spends a deliberately scarce budget. A
 * preview is a selection: the inspector asking for bytes because the cursor
 * stopped on an image. Routing selections through the download path would
 * write a `file.download` row per arrow-key press, which makes the log louder
 * and less true at the same time, and would burn the download budget on
 * looking.
 *
 * So this plans through `DownloadService.plan` with `charge: false` — the
 * guard, the stat and the not-a-regular-file refusal want no second
 * implementation — spends its own limit, opens no row (the precedent is
 * `tail`: a GET that reads contents and records nothing, because the log
 * answers "what was done to a fleet" and looking at a file the roots already
 * grant is not such an event), and reads its bytes through the same public
 * `stream` that TRE-66 uses, sudo fallback included.
 */

/**
 * The most bytes a preview will move, and there is deliberately no thumbnailer
 * behind this number. The expensive leg is the host — every byte crosses SSH
 * before anything could resize it — and decoding untrusted image bytes from a
 * remote machine belongs in the browser's sandboxed decoder, not in this
 * process. So the route refuses above the ceiling instead, before a byte is
 * read, and the box says why.
 *
 * Decimal, like every figure this application shows (TRE-133): 8 MB is
 * 8,000,000 bytes, not a mebibyte count wearing the wrong label.
 */
const DEFAULT_PREVIEW_CEILING = 8_000_000;

/** Overridable per install, the way `entryCeiling` is. */
export function previewCeiling(): number {
  const override = Number.parseInt(process.env.TREKKER_PREVIEW_BYTE_CEILING ?? "", 10);
  return Number.isNaN(override) || override < 1 ? DEFAULT_PREVIEW_CEILING : override;
}

@Injectable()
export class PreviewService {
  private readonly logger = new Logger(PreviewService.name);

  constructor(
    private readonly download: DownloadService,
    private readonly limits: RateLimitService,
  ) {}

  /**
   * Everything that can refuse, before the response is touched — the same
   * contract `DownloadService.plan` states, inherited by calling it.
   *
   * The limit is spent first, before the guard runs, so probing costs the
   * prober the same as a real preview — the position `signedLink` takes.
   */
  async plan(userId: string, hostId: string, path: string): Promise<DownloadPlan> {
    const verdict = await this.limits.consume(LIMITS.preview, userId);
    if (!verdict.allowed) {
      throw new HttpException(
        RateLimitService.describe(LIMITS.preview, verdict.resetSeconds),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const plan = await this.download.plan(userId, hostId, path, { charge: false });

    // Refused after the plan rather than before it, which means a directory
    // pays for the walk `plan` runs on one. Accepted, not fixed: the same walk
    // is reachable through the download route at the same cost, so refusing it
    // earlier here would add code without removing surface.
    if (plan.kind === "directory") {
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          code: "EISDIR",
          message: `${path} is a directory, and a preview reads one file.`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const ceiling = previewCeiling();
    const size = plan.size ?? 0;
    if (size > ceiling) {
      // `size` and `ceiling` ride along so the box can name the figure instead
      // of shrugging — the client formats them, this side only counts.
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          code: "EPREVIEWTOOBIG",
          message: `${path} is ${size.toLocaleString("en-GB")} bytes; previews stop at ${ceiling.toLocaleString("en-GB")}. Download it instead.`,
          size,
          ceiling,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return plan;
  }

  /**
   * The bytes, shaped like an opened download so `sendDownload` can send them
   * — same pipeline, same backpressure, same truncated-body-on-failure
   * behaviour — with a settle that has no row to close. The failure log stays:
   * a preview dying at the same byte every time is the same host signal a
   * download's is.
   *
   * With one carve-out the download does not need. The inspector aborts its
   * fetch the moment the selection moves on, and each abort reaches this side
   * as a premature close — so for a selection-driven read, that "failure" is
   * ordinary browsing and would outnumber every real one. It logs at debug;
   * the warning is kept for the failures a host caused.
   */
  async open(plan: DownloadPlan, sessionId?: string): Promise<OpenedDownload> {
    const stream = await this.download.stream(plan, null, sessionId);
    return {
      stream,
      settle: (bytes, outcome, detail) => {
        if (outcome === "failure") {
          if (/premature close/i.test(detail ?? "")) {
            this.logger.debug(`Preview of ${plan.realPath} abandoned by the client after ${bytes} bytes`);
          } else {
            this.logger.warn(`Preview of ${plan.realPath} ended after ${bytes} bytes: ${detail ?? "no detail"}`);
          }
        }
        return Promise.resolve();
      },
    };
  }
}
