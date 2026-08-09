import { registerAs } from "@nestjs/config";

export interface AppConfig {
  port: number;
  frontendUrl: string;
  databaseUrl: string;
  redisUrl: string;
}

export default registerAs("app", (): AppConfig => ({
  port: parseInt(process.env.PORT!, 10),
  frontendUrl: process.env.FRONTEND_URL!,
  databaseUrl: process.env.DATABASE_URL!,
  redisUrl: process.env.REDIS_URL!,
}));
