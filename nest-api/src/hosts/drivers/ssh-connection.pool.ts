import { createHash } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { DriverError } from "@hosts/drivers/driver-error";
import { secretsEqual } from "@secrets/secret-store.service";

/** How the pool authenticates. Material arrives decrypted from the secret store. */
export type SshAuth =
  | { kind: "PRIVATE_KEY"; privateKey: Buffer; passphrase?: Buffer }
  | { kind: "PASSWORD"; password: Buffer }
  | { kind: "AGENT"; agentSocket: string };

export interface HostConnectionSpec {
  hostId: string;
  address: string;
  port: number;
  username: string;
  auth: SshAuth;
  /**
   * Fingerprints this host is pinned to, "SHA256:<base64>". Empty means trust
   * on first use — TRE-10 owns recording what was seen. The verifier refuses
   * *before* authentication either way, so a mismatched host never sees the
   * credential.
   */
  pinnedFingerprints?: readonly string[];
}

export interface PoolSettings {
  /** TCP connect plus handshake. */
  connectTimeoutMs: number;
  /** Ceiling on any single SFTP call. */
  operationTimeoutMs: number;
  /** Close a connection unused for this long. */
  idleTimeoutMs: number;
  /** Concurrent operations per host. */
  maxConcurrency: number;
  keepaliveIntervalMs: number;
}

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  connectTimeoutMs: 15_000,
  operationTimeoutMs: 30_000,
  idleTimeoutMs: 5 * 60_000,
  // One recursive listing must not be able to starve every other pane. SSH
  // servers default to 10 channels; staying under that avoids the server
  // silently queueing us.
  maxConcurrency: 6,
  keepaliveIntervalMs: 20_000,
};

interface PooledEntry {
  client: Client;
  sftp: SFTPWrapper;
  inFlight: number;
  waiting: Array<() => void>;
  idleTimer: NodeJS.Timeout | null;
  connecting: Promise<PooledEntry> | null;
}

/** A borrowed SFTP handle. Release it or the slot leaks. */
export interface Lease {
  sftp: SFTPWrapper;
  client: Client;
  release(): void;
}

/** The result of a pre-persist connectivity test (TRE-12). Never carries the credential. */
export interface HostProbeResult {
  /** TCP connect and SSH handshake completed. */
  reachable: boolean;
  /** The credential authenticated. */
  authenticated: boolean;
  /** "SHA256:...", captured during the handshake — present even on auth failure. */
  fingerprint: string | null;
  /** The login directory, resolved once authenticated. */
  homeDir: string | null;
  /** The user the connection authenticated as. */
  remoteUser: string | null;
  /** A short human message with no credential in it. */
  detail: string;
}

/**
 * One ssh2 client per (host, user), reused across requests (TRE-9 §4).
 *
 * A fresh SSH handshake costs hundreds of milliseconds; doing one per directory
 * listing would make the app feel broken. Connections are lazy, keepalive'd,
 * evicted when idle, and capped so a single recursive walk cannot consume every
 * channel the server allows.
 */
@Injectable()
export class SshConnectionPool implements OnModuleDestroy {
  private readonly logger = new Logger(SshConnectionPool.name);
  private readonly entries = new Map<string, PooledEntry>();
  /**
   * Keys evicted while their handshake was still in flight.
   *
   * Eviction exists to guarantee that nothing keeps authenticating with a
   * credential the operator just replaced or deleted. A connection being
   * established at that moment has no client to close yet, so without this the
   * handshake would finish *after* the eviction and re-pool a connection built
   * from the revoked credential — the one outcome revocation must prevent.
   */
  private readonly evictedWhileConnecting = new Set<string>();

  constructor(private readonly settings: PoolSettings = DEFAULT_POOL_SETTINGS) {}

  private static key(spec: HostConnectionSpec): string {
    return `${spec.hostId}:${spec.username}`;
  }

  async acquire(spec: HostConnectionSpec): Promise<Lease> {
    const key = SshConnectionPool.key(spec);
    let entry = this.entries.get(key);

    if (!entry) {
      entry = await this.connect(spec, key);
    } else if (entry.connecting) {
      // Two requests raced for the same cold host: the second waits for the
      // first handshake rather than opening a second connection.
      entry = await entry.connecting;
    }

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }

    if (entry.inFlight >= this.settings.maxConcurrency) {
      await new Promise<void>((resolve) => entry.waiting.push(resolve));
    }
    entry.inFlight++;

    let released = false;
    return {
      sftp: entry.sftp,
      client: entry.client,
      release: () => {
        if (released) return; // Releasing twice would hand out a slot we never took.
        released = true;
        this.release(key);
      },
    };
  }

  private release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.inFlight = Math.max(0, entry.inFlight - 1);
    const next = entry.waiting.shift();
    if (next) {
      next();
      return;
    }

    if (entry.inFlight === 0) {
      entry.idleTimer = setTimeout(() => this.evict(key, "idle"), this.settings.idleTimeoutMs);
      entry.idleTimer.unref();
    }
  }

  private connect(spec: HostConnectionSpec, key: string): Promise<PooledEntry> {
    const pending = new Promise<PooledEntry>((resolve, reject) => {
      const client = new Client();
      let settled = false;

      const fail = (error: DriverError): void => {
        if (settled) return;
        settled = true;
        this.entries.delete(key);
        // The mark only matters while this handshake is alive; leaving it
        // behind would make the *next* connection on this key discard itself.
        this.evictedWhileConnecting.delete(key);
        client.destroy();
        reject(error);
      };

      const timer = setTimeout(
        () => fail(new DriverError("ETIMEDOUT", `Timed out connecting to ${spec.address}:${spec.port}`)),
        this.settings.connectTimeoutMs,
      );
      timer.unref();

      client.on("error", (error: Error & { level?: string }) => {
        clearTimeout(timer);
        fail(classifyConnectError(error, spec));
      });

      client.on("ready", () => {
        clearTimeout(timer);
        client.sftp((error, sftp) => {
          if (error) {
            fail(new DriverError("EIO", `SFTP subsystem unavailable: ${error.message}`, undefined, error));
            return;
          }
          if (settled) {
            sftp.end();
            return;
          }

          // Revoked mid-handshake: this connection authenticated with a
          // credential that is no longer valid, so it must die here rather
          // than be pooled for the next request. Checked before `settled` is
          // set, so fail() still runs its cleanup and rejects the caller.
          if (this.evictedWhileConnecting.delete(key)) {
            sftp.end();
            this.logger.log(`SSH connection discarded on arrival (evicted while connecting): ${key}`);
            fail(new DriverError("EAUTH", "The credential changed while connecting. Retry."));
            return;
          }

          settled = true;

          const entry: PooledEntry = { client, sftp, inFlight: 0, waiting: [], idleTimer: null, connecting: null };
          this.entries.set(key, entry);

          // A server-side disconnect must not leave a dead entry in the map to
          // be handed out on the next request.
          client.on("close", () => {
            if (this.entries.get(key) === entry) this.entries.delete(key);
            for (const wake of entry.waiting.splice(0)) wake();
          });

          this.logger.log(`SSH connected: ${spec.username}@${spec.address}:${spec.port}`);
          resolve(entry);
        });
      });

      client.connect(this.connectConfig(spec));
    });

    // Recorded before the handshake finishes so concurrent callers join it.
    this.entries.set(key, { connecting: pending } as unknown as PooledEntry);
    return pending;
  }

  private connectConfig(spec: HostConnectionSpec): ConnectConfig {
    const base: ConnectConfig = {
      host: spec.address,
      port: spec.port,
      username: spec.username,
      readyTimeout: this.settings.connectTimeoutMs,
      keepaliveInterval: this.settings.keepaliveIntervalMs,
      // Refuses the connection *before* offering any credential. Auditing the
      // fingerprint after authenticating would already have handed the key to
      // whoever answered.
      hostVerifier: (key: Buffer) => this.verifyHostKey(key, spec),
    };

    switch (spec.auth.kind) {
      case "PRIVATE_KEY":
        return {
          ...base,
          privateKey: spec.auth.privateKey,
          passphrase: spec.auth.passphrase?.toString("utf8"),
        };
      case "PASSWORD":
        return { ...base, password: spec.auth.password.toString("utf8") };
      case "AGENT":
        return { ...base, agent: spec.auth.agentSocket };
    }
  }

  private verifyHostKey(key: Buffer, spec: HostConnectionSpec): boolean {
    const pins = spec.pinnedFingerprints ?? [];
    if (pins.length === 0) {
      // Trust on first use. TRE-10 records what was seen so the second
      // connection is checked against it.
      return true;
    }

    const seen = Buffer.from(fingerprintOf(key), "utf8");
    return pins.some((pin) => secretsEqual(seen, Buffer.from(pin, "utf8")));
  }

  /**
   * A throwaway connection for the "test before you save" flow (TRE-12). Unlike
   * `acquire`, it never touches the pool map: a candidate host has no id to key
   * on, and a connection made from a credential typed into a form must not
   * outlive the request that tested it.
   *
   * The fingerprint is captured in the host verifier, which ssh2 runs during
   * the handshake — *before* authentication — so a wrong credential still comes
   * back with the fingerprint the user needs to confirm. Nothing here is logged:
   * the spec carries a live credential.
   */
  async probe(spec: HostConnectionSpec): Promise<HostProbeResult> {
    return new Promise<HostProbeResult>((resolve) => {
      const client = new Client();
      let fingerprint: string | null = null;
      let settled = false;

      const done = (result: HostProbeResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.destroy();
        resolve(result);
      };

      const timer = setTimeout(
        () =>
          done({
            reachable: false,
            authenticated: false,
            fingerprint,
            homeDir: null,
            remoteUser: null,
            detail: "Timed out",
          }),
        this.settings.connectTimeoutMs,
      );
      timer.unref();

      client.on("error", (error: Error & { level?: string; code?: string }) => {
        const classified = classifyConnectError(error, spec);
        // EAUTH means the handshake completed and the fingerprint was captured;
        // the host is reachable, the credential simply did not authenticate.
        if (classified.code === "EAUTH") {
          done({
            reachable: true,
            authenticated: false,
            fingerprint,
            homeDir: null,
            remoteUser: null,
            detail: "Authentication refused",
          });
          return;
        }
        done({
          reachable: false,
          authenticated: false,
          fingerprint,
          homeDir: null,
          remoteUser: null,
          detail: classified.message,
        });
      });

      client.on("ready", () => {
        client.sftp((error, sftp) => {
          if (error) {
            done({
              reachable: true,
              authenticated: true,
              fingerprint,
              homeDir: null,
              remoteUser: spec.username,
              detail: "Connected, SFTP unavailable",
            });
            return;
          }
          sftp.realpath(".", (realpathError, home) => {
            done({
              reachable: true,
              authenticated: true,
              fingerprint,
              homeDir: realpathError ? null : home,
              remoteUser: spec.username,
              detail: "Connected",
            });
          });
        });
      });

      // ssh2 parses the key material inside connect() and throws
      // *synchronously* on a malformed or wrongly-passphrased private key —
      // it never reaches the "error" handler. Unwrapped, the commonest mistake
      // anyone makes on this form (a truncated paste, a wrong passphrase)
      // would reject this promise as a 500 instead of the answer the screen
      // exists to give, and would leak the timer and the client with it.
      try {
        const config = this.connectConfig(spec);
        client.connect({
          ...config,
          hostVerifier: (key: Buffer) => {
            fingerprint = fingerprintOf(key);
            // A test trusts on first use — the fingerprint is being shown to
            // the user precisely so they can decide whether to pin it.
            return true;
          },
        });
      } catch (error) {
        done({
          reachable: false,
          authenticated: false,
          fingerprint,
          homeDir: null,
          remoteUser: null,
          // ssh2's own text ("Cannot parse privateKey: ...") names the
          // problem and quotes no key material.
          detail: error instanceof Error ? error.message : "Could not start the connection",
        });
      }
    });
  }

  /** Closes a host's connection now — on deletion, credential change or a key mismatch. */
  evictHost(hostId: string, reason: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${hostId}:`)) this.evict(key, reason);
    }
  }

  private evict(key: string, reason: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);

    if (entry.connecting) {
      // Nothing to close yet — the handshake is still running and owns the
      // only reference to the client. Mark the key so the connection is
      // destroyed the moment it arrives instead of being pooled.
      this.evictedWhileConnecting.add(key);
      this.logger.log(`SSH connection marked for discard (${reason}, still connecting): ${key}`);
      return;
    }

    entry.client.end();
    this.logger.log(`SSH connection closed (${reason}): ${key}`);
  }

  /** Test and diagnostics only. */
  get openConnectionCount(): number {
    return [...this.entries.values()].filter((entry) => !entry.connecting).length;
  }

  inFlightFor(hostId: string, username: string): number {
    return this.entries.get(`${hostId}:${username}`)?.inFlight ?? 0;
  }

  onModuleDestroy(): void {
    for (const key of [...this.entries.keys()]) this.evict(key, "shutdown");
  }
}

/** OpenSSH's format, so a fingerprint can be compared with `ssh-keyscan` output. */
export function fingerprintOf(hostKey: Buffer): string {
  return `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Four distinct outcomes, because the UI shows four different things: an
 * unreachable host is a network problem, a refused credential is a settings
 * problem, a key mismatch is a security event, and a timeout is neither.
 */
function classifyConnectError(error: Error & { level?: string; code?: string }, spec: HostConnectionSpec): DriverError {
  const target = `${spec.address}:${spec.port}`;

  if (error.level === "client-authentication") {
    return new DriverError("EAUTH", `Authentication refused by ${target} for ${spec.username}`, undefined, error);
  }
  // ssh2 reports a hostVerifier rejection this way.
  if (error.message?.includes("Host verification") || error.message?.includes("verification failed")) {
    return new DriverError(
      "EHOSTKEY",
      `Host key for ${target} does not match the pinned fingerprint`,
      undefined,
      error,
    );
  }
  if (error.code === "ETIMEDOUT" || error.message?.includes("Timed out")) {
    return new DriverError("ETIMEDOUT", `Timed out connecting to ${target}`, undefined, error);
  }
  if (
    error.code === "ENOTFOUND" ||
    error.code === "ECONNREFUSED" ||
    error.code === "EHOSTUNREACH" ||
    error.code === "ENETUNREACH"
  ) {
    return new DriverError("EUNREACHABLE", `Cannot reach ${target}`, undefined, error);
  }
  return new DriverError("EUNREACHABLE", `Cannot reach ${target}: ${error.message}`, undefined, error);
}
