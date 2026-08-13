import { Module } from "@nestjs/common";
import { DeleteService } from "@fs/delete.service";
import { FsController } from "@fs/fs.controller";
import { FsService } from "@fs/fs.service";
import { IdResolverService } from "@fs/id-resolver.service";
import { PermissionsService } from "@fs/permissions.service";
import { RenameService } from "@fs/rename.service";

/**
 * HostsModule is @Global, so HostDriverFactory and PathGuardService inject
 * here without being imported. AuditModule is @Global for the same reason,
 * which is what lets the controller annotate its own rows (TRE-30).
 */
@Module({
  controllers: [FsController],
  providers: [FsService, IdResolverService, PermissionsService, RenameService, DeleteService],
  exports: [FsService, IdResolverService, PermissionsService, RenameService, DeleteService],
})
export class FsModule {}
