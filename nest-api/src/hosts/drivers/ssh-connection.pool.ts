import { createHash } from "node:crypto";
import { DriverError } from "@hosts/drivers/driver-error";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { secretsEqual } from "@secrets/secret-store.service";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";

/** How the pool authenticates. Material arrives decrypted from the secret store. */
export type SshAuth =
  | { kind: "PRIVATE_KEY"; privateKey: Buffer; passphrase?: Buffer }
  | { kind: "PASSWORD"; password: Buffer }
  | { kind: "AGENT"; agentSocket: string };

/** One pinned host key: what was negotiated on first connect (TRE-10 §4). */
export interface HostKeyPin {
  /** The SSH algorithm name off the wire — "ssh-ed25519", "ssh-rsa". */
  algorithm: string;
  /** "SHA256:<base64>", the format `ssh-keygen -lf` prints. */
  fingerprint: string;
}

/** What the handshake actually offered, and how it compared to the pins. */
export interface ObservedHostKey {
  algorithm: string;
  fingerprint: string;
  /**
   * `trusted` — nothing was pinned, so this is first use and wants recording.
   * `matched` — it equals the pin for its algorithm.
   * `mismatch` — the host is pinned and this is not it. The connection was
   * refused before authentication, so `pinned` is what we expected to see.
   */
  verdict: "trusted" | "matched" | "mismatch";
  /** The fingerprint pinned for this algorithm, or null when none is. */
  pinned: string | null;
  /**
   * Set when this key matched a pin stored under a stale algorithm label, and
   * names that label. The caller rewrites the row so the next connection takes
   * the ordinary path.
   */
  relabelFrom: string | null;
}

/**
 * The algorithm every pin written before TRE-10 carries.
 *
 * It was a placeholder, not a wire name — the form hardcoded it and the API
 * defaulted to it — so no key a server offers can ever equal it. Left alone,
 * per-algorithm matching would refuse every host that existed before this
 * ticket, permanently, with no migration able to guess what the label should
 * have been: the wire algorithm was never recorded.
 */
export const LEGACY_ALGORITHM = "ssh";

export interface HostConnectionSpec {
  hostId: string;
  address: string;
  port: number;
  username: string;
  auth: SshAuth;
  /**
   * The keys this host is pinned to. Empty means trust on first use, and
   * `onHostKey` is what turns that first sighting into a pin — without it the
   * host is trusted on *every* use, which is not TOFU, it is no verification.
   *
   * The verifier refuses before authentication either way, so a host that
   * fails the check never sees the credential.
   */
  pins?: readonly HostKeyPin[];
  /**
   * Called from inside the host verifier with what was offered.
   *
   * Synchronous and must stay cheap: ssh2 is mid-handshake and waiting on the
   * return value of the verifier, so anything slow here is added latency on
   * every connection. Persisting is the caller's job, off this stack.
   */
  onHostKey?: (observed: ObservedHostKey) => void;
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
  /**
   * Borrowers queued for a slot, each carrying the ceiling it may proceed
   * under — a background borrower's is lower than an interactive one's
   * (TRE-32). Held as objects rather than bare resolvers so that `release` can
   * wake the first waiter that can actually run, instead of waking the one at
   * the front and having it queue straight back up while the freed slot sits
   * unused and nobody else is woken.
   */
  waiting: Array<{ ceiling: number; wake: () => void }>;
  /**
   * The connection has gone and this entry is off the map.
   *
   * It exists for the waiters. They re-check their ceiling after being woken,
   * and a dead entry's `inFlight` never falls again — so without a way to tell
   * them to stop asking, the wake-everybody on close would put them straight
   * back into a queue nothing will ever drain. Woken on a dead entry they
   * proceed instead, and fail fast on first use, which is what they did before
   * the ceiling existed.
   */
  dead?: boolean;
  idleTimer: NodeJS.Timeout | null;
  connecting: Promise<PooledEntry> | null;
}

/** A borrowed SFTP handle. Release it or the slot leaks. */
export interface Lease {
  sftp: SFTPWrapper;
  client: Client;
  release(): void;
}

export interface AcquireOptions {
  /**
   * Work nobody is waiting at a screen for (TRE-32).
   *
   * A disk scan holds its slot for minutes, which is a different thing from
   * every other borrower here — a listing holds one for milliseconds. Marked
   * background, it is refused the last `RESERVED_INTERACTIVE` slots and queues
   * instead, so browsing the host being scanned still has connections to use.
   */
  background?: boolean;
}

/**
 * Slots a background borrower may never take.
 *
 * Two, against a `maxConcurrency` of six. It is not tuned so much as reasoned:
 * a pane doing a listing needs one, and something like a download running
 * beside it needs the other, so two is the smallest number at which a person
 * browsing a host under scan never waits on the scan.
 */
export const RESERVED_INTERACTIVE = 2;

/** The result of a pre-persist connectivity test (TRE-12). Never carries the credential. */
export interface HostProbeResult {
  /** TCP connect and SSH handshake completed. */
  reachable: boolean;
  /** The credential authenticated. */
  authenticated: boolean;
  /** "SHA256:...", captured during the handshake — present even on auth failure. */
  fingerprint: string | null;
  /** The algorithm that fingerprint belongs to, so the pin records what was negotiated. */
  fingerprintAlgorithm: string | null;
  /** The login directory, resolved once authenticated. */
  homeDir: string | null;
  /** The user the connection authenticated as. */
  remoteUser: string | null;
  /** A short human message with no credential in it. */
  detail: string;
  /**
   * The handshake was refused because the key did not match what this host is
   * pinned to. `reachable` is still true — the host answered, it just is not
   * the one we trust — and no credential was offered.
   */
  hostKeyMismatch: boolean;
  /** What this host is pinned to for the offered algorithm, when it is pinned. */
  pinnedFingerprint: string | null;
}

/**
 * One ssh2 client per (host, user), reused across requests (TRE-9 §4).
 *
 * A fresh SSH handshake costs hundreds of milliseconds; doing one per directory
 * listing would make the app feel broken. Connections are lazy, keepalive'd,
 * evicted when idle, and capped so a single recursive walk cannot consume every
 * channel the server allows.
 *
 * **A known gap, found by TRE-32 and deliberately left.** The waiting queue has
 * no timeout and no abort: a borrower queued behind a slot that never frees
 * waits forever rather than failing with `ETIMEDOUT` like everything else here.
 * It has never bitten because every borrower until now held its slot for
 * milliseconds. A scan holds one for minutes, which is why `RESERVED_INTERACTIVE`
 * exists — it removes the case that would have made the gap visible, rather than
 * fixing the gap. Giving `acquire` a signal and a deadline is its own change.
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

  async acquire(spec: HostConnectionSpec, options: AcquireOptions = {}): Promise<Lease> {
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

    const ceiling = this.ceilingFor(options);
    // A loop rather than a single wait: being woken is permission to re-ask,
    // not permission to proceed. Another borrower can take the freed slot
    // between the wake and this line, and a background waiter woken by an
    // interactive release may still be over its lower ceiling.
    const held = entry;
    while (!held.dead && held.inFlight >= ceiling) {
      await new Promise<void>((wake) => held.waiting.push({ ceiling, wake }));
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

  /**
   * How many slots this borrower may occupy up to. Background work stops short
   * of the last few so that browsing the host never queues behind it (TRE-32).
   *
   * Floored at one: a `maxConcurrency` configured below the reservation would
   * otherwise give background work a ceiling of zero, and a scan that can never
   * acquire is a scan that hangs rather than one that runs politely.
   */
  private ceilingFor(options: AcquireOptions): number {
    if (!options.background) return this.settings.maxConcurrency;
    return Math.max(1, this.settings.maxConcurrency - RESERVED_INTERACTIVE);
  }

  private release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.inFlight = Math.max(0, entry.inFlight - 1);
    // The first waiter that can actually proceed, not simply the first waiter:
    // waking a background borrower that is still over its ceiling would leave
    // the freed slot idle with an interactive request queued behind it.
    const index = entry.waiting.findIndex((waiter) => entry.inFlight < waiter.ceiling);
    if (index !== -1) {
      const [next] = entry.waiting.splice(index, 1);
      next.wake();
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

          const entry: PooledEntry = {
            client,
            sftp,
            inFlight: 0,
            waiting: [],
            idleTimer: null,
            connecting: null,
          };
          this.entries.set(key, entry);

          // A server-side disconnect must not leave a dead entry in the map to
          // be handed out on the next request.
          client.on("close", () => {
            if (this.entries.get(key) === entry) this.entries.delete(key);
            entry.dead = true;
            for (const waiter of entry.waiting.splice(0)) waiter.wake();
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

  /**
   * Runs during the handshake, before any credential is offered (TRE-10 §2).
   * Returning false here is the whole ticket: it aborts the connection while
   * the private key is still ours.
   */
  private verifyHostKey(key: Buffer, spec: HostConnectionSpec): boolean {
    const { allow, ...observed } = evaluateHostKey(key, spec.pins ?? []);
    spec.onHostKey?.(observed);
    return allow;
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
      let fingerprintAlgorithm: string | null = null;
      let mismatch = false;
      let pinnedFingerprint: string | null = null;
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
            fingerprintAlgorithm,
            hostKeyMismatch: mismatch,
            pinnedFingerprint,
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
            fingerprintAlgorithm,
            hostKeyMismatch: mismatch,
            pinnedFingerprint,
            homeDir: null,
            remoteUser: null,
            detail: "Authentication refused",
          });
          return;
        }

        // The host answered and we refused it. Reporting that as unreachable
        // would send the user to look at the network, and would make the one
        // screen where a key change is caught describe it as a blip.
        if (mismatch) {
          done({
            reachable: true,
            authenticated: false,
            fingerprint,
            fingerprintAlgorithm,
            hostKeyMismatch: true,
            pinnedFingerprint,
            homeDir: null,
            remoteUser: null,
            detail: "Host key does not match the pinned fingerprint — no credential was sent",
          });
          return;
        }
        done({
          reachable: false,
          authenticated: false,
          fingerprint,
          fingerprintAlgorithm,
          hostKeyMismatch: mismatch,
          pinnedFingerprint,
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
              fingerprintAlgorithm,
              hostKeyMismatch: mismatch,
              pinnedFingerprint,
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
              fingerprintAlgorithm,
              hostKeyMismatch: mismatch,
              pinnedFingerprint,
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
            // The same decision the pool makes, for the same reason. A test
            // against an already-pinned host that skipped this would hand the
            // credential to whatever answered and only compare afterwards —
            // which is the ordering TRE-10 §2 exists to forbid, and it is the
            // one screen where a mismatch is most likely to be discovered.
            //
            // With no pins it still trusts on first use: the fingerprint is
            // being shown precisely so the user can decide whether to pin it.
            const evaluated = evaluateHostKey(key, spec.pins ?? []);
            fingerprint = evaluated.fingerprint;
            fingerprintAlgorithm = evaluated.algorithm;
            if (!evaluated.allow) {
              mismatch = true;
              pinnedFingerprint = evaluated.pinned;
            }
            return evaluated.allow;
          },
        });
      } catch (error) {
        done({
          reachable: false,
          authenticated: false,
          fingerprint,
          fingerprintAlgorithm,
          hostKeyMismatch: mismatch,
          pinnedFingerprint,
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

/**
 * The whole of TRE-10 §2 and §4, as a pure function: given what the server
 * offered and what we have pinned, may this connection continue?
 *
 * Separated from the pool because it is the one decision in this file that is
 * worth testing on its own — everything around it needs a socket, and a
 * security check nobody can exercise is a security check nobody has checked.
 */
export function evaluateHostKey(hostKey: Buffer, pins: readonly HostKeyPin[]): ObservedHostKey & { allow: boolean } {
  const algorithm = algorithmOf(hostKey);
  const fingerprint = fingerprintOf(hostKey);

  if (pins.length === 0) {
    // Trust on first use — and the caller must record it, or the host is
    // trusted on every connection rather than only the first.
    return {
      algorithm,
      fingerprint,
      verdict: "trusted",
      pinned: null,
      relabelFrom: null,
      allow: true,
    };
  }

  const pin = pins.find((candidate) => candidate.algorithm === algorithm);
  if (!pin) {
    // A pin written before TRE-10 is labelled "ssh", which matches no wire
    // name. Its *fingerprint* is still the one the user confirmed, so it is
    // honoured — but only on an exact fingerprint match, which is the same bar
    // every other pin has to clear. Nothing is trusted here that would not be
    // trusted under the correct label; only the label is wrong.
    const legacy = pins.find((candidate) => candidate.algorithm === LEGACY_ALGORITHM);
    if (legacy && secretsEqual(Buffer.from(fingerprint, "utf8"), Buffer.from(legacy.fingerprint, "utf8"))) {
      return {
        algorithm,
        fingerprint,
        verdict: "matched",
        pinned: legacy.fingerprint,
        relabelFrom: LEGACY_ALGORITHM,
        allow: true,
      };
    }

    // Otherwise: a pinned host that suddenly offers an algorithm we have never
    // seen is a mismatch, not a second key to record (§4). Recording it instead
    // would let anyone in front of the address pick an unpinned algorithm and
    // be trusted.
    return {
      algorithm,
      fingerprint,
      verdict: "mismatch",
      pinned: null,
      relabelFrom: null,
      allow: false,
    };
  }

  const matched = secretsEqual(Buffer.from(fingerprint, "utf8"), Buffer.from(pin.fingerprint, "utf8"));
  return {
    relabelFrom: null,
    algorithm,
    fingerprint,
    verdict: matched ? "matched" : "mismatch",
    pinned: pin.fingerprint,
    allow: matched,
  };
}

/**
 * OpenSSH's format, so a fingerprint can be read aloud against `ssh-keygen -lf`
 * on the real host. Verified byte for byte against ssh-keygen for ed25519 and
 * RSA — the base64 is unpadded, which is the part that is easy to get wrong.
 */
export function fingerprintOf(hostKey: Buffer): string {
  return `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
}

/**
 * The algorithm name off the wire: an SSH public key blob opens with a
 * uint32 length and that many bytes of name ("ssh-ed25519", "rsa-sha2-512").
 *
 * Read from the key itself rather than from anything the client configured,
 * because the point is to record what the *server* offered.
 */
export function algorithmOf(hostKey: Buffer): string {
  if (hostKey.length < 4) return "unknown";
  const length = hostKey.readUInt32BE(0);
  // A malformed blob must not become an out-of-range read or a huge string.
  if (length === 0 || length > 64 || hostKey.length < 4 + length) return "unknown";
  const name = hostKey.subarray(4, 4 + length).toString("utf8");
  // The name is printable ASCII; anything else means this is not a key blob.
  return /^[\x21-\x7e]+$/.test(name) ? name : "unknown";
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
