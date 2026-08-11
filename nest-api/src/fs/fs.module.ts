import { Module } from "@nestjs/common";
import { FsController } from "@fs/fs.controller";
import { FsService } from "@fs/fs.service";
import { IdResolverService } from "@fs/id-resolver.service";

/**
 * HostsModule is @Global, so HostDriverFactory and PathGuardService inject
 * here without being imported.
 */
@Module({
  controllers: [FsController],
  providers: [FsService, IdResolverService],
  exports: [FsService, IdResolverService],
})
export class FsModule {}
