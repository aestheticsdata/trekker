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
