import { Injectable, Logger } from "@nestjs/common";
import { DriverError } from "@hosts/drivers/driver-error";
import type { HostDriver } from "@hosts/drivers/host-driver";
import { LocalDriver } from "@hosts/drivers/local.driver";
import {
  DEFAULT_POOL_SETTINGS,
  type HostConnectionSpec,
  type SshAuth,
  SshConnectionPool,
} from "@hosts/drivers/ssh-connection.pool";
import { SshDriver } from "@hosts/drivers/ssh.driver";
import { SecretStoreService } from "@secrets/secret-store.service";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Turns a Hosts row into a driver (TRE-9).
 *
 * This is where the project's one structural decision pays off: callers ask for
 * a driver by host id and get the same interface back whether the host is the
 * machine the API runs on or a server on the other side of the world. Nothing
 * above this line branches on transport.
 */
@Injectable()
export class HostDriverFactory {
  private readonly logger = new Logger(HostDriverFactory.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretStoreService,
    private readonly pool: SshConnectionPool,
  ) {}

  async forHost(hostId: string, userId: string): Promise<HostDriver> {
    const host = await this.prisma.hosts.findFirst({
      // Scoped by user: a host id from another account must read as "no such
      // host", not as a permission error that confirms it exists.
      where: { id: hostId, userId },
      include: { credential: true, knownKeys: true },
    });

    if (!host) {
      throw new DriverError("ENOENT", `No such host: ${hostId}`);
    }

    if (host.transport === "LOCAL") {
      return new LocalDriver(host.id);
    }

    if (!host.address || !host.username) {
      throw new DriverError("EIO", `Host ${host.slug} is SSH but has no address or username configured.`);
    }
    if (!host.credential) {
      throw new DriverError("EAUTH", `Host ${host.slug} has no credential configured.`);
    }

    const spec: HostConnectionSpec = {
      hostId: host.id,
      address: host.address,
      port: host.port,
      username: host.username,
      auth: this.authFor(host.id, host.credential),
      pinnedFingerprints: host.knownKeys.map((key) => key.fingerprint),
    };

    return new SshDriver(spec, this.pool, DEFAULT_POOL_SETTINGS);
  }

  private authFor(
    hostId: string,
    credential: { kind: string; ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array; keyVersion: number },
  ): SshAuth {
    // The plaintext lives only as long as the connection spec. It is never
    // logged, never returned from an endpoint, and never turned into a string
    // except where ssh2's API forces it.
    const material = this.secrets.decrypt(credential, hostId);

    switch (credential.kind) {
      case "PRIVATE_KEY":
        return { kind: "PRIVATE_KEY", privateKey: material };
      case "PASSWORD":
        return { kind: "PASSWORD", password: material };
      case "AGENT":
        return { kind: "AGENT", agentSocket: material.toString("utf8") };
      default:
        throw new DriverError("EAUTH", `Unsupported credential kind: ${credential.kind}`);
    }
  }

  /**
   * Called when a host is deleted or its credential changes. Leaving the old
   * connection open would keep authenticating with a credential the operator
   * has just revoked.
   */
  invalidate(hostId: string, reason: string): void {
    this.pool.evictHost(hostId, reason);
    this.logger.log(`Invalidated pooled connections for host ${hostId} (${reason})`);
  }
}
