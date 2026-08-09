import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import appConfig from "@config/app.config";
import { validate } from "@config/env.validation";
import { DatabaseModule } from "@database/database.module";
import { HealthModule } from "@health/health.module";
import { RedisModule } from "@redis/redis.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
      validate,
      load: [appConfig],
    }),
    DatabaseModule,
    RedisModule,
    HealthModule,
  ],
})
export class AppModule {}
