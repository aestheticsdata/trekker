import { Module } from "@nestjs/common";
import { CreateService } from "@fs/create.service";
import { DeleteService } from "@fs/delete.service";
import { DownloadService } from "@fs/download.service";
import { FsController } from "@fs/fs.controller";
import { FsService } from "@fs/fs.service";
import { IdResolverService } from "@fs/id-resolver.service";
import { PermissionsService } from "@fs/permissions.service";
import { LinkController } from "@fs/link.controller";
import { LinkService } from "@fs/link.service";
import { RenameService } from "@fs/rename.service";
import { TailRegistryService } from "@fs/tail-registry.service";
import { TailService } from "@fs/tail.service";
import { UploadService } from "@fs/upload.service";

/**
 * HostsModule is @Global, so HostDriverFactory and PathGuardService inject
 * here without being imported. AuditModule is @Global for the same reason,
 * which is what lets the controller annotate its own rows (TRE-30). So is
 * SecretStoreModule, which is where the link-signing key comes from (TRE-66).
 *
 * `LinkController` is a second controller in this module rather than a route on
 * the first, because its GET carries no session guard and `FsController` puts
 * one on the class.
 */
@Module({
  controllers: [FsController, LinkController],
  providers: [
    FsService,
    IdResolverService,
    PermissionsService,
    RenameService,
    CreateService,
    DeleteService,
    DownloadService,
    UploadService,
    LinkService,
    TailService,
    TailRegistryService,
  ],
  exports: [
    FsService,
    IdResolverService,
    PermissionsService,
    RenameService,
    CreateService,
    DeleteService,
    DownloadService,
    UploadService,
    LinkService,
    TailService,
    TailRegistryService,
  ],
})
export class FsModule {}
