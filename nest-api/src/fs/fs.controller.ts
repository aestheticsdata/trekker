import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { FsQueryDto } from "@fs/dto/fs-query.dto";
import type { FileRowDetail } from "@fs/file-row";
import { type ListResult, FsService } from "@fs/fs.service";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";

/**
 * Reading the filesystem (TRE-13). Both routes are reads, so they carry the
 * session guard but not CSRF, matching how UsersController treats its GETs.
 */
@Controller("fs")
@UseGuards(SessionAuthGuard)
export class FsController {
  constructor(private readonly fs: FsService) {}

  @Get("list")
  list(@Req() req: Request, @Query() query: FsQueryDto): Promise<ListResult> {
    return this.fs.list(userIdOf(req), query.hostId, query.path);
  }

  @Get("stat")
  stat(@Req() req: Request, @Query() query: FsQueryDto): Promise<FileRowDetail> {
    return this.fs.stat(userIdOf(req), query.hostId, query.path);
  }
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}
