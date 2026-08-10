import { registerAs } from "@nestjs/config";

export interface AppConfig {
  host: string;
  port: number;
  frontendUrl: string;
  databaseUrl: string;
  redisUrl: string;
}

export default registerAs("app", (): AppConfig => ({
  // Loopback unless said otherwise: nginx is the only public entrance, so an
  // unset HOST fails closed rather than open (TRE-40).
  host: process.env.HOST ?? "127.0.0.1",
  port: parseInt(process.env.PORT!, 10),
  frontendUrl: process.env.FRONTEND_URL!,
  databaseUrl: process.env.DATABASE_URL!,
  redisUrl: process.env.REDIS_URL!,
}));
