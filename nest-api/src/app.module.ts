import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuditModule } from "@audit/audit.module";
import { BookmarksModule } from "@bookmarks/bookmarks.module";
import appConfig from "@config/app.config";
import { validate } from "@config/env.validation";
import { DatabaseModule } from "@database/database.module";
import { FsModule } from "@fs/fs.module";
import { HealthModule } from "@health/health.module";
import { loadEnv } from "@config/load-env";
import { RedisModule } from "@redis/redis.module";
import { HostsModule } from "@hosts/hosts.module";
import { ScansModule } from "@scans/scans.module";
import { SecretStoreModule } from "@secrets/secret-store.module";
import { TransfersModule } from "@transfers/transfers.module";
import { UsersModule } from "@users/users.module";
import { PrismaModule } from "./prisma/prisma.module";

// Runs before the decorator below is evaluated, which is when ConfigModule
// validates the environment. There is no .env in this project — configuration
// comes from ecosystem.config.js, PM2's in production and this loader's in
// development. In production this call is a no-op.
loadEnv();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // No envFilePath: nothing to read. See load-env.ts.
      ignoreEnvFile: true,
      validate,
      load: [appConfig],
    }),
    DatabaseModule,
    PrismaModule,
    RedisModule,
    // Before every feature module that mutates anything. It is @Global and
    // binds the interceptor with APP_INTERCEPTOR, so ordering is not load-
    // bearing — but reading it here first states the intent: nothing below
    // gets to write without being recorded (TRE-30).
    AuditModule,
    SecretStoreModule,
    HostsModule,
    // After HostsModule, which also declares routes under `hosts`. Nothing
    // depends on the order — every path here carries more segments than
    // `hosts/:id` — but the two sharing a prefix is worth reading in one place.
    ScansModule,
    BookmarksModule,
    FsModule,
    TransfersModule,
    HealthModule,
    UsersModule,
  ],
})
export class AppModule {}
