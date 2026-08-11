import { Module } from "@nestjs/common";
import { BookmarksController } from "@bookmarks/bookmarks.controller";
import { BookmarksService } from "@bookmarks/bookmarks.service";

/** Favourites (TRE-18 §3). Prisma is global, so there is nothing to import. */
@Module({
  controllers: [BookmarksController],
  providers: [BookmarksService],
  exports: [BookmarksService],
})
export class BookmarksModule {}
