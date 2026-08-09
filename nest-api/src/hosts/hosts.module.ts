import { Global, Module } from "@nestjs/common";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { DEFAULT_POOL_SETTINGS, SshConnectionPool } from "@hosts/drivers/ssh-connection.pool";

/**
 * Global because the pool must be a singleton: two pools would each open their
 * own connection to the same host and the concurrency cap would count to twice
 * what the server allows.
 */
@Global()
@Module({
  providers: [
    { provide: SshConnectionPool, useFactory: () => new SshConnectionPool(DEFAULT_POOL_SETTINGS) },
    HostDriverFactory,
  ],
  exports: [HostDriverFactory, SshConnectionPool],
})
export class HostsModule {}
