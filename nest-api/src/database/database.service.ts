import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import mariadb, { type Pool } from "mariadb";
import { withTimeout } from "@infrastructure/with-timeout.util";

const PING_TIMEOUT_MS = 2_000;

/**
 * A thin MySQL pool, used for now only by the health check.
 *
 * Prisma arrives with the schema in TRE-6 and becomes the way the app reads and
 * writes. This stays regardless: a liveness probe should not depend on the ORM
 * layer being correctly wired to tell you the database is reachable.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor() {
    // The pool connects lazily, so an unreachable database does not stop boot.
    this.pool = mariadb.createPool({
      // mariadb accepts a mysql:// URL through `connectionLimit`-style options
      // or a connection string; the string keeps one source of truth in .env.
      ...parseConnectionString(process.env.DATABASE_URL!),
      connectionLimit: 5,
      acquireTimeout: PING_TIMEOUT_MS,
      connectTimeout: PING_TIMEOUT_MS,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /** True when a round trip succeeds right now. Used by the health check. */
  ping(): Promise<boolean> {
    // The pool's own acquire timeout normally bounds this, but a socket that
    // accepts and then stalls is not covered by it. Same reasoning as Redis.
    return withTimeout(this.attemptPing(), PING_TIMEOUT_MS + 500, false);
  }

  private async attemptPing(): Promise<boolean> {
    let connection: Awaited<ReturnType<Pool["getConnection"]>> | undefined;
    try {
      connection = await this.pool.getConnection();
      await connection.query("SELECT 1");
      return true;
    } catch (error) {
      this.logger.warn(`MySQL unavailable: ${(error as Error).message}`);
      return false;
    } finally {
      await connection?.release();
    }
  }
}

interface ConnectionOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * `DATABASE_URL` is a single variable so the same value can be handed to Prisma
 * in TRE-6 without a second set of discrete host/user/password variables that
 * would inevitably drift apart from it.
 */
function parseConnectionString(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  };
}
