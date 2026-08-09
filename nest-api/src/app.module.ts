import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import appConfig from "@config/app.config";
import { validate } from "@config/env.validation";
import { DatabaseModule } from "@database/database.module";
import { HealthModule } from "@health/health.module";
import { loadEnv } from "@config/load-env";
import { RedisModule } from "@redis/redis.module";
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
    HealthModule,
  ],
})
export class AppModule {}
