import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { toHttp } from "@fs/driver-http";
import { readSpace } from "@fs/mount-table";
import { isPartialName, numberedName, partialName, safeRelativePath } from "@fs/upload-name";
import { resumeToken } from "@fs/upload-resume";
import { isDriverError } from "@hosts/drivers/driver-error";
import { mvArgv, rmArgv } from "@hosts/sudo/sudo-argv";
import { isPermissionRefusal, SudoRunnerService } from "@hosts/sudo/sudo-runner.service";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";

import type { FileEntry, HostDriver } from "@hosts/drivers/host-driver";
import type { ResumeClaim } from "@fs/upload-resume";
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

/**
 * How long a partial nobody came back for is kept (TRE-142).
 *
 * The sweep is the price of resume. A partial now outlives the attempt that
 * wrote it, which is the whole feature, and without something to take away the
 * abandoned ones every failed upload would leave a permanent hidden file in
 * somebody else's directory — an interrupted folder leaving one in every
 * subdirectory it reached.
 *
 * A week, because the thing being protected is a transfer somebody meant to
 * finish. Coming back the next morning, or after a weekend away from a laptop
 * that went to sleep mid-upload, has to still find its bytes there.
 */
const PARTIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function maxUploadBytes(): number {
  const override = Number.parseInt(process.env.TREKKER_UPLOAD_MAX_BYTES ?? "", 10);
  return Number.isNaN(override) || override < 1 ? DEFAULT_MAX_BYTES : override;
}

/**
 * The directories one request has already created and had validated (TRE-126).
 *
 * Made by the controller and shared across every part of a single request, so a
 * folder of two hundred files in ten subdirectories costs ten `mkdir` round
 * trips and ten guard checks rather than two hundred of each. Absent — as in
 * every caller that sends one file — means a memo of one, made here and thrown
 * away with the call.
 */
export type MadeDirectories = Map<string, string>;

/** What a client offers when it wants to continue rather than restart. */
export interface ResumeRequest {
  /** Hashed into the partial's name, so identity lives in the name alone. */
  claim: ResumeClaim;
  /**
   * The offset the client sliced its body at.
   *
   * Sent rather than inferred, and checked against the partial before a byte
   * is written. The server could simply append to whatever it has — but the
   * client has already decided which bytes to send, and if the two disagree
   * the result is a file made of the wrong halves that looks complete. So a
   * disagreement is refused and the transfer starts again, which is slow
   * exactly once and correct always.
   */
  from: number;
}

/**
 * How many files one survey may ask about (TRE-143).
 *
 * The same two hundred the multipart route takes, so the two halves of a
 * recovery are bounded alike: a batch that could be sent can be asked about.
 * A two-thousand-file selection is ten lookups, which is ten round trips rather
 * than one request holding two thousand paths.
 */
export const MAX_SURVEY = 200;

/** One file the caller is asking about. */
export interface SurveyRequest {
  /** Relative to the destination — `a.jpg`, or `photos/2019/a.jpg`. */
  name: string;
  /**
   * Present only for a file worth continuing.
   *
   * Its absence is not a smaller answer, it is a different question: without a
   * claim there is no token, so there is no partial to look for and `offset`
   * comes back zero. Which is correct for a packed file, whose partial is
   * random-named and was discarded when its request died.
   */
  claim?: ResumeClaim;
}

export interface SurveyAnswer {
  /** Echoed exactly as asked, so the caller can pair without re-deriving. */
  name: string;
  /** Something already holds that name in the destination. */
  there: boolean;
  /** What a partial holds. Always zero without a claim. */
  offset: number;
}

/** The three things a caller may add to a `receive`, none of them required. */
export interface ReceiveOptions {
  /** For the elevated write path (TRE-29). */
  sessionId?: string;
  /** Shared across the parts of one request (TRE-126). */
  made?: MadeDirectories;
  /** Present only on a single-part request, for a file worth continuing. */
  resume?: ResumeRequest;
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
    private readonly sudoRunner: SudoRunnerService,
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
  async destination(
    userId: string,
    hostId: string,
    directory: string,
    /**
     * Whether to take away the partials nobody came back for (TRE-142).
     *
     * Only the upload route asks for it. The offset lookup shares this method
     * and runs once per large file, and a folder of fifty of them would
     * otherwise be fifty listings of a directory to delete nothing from.
     */
    options: { sweep?: boolean } = {},
  ): Promise<{ driver: HostDriver; real: string }> {
    const driver = await this.driverFor(hostId, userId);
    // WRITE, and the guard's own refusal — an upload creates a file, so a
    // read-only root must refuse it exactly as a rename does.
    const validated = await this.guard.validate({ driver, userId, path: directory, intent: "write" });

    const stat = await this.statOf(driver, validated.realPath);
    if (stat.kind !== "directory") {
      throw new BadRequestException(`${directory} is not a directory.`);
    }

    if (options.sweep) await this.sweep(driver, validated.realPath);

    return { driver, real: validated.realPath };
  }

  /**
   * What is free where this upload is going, and how big the volume is
   * (TRE-144).
   *
   * Null for both when `df` could not answer, and no caller may read that as
   * zero: a host without a usable `df` has to go on accepting uploads, or a
   * check meant to prevent a full disk becomes an outage instead.
   *
   * Behind `destination`, so the path is validated as a write before anything
   * is measured. Free space is a fact about a volume and a volume is a fact
   * about a machine — answering for a path outside the roots would describe a
   * disk this user was never given.
   */
  async spaceAt(
    userId: string,
    hostId: string,
    directory: string,
  ): Promise<{ free: number | null; total: number | null }> {
    const { driver, real } = await this.destination(userId, hostId, directory);
    const space = await readSpace(driver, real);

    return space === null ? { free: null, total: null } : { free: space.freeBytes, total: space.totalBytes };
  }

  /**
   * The same question for a destination already resolved (TRE-144).
   *
   * The upload route holds the driver and the real path already, and would
   * otherwise pay for a second validation to learn one number.
   */
  freeAt(driver: HostDriver, real: string): Promise<number | null> {
    return readSpace(driver, real).then((space) => space?.freeBytes ?? null);
  }

  /**
   * How much of this file the host already holds (TRE-142).
   *
   * Asked before the body is built, because the answer decides what the body
   * *is*: the client sends `file.slice(offset)` and nothing else. Zero for
   * everything the server cannot positively identify — no partial, a directory
   * that does not exist yet, a path the guard refuses, a partial longer than
   * the file claims to be. Every one of those is a reason to send the whole
   * file, and none of them is a reason to fail.
   */
  async resumeOffset(
    userId: string,
    hostId: string,
    directory: string,
    requested: string,
    claim: ResumeClaim,
  ): Promise<{ offset: number }> {
    const { driver, real } = await this.destination(userId, hostId, directory);

    const placed = safeRelativePath(requested);
    if (placed === null) return { offset: 0 };

    const folder = await this.resolveFolder(userId, driver, real, placed.directories);
    if (folder === null) return { offset: 0 };

    const token = resumeToken({ ...claim, userId, hostId: driver.hostId, root: real, requested });
    const offset = await this.partialSize(driver, join(folder, partialName(token)));

    // A partial longer than the file it claims to be has nothing to do with
    // that file. Appending to it would produce something corrupt that looks
    // complete; starting over cannot.
    return { offset: offset > claim.size ? 0 : offset };
  }

  /**
   * What the host already has, for many files at once (TRE-143).
   *
   * The question a folder upload asks after its connection dropped: of these
   * two hundred names, which landed, which has bytes waiting, which never
   * arrived. Answering it is what lets the retry send only what is missing —
   * without it the only safe move is to send all two hundred again, which under
   * `keepBoth` means two hundred duplicates and under any policy means an
   * uplink spent twice.
   *
   * **One listing per directory, never a stat per file.** A stat is a round
   * trip, and two hundred round trips over SSH is the difference between a
   * lookup and a wait. Grouping by the directory each file would land in turns
   * a folder of two thousand into as many listings as it has directories.
   *
   * Answers come back in the order they were asked, one for one, including for
   * names the upload itself would refuse — a caller that had to reconcile a
   * shorter list against its own would be a caller with a new way to go wrong.
   */
  async survey(
    userId: string,
    hostId: string,
    directory: string,
    requested: readonly SurveyRequest[],
  ): Promise<SurveyAnswer[]> {
    const { driver, real } = await this.destination(userId, hostId, directory);

    const groups = new Map<string, { segments: readonly string[]; names: string[] }>();
    /** The sanitised last segment per requested name, or null when refused. */
    const finals = new Map<string, string | null>();

    for (const item of requested) {
      const placed = safeRelativePath(item.name);
      finals.set(item.name, placed?.name ?? null);
      if (placed === null) continue;

      const key = placed.directories.join("/");
      const group = groups.get(key) ?? { segments: placed.directories, names: [] };
      group.names.push(item.name);
      groups.set(key, group);
    }

    /** Every entry of every directory touched, by the path it sits under. */
    const listings = new Map<string, Map<string, number>>();

    for (const [key, group] of groups) {
      const folder = await this.resolveFolder(userId, driver, real, group.segments);
      if (folder === null) continue;

      // Typed on the recovery too: a bare `[]` widens the whole expression to
      // `any[]`, and the two reads below would stop being checked at all.
      const entries = await driver.list(folder).catch((): FileEntry[] => []);
      listings.set(key, new Map(entries.map((entry) => [entry.name, entry.size] as const)));
    }

    return requested.map((item) => {
      const final = finals.get(item.name) ?? null;
      const placed = final === null ? null : safeRelativePath(item.name);
      const listing = placed === null ? undefined : listings.get(placed.directories.join("/"));

      if (final === null || listing === undefined) return { name: item.name, there: false, offset: 0 };

      // Any entry, not only a file. A directory standing where the upload
      // wants to write is a name that is taken as surely as a file is, and the
      // upload would refuse it for exactly that reason.
      const there = listing.has(final);

      if (item.claim === undefined) return { name: item.name, there, offset: 0 };

      const token = resumeToken({ ...item.claim, userId, hostId: driver.hostId, root: real, requested: item.name });
      const offset = listing.get(partialName(token)) ?? 0;

      return { name: item.name, there, offset: offset > item.claim.size ? 0 : offset };
    });
  }

  /**
   * A relative path's directory on the host, or null if it is not reachable.
   *
   * Validated a segment at a time rather than joined and validated once, for
   * the reason `subdirectory` gives at length: a segment that is a symlink out
   * of the roots is a way out that no amount of string work can see. Null for a
   * directory not made yet and null for one the guard refuses, because both
   * mean the same thing to both callers — there is nothing here to find.
   */
  private async resolveFolder(
    userId: string,
    driver: HostDriver,
    root: string,
    segments: readonly string[],
  ): Promise<string | null> {
    let folder = root;

    for (const segment of segments) {
      try {
        const validated = await this.guard.validate({ driver, userId, path: join(folder, segment), intent: "write" });
        folder = validated.realPath;
      } catch {
        return null;
      }
    }

    return folder;
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
    root: string,
    requested: string,
    body: Readable,
    conflict: ConflictPolicy,
    options: ReceiveOptions = {},
  ): Promise<UploadOutcome> {
    const { sessionId, resume } = options;
    const made: MadeDirectories = options.made ?? new Map();

    // The whole path rather than only its last segment (TRE-126). A client
    // sending one file sends one segment and comes out of here unchanged.
    const placed = safeRelativePath(requested);
    if (placed === null) {
      body.resume();
      return {
        requested,
        name: null,
        ok: false,
        bytes: 0,
        code: "EBADNAME",
        message: "That path has a segment with nothing usable in it.",
      };
    }

    const name = placed.name;
    let directory = root;
    if (placed.directories.length > 0) {
      try {
        directory = await this.subdirectory(userId, driver, root, placed.directories, made);
      } catch (error) {
        body.resume();
        return { requested, name, ok: false, bytes: 0, ...folderRefusal(error) };
      }
    }

    // Asked before a byte is written. `skip` means "do not upload this", and
    // uploading it into a temporary file first would move the bytes anyway —
    // which is the whole cost the answer exists to avoid.
    if (conflict === "skip" && (await this.exists(driver, join(directory, name)))) {
      body.resume();
      return { requested, name, ok: true, bytes: 0, code: "ESKIPPED", message: "Already there; left alone." };
    }

    // The name a second attempt can find (TRE-142). Without a resume claim it
    // stays what it always was — random, unfindable, and removed on the way
    // out — because a client that is not going to come back has nothing to gain
    // from a partial that outlives it.
    const partial = join(
      directory,
      partialName(
        resume === undefined
          ? randomBytes(9).toString("hex")
          : resumeToken({ ...resume.claim, userId, hostId: driver.hostId, root, requested }),
      ),
    );

    // Counted apart, because they are owed to different things: the per-file
    // size limit is owed their sum, and the hourly byte budget only what this
    // request actually carried.
    let already = 0;
    let bytes = 0;
    let target: Writable | null = null;
    /** Settles when `tee` has finished, on the elevated path only (TRE-29). */
    let elevatedWrite: Promise<void> | null = null;

    if (resume !== undefined && resume.from > 0) {
      already = await this.partialSize(driver, partial);
      if (already !== resume.from) {
        body.resume();
        return {
          requested,
          name,
          ok: false,
          bytes: 0,
          code: "ERESUME",
          message: "What is here is not the length you continued from. Send it from the start.",
        };
      }
    }

    try {
      try {
        target = await driver.createWriteStream(partial, already > 0 ? { append: true } : undefined);
      } catch (error) {
        // The destination directory is root-owned, so even the `.part` cannot
        // be created as the login user. `sudo tee` writes it instead, and the
        // rename below goes the same way (TRE-29).
        if (!(isPermissionRefusal(error) && this.sudoRunner.isOpen(sessionId, driver.hostId))) throw error;
        // `tee` truncates, and `tee -a` is not on the sudo argv list — putting
        // it there is a security decision rather than a convenience. So a
        // resume that lands on the elevated path is refused and starts over,
        // which costs one transfer what a wrong flag would cost the file.
        if (already > 0) {
          body.resume();
          return {
            requested,
            name,
            ok: false,
            bytes: 0,
            code: "ERESUME",
            message: "That directory needs elevation, which cannot continue a partial. Send it from the start.",
          };
        }
        const write = this.sudoRunner.write(driver, sessionId, driver.hostId, partial);
        target = write.stdin;
        elevatedWrite = write.done;
      }
      const limit = maxUploadBytes();
      let spent = 0;

      // Where a failure on the destination is caught, now that `pipeline` is
      // not the thing catching it.
      //
      // This is not tidiness. A write that fails asynchronously — no space, a
      // channel that dropped — arrives as an `error` event and at no call site
      // at all; unnoticed, the code below would rename a truncated partial onto
      // the real name, which is the one outcome this whole file is arranged to
      // prevent. An unhandled `error` event would also take the process down.
      //
      // An array rather than a `let`, so the value survives the read: the
      // compiler can only see the assignment that never happens here, and
      // narrows a nullable local written from a listener down to nothing.
      const writeFailure: Error[] = [];
      target.on("error", (error: Error) => {
        writeFailure.push(error);
      });

      // Pumped by hand rather than through `pipeline` (TRE-142).
      //
      // `pipeline` destroys every stream it holds as soon as one of them
      // errors, and destroying a write stream throws away whatever it had
      // buffered. That was right while the partial was about to be unlinked
      // anyway; it is wrong now that a dropped connection is meant to leave its
      // bytes behind, because the partial would be there and be *empty* — which
      // is worse than not keeping one, since the next attempt would continue
      // from a length that is a lie.
      //
      // What the loop keeps from it: backpressure, so a slow host slows the
      // socket instead of filling this process, and the refusal thrown from
      // inside the read so the body stops at the byte it was refused on rather
      // than after the rest of a file nobody is going to keep.
      try {
        // Typed at the iteration rather than inferred: a `Readable` yields
        // `any`, and the byte counter that the whole size limit rests on is
        // not a number to take on trust from a stream's type declaration.
        for await (const chunk of body as AsyncIterable<Buffer>) {
          bytes += chunk.length;
          if (already + bytes > limit) {
            throw new UploadRefused(
              "ETOOLARGE",
              `${name} is over the ${formatBytes(limit)} limit for one upload.`,
              HttpStatus.PAYLOAD_TOO_LARGE,
            );
          }
          if (!target.write(chunk)) await once(target, "drain");
        }
      } finally {
        // Flushed on every path out, refusals included. What is on the host has
        // to be what the next attempt is told is there, and a buffer still held
        // in this process is exactly the difference between the two.
        await endStream(target);
      }

      if (writeFailure.length > 0) throw writeFailure[0];
      // Bytes reaching the pipe is not `tee` having written them. On the
      // elevated path the file exists only once this settles.
      if (elevatedWrite !== null) await elevatedWrite;

      // Spent after the fact but in units, so the *next* upload is the one that
      // is refused. Charging up front would mean trusting Content-Length, which
      // is the header this whole path exists not to trust.
      spent = Math.ceil(bytes / BUDGET_UNIT);
      if (spent > 0) {
        const verdict = await this.limits.consume(LIMITS.uploadedBytes, userId, spent);
        if (!verdict.allowed) {
          // Thrown rather than discarded first: the catch below decides what
          // becomes of the partial, and this is the one refusal whose bytes are
          // worth keeping — the budget is a statement about the clock, and the
          // same bytes are welcome in an hour.
          throw new UploadRefused(
            "ETOOMUCH",
            RateLimitService.describe(LIMITS.uploadedBytes, verdict.resetSeconds),
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }

      const final = await this.settleName(driver, directory, name, conflict);
      if (final === null) {
        await this.discard(driver, target, partial, { sessionId, hostId: driver.hostId });
        return { requested, name, ok: true, bytes: 0, code: "ESKIPPED", message: "Already there; left alone." };
      }

      // The one moment the file becomes real. `rename` within a directory is
      // atomic on every filesystem this runs on, so a reader sees the old file
      // or the new one and never a half of either.
      //
      // Under sudo it is `mv` rather than SFTP's rename, and it is the reason
      // `mv` is on the sudo list at all: without it a root-owned file would
      // have to be written over directly, and an interrupted save would leave
      // a truncated config rather than the original.
      try {
        await driver.rename(partial, final);
      } catch (error) {
        // Reached two ways: the directory was root-owned (so the write above
        // was elevated too), or it was writable but the *target* was not.
        if (!(isPermissionRefusal(error) && this.sudoRunner.isOpen(sessionId, driver.hostId))) throw error;
        await this.sudoRunner.run(driver, sessionId, driver.hostId, "mv", mvArgv(partial, final));
      }
      return { requested, name: basename(final), ok: true, bytes };
    } catch (error) {
      // Whether what is written is worth coming back to (TRE-142).
      //
      // The answer used to be always no, on reasoning that was right at the
      // time: an error we caught is not a crash, and litter would make the
      // difference impossible to see later. Resume needs the opposite for the
      // one case it exists for — a transfer the wire dropped — and the sweep is
      // what keeps that from becoming the litter the old reasoning meant.
      if (keepPartial(error, already + bytes, resume !== undefined)) await this.closeStream(target);
      else await this.discard(driver, target, partial, { sessionId, hostId: driver.hostId });

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
   * The directory one part of a folder upload goes into, made if it is not
   * there (TRE-126).
   *
   * Walked a segment at a time rather than made in one recursive `mkdir`, and
   * the reason is a symlink. `photos` may already exist on the host and point
   * at somewhere outside the roots; a recursive mkdir would cheerfully create
   * `photos/2019` inside it and the guard would only be asked afterwards, with
   * the directory already made. Creating one level and validating it before
   * descending means the guard refuses while nothing has been created outside.
   *
   * `recursive` is still set on each step, because it is the flag that makes an
   * existing directory not an error — it never creates more than the one level,
   * since everything above has already been walked.
   *
   * There is no elevated path here on purpose. `mkdir` is not on
   * `SUDO_ONLY_PROGRAMS` and putting it there is a security decision, not a
   * convenience: a folder upload into a root-owned tree fails at the first
   * directory, and says so, rather than quietly acquiring the ability to make
   * directories as root.
   */
  private async subdirectory(
    userId: string,
    driver: HostDriver,
    root: string,
    segments: readonly string[],
    made: MadeDirectories,
  ): Promise<string> {
    let real = root;
    let key = "";

    for (const segment of segments) {
      key = key === "" ? segment : `${key}/${segment}`;

      const known = made.get(key);
      if (known !== undefined) {
        real = known;
        continue;
      }

      const next = join(real, segment);
      await driver.mkdir(next, { recursive: true });
      const validated = await this.guard.validate({ driver, userId, path: next, intent: "write" });

      real = validated.realPath;
      made.set(key, real);

      // Once per directory per request, off the memo above. A folder upload
      // interrupted halfway leaves a partial in whichever subdirectory it had
      // reached, and this is the only moment anything looks in there.
      await this.sweep(driver, real);
    }

    return real;
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
   * Stop the write and wait for the descriptor to settle.
   *
   * The wait is not defensive tidiness, it is a bug this file had until a test
   * caught it. `createWriteStream` opens lazily, so a refusal on the first
   * chunk destroys a stream whose `open(O_CREAT)` is still in flight — and that
   * open lands *after* the unlink and recreates the file. An empty `.part`
   * would then be left in every directory anyone tried to upload something too
   * large into. Waiting for `close` means the fd is settled before the entry is
   * removed, in either order of events.
   *
   * Its own method since TRE-142, because a kept partial needs the waiting half
   * without the removing one: the next attempt stats this file to find its
   * offset, and statting it while a descriptor is still draining into it reads
   * a length that is about to change.
   */
  private async closeStream(target: Writable | null): Promise<void> {
    if (target === null || target.closed) return;

    target.destroy();
    await new Promise<void>((resolve) => {
      target.once("close", resolve);
      // A stream that errored may never emit `close`; the unlink that may
      // follow is harmless against a file that was never made.
      target.once("error", () => resolve());
    });
  }

  /** Close it, and take the partial away with it. */
  private async discard(
    driver: HostDriver,
    target: Writable | null,
    path: string,
    elevated?: { sessionId?: string; hostId: string },
  ): Promise<void> {
    await this.closeStream(target);

    await driver.unlink(path).catch(async () => {
      // Already gone, or never created, or root's — the last of those is the
      // one worth retrying, because a `.part` written by `tee` belongs to root
      // and the login user cannot remove it. Litter in `/etc` is exactly the
      // kind this file exists to avoid leaving.
      if (elevated && this.sudoRunner.isOpen(elevated.sessionId, elevated.hostId)) {
        await this.sudoRunner.run(driver, elevated.sessionId, elevated.hostId, "rm", rmArgv("file", path)).catch(() => {
          // Nothing to report: this runs on the failure path already, and a
          // second failure here would replace the first.
        });
      }
    });
  }

  /**
   * What a partial holds, or zero for anything that is not one (TRE-142).
   *
   * Never throws. Every failure here — no such file, a directory wearing the
   * name, a host that would not answer — means the same thing to both callers:
   * there is nothing to continue, so send the whole file.
   */
  private async partialSize(driver: HostDriver, path: string): Promise<number> {
    return driver.stat(path).then(
      (stat) => (stat.kind === "file" ? stat.size : 0),
      () => 0,
    );
  }

  /**
   * Take away the partials nobody came back for (TRE-142).
   *
   * Best effort, always. This is tidying, and tidying that can refuse an upload
   * is worse than the mess it prevents — so a listing that fails, an entry that
   * will not unlink, a host that is slow to answer all end the same way, with
   * the upload carrying on.
   *
   * `isPartialName` is what makes this safe to point at somebody's own
   * directory: it matches the shape this service writes and nothing else.
   */
  private async sweep(driver: HostDriver, directory: string): Promise<void> {
    const cutoff = Date.now() - PARTIAL_TTL_MS;

    try {
      for (const entry of await driver.list(directory)) {
        if (entry.kind !== "file" || !isPartialName(entry.name)) continue;
        if (entry.mtimeMs > cutoff) continue;

        await driver.unlink(join(directory, entry.name)).catch(() => {
          // Someone else's, or root's, or already gone. Left where it is.
        });
      }
    } catch {
      // The directory could not be listed. Nothing here is worth an upload.
    }
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

/**
 * End the write and wait for it to flush, whatever it makes of that.
 *
 * The counterpart of `closeStream`: that one throws the buffer away, this one
 * puts it on the host. Both resolve rather than reject, because both run where
 * the interesting error has already happened and a second one raised here would
 * replace the first.
 */
function endStream(target: Writable): Promise<void> {
  if (target.writableEnded || target.destroyed) return Promise.resolve();

  return new Promise((resolve) => {
    target.once("error", () => resolve());
    target.end(() => resolve());
  });
}

/**
 * Whether the bytes already written are worth a second attempt (TRE-142).
 *
 * The question is not "did this fail" — everything reaching here failed — but
 * "would coming back to it get a different answer". Three groups, and the
 * middle one is the only one that needed thinking about.
 */
function keepPartial(error: unknown, written: number, findable: boolean): boolean {
  // Nothing to come back to, or no way to come back to it. A partial written
  // without a resume claim carries a random name that nothing can look up
  // again, so keeping it would be litter rather than a saved transfer — which
  // is why this was the whole of the behaviour before TRE-142.
  if (written === 0 || !findable) return false;

  // A refusal about the file will refuse it again — except the hourly byte
  // budget, which is a refusal about the clock. Those bytes are welcome in an
  // hour, and discarding them would mean sending them twice.
  if (error instanceof UploadRefused) return error.code === "ETOOMUCH";

  // The host said no: permission, no space, a read-only mount. A second attempt
  // meets the same answer, and the partial would sit there until the sweep.
  if (isDriverError(error)) return false;

  // Everything else is the wire, which is the case this exists for.
  return true;
}

/**
 * Why a folder could not be made, in the shape an outcome takes.
 *
 * A part whose directory is refused fails on its own rather than taking the
 * request down, which is the same rule the rest of `receive` follows: one bad
 * name in a batch of fifty must not discard the forty-nine that were fine.
 */
function folderRefusal(error: unknown): { code: string; message: string } {
  if (isDriverError(error)) {
    return error.code === "EACCES" || error.code === "EPERM"
      ? { code: error.code, message: "Permission denied making that folder on the host." }
      : { code: error.code, message: `The host refused the folder with ${error.code}.` };
  }
  // The path guard's own refusal, which already reads as a sentence.
  if (error instanceof HttpException) return { code: "EPATH", message: error.message };
  return { code: "EUNKNOWN", message: "That folder could not be made on the host." };
}

function join(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/**
 * Round numbers for a sentence a person reads, not for arithmetic.
 *
 * Exported since TRE-144 so the route's "needs X, Y is free" refusal is worded
 * by the same function as the size limit's. Two formatters would eventually
 * disagree about a boundary, and the two messages sit one screen apart.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(0)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${bytes} bytes`;
}
