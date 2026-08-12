import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "@redis/redis.service";

import type { LimitRule } from "@audit/limits";

export interface LimitVerdict {
  allowed: boolean;
  /** Seconds until the window rolls. Only meaningful when refused. */
  resetSeconds: number;
  /**
   * Uses counted in this window, this one included — so `count === max + 1` is
   * the moment the limit was crossed, and only that moment. A caller that
   * writes a log row on a refusal needs it: without it, one walker generating
   * a thousand refusals a minute writes a thousand identical rows and buries
   * the signal under its own volume. `0` when the counter was unavailable.
   */
  count: number;
}

/**
 * Fixed-window counters in Redis (TRE-30 §3).
 *
 * Fixed rather than sliding, on purpose: a sliding window costs a sorted set
 * per subject and a trim on every call, and buys precision at the boundary
 * that nothing here needs. These limits exist to stop a script and a stolen
 * session, not to meter a paid API — being able to spend two windows' worth
 * across one boundary is not a hole worth that machinery.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Counts one use (or `amount` of them) against a limit.
   *
   * **Fails open if Redis is unreachable**, matching `RedisService.countAttempt`
   * and for the same reason: sessions live in Redis, so a request that got far
   * enough to be limited proves Redis was up moments ago. Refusing every
   * mutation because the counter is briefly unavailable would turn a cache
   * blip into an outage, and the audit log — which fails *closed* — is the
   * control that actually has to hold.
   */
  async consume(rule: LimitRule, scope: string, amount = 1): Promise<LimitVerdict> {
    const key = `${rule.key}:${scope}`;

    try {
      const client = this.redis.getClient();
      const count = await client.incrBy(key, amount);

      // Only on the write that created the key. Setting it every time would
      // slide the window forward on each call and the limit would never fire.
      if (count === amount) {
        await client.expire(key, rule.windowSeconds);
      }

      if (count <= rule.max) return { allowed: true, resetSeconds: 0, count };

      const ttl = await client.ttl(key);
      return { allowed: false, resetSeconds: ttl > 0 ? ttl : rule.windowSeconds, count };
    } catch (error) {
      this.logger.warn(`Rate limit ${rule.key} unavailable, allowing: ${(error as Error).message}`);
      return { allowed: true, resetSeconds: 0, count: 0 };
    }
  }

  /**
   * The message a refusal returns. Names the limit and when it lifts, because
   * a 429 that says only "too many requests" is a support ticket — the caller
   * cannot tell whether to wait a second or an hour, and neither can whoever
   * they ask.
   */
  static describe(rule: LimitRule, resetSeconds: number): string {
    const wait =
      resetSeconds >= 60 ? `${Math.ceil(resetSeconds / 60)} minute(s)` : `${Math.max(resetSeconds, 1)} second(s)`;
    return `Rate limit reached: at most ${rule.max} ${rule.label} per ${describeWindow(rule.windowSeconds)}. Try again in ${wait}.`;
  }
}

function describeWindow(seconds: number): string {
  if (seconds >= 3600) return `${seconds / 3600} hour(s)`;
  if (seconds >= 60) return `${seconds / 60} minute(s)`;
  return `${seconds} second(s)`;
}
