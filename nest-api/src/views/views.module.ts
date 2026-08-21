import { Module } from "@nestjs/common";
import { ViewsController } from "@views/views.controller";
import { ViewsService } from "@views/views.service";

/** Saved views (TRE-37). Prisma is global, so there is nothing to import. */
@Module({
  controllers: [ViewsController],
  providers: [ViewsService],
  exports: [ViewsService],
})
export class ViewsModule {}
