import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { Audited, NotAudited } from "@audit/audited.decorator";
import { AuditService } from "@audit/audit.service";
import { LIMITS } from "@audit/limits";
import { ChangeModeDto } from "@fs/dto/change-mode.dto";
import { ChangeOwnerDto } from "@fs/dto/change-owner.dto";
import { FsQueryDto } from "@fs/dto/fs-query.dto";
import { RenameBatchDto } from "@fs/dto/rename-batch.dto";
import { RenameDto } from "@fs/dto/rename.dto";
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
