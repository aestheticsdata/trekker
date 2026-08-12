import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { Audited } from "@audit/audited.decorator";
import { AuditService } from "@audit/audit.service";
import { LIMITS } from "@audit/limits";
import { ChangeModeDto } from "@fs/dto/change-mode.dto";
import { ChangeOwnerDto } from "@fs/dto/change-owner.dto";
import { FsQueryDto } from "@fs/dto/fs-query.dto";
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
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";

/**
 * Reading the filesystem (TRE-13) and changing what it permits (TRE-21).
 *
 * The reads carry the session guard alone, matching how UsersController treats
 * its GETs. The two writes add CSRF and `@Audited`: they are the first routes
 * in this application that change another machine, and both facts about them —
 * that they are recorded, and that they are bounded — are decided here rather
 * than remembered later.
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
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
