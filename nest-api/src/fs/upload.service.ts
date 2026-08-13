import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { toHttp } from "@fs/driver-http";
import { numberedName, partialName, safeFilename } from "@fs/upload-name";
import { isDriverError } from "@hosts/drivers/driver-error";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";

import type { HostDriver } from "@hosts/drivers/host-driver";
import type { Readable, Writable } from "node:stream";

/**
 * Putting a file onto a host without a shell (TRE-65).
 *
 * Three properties, each of which is the reason for a piece of this file:
 *
 * **Nothing is spooled.** The bytes go from the request socket to the
 * destination driver and are never held — not in memory, not in a temp file on
 * the API host. `multer`, which `@nestjs/platform-express` bundles, writes to
 * the API's own disk first; that is why this uses busboy at the controller and
 * takes a `Readable` here.
 *
 * **Nothing partial is ever called the real name.** The upload is written under
 * a hidden `.part` name in the destination directory and renamed into place
 * only once the stream has ended cleanly. An upload that dies halfway leaves a
 * `.part` file, which is removed on the way out; what it never leaves is a
 * truncated file under the name somebody is about to open.
 *
 * **The limit is enforced against the bytes, not the header.** `Content-Length`
 * is a claim by the client. The counter here is incremented from the chunks
 * actually received, so a client that understates it is cut off at the same
 * byte as one that is honest.
 */

/** Ten gigabytes, unless the install says otherwise. */
const DEFAULT_MAX_BYTES = 10 * 1024 ** 3;

/**
 * How much is spent against the hourly byte budget at a time.
 *
 * Spending per chunk would be a Redis round trip per 64 KB. Spending once at
 * the end would be a budget that never refuses anything. Sixty-four megabytes
 * is the granularity at which the budget is worth about a second of transfer,
 * which is close enough to "enforced" and cheap enough to ignore.
 */
const BUDGET_UNIT = 64 * 1024 ** 2;

export function maxUploadBytes(): number {
  const override = Number.parseInt(process.env.TREKKER_UPLOAD_MAX_BYTES ?? "", 10);
  return Number.isNaN(override) || override < 1 ? DEFAULT_MAX_BYTES : override;
}

/** What to do when the destination already holds this name. */
export type ConflictPolicy = "overwrite" | "skip" | "keepBoth";

export interface UploadOutcome {
  /** The name as sent, before sanitising — so the UI can pair it with its row. */
  requested: string;
  /** What it ended up called on the host, or null when nothing was written. */
  name: string | null;
  ok: boolean;
  bytes: number;
  /** Present when `ok` is false, or when the policy was `skip` and it applied. */
  code?: string;
  message?: string;
}

/**
 * Raised while the body is still arriving, so the controller can stop reading
 * it rather than let busboy run to the end of a file nobody will keep.
 */
export class UploadRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY,
  ) {
    super(message);
    this.name = "UploadRefused";
  }
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly limits: RateLimitService,
  ) {}

  /**
   * The destination, decided once for the whole request.
   *
   * Before busboy is handed the body, and that ordering is the point: the
   * directory arrives as a query parameter precisely so it can be validated
   * while the request body is still unread. A multipart field would arrive
   * *after* the file part in a client's own ordering, which would mean either
   * buffering the file to find out where it goes or writing it somewhere and
   * asking afterwards.
   */
  async destination(userId: string, hostId: string, directory: string): Promise<{ driver: HostDriver; real: string }> {
    const driver = await this.driverFor(hostId, userId);
    // WRITE, and the guard's own refusal — an upload creates a file, so a
    // read-only root must refuse it exactly as a rename does.
    const validated = await this.guard.validate({ driver, userId, path: directory, intent: "write" });

    const stat = await this.statOf(driver, validated.realPath);
    if (stat.kind !== "directory") {
      throw new BadRequestException(`${directory} is not a directory.`);
    }

    return { driver, real: validated.realPath };
  }

  /**
   * One file, from the socket to the host.
   *
   * Never throws for an ordinary failure — a refused name, a conflict skipped,
   * a host that said no — because a request may carry several files and one
   * bad name should not discard the four that were fine. The exception is
   * `UploadRefused`, raised for the size limit and the byte budget, which the
   * controller uses to stop reading the body: past those there is no point
   * receiving the rest.
   */
  async receive(
    userId: string,
    driver: HostDriver,
    directory: string,
    requested: string,
    body: Readable,
    conflict: ConflictPolicy,
  ): Promise<UploadOutcome> {
    const name = safeFilename(requested);
    if (name === "") {
      body.resume();
      return {
        requested,
        name: null,
        ok: false,
        bytes: 0,
        code: "EBADNAME",
        message: "That filename has nothing usable in it.",
      };
    }

    // Asked before a byte is written. `skip` means "do not upload this", and
    // uploading it into a temporary file first would move the bytes anyway —
    // which is the whole cost the answer exists to avoid.
    if (conflict === "skip" && (await this.exists(driver, join(directory, name)))) {
      body.resume();
      return { requested, name, ok: true, bytes: 0, code: "ESKIPPED", message: "Already there; left alone." };
    }

    const partial = join(directory, partialName(randomBytes(9).toString("hex")));
    let bytes = 0;
    let target: Writable | null = null;

    try {
      target = await driver.createWriteStream(partial);
      const limit = maxUploadBytes();
      let spent = 0;

      // The counting happens here rather than in a Transform so the refusal can
      // be thrown from inside the pipeline, which destroys both ends — a
      // Transform that merely stopped pushing would leave the socket draining
      // a file nobody is writing down.
      await pipeline(
        body,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            bytes += chunk.length;
            if (bytes > limit) {
              throw new UploadRefused(
                "ETOOLARGE",
                `${name} is over the ${formatBytes(limit)} limit for one upload.`,
                HttpStatus.PAYLOAD_TOO_LARGE,
              );
            }
            yield chunk;
          }
        },
        target,
      );

      // Spent after the fact but in units, so the *next* upload is the one that
      // is refused. Charging up front would mean trusting Content-Length, which
      // is the header this whole path exists not to trust.
      spent = Math.ceil(bytes / BUDGET_UNIT);
      if (spent > 0) {
        const verdict = await this.limits.consume(LIMITS.uploadedBytes, userId, spent);
        if (!verdict.allowed) {
          await this.discard(driver, target, partial);
          throw new UploadRefused(
            "ETOOMUCH",
            RateLimitService.describe(LIMITS.uploadedBytes, verdict.resetSeconds),
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }

      const final = await this.settleName(driver, directory, name, conflict);
      if (final === null) {
        await this.discard(driver, target, partial);
        return { requested, name, ok: true, bytes: 0, code: "ESKIPPED", message: "Already there; left alone." };
      }

      // The one moment the file becomes real. `rename` within a directory is
      // atomic on every filesystem this runs on, so a reader sees the old file
      // or the new one and never a half of either.
      await driver.rename(partial, final);
      return { requested, name: basename(final), ok: true, bytes };
    } catch (error) {
      // Whatever happened, the `.part` does not stay. It is hidden and named,
      // so one that survives a hard crash is identifiable — but an error we
      // caught is not a crash, and leaving litter behind would make the
      // difference impossible to see later.
      await this.discard(driver, target, partial);

      if (error instanceof UploadRefused) throw error;
      if (isDriverError(error)) {
        return {
          requested,
          name,
          ok: false,
          bytes,
          code: error.code,
          message:
            error.code === "EACCES" || error.code === "EPERM"
              ? "Permission denied on the host."
              : `The host refused with ${error.code}.`,
        };
      }

      this.logger.warn(`Upload of ${name} failed after ${bytes} bytes: ${(error as Error).message}`);
      return { requested, name, ok: false, bytes, code: "EUNKNOWN", message: "The upload did not complete." };
    }
  }

  /**
   * The name the file will actually take, decided as late as possible.
   *
   * Late because the check is a race either way and this is the cheapest place
   * to lose it: a `keepBoth` that picked its number before the transfer would
   * be answering a question about a directory as it was several minutes ago.
   * Returns null when the answer is now "skip" — the file appeared while this
   * upload was arriving.
   */
  private async settleName(
    driver: HostDriver,
    directory: string,
    name: string,
    conflict: ConflictPolicy,
  ): Promise<string | null> {
    const path = join(directory, name);
    if (!(await this.exists(driver, path))) return path;

    if (conflict === "overwrite") return path;
    if (conflict === "skip") return null;

    for (let attempt = 2; attempt < 1000; attempt += 1) {
      const candidate = join(directory, numberedName(name, attempt));
      if (!(await this.exists(driver, candidate))) return candidate;
    }
    // A thousand copies of one name is not a conflict, it is a loop somewhere.
    throw new UploadRefused("ETOOMANYCOPIES", `There are already a thousand copies of ${name} here.`);
  }

  /**
   * Remove the partial, after making sure nothing is still going to write it.
   *
   * The wait is not defensive tidiness, it is a bug this file had until a test
   * caught it. `createWriteStream` opens lazily, so a refusal on the first
   * chunk destroys a stream whose `open(O_CREAT)` is still in flight — and that
   * open lands *after* the unlink and recreates the file. An empty `.part`
   * would then be left in every directory anyone tried to upload something too
   * large into. Waiting for `close` means the fd is settled before the entry is
   * removed, in either order of events.
   */
  private async discard(driver: HostDriver, target: Writable | null, path: string): Promise<void> {
    if (target !== null && !target.closed) {
      target.destroy();
      await new Promise<void>((resolve) => {
        target.once("close", resolve);
        // A stream that errored may never emit `close`; the unlink below is
        // harmless against a file that was never made.
        target.once("error", () => resolve());
      });
    }

    await driver.unlink(path).catch(() => {
      // Already gone, or never created. Nothing to report: this runs on the
      // failure path and a second failure here would replace the first.
    });
  }

  private async exists(driver: HostDriver, path: string): Promise<boolean> {
    return driver.stat(path).then(
      () => true,
      () => false,
    );
  }

  private async statOf(driver: HostDriver, realPath: string) {
    try {
      return await driver.stat(realPath);
    } catch (error) {
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }

  private async driverFor(hostId: string, userId: string): Promise<HostDriver> {
    try {
      return await this.factory.forHost(hostId, userId);
    } catch (error) {
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }
}

/** The HTTP exception an `UploadRefused` becomes once the controller is done. */
export function toRefusalException(error: UploadRefused): HttpException {
  return new HttpException({ statusCode: error.status, code: error.code, message: error.message }, error.status);
}

function join(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(0)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${bytes} bytes`;
}
