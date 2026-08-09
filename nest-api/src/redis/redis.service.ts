import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createClient, type RedisClientType } from "redis";
import { withTimeout } from "@infrastructure/with-timeout.util";

export const SESSION_PREFIX = "trekker:";

const PING_TIMEOUT_MS = 1_000;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: RedisClientType;

  constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL,
      // Without this, commands issued while the connection is down are queued
      // until it comes back — so a health probe against a dead Redis hangs
      // instead of answering "down". Fail fast and let the caller decide.
      disableOfflineQueue: true,
      socket: {
        // Keep retrying forever with a bounded backoff. Redis being down is a
        // degraded state the health check reports, not a reason for the API to
        // die — see TRE-4's "killing Redis flips its field" criterion.
        reconnectStrategy: (retries) => Math.min(1000 * 2 ** retries, 30_000),
      },
    });

    // node-redis throws on an unhandled "error" event. Attaching this handler is
    // what keeps a Redis outage from taking the process with it.
    this.client.on("error", (error: Error) => {
      this.logger.warn(`Redis unavailable: ${error.message}`);
    });
    this.client.on("ready", () => this.logger.log("Redis connected"));
  }

  onModuleInit(): void {
    // Not awaited, and that is the whole point. With a reconnect strategy that
    // never gives up, `connect()` does not reject when Redis is down — it just
    // never settles. Awaiting it would hang module init and the API would never
    // reach `listen()`, which is exactly the state a fresh clone starts in.
    void this.client.connect().catch((error: Error) => {
      this.logger.warn(`Redis not reachable at startup, retrying in background: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  getClient(): RedisClientType {
    return this.client;
  }

  /**
   * Destroys every stored session belonging to a user.
   *
   * Called on sign-in (one live session per account) and on recovery, where
   * "all other sessions were revoked" has to be true rather than reassuring.
   *
   * SCAN rather than KEYS: KEYS blocks the Redis event loop for the whole scan,
   * and this runs on a request path.
   */
  async clearSessionsForUser(userId: string): Promise<void> {
    for await (const keys of this.client.scanIterator({ MATCH: `${SESSION_PREFIX}*`, COUNT: 100 })) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        try {
          const value = await this.client.get(key);
          if (!value) continue;
          const session = JSON.parse(value) as { userId?: string };
          if (session.userId === userId) {
            await this.client.del(key);
          }
        } catch {
          // A malformed or already-deleted entry is not a reason to leave the
          // rest of the user's sessions alive.
        }
      }
    }
  }

  /**
   * Fixed-window counter, used to throttle auth attempts per account.
   *
   * Returns the count after this attempt. Redis being unreachable returns 0 —
   * the request proceeds, because a session cannot be established without Redis
   * anyway, so there is nothing to protect at that point.
   */
  async countAttempt(key: string, windowSeconds: number): Promise<number> {
    try {
      const count = await this.client.incr(key);
      if (count === 1) {
        await this.client.expire(key, windowSeconds);
      }
      return count;
    } catch (error) {
      this.logger.warn(`Rate-limit counter unavailable: ${(error as Error).message}`);
      return 0;
    }
  }

  async resetAttempts(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch {
      // Best effort: a stale counter expires on its own.
    }
  }

  /** True when a round trip succeeds right now. Used by the health check. */
  async ping(): Promise<boolean> {
    if (!this.client.isOpen) return false;
    // Bounded: mid-outage, node-redis can sit on a command rather than reject
    // it, and an unanswerable health endpoint is worse than a "down" field.
    return withTimeout(
      this.client.ping().then((reply) => reply === "PONG"),
      PING_TIMEOUT_MS,
      false,
    );
  }
}
