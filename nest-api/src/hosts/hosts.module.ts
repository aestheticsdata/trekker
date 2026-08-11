import { homedir } from "node:os";
import { Global, Module } from "@nestjs/common";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { DEFAULT_POOL_SETTINGS, SshConnectionPool } from "@hosts/drivers/ssh-connection.pool";
import { HostSummaryService } from "@hosts/host-summary.service";
import { HostsController } from "@hosts/hosts.controller";
import { HostsService } from "@hosts/hosts.service";
import { computeLocalDenylist } from "@hosts/path-guard/local-denylist";
import { LOCAL_DENYLIST, PathGuardService } from "@hosts/path-guard/path-guard.service";

/**
 * Global because the pool must be a singleton: two pools would each open their
 * own connection to the same host and the concurrency cap would count to twice
 * what the server allows.
 */
@Global()
@Module({
  controllers: [HostsController],
  providers: [
    { provide: SshConnectionPool, useFactory: () => new SshConnectionPool(DEFAULT_POOL_SETTINGS) },
    HostDriverFactory,
    // Computed once at boot: where the process runs does not change while it
    // runs, and every validate() call reads the same frozen list (TRE-11).
    { provide: LOCAL_DENYLIST, useFactory: () => computeLocalDenylist({ startDir: __dirname, homeDir: homedir() }) },
    PathGuardService,
    HostSummaryService,
    HostsService,
  ],
  exports: [HostDriverFactory, SshConnectionPool, PathGuardService, HostsService, HostSummaryService],
})
export class HostsModule {}
