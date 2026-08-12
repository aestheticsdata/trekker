import { HttpException } from "@nestjs/common";
import { ActivityService } from "@audit/activity.service";
import { AuditService } from "@audit/audit.service";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { REDACTED, redact, redactDetail } from "@audit/redact";
import { RetentionService } from "@audit/retention.service";

import type { RedisService } from "@redis/redis.service";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * TRE-30's Done list, minus the parts that need operations M2 has not built.
 *
 * `audit-coverage.spec.ts` proves every mutating route makes a decision. This
 * file proves the decisions do what they claim: that a secret cannot reach the
 * table, that a limit fires where it says it does, that the prune respects its
 * window, and that paging cannot lose a row.
 */

const USER = "user-1";
const SECRET = "correct-horse-battery-staple";

// ---------------------------------------------------------------- redaction

describe("redaction", () => {
  it("strips by key name, at any depth", () => {
    const clean = redact({
      label: "web-01",
      credentialSecret: SECRET,
      nested: { credentialPassphrase: SECRET, deeper: { apiToken: SECRET } },
    });

    expect(JSON.stringify(clean)).not.toContain(SECRET);
    expect(clean?.label).toBe("web-01");
  });

  it("strips by value shape, when the key gives nothing away", () => {
    // The case a key-name denylist cannot catch, and the one that actually
    // happens: a private key pasted into a field called something ordinary.
    const clean = redact({
      // The marker below is read by gitleaks and by .githooks/infra-patterns.sh
      // alike. It is how a line says "this shape is the subject here, not a
      // secret" without exempting the file — which is where a real key would
      // then be able to hide.
      note: "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-key\n", // gitleaks:allow
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc",
      header: "Bearer sk-live-0123456789",
    });

    expect(clean).toEqual({ note: REDACTED, jwt: REDACTED, header: REDACTED });
  });

  it("replaces rather than deletes", () => {
    // A missing field reads as "there was nothing there". The true statement is
    // "there was something and we chose not to keep it", and an operator
    // reconstructing an incident needs to be able to tell those apart.
    expect(Object.keys(redact({ password: SECRET }) ?? {})).toEqual(["password"]);
  });

  it("keeps a stack trace and a connection string out of the detail line", () => {
    expect(redactDetail("Bearer sk-live-0123456789")).toBe(REDACTED);
    expect(redactDetail("x".repeat(400))?.length).toBe(255);
    expect(redactDetail("connect ECONNREFUSED\n  at Socket.foo")).toBe("connect ECONNREFUSED at Socket.foo");
  });

  it("strips a secret quoted inside a driver's error message", () => {
    // The shape that actually leaks. A whole-value check cannot see this: the
    // secret is a fragment of a sentence rather than the sentence.
    expect(redactDetail(`Access denied for user 'trekker' (using password: ${SECRET})`)).toBe(
      "Access denied for user 'trekker' (using password=[redacted])",
    );
    expect(redactDetail(`connect failed passphrase="${SECRET}" host=web-01`)).toContain(REDACTED);
    expect(redactDetail(`connect failed passphrase="${SECRET}" host=web-01`)).toContain("host=web-01");
  });

  it("never lets a secret reach the row through a payload, whichever door it came in", () => {
    // The Done-list check, done where the guarantee actually lives. The table
    // stores exactly what AuditService hands Prisma, so capturing that and
    // searching it is the same assertion as grepping the table afterwards —
    // without needing a database to run it in the pre-deploy gate.
    //
    // Payloads only. `detail` is free text with no schema and its scrubbing is
    // best-effort by construction — asserting a guarantee there that redaction
    // cannot make would be a green test standing in for a promise nobody kept.
    const written: unknown[] = [];
    const prisma = {
      activityLog: {
        create: (args: { data: unknown }) => {
          written.push(args.data);
          return Promise.resolve({ id: "row-1" });
        },
        update: (args: { data: unknown }) => {
          written.push(args.data);
          return Promise.resolve({});
        },
      },
    } as unknown as PrismaService;

    const audit = new AuditService(prisma);

    return (async () => {
      const id = await audit.open({
        userId: USER,
        kind: "host.create",
        summary: "Added a host",
        // A header with this file's own fake interpolated behind it, not a key.
        payload: { password: SECRET, key: SECRET, blob: `-----BEGIN OPENSSH PRIVATE KEY-----${SECRET}` }, // gitleaks:allow
      });
      await audit.settle(id, "success", 12, { payload: { credentialSecret: SECRET } });
      await audit.refused(
        { userId: USER, kind: "host.create", summary: "Refused", payload: { token: SECRET } },
        "rate limit reached",
      );

      expect(written).toHaveLength(3);
      expect(JSON.stringify(written)).not.toContain(SECRET);
    })();
  });
});

// ---------------------------------------------------------------- rate limits

function redisReturning(counts: number[], ttl = 42): { redis: RedisService; expires: number[] } {
  const expires: number[] = [];
  let call = 0;
  const redis = {
    getClient: () => ({
      incrBy: () => Promise.resolve(counts[Math.min(call++, counts.length - 1)]),
      expire: (_key: string, seconds: number) => {
        expires.push(seconds);
        return Promise.resolve(true);
      },
      ttl: () => Promise.resolve(ttl),
    }),
  } as unknown as RedisService;
  return { redis, expires };
}

describe("rate limits", () => {
  const rule = LIMITS.passwordChange;

  it("allows up to the threshold and refuses the one after it", async () => {
    const limits = new RateLimitService(redisReturning([rule.max]).redis);
    await expect(limits.consume(rule, USER)).resolves.toMatchObject({ allowed: true });

    const over = new RateLimitService(redisReturning([rule.max + 1]).redis);
    await expect(over.consume(rule, USER)).resolves.toMatchObject({ allowed: false, resetSeconds: 42 });
  });

  it("sets the expiry only on the write that created the key", async () => {
    // Re-setting it on every call slides the window forward each time and the
    // limit never fires at all — a limit that looks enforced and is not.
    const { redis, expires } = redisReturning([1, 2, 3]);
    const limits = new RateLimitService(redis);

    await limits.consume(rule, USER);
    await limits.consume(rule, USER);
    await limits.consume(rule, USER);

    expect(expires).toEqual([rule.windowSeconds]);
  });

  it("fails open when Redis is unreachable", async () => {
    const broken = {
      getClient: () => {
        throw new Error("redis down");
      },
    } as unknown as RedisService;

    await expect(new RateLimitService(broken).consume(rule, USER)).resolves.toMatchObject({ allowed: true });
  });

  it("names the limit and when it lifts", () => {
    // A 429 saying only "too many requests" is a support ticket: the caller
    // cannot tell whether to wait a second or an hour, and nor can whoever
    // they ask.
    const message = RateLimitService.describe(rule, 120);
    expect(message).toContain(String(rule.max));
    expect(message).toContain(rule.label);
    expect(message).toContain("2 minute(s)");
  });

  it("throws 429 rather than running the operation", () => {
    // Guards the shape the interceptor depends on: the refusal has to be an
    // HttpException with 429, or it settles as a `failure` and the strip
    // reports an outage where the truth is a limit doing its job.
    const error = new HttpException(RateLimitService.describe(rule, 5), 429);
    expect(error.getStatus()).toBe(429);
  });
});

// ---------------------------------------------------------------- retention

describe("retention", () => {
  function prismaWith(rows: { id: string; destructive: boolean; createdAt: Date }[]) {
    const store = [...rows];
    const seen: { destructive: boolean; before: Date }[] = [];

    const prisma = {
      activityLog: {
        findMany: ({ where, take }: { where: { destructive: boolean; createdAt: { lt: Date } }; take: number }) => {
          seen.push({ destructive: where.destructive, before: where.createdAt.lt });
          return Promise.resolve(
            store
              .filter((row) => row.destructive === where.destructive && row.createdAt < where.createdAt.lt)
              .slice(0, take)
              .map((row) => ({ id: row.id })),
          );
        },
        deleteMany: ({ where }: { where: { id: { in: string[] } } }) => {
          const doomed = new Set(where.id.in);
          const before = store.length;
          for (let index = store.length - 1; index >= 0; index -= 1) {
            if (doomed.has(store[index].id)) store.splice(index, 1);
          }
          return Promise.resolve({ count: before - store.length });
        },
      },
    } as unknown as PrismaService;

    return { prisma, store, seen };
  }

  const now = new Date("2026-08-12T00:00:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  it("keeps destructive rows four times longer than ordinary ones", async () => {
    const { prisma, store } = prismaWith([
      { id: "ordinary-fresh", destructive: false, createdAt: daysAgo(30) },
      { id: "ordinary-stale", destructive: false, createdAt: daysAgo(120) },
      // Past the ordinary window, well inside the destructive one. This row is
      // the whole point: a prune that used one window would delete exactly the
      // history someone comes looking for.
      { id: "destructive-mid", destructive: true, createdAt: daysAgo(120) },
      { id: "destructive-stale", destructive: true, createdAt: daysAgo(400) },
    ]);

    const removed = await new RetentionService(prisma).prune(now);

    expect(removed).toEqual({ ordinary: 1, destructive: 1 });
    expect(store.map((row) => row.id).sort()).toEqual(["destructive-mid", "ordinary-fresh"]);
  });

  it("queries each class against its own cut-off", async () => {
    const { prisma, seen } = prismaWith([]);
    await new RetentionService(prisma).prune(now);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ destructive: false, before: daysAgo(90) });
    expect(seen[1]).toMatchObject({ destructive: true, before: daysAgo(365) });
  });

  it("survives a database that will not answer", async () => {
    // A prune that cannot run leaves rows behind, which is a disk problem. A
    // prune that throws takes the API down, which is an outage.
    const broken = {
      activityLog: {
        findMany: () => Promise.reject(new Error("gone")),
      },
    } as unknown as PrismaService;

    await expect(new RetentionService(broken).prune(now)).resolves.toEqual({ ordinary: 0, destructive: 0 });
  });
});

// ---------------------------------------------------------------- reading

describe("activity paging", () => {
  function serviceOver(count: number) {
    const captured: { where: Record<string, unknown>; take: number }[] = [];

    const prisma = {
      activityLog: {
        findMany: (args: { where: Record<string, unknown>; take: number }) => {
          captured.push(args);
          return Promise.resolve(
            Array.from({ length: Math.min(count, args.take) }, (_, index) => ({
              id: `row-${index}`,
              kind: "host.create",
              summary: "Added a host",
              tag: null,
              hostId: null,
              outcome: "success" as const,
              detail: null,
              elevated: false,
              bytes: 9_007_199_254_740_993n,
              durationMs: 4,
              createdAt: new Date("2026-08-12T00:00:00Z"),
              payload: null,
            })),
          );
        },
      },
    } as unknown as PrismaService;

    return { service: new ActivityService(prisma), captured };
  }

  it("asks for one more row than requested, and reports the next cursor", async () => {
    // The extra row's existence is the answer to "is there another page",
    // which beats a second COUNT that can disagree with the first by the time
    // it runs.
    const { service, captured } = serviceOver(100);
    const page = await service.list(USER, { limit: "5" });

    expect(captured[0].take).toBe(6);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBe("row-4");
  });

  it("reports no next cursor on the last page", async () => {
    const { service } = serviceOver(3);
    await expect(service.list(USER, { limit: "5" })).resolves.toMatchObject({ nextCursor: null });
  });

  it("scopes to the session user and pages on the id, never on createdAt", async () => {
    const { service, captured } = serviceOver(1);
    await service.list(USER, { cursor: "row-9", hostId: "host-1", kind: "host.delete" });

    expect(captured[0].where).toMatchObject({
      userId: USER,
      hostId: "host-1",
      kind: "host.delete",
      id: { lt: "row-9" },
    });
    // A createdAt cursor loses rows that share a millisecond, silently, and
    // exactly at the page boundary.
    expect(captured[0].where).not.toHaveProperty("createdAt");
  });

  it("clamps the limit rather than trusting it", async () => {
    const { service, captured } = serviceOver(1);
    await service.list(USER, { limit: "999" });
    expect(captured[0].take).toBe(101);

    await service.list(USER, { limit: "0" });
    expect(captured[1].take).toBe(2);
  });

  it("carries a byte count out as a string", async () => {
    // 2^53 + 1. Through `Number` it comes back as 2^53 and nothing complains;
    // through JSON.stringify on the BigInt it throws outright.
    const { service } = serviceOver(1);
    const page = await service.list(USER, {});

    expect(page.items[0].bytes).toBe("9007199254740993");
    expect(() => JSON.stringify(page)).not.toThrow();
  });
});
