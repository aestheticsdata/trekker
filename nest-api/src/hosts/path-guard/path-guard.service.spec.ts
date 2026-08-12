import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForbiddenException, HttpException } from "@nestjs/common";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { LocalDriver } from "@hosts/drivers/local.driver";
import {
  PathGuardService,
  PATH_DENYLISTED_MESSAGE,
  PATH_REFUSED_MESSAGE,
  withinRoots,
} from "@hosts/path-guard/path-guard.service";
import type { AuditOpening, AuditService } from "@audit/audit.service";
import type { RedisService } from "@redis/redis.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * TRE-11's Done list, distilled to the attacks that matter. Everything runs
 * against the real LocalDriver on a real temp tree — path security faked with
 * mocks would test the mocks.
 */

const HOST_ID = "host-under-test";
const USER_ID = "user-1";

let base: string;

interface RootFixture {
  path: string;
  access: "READ" | "WRITE";
}

/**
 * A stand-in Redis with the three operations the limiter uses, counting for
 * real. Deliberately not an always-allow stub: the refusal limit now sits on
 * the path of every refusal in this file, and stubbing it away would mean the
 * tests below no longer run the code they appear to run.
 *
 * One counter per guard, so a test that pushes past the limit cannot change
 * what the next test sees.
 */
function memoryLimits(): RateLimitService {
  const counts = new Map<string, number>();
  const redis = {
    getClient: () => ({
      incrBy: (key: string, amount: number) => {
        const next = (counts.get(key) ?? 0) + amount;
        counts.set(key, next);
        return Promise.resolve(next);
      },
      expire: () => Promise.resolve(true),
      ttl: () => Promise.resolve(30),
    }),
  } as unknown as RedisService;
  return new RateLimitService(redis);
}

function recordingAudit(): { audit: AuditService; rows: AuditOpening[]; details: string[] } {
  const rows: AuditOpening[] = [];
  const details: string[] = [];
  const audit = {
    refused: (opening: AuditOpening, detail: string) => {
      rows.push(opening);
      details.push(detail);
      return Promise.resolve();
    },
  } as unknown as AuditService;
  return { audit, rows, details };
}

interface GuardOptions {
  transport?: "LOCAL" | "SSH";
  denylist?: string[];
  limits?: RateLimitService;
  audit?: AuditService;
  /**
   * Defaults to MEMBER, and that default is load-bearing: every test above the
   * owner block asserts the restricted path, and they only mean anything while
   * the account under test is a restricted one.
   */
  role?: "OWNER" | "MEMBER";
}

function guardFor(roots: RootFixture[], options: GuardOptions = {}) {
  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? {
                id: HOST_ID,
                userId: USER_ID,
                transport: options.transport ?? "LOCAL",
                roots,
                user: { role: options.role ?? "MEMBER" },
              }
            : null,
        ),
    },
  } as unknown as PrismaService;
  return new PathGuardService(
    prisma,
    options.denylist ?? [join(base, "install")],
    options.limits ?? memoryLimits(),
    options.audit ?? recordingAudit().audit,
  );
}

const driver = () => new LocalDriver(HOST_ID);

beforeAll(async () => {
  // realpath: on macOS the tmpdir sits behind a /var → /private/var symlink,
  // and the guard compares resolved paths.
  base = await realpath(await mkdtemp(join(tmpdir(), "trekker-path-guard-")));

  await mkdir(join(base, "allowed", "sub"), { recursive: true });
  await writeFile(join(base, "allowed", "file.txt"), "in-root");
  await writeFile(join(base, "allowed", "sub", "deep.txt"), "deeper");
  await mkdir(join(base, "allowedbis"));
  await mkdir(join(base, "readonly"));
  await writeFile(join(base, "readonly", "r.txt"), "read me");
  await mkdir(join(base, "outside"));
  await writeFile(join(base, "outside", "secret.txt"), "not yours");
  await mkdir(join(base, "install"));
  await writeFile(join(base, "install", "ecosystem.config.js"), "secrets live here");

  await symlink(join(base, "allowed", "sub"), join(base, "allowed", "link-inside"));
  await symlink(join(base, "outside"), join(base, "allowed", "link-outside"));
  await symlink(join(base, "install"), join(base, "allowed", "link-install"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function refusalOf(promise: Promise<unknown>): Promise<ForbiddenException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ForbiddenException) return error;
    throw error;
  }
  throw new Error("expected the guard to refuse");
}

describe("PathGuardService", () => {
  it("grants a path inside a WRITE root and hands back the resolved real path", async () => {
    const guard = guardFor([{ path: join(base, "allowed"), access: "WRITE" }]);
    const validated = await guard.validate({
      driver: driver(),
      userId: USER_ID,
      path: join(base, "allowed", "file.txt"),
      intent: "write",
    });
    expect(validated.realPath).toBe(join(base, "allowed", "file.txt"));
    expect(validated.hostId).toBe(HOST_ID);
  });

  it("refuses `..` traversal that resolves outside every root", async () => {
    const guard = guardFor([{ path: join(base, "allowed"), access: "WRITE" }]);
    const escape = join(base, "allowed") + "/../outside/secret.txt";
    const error = await refusalOf(guard.validate({ driver: driver(), userId: USER_ID, path: escape, intent: "read" }));
    expect(error.message).toBe(PATH_REFUSED_MESSAGE);
  });

  it("refuses a symlink inside a root that points outside it", async () => {
    const guard = guardFor([{ path: join(base, "allowed"), access: "WRITE" }]);
    await refusalOf(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "allowed", "link-outside", "secret.txt"),
        intent: "read",
      }),
    );
  });

  it("follows a symlink that stays inside the root", async () => {
    const guard = guardFor([{ path: join(base, "allowed"), access: "WRITE" }]);
    const validated = await guard.validate({
      driver: driver(),
      userId: USER_ID,
      path: join(base, "allowed", "link-inside", "deep.txt"),
      intent: "read",
    });
    expect(validated.realPath).toBe(join(base, "allowed", "sub", "deep.txt"));
  });

  it("validates a not-yet-existing path against its nearest existing ancestor", async () => {
    const guard = guardFor([{ path: join(base, "allowed"), access: "WRITE" }]);
    const validated = await guard.validate({
      driver: driver(),
      userId: USER_ID,
      path: join(base, "allowed", "new-dir", "new-file.txt"),
      intent: "write",
    });
    expect(validated.realPath).toBe(join(base, "allowed", "new-dir", "new-file.txt"));
  });

  it("refuses `..` smuggled through a not-yet-existing suffix", async () => {
    const guard = guardFor([{ path: join(base, "allowed"), access: "WRITE" }]);
    await refusalOf(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "allowed") + "/ghost/../../outside/x",
        intent: "write",
      }),
    );
  });

  it("refuses a nonexistent path whose ancestor lies outside the roots", async () => {
    const guard = guardFor([{ path: join(base, "allowed"), access: "WRITE" }]);
    await refusalOf(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "outside", "new-file.txt"),
        intent: "write",
      }),
    );
  });

  it("refuses writes into a READ root but allows reads", async () => {
    const guard = guardFor([{ path: join(base, "readonly"), access: "READ" }]);
    const target = join(base, "readonly", "r.txt");
    await expect(
      guard.validate({ driver: driver(), userId: USER_ID, path: target, intent: "read" }),
    ).resolves.toMatchObject({ realPath: target });
    await refusalOf(guard.validate({ driver: driver(), userId: USER_ID, path: target, intent: "write" }));
  });

  it("does not let a root admit its string-prefix sibling (/data vs /database)", async () => {
    const guard = guardFor([{ path: join(base, "allowed"), access: "WRITE" }]);
    await refusalOf(
      guard.validate({ driver: driver(), userId: USER_ID, path: join(base, "allowedbis"), intent: "read" }),
    );
  });

  it("refuses the denylist on a LOCAL host even under a root of `/`", async () => {
    const guard = guardFor([{ path: "/", access: "WRITE" }]);
    // The `/` root really does grant everything else…
    await expect(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "outside", "secret.txt"),
        intent: "read",
      }),
    ).resolves.toBeDefined();
    // …but never the install directory, not even through a symlink.
    await refusalOf(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "install", "ecosystem.config.js"),
        intent: "read",
      }),
    );
    await refusalOf(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "allowed", "link-install", "ecosystem.config.js"),
        intent: "read",
      }),
    );
  });

  it("answers identically for a forbidden path that exists and one that does not", async () => {
    const guard = guardFor([{ path: join(base, "allowed"), access: "WRITE" }]);
    const existing = await refusalOf(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "outside", "secret.txt"),
        intent: "read",
      }),
    );
    const missing = await refusalOf(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "outside", "does-not-exist.txt"),
        intent: "read",
      }),
    );
    expect(existing.getStatus()).toBe(missing.getStatus());
    expect(existing.message).toBe(missing.message);
  });

  it("refuses relative paths and NUL bytes outright", async () => {
    const guard = guardFor([{ path: join(base, "allowed"), access: "WRITE" }]);
    await refusalOf(guard.validate({ driver: driver(), userId: USER_ID, path: "etc/passwd", intent: "read" }));
    await refusalOf(
      guard.validate({ driver: driver(), userId: USER_ID, path: join(base, "allowed", "a\0b"), intent: "read" }),
    );
  });

  it("reports an unknown or foreign host as not-found, never as forbidden", async () => {
    const guard = guardFor([{ path: join(base, "allowed"), access: "WRITE" }]);
    await expect(
      guard.validate({
        driver: driver(),
        userId: "someone-else",
        path: join(base, "allowed", "file.txt"),
        intent: "read",
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ---------------------------------------------------- owner bypass (TRE-48)

describe("owner bypass", () => {
  const narrow = (): RootFixture[] => [{ path: join(base, "allowed"), access: "WRITE" }];
  const owner = { role: "OWNER" as const };

  it("opens a path outside every configured root", async () => {
    // The pair of the member test above, which refuses this exact path.
    const guard = guardFor(narrow(), owner);
    await expect(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "outside", "secret.txt"),
        intent: "read",
      }),
    ).resolves.toMatchObject({ realPath: join(base, "outside", "secret.txt") });
  });

  it("allows write intent where the configured root is READ", async () => {
    // The half nobody sees by browsing: containment and intent are separate
    // checks, so an owner whose reach was READ would still be refused chmod
    // and chown, and PermissionsService would report it as a per-path failure
    // rather than a refusal.
    const guard = guardFor([{ path: join(base, "readonly"), access: "READ" }], owner);
    await expect(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "readonly", "r.txt"),
        intent: "write",
      }),
    ).resolves.toMatchObject({ realPath: join(base, "readonly", "r.txt") });
  });

  it("reports the whole filesystem as the owner's reach, so symlinks read as inside it", async () => {
    // Asserted directly because this return value is the entire contract
    // behind TRE-13's `linkInsideRoot`, and the front blocks a symlink click
    // on that flag. Without it the bypass passes its own suite and still
    // refuses the owner in the browser.
    const guard = guardFor(narrow(), owner);
    const roots = await guard.resolveRoots(driver(), USER_ID);
    expect(roots).toEqual([{ path: "/", realPath: "/", access: "WRITE" }]);
    expect(withinRoots(join(base, "outside"), roots, "read")).toBe(true);
  });

  it("still refuses the denylist, and says why", async () => {
    // The one boundary left standing: past it sit the master key and the API
    // user's SSH keys. The owner gets an explanation because for them this is
    // now the only refusal a real path can produce.
    const guard = guardFor(narrow(), owner);
    const direct = await refusalOf(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "install", "ecosystem.config.js"),
        intent: "read",
      }),
    );
    expect(direct.message).toBe(PATH_DENYLISTED_MESSAGE);

    // Through a symlink too, which is what proves the check still happens
    // after resolution rather than as an early return.
    const linked = await refusalOf(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "allowed", "link-install", "ecosystem.config.js"),
        intent: "read",
      }),
    );
    expect(linked.message).toBe(PATH_DENYLISTED_MESSAGE);
  });

  it("keeps the uniform refusal for a member meeting the denylist", async () => {
    // The explanation is a courtesy to the owner, not a change to what the
    // application discloses. Everyone else still cannot tell one refusal from
    // another.
    const guard = guardFor([{ path: "/", access: "WRITE" }]);
    const error = await refusalOf(
      guard.validate({
        driver: driver(),
        userId: USER_ID,
        path: join(base, "install", "ecosystem.config.js"),
        intent: "read",
      }),
    );
    expect(error.message).toBe(PATH_REFUSED_MESSAGE);
  });

  it("is never rate limited out of navigation", async () => {
    // Through the denylist, because that is the refusal an owner actually
    // produces in bulk: those directories sit under the API user's home, which
    // is the LOCAL host's default home and default root, and the explorer
    // prefetches on hover. A counted owner would be 429ed out of the very walk
    // this ticket asked for, without ever clicking anything.
    const guard = guardFor(narrow(), owner);
    for (let attempt = 1; attempt <= LIMITS.pathRefusal.max + 5; attempt += 1) {
      const error = await refusalError(guard, join(base, "install", `probe-${attempt}.js`));
      expect(error.getStatus()).toBe(403);
      // And it keeps explaining itself past the line, rather than degrading
      // into the message for a limit that was not applied.
      expect(error.message).toBe(PATH_DENYLISTED_MESSAGE);
    }
  });

  it("still writes the one audit row when the owner crosses the line", async () => {
    // The count is kept precisely so this row survives the bypass, and the
    // summary must not claim the owner was blocked when they were not.
    const { audit, rows, details } = recordingAudit();
    const guard = guardFor(narrow(), { ...owner, audit });

    for (let attempt = 1; attempt <= LIMITS.pathRefusal.max + 5; attempt += 1) {
      await refusalError(guard, join(base, "install", `probe-${attempt}.js`));
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: USER_ID, hostId: HOST_ID, kind: "path.refused" });
    expect(rows[0].summary).not.toContain("Blocked");
    // The strip renders summary and detail as one line, so the detail must not
    // announce a limit the summary just said was not applied.
    expect(details[0]).not.toContain("Rate limit reached");
  });
});

// ------------------------------------------------ refused-path limit (TRE-30)

/** A path that is always outside the roots, and never the same one twice. */
function outside(attempt: number): string {
  return join(base, "outside", `no-${attempt}.txt`);
}

async function refusalError(guard: PathGuardService, path: string): Promise<HttpException> {
  try {
    await guard.validate({ driver: driver(), userId: USER_ID, path, intent: "read" });
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error("expected the guard to refuse");
}

describe("refused-path limit", () => {
  const roots = (): RootFixture[] => [{ path: join(base, "allowed"), access: "WRITE" }];
  const { max } = LIMITS.pathRefusal;

  it("answers 403 up to the limit and 429 past it", async () => {
    const guard = guardFor(roots());

    for (let attempt = 1; attempt <= max; attempt += 1) {
      expect((await refusalError(guard, outside(attempt))).getStatus()).toBe(403);
    }

    const blocked = await refusalError(guard, outside(max + 1));
    expect(blocked.getStatus()).toBe(429);
    // Names the limit and the wait: a 429 that says only "too many requests"
    // leaves the caller unable to tell a second from an hour.
    expect(blocked.message).toContain(String(max));
  });

  it("still serves the paths the user is allowed to open", async () => {
    // The property that makes this limit safe to enforce: it counts refusals,
    // never requests. Someone mistyping a path is stopped from mistyping a
    // twenty-first, not from doing their job.
    const guard = guardFor(roots());
    for (let attempt = 1; attempt <= max + 1; attempt += 1) {
      await refusalError(guard, outside(attempt));
    }

    await expect(
      guard.validate({ driver: driver(), userId: USER_ID, path: join(base, "allowed", "file.txt"), intent: "read" }),
    ).resolves.toMatchObject({ realPath: join(base, "allowed", "file.txt") });
  });

  it("writes one audit row as the line is crossed, not one per refusal after it", async () => {
    // Read routes are not audited, so for a filesystem walk this row is the
    // only record there is — and a row per refusal past the limit would bury
    // it under the very volume it is reporting.
    const { audit, rows } = recordingAudit();
    const guard = guardFor(roots(), { audit });

    for (let attempt = 1; attempt <= max + 5; attempt += 1) {
      await refusalError(guard, outside(attempt));
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: USER_ID, hostId: HOST_ID, kind: "path.refused" });
  });

  it("refuses on its own when the counter is unavailable", async () => {
    // RateLimitService fails open by design. That must not become the guard
    // failing open: a path outside the roots is still forbidden when Redis is
    // down, it simply stops being counted.
    const broken = new RateLimitService({
      getClient: () => {
        throw new Error("redis down");
      },
    } as unknown as RedisService);
    const guard = guardFor(roots(), { limits: broken });

    for (let attempt = 1; attempt <= max + 2; attempt += 1) {
      expect((await refusalError(guard, outside(attempt))).getStatus()).toBe(403);
    }
  });
});
