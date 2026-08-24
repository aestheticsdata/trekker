import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpException } from "@nestjs/common";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { LocalDriver } from "@hosts/drivers/local.driver";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { DriverError } from "@hosts/drivers/driver-error";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { SudoRunnerService } from "@hosts/sudo/sudo-runner.service";
import { SudoService } from "@hosts/sudo/sudo.service";
import type { IdResolverService } from "@fs/id-resolver.service";
import { PermissionSnapshotService, type SnapshotEntry } from "@fs/permission-snapshot.service";
import { PermissionsService, describeMode, entryCeiling, parseMode, specialBits } from "@fs/permissions.service";
import { walkTree } from "@fs/tree-walk";
import { FsController } from "@fs/fs.controller";
import { CsrfGuard } from "@users/guards/csrf.guard";
import { SessionAuthGuard } from "@users/guards/session-auth.guard";

import type { AuditService } from "@audit/audit.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "@redis/redis.service";

/**
 * TRE-21, against the real LocalDriver on a real tree. A permissions change
 * mocked at the driver would test the mock: what is actually worth proving is
 * that a recursive chmod does not lock itself out halfway through, and that is
 * a property of the filesystem, not of this code's intentions.
 */

const HOST_ID = "host-under-test";
const USER_ID = "user-1";

/** Tests must not run as root: half of what is asserted here is what a normal user cannot do. */
const asRoot = process.getuid?.() === 0;
const unlessRoot = asRoot ? it.skip : it;

let base: string;

function memoryLimits(): RateLimitService {
  const counts = new Map<string, number>();
  return new RateLimitService({
    getClient: () => ({
      incrBy: (key: string, amount: number) => {
        const next = (counts.get(key) ?? 0) + amount;
        counts.set(key, next);
        return Promise.resolve(next);
      },
      expire: () => Promise.resolve(true),
      ttl: () => Promise.resolve(30),
    }),
  } as unknown as RedisService);
}

const silentAudit = { refused: () => Promise.resolve() } as unknown as AuditService;

/** Names fixed here rather than read from the host, so the assertions mean the same thing everywhere. */
const ids = {
  forHost: () =>
    Promise.resolve({
      users: new Map([
        [0, "root"],
        [4242, "alice"],
      ]),
      groups: new Map([
        [0, "wheel"],
        [4242, "developers"],
      ]),
      at: Date.now(),
    }),
} as unknown as IdResolverService;

function serviceFor(
  roots: { path: string; access: "READ" | "WRITE" }[],
  role: "OWNER" | "MEMBER" = "MEMBER",
  /** Denylisted on the LOCAL host, as `computeLocalDenylist` produces at boot. */
  denylist: string[] = [join(base, "install")],
): PermissionsService {
  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? { id: HOST_ID, userId: USER_ID, transport: "LOCAL", roots, user: { role } }
            : null,
        ),
    },
    permissionSnapshots: {
      createMany: ({ data }: { data: unknown[] }) => Promise.resolve({ count: data.length }),
    },
  } as unknown as PrismaService;

  const guard = new PathGuardService(prisma, denylist, memoryLimits(), silentAudit);
  const factory = { forHost: () => Promise.resolve(new LocalDriver(HOST_ID)) } as unknown as HostDriverFactory;
  // A real runner over a real (empty) window store: nothing here opens one, so
  // `isOpen` is always false and every change takes the ordinary path. That is
  // the point — TRE-29 must not have altered what happens without a window.
  return new PermissionsService(
    factory,
    guard,
    ids,
    new SudoRunnerService(new SudoService()),
    new PermissionSnapshotService(prisma),
  );
}

/**
 * The same service, over a driver that refuses the way a root-owned file does,
 * with a sudo window already open (TRE-29).
 *
 * The driver is a real `LocalDriver` with two methods replaced: `chmod` throws
 * whatever the test asks for, and `exec` records the elevated call instead of
 * running `sudo`. Everything else — the guard, the roots, the denylist, the
 * walk — is the real thing, because those are what the escalation must not be
 * able to step around.
 */
function elevatedServiceFor(
  roots: { path: string; access: "READ" | "WRITE" }[],
  refusal: DriverError,
  denylist: string[] = [join(base, "install")],
): { service: PermissionsService; elevatedCalls: Array<{ program: string; args: readonly string[] }> } {
  const elevatedCalls: Array<{ program: string; args: readonly string[] }> = [];

  const driver = new LocalDriver(HOST_ID) as LocalDriver & Record<string, unknown>;
  driver.chmod = () => Promise.reject(refusal);
  driver.exec = (program: string, args: readonly string[]) => {
    elevatedCalls.push({ program, args });
    return Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "" });
  };

  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? { id: HOST_ID, userId: USER_ID, transport: "LOCAL", roots, user: { role: "MEMBER" } }
            : null,
        ),
    },
    permissionSnapshots: {
      createMany: ({ data }: { data: unknown[] }) => Promise.resolve({ count: data.length }),
    },
  } as unknown as PrismaService;

  const guard = new PathGuardService(prisma, denylist, memoryLimits(), silentAudit);
  const factory = { forHost: () => Promise.resolve(driver) } as unknown as HostDriverFactory;

  const sudo = new SudoService();
  sudo.open(SESSION_ID, HOST_ID, "hunter2");

  return {
    service: new PermissionsService(
      factory,
      guard,
      ids,
      new SudoRunnerService(sudo),
      new PermissionSnapshotService(prisma),
    ),
    elevatedCalls,
  };
}

function serviceForWithSnapshots(roots: { path: string; access: "READ" | "WRITE" }[]): {
  service: PermissionsService;
  recorded: SnapshotEntry[];
} {
  const recorded: SnapshotEntry[] = [];
  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? { id: HOST_ID, userId: USER_ID, transport: "LOCAL", roots, user: { role: "MEMBER" } }
            : null,
        ),
    },
    permissionSnapshots: {
      createMany: ({ data }: { data: SnapshotEntry[] }) => {
        recorded.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
  } as unknown as PrismaService;

  const guard = new PathGuardService(prisma, [join(base, "install")], memoryLimits(), silentAudit);
  const factory = { forHost: () => Promise.resolve(new LocalDriver(HOST_ID)) } as unknown as HostDriverFactory;
  const service = new PermissionsService(
    factory,
    guard,
    ids,
    new SudoRunnerService(new SudoService()),
    new PermissionSnapshotService(prisma),
  );
  return { service, recorded };
}

const SESSION_ID = "session-under-test";

const writeRoot = () => [{ path: base, access: "WRITE" as const }];

async function modeOf(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o7777).toString(8).padStart(4, "0");
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "trekker-permissions-")));
});

afterAll(async () => {
  // The tests deliberately leave directories unreadable; make the tree
  // removable again before handing it to rm.
  await chmod(base, 0o755).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the walk

describe("walkTree", () => {
  it("returns children before the directory that holds them", async () => {
    const root = join(base, "walk-order");
    await mkdir(join(root, "inner"), { recursive: true });
    await writeFile(join(root, "inner", "deep.txt"), "x");
    await writeFile(join(root, "top.txt"), "y");

    const walked = await walkTree(new LocalDriver(HOST_ID), root, 100);

    expect(walked.paths.at(-1)).toBe(root);
    expect(walked.paths.indexOf(join(root, "inner", "deep.txt"))).toBeLessThan(
      walked.paths.indexOf(join(root, "inner")),
    );
    expect(walked.exceeded).toBe(false);
  });

  it("never walks into a symlink, and never returns one", async () => {
    // The containment property. `chmod` follows symlinks, so a link inside the
    // tree is a way out of the roots that the guard never saw — it validated
    // the path the client sent, not a link found three levels down.
    const root = join(base, "walk-links");
    await mkdir(join(root, "real"), { recursive: true });
    await writeFile(join(root, "real", "f.txt"), "x");
    await mkdir(join(base, "elsewhere"), { recursive: true });
    await writeFile(join(base, "elsewhere", "secret.txt"), "not yours");
    await symlink(join(base, "elsewhere"), join(root, "escape"));

    const walked = await walkTree(new LocalDriver(HOST_ID), root, 100);

    expect(walked.paths).not.toContain(join(root, "escape"));
    expect(walked.paths.some((path) => path.includes("elsewhere"))).toBe(false);
    expect(walked.skippedLinks).toBe(1);
  });

  it("stops at the ceiling instead of walking the whole tree", async () => {
    const root = join(base, "walk-big");
    await mkdir(root, { recursive: true });
    for (let index = 0; index < 12; index += 1) await writeFile(join(root, `f${index}`), "x");

    const walked = await walkTree(new LocalDriver(HOST_ID), root, 5);

    expect(walked.exceeded).toBe(true);
    expect(walked.paths.length).toBeLessThanOrEqual(6);
  });

  it("treats a plain file as itself, not as an unreadable directory", async () => {
    const file = join(base, "walk-file.txt");
    await writeFile(file, "x");

    const walked = await walkTree(new LocalDriver(HOST_ID), file, 100);

    expect(walked.paths).toEqual([file]);
    expect(walked.unreadable).toEqual([]);
  });

  unlessRoot("names a directory it could not read rather than counting it as empty", async () => {
    const root = join(base, "walk-denied");
    await mkdir(join(root, "closed"), { recursive: true });
    await writeFile(join(root, "closed", "hidden.txt"), "x");
    await chmod(join(root, "closed"), 0o000);

    const walked = await walkTree(new LocalDriver(HOST_ID), root, 100);

    expect(walked.unreadable).toEqual([join(root, "closed")]);
    // Still in the list: changing its mode is how an unreadable directory is
    // fixed, so it must remain a target.
    expect(walked.paths).toContain(join(root, "closed"));

    await chmod(join(root, "closed"), 0o755);
  });

  it("carries gid alongside uid on every entry, including the root's own", async () => {
    const root = join(base, "walk-gid");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "f.txt"), "x");

    const walked = await walkTree(new LocalDriver(HOST_ID), root, 100);

    const expectedGid = process.getgid?.() ?? 0;
    const file = walked.details.find((entry) => entry.path === join(root, "f.txt"));
    const rootEntry = walked.details.find((entry) => entry.path === root);
    expect(file?.gid).toBe(expectedGid);
    expect(rootEntry?.gid).toBe(expectedGid);
  });
});

describe("chmod — undo snapshots (TRE-75)", () => {
  it("records the previous mode for every entry actually changed, when given an activityLogId", async () => {
    const root = join(base, "snap-recursive");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "x");
    await writeFile(join(root, "b.txt"), "y");
    await chmod(join(root, "a.txt"), 0o644);
    await chmod(join(root, "b.txt"), 0o600);

    const { service, recorded } = serviceForWithSnapshots(writeRoot());

    await service.chmod(USER_ID, HOST_ID, [root], 0o755, true, undefined, "activity-1");

    const a = recorded.find((row) => row.path === join(root, "a.txt"));
    const b = recorded.find((row) => row.path === join(root, "b.txt"));
    expect(a?.mode).toBe(0o644);
    expect(b?.mode).toBe(0o600);
    expect(recorded.every((row) => row.activityLogId === "activity-1")).toBe(true);
  });

  it("records nothing when no activityLogId is given", async () => {
    const root = join(base, "snap-none");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "x");

    const { service, recorded } = serviceForWithSnapshots(writeRoot());

    await service.chmod(USER_ID, HOST_ID, [root], 0o755, true);

    expect(recorded).toEqual([]);
  });

  it("pays one stat for a non-recursive change, and records only that path", async () => {
    const file = join(base, "snap-single.txt");
    await writeFile(file, "x");
    await chmod(file, 0o644);

    const { service, recorded } = serviceForWithSnapshots(writeRoot());

    await service.chmod(USER_ID, HOST_ID, [file], 0o600, false, undefined, "activity-2");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ activityLogId: "activity-2", path: file, mode: 0o644 });
  });
});

// ------------------------------------------------------------------- parsing

describe("mode parsing", () => {
  it("reads octal, and refuses anything that is not a mode", () => {
    expect(parseMode("0644")).toBe(0o644);
    expect(parseMode("755")).toBe(0o755);
    // The reason mode travels as a string: JSON would make this 644 decimal,
    // which is 0o1204 — a valid mode, and not the one anyone asked for.
    expect(parseMode("0644")).not.toBe(644);
    expect(() => parseMode("0999")).toThrow();
    expect(() => parseMode("rwxr-xr-x")).toThrow();
    expect(() => parseMode("77777")).toThrow();
  });

  it("names the bits that leave privilege behind", () => {
    expect(specialBits(0o4755)).toEqual(["setuid"]);
    expect(specialBits(0o6755)).toEqual(["setuid", "setgid"]);
    expect(specialBits(0o1777)).toEqual(["sticky"]);
    expect(specialBits(0o0644)).toEqual([]);
    expect(describeMode(0o4755)).toContain("setuid");
  });
});

// --------------------------------------------------------------------- chmod

describe("chmod", () => {
  it("changes one file, and a multi-selection", async () => {
    const first = join(base, "one.txt");
    const second = join(base, "two.txt");
    await writeFile(first, "a");
    await writeFile(second, "b");
    await chmod(first, 0o600);
    await chmod(second, 0o600);

    const result = await serviceFor(writeRoot()).chmod(USER_ID, HOST_ID, [first, second], 0o644, false);

    expect(result.changed).toBe(2);
    expect(result.failed).toBe(0);
    expect(await modeOf(first)).toBe("0644");
    expect(await modeOf(second)).toBe("0644");
  });

  unlessRoot("applies recursively without locking itself out of the tree", async () => {
    // The reason the walk is post-order. Removing `x` from a directory makes
    // its children unreachable, so a parent-first pass would take away its own
    // permission to continue and report success on a job it abandoned.
    const root = join(base, "recursive");
    await mkdir(join(root, "inner"), { recursive: true });
    await writeFile(join(root, "inner", "deep.txt"), "x");
    await writeFile(join(root, "top.txt"), "y");

    const result = await serviceFor(writeRoot()).chmod(USER_ID, HOST_ID, [root], 0o700, true);

    expect(result.failed).toBe(0);
    expect(result.changed).toBe(4); // root, inner, deep.txt, top.txt
    expect(await modeOf(join(root, "inner", "deep.txt"))).toBe("0700");
    expect(await modeOf(root)).toBe("0700");
  });

  unlessRoot("does not follow a symlink into the denylist, which is a second lock on the same door", async () => {
    // Deliberately recorded as what it is: this passes with or without TRE-52's
    // filter, because the walk skips symlinks outright and so never reaches the
    // target. Kept because the two mechanisms guard the same door and the day
    // the walk starts following links, the filter is what has to hold — and
    // this test is where that change announces itself.
    const root = join(base, "around");
    await mkdir(join(root, "keep"), { recursive: true });
    await writeFile(join(root, "keep", "ordinary.txt"), "x");
    await chmod(join(root, "keep", "ordinary.txt"), 0o600);

    const secret = join(base, "install", "under-around");
    await mkdir(secret, { recursive: true });
    const key = join(secret, "ecosystem.config.js");
    await writeFile(key, "master key lives here");
    await chmod(key, 0o600);
    await symlink(secret, join(root, "link-to-install"));

    const result = await serviceFor(writeRoot()).chmod(USER_ID, HOST_ID, [root], 0o777, true);

    expect(await modeOf(join(root, "keep", "ordinary.txt"))).toBe("0777");
    expect(await modeOf(key)).toBe("0600");
    // The reason it was spared, asserted rather than assumed.
    expect(result.skippedLinks).toBeGreaterThan(0);
  });

  unlessRoot("leaves a denylisted entry the walk really reaches alone, and names it", async () => {
    // TRE-52 proper. The guard refuses a denylisted path the client names; a
    // recursive change aimed at the directory ABOVE it never names those paths
    // at all — the walk invents them — and that is what used to reach `~/.ssh`
    // from a chmod on the home directory it sits in.
    //
    // No symlink here: the denylisted directory is a real child, so the walk
    // enumerates it and only the filter can stop the change.
    const root = join(base, "holds-install");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "plain.txt"), "x");
    await chmod(join(root, "plain.txt"), 0o600);

    const denied = join(root, "secrets");
    await mkdir(denied, { recursive: true });
    const inside = join(denied, "key.txt");
    await writeFile(inside, "x");
    await chmod(inside, 0o600);

    const result = await serviceFor(writeRoot(), "MEMBER", [denied]).chmod(USER_ID, HOST_ID, [root], 0o777, true);

    expect(await modeOf(join(root, "plain.txt"))).toBe("0777");
    expect(await modeOf(inside)).toBe("0600");
    expect(result.refused).toEqual(expect.arrayContaining([inside, denied]));
    // A partial result, not a failure: the rest of the tree is a legitimate
    // change and refusing all of it would be the batch failure this route
    // exists to avoid.
    expect(result.failed).toBe(0);
    expect(result.changed).toBeGreaterThan(0);
  });

  it("refuses a recursive change above the ceiling, and says how big it is", async () => {
    const root = join(base, "huge");
    await mkdir(root, { recursive: true });
    for (let index = 0; index < 8; index += 1) await writeFile(join(root, `f${index}`), "x");

    process.env.TREKKER_RECURSIVE_ENTRY_CEILING = "3";
    expect(entryCeiling()).toBe(3);

    const error = await serviceFor(writeRoot())
      .chmod(USER_ID, HOST_ID, [root], 0o755, true)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HttpException);
    const body = (error as HttpException).getResponse() as { code: string; message: string; ceiling: number };
    expect((error as HttpException).getStatus()).toBe(422);
    expect(body.code).toBe("ETOOMANY");
    expect(body.ceiling).toBe(3);
    expect(body.message).toContain("3");

    delete process.env.TREKKER_RECURSIVE_ENTRY_CEILING;
  });

  it("reports exactly which paths failed and keeps the ones that worked", async () => {
    const good = join(base, "partial-ok.txt");
    await writeFile(good, "a");
    const outside = join(base, "..", "not-in-any-root.txt");

    const result = await serviceFor([{ path: join(base), access: "WRITE" }]).chmod(
      USER_ID,
      HOST_ID,
      [good, outside, join(base, "missing.txt")],
      0o640,
      false,
    );

    expect(result.failed).toBe(2);
    expect(result.results.find((row) => row.path === good)?.ok).toBe(true);
    expect(result.results.find((row) => row.path === outside)?.ok).toBe(false);
    expect(await modeOf(good)).toBe("0640");
  });

  it("fails the request when every path failed, rather than returning a 200 nobody reads", async () => {
    const missing = join(base, "gone-a.txt");
    const alsoMissing = join(base, "gone-b.txt");

    const error = await serviceFor(writeRoot())
      .chmod(USER_ID, HOST_ID, [missing, alsoMissing], 0o644, false)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HttpException);
    const body = (error as HttpException).getResponse() as { results: { path: string }[]; message: string };
    expect(body.results).toHaveLength(2);
    expect(body.message).toContain("2");
  });

  it("refuses a path outside the roots even though the request looks ordinary", async () => {
    // The bypass the ticket asks about: the UI never offers this path, so the
    // only way to send it is by hand.
    const inside = join(base, "inside.txt");
    await writeFile(inside, "x");
    await mkdir(join(base, "fenced"), { recursive: true });
    const fenced = join(base, "fenced", "file.txt");
    await writeFile(fenced, "x");
    await chmod(fenced, 0o600);

    const result = await serviceFor([{ path: join(base), access: "READ" }])
      .chmod(USER_ID, HOST_ID, [fenced], 0o777, false)
      .catch((thrown: unknown) => thrown);

    // A READ root grants no writes, so this is refused before any driver call.
    expect(result).toBeInstanceOf(HttpException);
    expect(await modeOf(fenced)).toBe("0600");
  });

  it("answers 403 for a batch of refused paths, however long the batch is", async () => {
    // The live bug TRE-50 closed. The refusal counter used to answer 429 past
    // its threshold; `failure()` stamps `code: String(getStatus())`, and
    // `allFailed()` maps EPERM, EACCES, "403" and ENOENT and nothing else — so
    // a long enough all-refused batch fell through to 502 Bad Gateway and told
    // the operator their host was unreachable when it was their own roots.
    await mkdir(join(base, "fenced"), { recursive: true });
    const refused: string[] = [];
    for (let index = 0; index < LIMITS.pathRefusal.max + 5; index += 1) {
      const path = join(base, "fenced", `batch-${index}.txt`);
      await writeFile(path, "x");
      refused.push(path);
    }

    const error = await serviceFor([{ path: join(base), access: "READ" }])
      .chmod(USER_ID, HOST_ID, refused, 0o777, false)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(403);
  });

  it("lets the install's owner change a file outside every configured root", async () => {
    // The pair of the test above, and the half of TRE-48 that browsing cannot
    // show: the owner's reach has to grant write intent too, or chmod stays
    // refused everywhere the roots do not reach while listing works fine.
    await mkdir(join(base, "unfenced"), { recursive: true });
    const target = join(base, "unfenced", "file.txt");
    await writeFile(target, "x");
    await chmod(target, 0o600);

    await serviceFor([{ path: join(base, "nowhere-near-it"), access: "READ" }], "OWNER").chmod(
      USER_ID,
      HOST_ID,
      [target],
      0o644,
      false,
    );

    expect(await modeOf(target)).toBe("0644");
  });
});

// --------------------------------------------------------------------- chown

describe("chown", () => {
  it("changes nothing when neither owner nor group is given", async () => {
    const file = join(base, "chown-none.txt");
    await writeFile(file, "x");

    await expect(serviceFor(writeRoot()).chown(USER_ID, HOST_ID, [file], undefined, undefined, false)).rejects.toThrow(
      /owner/i,
    );
  });

  it("accepts the current owner by number, which is the one change anyone may make", async () => {
    const file = join(base, "chown-self.txt");
    await writeFile(file, "x");

    const result = await serviceFor(writeRoot()).chown(
      USER_ID,
      HOST_ID,
      [file],
      String(process.getuid?.() ?? 0),
      undefined,
      false,
    );

    expect(result.failed).toBe(0);
    expect(result.changed).toBe(1);
  });

  unlessRoot("steps over the denylist on a recursive change, the same as chmod does", async () => {
    // TRE-52 again, through the other verb. chown is the half that hands a file
    // to another uid, which is the version of this that gives `~/.ssh` away
    // rather than merely opening it.
    const root = join(base, "chown-around");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "plain.txt"), "x");

    const denied = join(root, "secrets");
    await mkdir(denied, { recursive: true });
    await writeFile(join(denied, "key.txt"), "x");

    const result = await serviceFor(writeRoot(), "MEMBER", [denied]).chown(
      USER_ID,
      HOST_ID,
      [root],
      String(process.getuid?.() ?? 0),
      undefined,
      true,
    );

    expect(result.refused).toEqual(expect.arrayContaining([denied, join(denied, "key.txt")]));
    // Counted as untouched, not as changed: `changed` is what the response
    // promises actually happened.
    expect(result.changed).toBe(2); // root and plain.txt
    expect(result.failed).toBe(0);
  });

  unlessRoot("says an unprivileged chown needs elevation instead of just denying it", async () => {
    // The distinction the ticket asks for: "you may not" is wrong. The truth is
    // "not without root", and it points at the toggle that provides it.
    const file = join(base, "chown-root.txt");
    await writeFile(file, "x");

    const error = await serviceFor(writeRoot())
      .chown(USER_ID, HOST_ID, [file], "root", undefined, false)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HttpException);
    const body = (error as HttpException).getResponse() as { results: { code?: string; message?: string }[] };
    expect(body.results[0].code).toBe("EPERM");
    expect(body.results[0].message).toMatch(/elevation/i);
  });

  it("refuses an unknown name before touching anything, not halfway through", async () => {
    // Resolution happens once, up front. A typo in a group name that surfaced
    // on the fourth of ten paths would leave the first three owned by someone
    // new and no way to tell from the response.
    const first = join(base, "chown-batch-a.txt");
    const second = join(base, "chown-batch-b.txt");
    await writeFile(first, "x");
    await writeFile(second, "x");

    await expect(
      serviceFor(writeRoot()).chown(USER_ID, HOST_ID, [first, second], undefined, "nosuchgroup", false),
    ).rejects.toThrow(/no group named/i);
  });

  it("explains that a group outside /etc/group has to be numeric", async () => {
    // Nothing on the exec allowlist resolves a group name, and saying "not
    // found" would send someone looking for a group that does exist.
    await expect(
      serviceFor(writeRoot()).chown(USER_ID, HOST_ID, [base], undefined, "ldap-group", false),
    ).rejects.toThrow(/numeric gid/i);
  });
});

// --------------------------------------------------------------------- count

describe("count", () => {
  it("reports what a recursive change would touch, links excluded", async () => {
    const root = join(base, "counted");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "a.txt"), "x");
    await writeFile(join(root, "b.txt"), "y");
    await symlink(join(root, "b.txt"), join(root, "link"));

    const result = await serviceFor(writeRoot()).count(USER_ID, HOST_ID, root);

    expect(result.entries).toBe(4); // root, sub, a.txt, b.txt
    expect(result.skippedLinks).toBe(1);
    expect(result.exceeded).toBe(false);
  });

  it("excludes what the change would step over, so the modal's figure is the honest one", async () => {
    // TRE-52. This number is what the confirmation dialog shows before a
    // recursive change, so counting entries the change will refuse to touch
    // would make the dialog promise work that is not going to happen.
    const root = join(base, "counted-denied");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "x");

    const denied = join(root, "secrets");
    await mkdir(denied, { recursive: true });
    await writeFile(join(denied, "key.txt"), "x");

    const result = await serviceFor(writeRoot(), "MEMBER", [denied]).count(USER_ID, HOST_ID, root);

    expect(result.refused).toBe(2); // secrets, key.txt
    expect(result.entries).toBe(2); // root, a.txt
  });
});

// ---------------------------------------------------------------- the guards

describe("route wiring", () => {
  // The two writes are the first routes in this app that change another
  // machine. Both facts about them — that a session is required, and that a
  // cross-site form cannot forge one — are decorator metadata, which is
  // exactly the kind of thing a refactor drops silently. Read back from Nest's
  // own metadata rather than trusted to review.
  //
  // The handler is fetched through its property descriptor rather than off the
  // prototype: `@UseGuards` stores its metadata on the function object itself,
  // and reading a method out as a value is exactly what `unbound-method` is
  // there to stop — correctly, in the general case. The descriptor asks for the
  // function without pretending it is a callable this-bound method.
  const handlerOf = (method: string): object =>
    Object.getOwnPropertyDescriptor(FsController.prototype, method)?.value as object;

  const guardsOn = (method: "chmod" | "chown" | "list"): unknown[] => [
    ...((Reflect.getMetadata("__guards__", FsController) as unknown[]) ?? []),
    ...((Reflect.getMetadata("__guards__", handlerOf(method)) as unknown[]) ?? []),
  ];

  it("puts CSRF and the session guard on both writes", () => {
    for (const route of ["chmod", "chown"] as const) {
      expect(guardsOn(route)).toContain(SessionAuthGuard);
      expect(guardsOn(route)).toContain(CsrfGuard);
    }
  });

  it("leaves the reads on the session guard alone", () => {
    // A GET carrying a CSRF requirement would be a bug in the other direction:
    // the token exists to protect state changes, and demanding it to browse
    // would break every cold load.
    expect(guardsOn("list")).toContain(SessionAuthGuard);
    expect(guardsOn("list")).not.toContain(CsrfGuard);
  });
});

/**
 * Escalation, and the two things it must never become (TRE-29).
 *
 * Sudo widens *permission*, never *reach*. The guard, the roots and the
 * denylist all run above the retry and are unchanged by it, so the tests that
 * matter most here are the ones where escalation is available and the answer is
 * still no.
 */
describe("falling back to sudo", () => {
  it("retries a permission refusal as root, with the mode in octal", async () => {
    const target = join(base, "escalate.txt");
    await writeFile(target, "x");
    const { service, elevatedCalls } = elevatedServiceFor(writeRoot(), new DriverError("EACCES", "denied", target));

    const result = await service.chmod(USER_ID, HOST_ID, [target], 0o640, false, SESSION_ID);

    expect(result.changed).toBe(1);
    expect(result.elevated).toBe(1);
    expect(elevatedCalls).toEqual([{ program: "chmod", args: ["0640", "--", target] }]);
  });

  it("does not retry a failure sudo could not fix", async () => {
    // A missing file is missing as root too. Escalating here would put a root
    // operation in the audit log for a request that was never going to work.
    const target = join(base, "gone.txt");
    await writeFile(target, "x");
    const { service, elevatedCalls } = elevatedServiceFor(writeRoot(), new DriverError("ENOENT", "no such", target));

    await expect(service.chmod(USER_ID, HOST_ID, [target], 0o640, false, SESSION_ID)).rejects.toThrow();
    expect(elevatedCalls).toHaveLength(0);
  });

  it("does not escalate without a session", async () => {
    // The window is keyed by session. No session, no window, whatever is held.
    const target = join(base, "nosession.txt");
    await writeFile(target, "x");
    const { service, elevatedCalls } = elevatedServiceFor(writeRoot(), new DriverError("EACCES", "denied", target));

    await expect(service.chmod(USER_ID, HOST_ID, [target], 0o640, false)).rejects.toThrow();
    expect(elevatedCalls).toHaveLength(0);
  });

  it("still refuses a path outside the roots, window open or not", async () => {
    // Sudo does not widen the allowlist. The guard runs before any of this.
    const outside = join(base, "outside.txt");
    await writeFile(outside, "x");
    const { service, elevatedCalls } = elevatedServiceFor(
      [{ path: join(base, "inside"), access: "WRITE" }],
      new DriverError("EACCES", "denied", outside),
    );

    await expect(service.chmod(USER_ID, HOST_ID, [outside], 0o640, false, SESSION_ID)).rejects.toThrow();
    // Never reached the driver at all, let alone sudo.
    expect(elevatedCalls).toHaveLength(0);
  });

  it("still steps over a denylisted entry, window open or not", async () => {
    // The install tree holds the master key. Root is exactly the privilege that
    // would make reading it possible, which is why the denylist must win here.
    const install = join(base, "install");
    await mkdir(install, { recursive: true });
    await writeFile(join(install, "master.key"), "secret");
    const { service, elevatedCalls } = elevatedServiceFor(writeRoot(), new DriverError("EACCES", "denied", install));

    const result = await service.chmod(USER_ID, HOST_ID, [base], 0o700, true, SESSION_ID);

    expect(result.refused).toContain(join(install, "master.key"));
    for (const call of elevatedCalls) {
      expect(call.args).not.toContain(join(install, "master.key"));
    }
  });
});
