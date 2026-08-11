import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { CreateBookmarkDto } from "@bookmarks/dto/create-bookmark.dto";
import type { UpdateBookmarkDto } from "@bookmarks/dto/update-bookmark.dto";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Favourites (TRE-18 §3).
 *
 * A bookmark belongs to a host, and a host belongs to a user — there is no
 * `userId` column here. Every query therefore joins through `host: { userId }`
 * rather than filtering on the bookmark itself, which is what stops one account
 * reading, editing or deleting another's. A row that is not yours reads as 404,
 * never 403: the response must not confirm the id exists (the convention
 * HostsService set in TRE-12).
 *
 * Ordering is `position` within a host, which is all the schema can express —
 * `@@index([hostId, position])`. There is no cross-host order, so the client
 * groups by host rather than showing one flat list. Inventing a user-level
 * ordering would be a schema change, not an endpoint.
 */

export interface BookmarkView {
  id: string;
  hostId: string;
  path: string;
  label: string;
  hint: string | null;
  position: number;
}

@Injectable()
export class BookmarksService {
  private readonly logger = new Logger(BookmarksService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every favourite the user has, across every host they own. */
  async list(userId: string): Promise<BookmarkView[]> {
    const rows = await this.prisma.bookmarks.findMany({
      where: { host: { userId } },
      orderBy: [{ hostId: "asc" }, { position: "asc" }, { label: "asc" }],
    });
    return rows.map(toView);
  }

  async create(userId: string, dto: CreateBookmarkDto): Promise<BookmarkView> {
    await this.requireHost(userId, dto.hostId);

    // Appended by default, so adding one from the pane's context menu does not
    // silently land in the middle of the list.
    const position =
      dto.position ??
      ((
        await this.prisma.bookmarks.aggregate({
          where: { hostId: dto.hostId },
          _max: { position: true },
        })
      )._max.position ?? -1) + 1;

    try {
      const created = await this.prisma.bookmarks.create({
        data: {
          hostId: dto.hostId,
          path: cleanPath(dto.path),
          label: dto.label,
          hint: dto.hint ?? null,
          position,
        },
      });
      return toView(created);
    } catch (error) {
      // @@unique([hostId, path]) — bookmarking the same directory twice is a
      // double click, not an error worth a stack trace.
      if (isUniqueViolation(error)) {
        throw new ConflictException("That directory is already a favourite on this host");
      }
      throw error;
    }
  }

  async update(userId: string, id: string, dto: UpdateBookmarkDto): Promise<BookmarkView> {
    await this.require(userId, id);

    const updated = await this.prisma.bookmarks.update({
      where: { id },
      data: {
        label: dto.label ?? undefined,
        // Distinguished from absent: "" clears the second line.
        hint: dto.hint === undefined ? undefined : dto.hint === "" ? null : dto.hint,
        position: dto.position ?? undefined,
      },
    });
    return toView(updated);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.require(userId, id);
    await this.prisma.bookmarks.delete({ where: { id } });
    this.logger.log(`Bookmark deleted: ${id} for user ${userId}`);
  }

  /**
   * Reorder within one host, as one transaction.
   *
   * A drag produces a whole new order, not a delta, so the client sends the
   * list — rewriting every position is what makes the result independent of
   * how many intermediate states the drag passed through.
   */
  async reorder(userId: string, hostId: string, ids: readonly string[]): Promise<BookmarkView[]> {
    await this.requireHost(userId, hostId);

    const owned = await this.prisma.bookmarks.findMany({ where: { hostId }, select: { id: true } });
    const known = new Set(owned.map((row) => row.id));
    // An id from another host would move a row out from under its owner.
    if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
      throw new NotFoundException("The order must list exactly this host's bookmarks");
    }

    await this.prisma.$transaction(
      ids.map((id, position) => this.prisma.bookmarks.update({ where: { id }, data: { position } })),
    );

    return this.list(userId);
  }

  // ---- internals ----------------------------------------------------------

  private async require(userId: string, id: string): Promise<void> {
    const found = await this.prisma.bookmarks.findFirst({ where: { id, host: { userId } }, select: { id: true } });
    if (!found) throw new NotFoundException("Bookmark not found");
  }

  private async requireHost(userId: string, hostId: string): Promise<void> {
    const host = await this.prisma.hosts.findFirst({ where: { id: hostId, userId }, select: { id: true } });
    if (!host) throw new NotFoundException("Host not found");
  }
}

/** The same normalisation the path guard applies, so `/srv/` and `/srv` are one row. */
function cleanPath(path: string): string {
  return `/${path.trim().split("/").filter(Boolean).join("/")}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

function toView(row: {
  id: string;
  hostId: string;
  path: string;
  label: string;
  hint: string | null;
  position: number;
}): BookmarkView {
  return {
    id: row.id,
    hostId: row.hostId,
    path: row.path,
    label: row.label,
    hint: row.hint,
    position: row.position,
  };
}
