import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { Audited, NotAudited } from "@audit/audited.decorator";
import { AuditService } from "@audit/audit.service";
import { LIMITS } from "@audit/limits";
import { ChangeModeDto } from "@fs/dto/change-mode.dto";
import { ChangeOwnerDto } from "@fs/dto/change-owner.dto";
import { DeleteDto, DeletePlanDto } from "@fs/dto/delete.dto";
import { FsQueryDto } from "@fs/dto/fs-query.dto";
import { RenameBatchDto } from "@fs/dto/rename-batch.dto";
import { RenameDto } from "@fs/dto/rename.dto";
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
import type { RenamePlan } from "@fs/rename-plan";
import { type RenameResult, RenameService } from "@fs/rename.service";
import { UploadQueryDto } from "@fs/dto/upload.dto";
import { receiveMultipart } from "@fs/upload-multipart";
import { toRefusalException, type UploadOutcome, UploadService } from "@fs/upload.service";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";

/**
 * Reading the filesystem (TRE-13), changing what it permits (TRE-21) and
 * changing what things are called (TRE-22).
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
    private readonly permissions: PermissionsService,
    private readonly rename: RenameService,
    private readonly remove: DeleteService,
    private readonly download: DownloadService,
    private readonly upload: UploadService,
    private readonly audit: AuditService,
  ) {}

  @Get("list")
  list(@Req() req: Request, @Query() query: FsQueryDto): Promise<ListResult> {
    return this.fs.list(userIdOf(req), query.hostId, query.path);
  }

  @Get("stat")
  stat(@Req() req: Request, @Query() query: FsQueryDto): Promise<FileRowDetail> {
    return this.fs.stat(userIdOf(req), query.hostId, query.path);
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

    const { outcomes, refusal } = await receiveMultipart(req, (filename, stream) =>
      this.upload.receive(userId, driver, real, filename, stream, conflict),
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
  async chmod(@Req() req: Request, @Body() dto: ChangeModeDto): Promise<ChangeResult> {
    const mode = parseMode(dto.mode);
    const result = await this.permissions.chmod(userIdOf(req), dto.hostId, dto.paths, mode, dto.recursive === true);

    this.audit.annotate(req, {
      hostId: dto.hostId,
      summary: `chmod ${describeMode(mode)} on ${count(result.changed, "entry", "entries")}`,
      payload: { changed: result.changed, failed: result.failed, skippedLinks: result.skippedLinks },
    });
    return result;
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
  async chown(@Req() req: Request, @Body() dto: ChangeOwnerDto): Promise<ChangeResult> {
    const result = await this.permissions.chown(
      userIdOf(req),
      dto.hostId,
      dto.paths,
      dto.owner,
      dto.group,
      dto.recursive === true,
    );

    this.audit.annotate(req, {
      hostId: dto.hostId,
      payload: { changed: result.changed, failed: result.failed, skippedLinks: result.skippedLinks },
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
    const result = await this.remove.remove(userIdOf(req), dto.hostId, dto.paths, dto.confirmation);

    this.audit.annotate(req, {
      hostId: dto.hostId,
      summary: `deleted ${count(result.entriesRemoved, "entry", "entries")}, ${result.bytesFreed} bytes`,
      payload: { entriesRemoved: result.entriesRemoved, bytesFreed: result.bytesFreed, failed: result.failed },
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
