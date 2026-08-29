import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { Audited, NotAudited } from "@audit/audited.decorator";
import { AuditService } from "@audit/audit.service";
import { LIMITS } from "@audit/limits";
import { ChangeModeDto } from "@fs/dto/change-mode.dto";
import { ChangeOwnerDto } from "@fs/dto/change-owner.dto";
import { CreateEntryDto } from "@fs/dto/create-entry.dto";
import { CreateService } from "@fs/create.service";
import { DirSizesQueryDto } from "@fs/dto/dir-sizes-query.dto";
import { type DirSizeFrame, DirSizeService } from "@fs/dir-size.service";
import { DeleteDto, DeletePlanDto } from "@fs/dto/delete.dto";
import { FsQueryDto } from "@fs/dto/fs-query.dto";
import { RenameBatchDto } from "@fs/dto/rename-batch.dto";
import { RenameDto } from "@fs/dto/rename.dto";
import { TailQueryDto } from "@fs/dto/tail-query.dto";
import { type DeletePlan, type DeleteResult, DeleteService } from "@fs/delete.service";
import { contentDisposition, DOWNLOAD_CONTENT_TYPE, DOWNLOAD_CSP, parseRange, rangeLength } from "@fs/download-headers";
import { sendDownload } from "@fs/download-response";
import { DownloadService } from "@fs/download.service";
import type { FileRowDetail } from "@fs/file-row";
import { type ListResult, FsService } from "@fs/fs.service";
import {
  type ChangeResult,
  type CountResult,
  describeMode,
  parseMode,
  specialBits,
  PermissionsService,
} from "@fs/permissions.service";
import { UndoPermissionsDto } from "@fs/dto/undo-permissions.dto";
import { PermissionsUndoService, type UndoResult } from "@fs/permissions-undo.service";
import type { RenamePlan } from "@fs/rename-plan";
import { type RenameResult, RenameService } from "@fs/rename.service";
import { TailService } from "@fs/tail.service";
import { heartbeat, lastEventIdOf, openStream, sendFrame, subscriberFor } from "@fs/tail-sse";
import { UploadQueryDto } from "@fs/dto/upload.dto";
import { receiveMultipart } from "@fs/upload-multipart";
import { type MadeDirectories, toRefusalException, type UploadOutcome, UploadService } from "@fs/upload.service";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";

/**
 * Reading the filesystem (TRE-13), changing what it permits (TRE-21), changing
 * what things are called (TRE-22) and making new ones (TRE-69).
 *
 * The reads carry the session guard alone, matching how UsersController treats
 * its GETs. The writes add CSRF and `@Audited`: they are the routes in this
 * application that change another machine, and both facts about them — that
 * they are recorded, and that they are bounded — are decided here rather than
 * remembered later.
 *
 * `rename/preview` is the one POST here that is exempt, and its exemption says
 * why at the route. It is a POST for its body alone.
 *
 * The `describe` callbacks run before the handler, so they see only what the
 * request claims. What actually happened — how many entries changed, which
 * paths refused — is annotated afterwards, once the service has been.
 */
@Controller("fs")
@UseGuards(SessionAuthGuard)
export class FsController {
  constructor(
    private readonly fs: FsService,
    private readonly dirSizes: DirSizeService,
    private readonly permissions: PermissionsService,
    private readonly permissionsUndo: PermissionsUndoService,
    private readonly rename: RenameService,
    private readonly create: CreateService,
    private readonly remove: DeleteService,
    private readonly download: DownloadService,
    private readonly upload: UploadService,
    private readonly tail: TailService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A live tail, as server-sent events (TRE-34).
   *
   * Declared before `list` for no routing reason — `fs/tail` collides with
   * nothing — but next to the other reads, because that is what it is.
   *
   * `async`, and the ordering is the whole design of the handler. Everything
   * that can refuse — the rate limit, the roots guard, "that is not a regular
   * file", the concurrency caps — runs inside `open()` **before** a single
   * header is written, so a refusal is a real 403, 404, 409 or 429. After
   * `openStream` the status line is spent and the only thing left to say is an
   * `error` frame on a response that already returned 200.
   *
   * No CSRF: a GET is exempt on both sides, which is what lets the front open
   * this with an `EventSource` — an `EventSource` cannot set a header, so a
   * stream demanding one would be a stream the browser could never open.
   *
   * Not audited, and not exempted either: `audit-coverage.spec.ts` scans the
   * mutating verbs, and a GET is outside it — the same position the five reads
   * above are in. The bound that does apply is `LIMITS.tail`, spent by name
   * inside the service because a GET has no decorator to declare one on.
   */
  @Get("tail")
  async tailFile(@Req() req: Request, @Res() res: Response, @Query() query: TailQueryDto): Promise<void> {
    const request = req as AuthenticatedRequest;

    const opened = await this.tail.open({
      userId: request.user.id,
      sessionId: req.sessionID,
      hostId: query.hostId,
      path: query.path,
      lines: query.lines,
      lastEventId: lastEventIdOf(req.headers["last-event-id"]),
      subscriber: subscriberFor(res),
    });

    openStream(res);
    sendFrame(res, {
      event: "ready",
      data: {
        hostId: query.hostId,
        path: opened.realPath,
        source: opened.source,
        shared: opened.shared,
        resumed: opened.resumed,
      },
    });

    const ping = heartbeat(res);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      opened.unsubscribe();
    };

    // `close` covers the ordinary end and the killed browser alike. `error` is
    // here because a socket reset surfaces as `error` and does not always
    // follow with `close` — and a subscriber left behind is a source that never
    // learns nobody is listening, which is the leak this ticket is about.
    req.on("close", close);
    res.on("error", close);
  }

  @Get("list")
  list(@Req() req: Request, @Query() query: FsQueryDto): Promise<ListResult> {
    return this.fs.list(userIdOf(req), query.hostId, query.path);
  }

  @Get("stat")
  stat(@Req() req: Request, @Query() query: FsQueryDto): Promise<FileRowDetail> {
    return this.fs.stat(userIdOf(req), query.hostId, query.path);
  }

  /**
   * What the directories in a listing actually contain (TRE-107).
   *
   * Server-sent events, and the shape the scan feed uses rather than the tail's
   * — one payload kind, sent bare, because this is a progress feed and has
   * nothing to discriminate. A frame is either one directory's answer or the
   * `{ done: true }` that says the queue drained.
   *
   * The ordering is `tailFile`'s, for `tailFile`'s reason: the rate limit, the
   * roots guard and the `readdir` all run inside `open()` **before** a header
   * is written, so a refusal is a real 403, 404 or 429. `start()` is separate
   * from `open()` so the first frame cannot outrun `openStream` — a warm `du`
   * answers faster than the next line of this handler runs.
   *
   * Closing the stream is the only way this ends early, and it is the feature:
   * navigating away kills every `du` it started, which is what keeps a
   * held-down arrow key from leaving a walk per directory on somebody's server.
   *
   * No CSRF, for `tailFile`'s reason — an `EventSource` cannot set a header.
   * Not audited: a GET, like the five reads above it.
   */
  @Get("dir-sizes/stream")
  async dirSizeStream(@Req() req: Request, @Res() res: Response, @Query() query: DirSizesQueryDto): Promise<void> {
    const request = req as AuthenticatedRequest;

    const opened = await this.dirSizes.open({
      userId: request.user.id,
      // An open sudo window makes the difference between a directory's real
      // total and the part of it this account happens to be able to read.
      sessionId: req.sessionID,
      hostId: query.hostId,
      path: query.path,
      firstVisible: query.firstVisible ?? 0,
      visibleCount: query.visibleCount ?? 0,
    });

    openStream(res);
    const send = (payload: DirSizeFrame | { done: true }): void => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const run = opened.start(send);
    const ping = heartbeat(res);

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      run.cancel();
    };

    // `error` as well as `close`, for the reason `tailFile` gives: a socket
    // reset surfaces as `error` and does not always bring a `close` with it,
    // and a run left behind is a `du` nobody is waiting for.
    req.on("close", close);
    res.on("error", close);

    await run.done;
    close();
    send({ done: true });
    res.end();
  }

  /**
   * What a recursive change would touch. The modal asks the moment the box is
   * ticked, because "apply to everything underneath" is a promise nobody can
   * evaluate without the number.
   */
  @Get("count")
  count(@Req() req: Request, @Query() query: FsQueryDto): Promise<CountResult> {
    return this.permissions.count(userIdOf(req), query.hostId, query.path);
  }

  /**
   * A file, or a directory as a zip (TRE-26).
   *
   * The only route here that writes to the response itself, and the only one
   * whose audit row is not the interceptor's doing. Both follow from it being a
   * GET that streams: the interceptor watches the mutating verbs by design, and
   * a body this size cannot be an object Nest serialises.
   *
   * No CSRF, and that is not an oversight — a GET is exempt on both sides
   * (`SAFE_HTTP_METHODS`), which is what lets the front do this as an anchor.
   * An anchor cannot set a header, so a download demanding one would be a
   * download the browser's own Save-As could never perform.
   *
   * Everything that can refuse does so in `plan()`, before the response is
   * touched. After the first byte there is no status line left to change.
   */
  @Get("download")
  async downloadPath(@Req() req: Request, @Res() res: Response, @Query() query: FsQueryDto): Promise<void> {
    const userId = userIdOf(req);
    const plan = await this.download.plan(userId, query.hostId, query.path);

    const headers: Record<string, string> = {
      "Content-Type": DOWNLOAD_CONTENT_TYPE,
      "Content-Disposition": contentDisposition(plan.filename),
      // Neither of these is the control — the disposition and the opaque type
      // are — but a sniffed type is how a `.txt` full of markup became a page
      // often enough that the header exists.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": DOWNLOAD_CSP,
      // A file's bytes are the same bytes every time; an archive's are built
      // fresh and differ run to run. Neither should sit in a shared cache.
      "Cache-Control": "private, no-store",
    };

    if (plan.kind === "directory") {
      // No length and no ranges: the archive is produced as it is sent, so its
      // size is unknown until it is over. Saying `none` is better than staying
      // silent — a client that assumes ranges work and asks for one gets a
      // whole archive from byte zero and no explanation.
      headers["Accept-Ranges"] = "none";
      const opened = await this.download.open(userId, req.sessionID, query.hostId, query.path, plan, null);
      return sendDownload(res, opened, { status: HttpStatus.OK, headers });
    }

    const size = plan.size ?? 0;
    const verdict = parseRange(req.headers.range, size);

    headers["Accept-Ranges"] = "bytes";

    if (verdict.kind === "unsatisfiable") {
      // 416 carries the size so the client can ask again correctly, which is
      // the only useful thing this response has to say.
      res.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE).setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }

    const range = verdict.kind === "partial" ? verdict.range : null;
    const expectBytes = range ? rangeLength(range) : size;
    headers["Content-Length"] = String(expectBytes);
    if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;

    const opened = await this.download.open(userId, req.sessionID, query.hostId, query.path, plan, range);
    return sendDownload(res, opened, {
      status: range ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK,
      headers,
      expectBytes,
    });
  }

  /**
   * A file from the laptop onto a host (TRE-65).
   *
   * Destructive, and the flag is not a formality: `conflict=overwrite` replaces
   * a file that was there, with no undo and no trash. The row therefore keeps
   * the long retention and the route carries a limit, which is the pair
   * `audit-coverage.spec.ts` enforces.
   *
   * The body is never parsed by Nest. `@Req()` hands over the raw request and
   * busboy reads it a part at a time — see `upload-multipart.ts` for why multer
   * is the wrong tool and why the destination arrives in the query string.
   */
  @Post("upload")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.upload",
    destructive: true,
    limit: LIMITS.upload,
    // From the query, not the body — there is no parsed body on this route, and
    // `describe` runs before busboy has seen a byte of it.
    describe: (request) => {
      const query = request.query as { path?: string; conflict?: string };
      return {
        summary: `upload into ${query.path ?? "?"}`,
        paths: query.path ? [query.path] : [],
        payload: { conflict: query.conflict ?? "keepBoth" },
      };
    },
  })
  async uploadFiles(
    @Req() req: Request,
    @Query() query: UploadQueryDto,
  ): Promise<{ results: UploadOutcome[]; uploaded: number; bytes: number; failed: number }> {
    const userId = userIdOf(req);
    const conflict = query.conflict ?? "keepBoth";
    // Before the body is touched, which is the ordering the whole route is
    // arranged around.
    const { driver, real } = await this.upload.destination(userId, query.hostId, query.path);

    // One memo for the whole request (TRE-126). A folder arrives as many parts
    // sharing a handful of directories, and without this each part would make
    // and re-validate every one of them.
    const made: MadeDirectories = new Map();

    const { outcomes, refusal } = await receiveMultipart(req, (filename, stream) =>
      this.upload.receive(userId, driver, real, filename, stream, conflict, req.sessionID, made),
    );

    const uploaded = outcomes.filter((outcome) => outcome.ok && outcome.code !== "ESKIPPED").length;
    const bytes = outcomes.reduce((total, outcome) => total + outcome.bytes, 0);
    const failed = outcomes.filter((outcome) => !outcome.ok).length;

    this.audit.annotate(req, {
      hostId: query.hostId,
      summary: `uploaded ${count(uploaded, "file")} into ${query.path}`,
      tag: count(uploaded, "file"),
      bytes,
      payload: { uploaded, failed, skipped: outcomes.filter((outcome) => outcome.code === "ESKIPPED").length },
    });

    // Thrown after the annotation, so the row records what did land before the
    // request was cut off. A refusal that erased the successful half of its own
    // request would be the log lying by omission.
    if (refusal !== null) throw toRefusalException(refusal);

    return { results: outcomes, uploaded, bytes, failed };
  }

  /**
   * One new directory (TRE-69 §1).
   *
   * The two creates below are the only routes here that answer 201 rather than
   * 200, and they earn it: each one puts a resource on another machine and
   * hands back what it is. Everything else in this controller changes something
   * that was already there, which is why the rest pin themselves to 200 against
   * Nest's POST default.
   *
   * Not destructive — `mkdir` refuses an existing name rather than replacing
   * one — so the coverage spec does not require a limit. It carries one anyway;
   * see `LIMITS.entryCreate`.
   */
  @Post("mkdir")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.CREATED)
  @Audited({
    kind: "file.mkdir",
    limit: LIMITS.entryCreate,
    describe: (request) => {
      const body = request.body as { hostId?: string; path?: string; name?: string };
      return {
        summary: `mkdir ${body.name ?? "?"} in ${body.path ?? "?"}`,
        hostId: body.hostId,
        // The containing directory, not the new path: this is what the guard
        // adjudicated, and it is the path that existed when the row was written.
        paths: body.path ? [body.path] : [],
        payload: { name: body.name },
      };
    },
  })
  async makeDirectory(@Req() req: Request, @Body() dto: CreateEntryDto): Promise<FileRowDetail> {
    const entry = await this.create.mkdir(userIdOf(req), dto.hostId, dto.path, dto.name);
    this.audit.annotate(req, { hostId: dto.hostId, payload: { created: entry.path, mode: entry.mode } });
    return entry;
  }

  /**
   * One new empty file (TRE-69 §1).
   *
   * Exclusive, and that is the whole ticket: the driver opens with `O_EXCL`, so
   * this route cannot empty a file that is already under the name it was given.
   * A create that lost that race would answer 200 having destroyed the thing
   * the operator was about to open.
   */
  @Post("create")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.CREATED)
  @Audited({
    kind: "file.create",
    limit: LIMITS.entryCreate,
    describe: (request) => {
      const body = request.body as { hostId?: string; path?: string; name?: string };
      return {
        summary: `create ${body.name ?? "?"} in ${body.path ?? "?"}`,
        hostId: body.hostId,
        paths: body.path ? [body.path] : [],
        payload: { name: body.name },
      };
    },
  })
  async makeFile(@Req() req: Request, @Body() dto: CreateEntryDto): Promise<FileRowDetail> {
    const entry = await this.create.createFile(userIdOf(req), dto.hostId, dto.path, dto.name);
    this.audit.annotate(req, { hostId: dto.hostId, payload: { created: entry.path, mode: entry.mode } });
    return entry;
  }

  @Post("chmod")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.chmod",
    // Destructive in the sense the retention window means: this is the route
    // that grants privilege. A setuid bit set here outlives everything else in
    // this log, which is why the row is kept four times as long.
    destructive: true,
    limit: LIMITS.permissionChange,
    describe: (request) => {
      const body = request.body as { paths?: string[]; mode?: string; recursive?: boolean };
      const paths = body.paths ?? [];
      const marks = /^[0-7]{3,4}$/.test(body.mode ?? "") ? specialBits(Number.parseInt(body.mode as string, 8)) : [];
      return {
        summary: `chmod ${body.mode ?? "?"} on ${count(paths.length, "path")}${body.recursive ? ", recursive" : ""}`,
        // The tag is what a filter keys on later. Nothing else in this log is
        // worth finding as urgently as the changes that left a setuid bit.
        tag: marks[0],
        paths,
        payload: { mode: body.mode, recursive: body.recursive === true, special: marks },
      };
    },
  })
  async chmod(
    @Req() req: Request,
    @Body() dto: ChangeModeDto,
  ): Promise<ChangeResult & { activityLogId: string | null }> {
    const mode = parseMode(dto.mode);
    const activityLogId = this.audit.rowIdOf(req);
    const result = await this.permissions.chmod(
      userIdOf(req),
      dto.hostId,
      dto.paths,
      mode,
      dto.recursive === true,
      req.sessionID,
      activityLogId ?? undefined,
    );

    this.audit.annotate(req, {
      // `elevated` in the summary and not only in the payload, because "what
      // did this session do as root" has to be answerable by reading the strip
      // rather than by opening every row (TRE-29).
      hostId: dto.hostId,
      summary:
        `chmod ${describeMode(mode)} on ${count(result.changed, "entry", "entries")}` +
        (result.elevated > 0 ? `, ${count(result.elevated, "as root", "as root")}` : ""),
      payload: {
        changed: result.changed,
        failed: result.failed,
        skippedLinks: result.skippedLinks,
        elevated: result.elevated,
      },
    });
    return { ...result, activityLogId };
  }

  @Post("chown")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.chown",
    destructive: true,
    limit: LIMITS.permissionChange,
    describe: (request) => {
      const body = request.body as { paths?: string[]; owner?: string; group?: string; recursive?: boolean };
      const target = [body.owner, body.group].filter(Boolean).join(":") || "?";
      return {
        summary: `chown ${target} on ${count((body.paths ?? []).length, "path")}${body.recursive ? ", recursive" : ""}`,
        paths: body.paths ?? [],
        payload: { owner: body.owner, group: body.group, recursive: body.recursive === true },
      };
    },
  })
  async chown(
    @Req() req: Request,
    @Body() dto: ChangeOwnerDto,
  ): Promise<ChangeResult & { activityLogId: string | null }> {
    const activityLogId = this.audit.rowIdOf(req);
    const result = await this.permissions.chown(
      userIdOf(req),
      dto.hostId,
      dto.paths,
      dto.owner,
      dto.group,
      dto.recursive === true,
      req.sessionID,
      activityLogId ?? undefined,
    );

    this.audit.annotate(req, {
      hostId: dto.hostId,
      summary:
        `chown on ${count(result.changed, "entry", "entries")}` +
        (result.elevated > 0 ? `, ${count(result.elevated, "as root", "as root")}` : ""),
      payload: {
        changed: result.changed,
        failed: result.failed,
        skippedLinks: result.skippedLinks,
        elevated: result.elevated,
      },
    });
    return { ...result, activityLogId };
  }

  @Post("chmod/undo")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.chmod.undo",
    destructive: true,
    limit: LIMITS.permissionChange,
    describe: (request) => {
      const body = request.body as { activityLogId?: string };
      return { summary: "undo chmod", payload: { undoes: body.activityLogId } };
    },
  })
  async undoChmod(@Req() req: Request, @Body() dto: UndoPermissionsDto): Promise<UndoResult> {
    const result = await this.permissionsUndo.undoChmod(userIdOf(req), dto.activityLogId, req.sessionID);
    this.audit.annotate(req, {
      hostId: result.hostId,
      summary: `undo chmod on ${count(result.restored, "entry", "entries")}`,
      payload: {
        restored: result.restored,
        failed: result.failed,
        elevated: result.elevated,
        undoes: dto.activityLogId,
      },
    });
    return result;
  }

  @Post("chown/undo")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.chown.undo",
    destructive: true,
    limit: LIMITS.permissionChange,
    describe: (request) => {
      const body = request.body as { activityLogId?: string };
      return { summary: "undo chown", payload: { undoes: body.activityLogId } };
    },
  })
  async undoChown(@Req() req: Request, @Body() dto: UndoPermissionsDto): Promise<UndoResult> {
    const result = await this.permissionsUndo.undoChown(userIdOf(req), dto.activityLogId, req.sessionID);
    this.audit.annotate(req, {
      hostId: result.hostId,
      summary: `undo chown on ${count(result.restored, "entry", "entries")}`,
      payload: {
        restored: result.restored,
        failed: result.failed,
        elevated: result.elevated,
        undoes: dto.activityLogId,
      },
    });
    return result;
  }

  /**
   * One entry, one new name (TRE-22). F2 in the explorer.
   *
   * Destructive in the same sense the mode changes are: there is no undo and no
   * trash, and a rename is how a file becomes one nobody can find again.
   */
  @Post("rename")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.rename",
    destructive: true,
    limit: LIMITS.rename,
    describe: (request) => {
      const body = request.body as { path?: string; newName?: string };
      return {
        summary: `rename ${basename(body.path ?? "?")} → ${body.newName ?? "?"}`,
        paths: body.path ? [body.path] : [],
        payload: { newName: body.newName },
      };
    },
  })
  async renameOne(@Req() req: Request, @Body() dto: RenameDto): Promise<RenameResult> {
    const result = await this.rename.renameOne(userIdOf(req), dto.hostId, dto.path, dto.newName);
    this.audit.annotate(req, { hostId: dto.hostId, payload: { renamed: result.renamed } });
    return result;
  }

  /**
   * What the pattern would do (TRE-22 §1), computed by the code that would do it.
   *
   * A POST because it carries a body, not because it changes anything — which
   * is why it validates the directory for read and why it is exempt below.
   */
  @Post("rename/preview")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @NotAudited(
    "A preview changes nothing on the host: it lists a directory, applies the pattern in a thread that is " +
      "always terminated, and returns names. The modal issues one per keystroke, so a row here would bury the " +
      "rename it precedes — and that rename is audited, with the pattern that produced it.",
  )
  preview(@Req() req: Request, @Body() dto: RenameBatchDto): Promise<RenamePlan & { directory: string }> {
    return this.rename.preview(
      userIdOf(req),
      dto.hostId,
      dto.paths,
      dto.pattern,
      dto.replacement,
      dto.global === true,
      dto.ignoreCase === true,
    );
  }

  @Post("rename/batch")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.rename",
    destructive: true,
    limit: LIMITS.rename,
    // The pattern is the operation. A row saying "renamed 40 files" without it
    // records that something happened and nothing about what — and this is the
    // one file operation whose damage is invisible in a listing afterwards.
    describe: (request) => {
      const body = request.body as { paths?: string[]; pattern?: string; replacement?: string };
      const paths = body.paths ?? [];
      return {
        summary: `rename ${count(paths.length, "entry", "entries")} · s/${body.pattern ?? ""}/${body.replacement ?? ""}/`,
        tag: count(paths.length, "file"),
        paths,
        payload: { pattern: body.pattern, replacement: body.replacement },
      };
    },
  })
  async renameBatch(@Req() req: Request, @Body() dto: RenameBatchDto): Promise<RenameResult> {
    const result = await this.rename.batch(
      userIdOf(req),
      dto.hostId,
      dto.paths,
      dto.pattern,
      dto.replacement,
      dto.global === true,
      dto.ignoreCase === true,
    );

    this.audit.annotate(req, {
      hostId: dto.hostId,
      summary: `renamed ${count(result.renamed, "entry", "entries")} in ${result.directory}`,
      payload: { renamed: result.renamed, stranded: result.stranded },
    });
    return result;
  }

  /**
   * What a delete would take (TRE-25 §3). A POST for its body, like
   * `rename/preview`, and exempt for the same reason: it removes nothing.
   *
   * It walks and it validates as a *write*, so a plan is never shown for
   * something the delete itself would refuse — a confirmation dialogue for an
   * operation that cannot happen is worse than the refusal.
   */
  @Post("delete/plan")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @NotAudited("Walks and reports. Removes nothing; the delete that follows is the audited event.")
  plan(@Req() req: Request, @Body() dto: DeletePlanDto): Promise<DeletePlan> {
    return this.remove.plan(userIdOf(req), dto.hostId, dto.paths);
  }

  @Post("delete")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.delete",
    destructive: true,
    limit: LIMITS.fileDelete,
    // The full path list, always. This is the one operation whose damage cannot
    // be read back off the filesystem afterwards — there is nothing left to
    // look at — so the row has to carry what was there before it ran. The
    // interceptor writes it before the handler, which is what makes it survive
    // a delete that fails halfway.
    describe: (request) => {
      const body = request.body as { paths?: string[] };
      const paths = body.paths ?? [];
      return {
        summary: `delete ${count(paths.length, "entry", "entries")}${paths.length === 1 ? ` · ${basename(paths[0])}` : ""}`,
        tag: count(paths.length, "entry", "entries"),
        paths,
      };
    },
  })
  async deletePaths(@Req() req: Request, @Body() dto: DeleteDto): Promise<DeleteResult> {
    const result = await this.remove.remove(userIdOf(req), dto.hostId, dto.paths, dto.confirmation, req.sessionID);

    const elevated = result.results.reduce((total, outcome) => total + (outcome.elevated ?? 0), 0);
    this.audit.annotate(req, {
      hostId: dto.hostId,
      summary:
        `deleted ${count(result.entriesRemoved, "entry", "entries")}, ${result.bytesFreed} bytes` +
        (elevated > 0 ? `, ${count(elevated, "as root", "as root")}` : ""),
      payload: {
        entriesRemoved: result.entriesRemoved,
        bytesFreed: result.bytesFreed,
        failed: result.failed,
        elevated,
      },
    });
    return result;
  }
}

/** The final segment, for a log line. Never used to build a path. */
function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
