import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuditService } from "@audit/audit.service";
import { Audited } from "@audit/audited.decorator";
import { type BookmarkView, BookmarksService } from "@bookmarks/bookmarks.service";
import { CreateBookmarkDto } from "@bookmarks/dto/create-bookmark.dto";
import { ReorderBookmarksDto } from "@bookmarks/dto/reorder-bookmarks.dto";
import { UpdateBookmarkDto } from "@bookmarks/dto/update-bookmark.dto";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { type AuthenticatedRequest, SessionAuthGuard } from "@users/guards/session-auth.guard";

/**
 * Favourites (TRE-18 §3). Session guard on every route, CSRF on every mutating
 * one — the shape HostsController set.
 *
 * Ownership is enforced in the service by joining through the host's `userId`,
 * so another account's bookmark id reads as 404 rather than 403.
 */
@Controller("bookmarks")
@UseGuards(SessionAuthGuard)
export class BookmarksController {
  constructor(
    private readonly bookmarks: BookmarksService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Req() req: Request): Promise<BookmarkView[]> {
    return this.bookmarks.list(userIdOf(req));
  }

  /** Declared before `:id`, or "reorder" is read as a bookmark id. */
  @Patch("reorder")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "bookmark.reorder",
    describe: (request) => {
      const body = request.body as { ids?: string[] };
      return {
        summary: "Reordered favourites",
        tag: body.ids ? `${body.ids.length} items` : undefined,
      };
    },
  })
  async reorder(@Req() req: Request, @Body() dto: ReorderBookmarksDto): Promise<BookmarkView[]> {
    const view = await this.bookmarks.reorder(userIdOf(req), dto.hostId, dto.ids);
    this.audit.annotate(req, { hostId: dto.hostId });
    return view;
  }

  @Post()
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.CREATED)
  @Audited({
    kind: "bookmark.create",
    describe: (request) => {
      const body = request.body as { label?: string; path?: string };
      return {
        summary: `Bookmarked ${body.path ?? "a path"}`,
        tag: body.label,
        paths: body.path ? [body.path] : undefined,
      };
    },
  })
  async create(@Req() req: Request, @Body() dto: CreateBookmarkDto): Promise<BookmarkView> {
    const bookmark = await this.bookmarks.create(userIdOf(req), dto);
    this.audit.annotate(req, { hostId: bookmark.hostId });
    return bookmark;
  }

  @Patch(":id")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "bookmark.update",
    describe: (request) => ({
      summary: "Edited a favourite",
      payload: { requestedBookmarkId: request.params.id },
    }),
  })
  async update(@Req() req: Request, @Param("id") id: string, @Body() dto: UpdateBookmarkDto): Promise<BookmarkView> {
    const bookmark = await this.bookmarks.update(userIdOf(req), id, dto);
    this.audit.annotate(req, { hostId: bookmark.hostId, summary: `Edited the favourite ${bookmark.label}` });
    return bookmark;
  }

  @Delete(":id")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "bookmark.delete",
    describe: (request) => ({
      summary: "Removed a favourite",
      payload: { requestedBookmarkId: request.params.id },
    }),
  })
  async remove(@Req() req: Request, @Param("id") id: string): Promise<{ ok: true }> {
    await this.bookmarks.remove(userIdOf(req), id);
    return { ok: true };
  }
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}
