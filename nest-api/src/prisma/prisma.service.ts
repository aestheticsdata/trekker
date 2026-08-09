import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { describeTarget, parseDatabaseUrl } from "../config/database-url";
import { PrismaClient } from "../../generated/prisma/client";

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Prisma over the MariaDB driver adapter, same as pfa.
 *
 * The health check does not go through here on purpose — see DatabaseService.
 * A liveness probe that depends on the ORM being wired correctly cannot tell
 * you whether the database is reachable.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(PrismaService.name);
  private readonly target: string;

  constructor() {
    // env.validation already rejects a missing DATABASE_URL at boot; parsing
    // here throws a named error rather than a cryptic URL parse failure.
    const connection = parseDatabaseUrl(process.env.DATABASE_URL);

    super({
      adapter: new PrismaMariaDb({
        ...connection,
        connectionLimit: 10,
        allowPublicKeyRetrieval: true,
        // Bounds the check below. Without these, an address that accepts and
        // then stalls hangs module init and the API never reaches listen().
        connectTimeout: CONNECT_TIMEOUT_MS,
        acquireTimeout: CONNECT_TIMEOUT_MS,
      }),
    });

    this.target = describeTarget(connection);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();

    // $connect() resolves without opening a socket — the driver adapter's pool
    // is lazy, so it succeeds even against credentials that cannot log in. One
    // real round trip is what actually proves the database is there.
    //
    // Unlike Redis this is fatal. Sessions can degrade; the data layer cannot,
    // and an API that boots only to fail every request is worse than one that
    // refuses to boot and says why.
    try {
      await this.$queryRaw`SELECT 1`;
    } catch (error) {
      throw new Error(`Cannot reach the database at ${this.target}: ${(error as Error).message}`);
    }

    PrismaService.logger.log(`Prisma connected to ${this.target}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
