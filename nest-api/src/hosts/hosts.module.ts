import { homedir } from "node:os";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { DEFAULT_POOL_SETTINGS, SshConnectionPool } from "@hosts/drivers/ssh-connection.pool";
import { HostDisksService } from "@hosts/host-disks.service";
import { HostKeyService } from "@hosts/host-key.service";
import { HostMetricsService } from "@hosts/host-metrics.service";
import { HostSummaryService } from "@hosts/host-summary.service";
import { HostsController } from "@hosts/hosts.controller";
import { HostsService } from "@hosts/hosts.service";
import { SudoRunnerService } from "@hosts/sudo/sudo-runner.service";
import { SudoService } from "@hosts/sudo/sudo.service";
import { computeLocalDenylist } from "@hosts/path-guard/local-denylist";
import { LOCAL_DENYLIST, PathGuardService } from "@hosts/path-guard/path-guard.service";
import { Global, Module } from "@nestjs/common";

/**
 * Global because the pool must be a singleton: two pools would each open their
 * own connection to the same host and the concurrency cap would count to twice
 * what the server allows.
 */
@Global()
@Module({
  controllers: [HostsController],
  providers: [
    {
      provide: SshConnectionPool,
      useFactory: () => new SshConnectionPool(DEFAULT_POOL_SETTINGS),
    },
    HostDriverFactory,
    // Computed once at boot: where the process runs does not change while it
    // runs, and every validate() call reads the same frozen list (TRE-11).
    {
      provide: LOCAL_DENYLIST,
      useFactory: () => computeLocalDenylist({ startDir: __dirname, homeDir: homedir() }),
    },
    PathGuardService,
    HostSummaryService,
    // Built by hand: its one constructor argument is the gap between the two
    // readings a rate needs, which a test shortens to nothing. Left to the
    // container, that `number` is a token Nest looks for a provider of.
    {
      provide: HostMetricsService,
      useFactory: () => new HostMetricsService(),
    },
    HostDisksService,
    HostKeyService,
    // Holds sudo passwords in memory, so it must be the one instance the whole
    // process shares — the module is @Global, which is what makes that true.
    SudoService,
    SudoRunnerService,
    HostsService,
  ],
  exports: [
    HostDriverFactory,
    SshConnectionPool,
    PathGuardService,
    HostsService,
    HostSummaryService,
    HostMetricsService,
    HostDisksService,
    HostKeyService,
    SudoService,
    SudoRunnerService,
  ],
})
export class HostsModule {}
