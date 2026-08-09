import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { Application, NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";
import { AppConfig } from "@config/app.config";
import { formatRouteLog } from "@infrastructure/logger";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  (app.getHttpAdapter().getInstance() as Application).set("trust proxy", 1);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.setGlobalPrefix("api");

  const configService = app.get(ConfigService);
  const appConfig = configService.getOrThrow<AppConfig>("app");

  app.enableCors({
    origin: appConfig.frontendUrl,
    credentials: true,
  });

  app.use("/api", (req: Request, _res: Response, next: NextFunction) => {
    const url = req.originalUrl ?? req.url ?? req.path ?? "";
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.ip ?? req.socket?.remoteAddress ?? "?";
    const userAgent = (req.headers["user-agent"] ?? "unknown").slice(0, 60);
    console.log(formatRouteLog(req.method, url, "Nest", { ip, userAgent }));
    next();
  });

  await app.listen(appConfig.port);
  console.log(`Trekker API listening on :${appConfig.port}`);
}

bootstrap().catch((error: Error) => {
  // Runtime startup failures — port already bound, adapter refusing to listen.
  // Env validation does *not* land here: ConfigModule.forRoot() runs while
  // app.module is being imported, so it throws before bootstrap() is called and
  // Nest's own handler reports it. That message already names the variable and
  // the remedy, which is what matters.
  console.error(`\nTrekker API failed to start.\n\n${error.message}\n`);
  process.exit(1);
});
