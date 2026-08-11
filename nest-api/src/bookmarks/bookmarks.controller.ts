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
  constructor(private readonly bookmarks: BookmarksService) {}

  @Get()
  list(@Req() req: Request): Promise<BookmarkView[]> {
    return this.bookmarks.list(userIdOf(req));
  }

  /** Declared before `:id`, or "reorder" is read as a bookmark id. */
  @Patch("reorder")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  reorder(@Req() req: Request, @Body() dto: ReorderBookmarksDto): Promise<BookmarkView[]> {
    return this.bookmarks.reorder(userIdOf(req), dto.hostId, dto.ids);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: Request, @Body() dto: CreateBookmarkDto): Promise<BookmarkView> {
    return this.bookmarks.create(userIdOf(req), dto);
  }

  @Patch(":id")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  update(@Req() req: Request, @Param("id") id: string, @Body() dto: UpdateBookmarkDto): Promise<BookmarkView> {
    return this.bookmarks.update(userIdOf(req), id, dto);
  }

  @Delete(":id")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  async remove(@Req() req: Request, @Param("id") id: string): Promise<{ ok: true }> {
    await this.bookmarks.remove(userIdOf(req), id);
    return { ok: true };
  }
}

function userIdOf(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}
