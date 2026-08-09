import { Injectable } from "@nestjs/common";
import { DatabaseService } from "@database/database.service";
import { RedisService } from "@redis/redis.service";

export interface HealthReport {
  status: "ok" | "degraded";
  uptimeSeconds: number;
  dependencies: {
    mysql: "up" | "down";
    redis: "up" | "down";
  };
}

@Injectable()
export class HealthService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Reports each dependency separately.
   *
   * The endpoint answers 200 whether or not the dependencies are up — the
   * caller reads `status` and `dependencies`. That is deliberate: a probe that
   * returns 200 while the database is down is useless, but one that returns 503
   * and an empty body is equally useless because it cannot say *which* part is
   * broken. Reporting both, always reachable, is what makes it worth calling.
   */
  async check(): Promise<HealthReport> {
    const [mysqlUp, redisUp] = await Promise.all([this.databaseService.ping(), this.redisService.ping()]);

    return {
      status: mysqlUp && redisUp ? "ok" : "degraded",
      uptimeSeconds: Math.round(process.uptime()),
      dependencies: {
        mysql: mysqlUp ? "up" : "down",
        redis: redisUp ? "up" : "down",
      },
    };
  }
}
