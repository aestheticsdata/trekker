import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpException } from "@nestjs/common";
import { RateLimitService } from "@audit/rate-limit.service";
import { LocalDriver } from "@hosts/drivers/local.driver";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { confirmationToken, equivalentCommand, pathDepth, tokenMatches } from "@fs/delete-plan";
import { DeleteService } from "@fs/delete.service";
import { isMountPoint, parseMountPoints } from "@fs/mount-table";

import type { AuditService } from "@audit/audit.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "@redis/redis.service";

/**
 * TRE-25, against the real LocalDriver on a real tree — the trade
 * `rename.spec.ts` and `permissions.spec.ts` already make.
 *
 * It matters more here than anywhere else in this codebase. The claims worth
 * proving are "nothing was removed" claims, and a mock that reports a refusal
 * proves only that the mock was asked. These tests check the filesystem
 * afterwards.
 */

const HOST_ID = "host-under-test";
const USER_ID = "user-1";

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

function serviceFor(roots: { path: string; access: "READ" | "WRITE" }[], denylist: string[] = []): DeleteService {
  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? { id: HOST_ID, userId: USER_ID, transport: "LOCAL", roots, user: { role: "MEMBER" } }
            : null,
        ),
    },
  } as unknown as PrismaService;

  const guard = new PathGuardService(prisma, denylist, memoryLimits(), silentAudit);
  const factory = { forHost: () => Promise.resolve(new LocalDriver(HOST_ID)) } as unknown as HostDriverFactory;
  return new DeleteService(factory, guard, memoryLimits());
}

const writeRoot = () => [{ path: base, access: "WRITE" as const }];

async function fixture(name: string, entries: readonly string[]): Promise<string> {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  for (const entry of entries) await writeFile(join(dir, entry), entry);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    try {
      await readdir(path);
      return true;
    } catch {
      return false;
    }
  }
}

function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 0;
}

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  return (error.getResponse() as { code?: string }).code;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "trekker-delete-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("the confirmation token", () => {
  it("is the name itself for one entry, so the gesture is about that file", () => {
    expect(confirmationToken(["/var/log/production.sql"])).toBe("production.sql");
  });

  it("is a count for several, because there is no one name to type", () => {
    expect(confirmationToken(["/a/one", "/a/two", "/a/three"])).toBe("delete 3 items");
  });

  it("ignores a trailing slash on a directory", () => {
    expect(confirmationToken(["/var/log/"])).toBe("log");
  });

  it("forgives surrounding space, which autocomplete adds and nobody can see", () => {
    expect(tokenMatches("  production.sql ", "production.sql")).toBe(true);
  });

  it("does not forgive case — two names that differ by it are two files", () => {
    expect(tokenMatches("Production.sql", "production.sql")).toBe(false);
  });

  /**
   * The failure this whole mechanism exists for: the operator agrees to three
   * entries and the client sends three hundred. The words no longer describe
   * the request, and the request is refused.
   */
  it("stops a selection that changed under the modal", () => {
    const agreed = confirmationToken(["/a/one", "/a/two", "/a/three"]);
    const sent = confirmationToken(Array.from({ length: 300 }, (_, index) => `/a/${index}`));
    expect(tokenMatches(agreed, sent)).toBe(false);
  });
});

describe("the mount table", () => {
  const DF = [
    "Filesystem     1024-blocks      Used Available Capacity Mounted on",
    "/dev/sda1         41152736  12345678  26789012      32% /",
    "tmpfs               404832         0    404832       0% /run",
    "/dev/sdb1        976762584 123456789 853305795      13% /mnt/My Backup Drive",
  ].join("\n");

  it("reads the mount points, including one whose path holds spaces", () => {
    expect(parseMountPoints(DF)).toEqual(["/", "/run", "/mnt/My Backup Drive"]);
  });

  it("drops the header by shape, so a warning printed above it cannot shift the parse", () => {
    const noisy = `df: /net: Operation not permitted\n${DF}`;
    expect(parseMountPoints(noisy)).toEqual(["/", "/run", "/mnt/My Backup Drive"]);
  });

  it("compares a walked path with any trailing slash normalised away", () => {
    const points = new Set(parseMountPoints(DF));
    expect(isMountPoint("/mnt/My Backup Drive/", points)).toBe(true);
    expect(isMountPoint("/mnt/My Backup Drive/photos", points)).toBe(false);
  });

  it("keeps / as a mount point rather than normalising it to nothing", () => {
    expect(isMountPoint("/", new Set(parseMountPoints(DF)))).toBe(true);
  });
});

describe("the shape of a mistake", () => {
  it("counts depth so a floor can be put under it", () => {
    expect(pathDepth("/")).toBe(0);
    expect(pathDepth("/var")).toBe(1);
    expect(pathDepth("/var/log")).toBe(2);
  });

  it("shows a command whose paths are quoted the way a person would have to quote them", () => {
    expect(equivalentCommand(["/tmp/two words"], true)).toBe("rm -rf '/tmp/two words'");
    expect(equivalentCommand(["/tmp/plain"], false)).toBe("rm -f /tmp/plain");
  });
});

describe("deleting", () => {
  it("removes a file and reports what it took", async () => {
    const dir = await fixture("simple", ["alpha"]);
    const service = serviceFor(writeRoot());

    const result = await service.remove(USER_ID, HOST_ID, [join(dir, "alpha")], "alpha");

    expect(result.entriesRemoved).toBe(1);
    expect(result.bytesFreed).toBe("alpha".length);
    expect(await exists(join(dir, "alpha"))).toBe(false);
  });

  it("removes a directory and everything under it, children first", async () => {
    const dir = await fixture("tree", ["one", "two"]);
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "three"), "three");
    const service = serviceFor(writeRoot());

    const result = await service.remove(USER_ID, HOST_ID, [dir], "tree");

    // three files, the nested directory, and the directory itself
    expect(result.entriesRemoved).toBe(5);
    expect(await exists(dir)).toBe(false);
  });

  it("refuses a confirmation that does not match, and removes nothing", async () => {
    const dir = await fixture("guarded", ["alpha"]);
    const service = serviceFor(writeRoot());

    await expect(service.remove(USER_ID, HOST_ID, [join(dir, "alpha")], "beta")).rejects.toThrow(/Confirmation/);
    expect(await exists(join(dir, "alpha"))).toBe(true);
  });

  /**
   * The walk never descends through a link, so the target is reached only if
   * something is badly wrong. Worth proving against a real filesystem, where
   * `unlink` on a link to a directory is the operation that distinguishes the
   * two behaviours.
   */
  it("unlinks a symlink and leaves what it points at alone", async () => {
    const dir = await fixture("links", []);
    const target = await fixture("target", ["treasure"]);
    await symlink(target, join(dir, "pointer"));
    const service = serviceFor(writeRoot());

    await service.remove(USER_ID, HOST_ID, [dir], "links");

    expect(await exists(dir)).toBe(false);
    expect(await exists(join(target, "treasure"))).toBe(true);
  });

  it("refuses a path that is one of the host's own roots", async () => {
    const service = serviceFor(writeRoot());
    // The correct token deliberately: a wrong one is refused a step earlier and
    // would prove only that the token check works, which another test does.
    const token = base.split("/").at(-1) as string;

    const error = await service.remove(USER_ID, HOST_ID, [base], token).catch((thrown: unknown) => thrown);

    expect(statusOf(error)).toBe(403);
    expect(codeOf(error)).toBe("EISROOT");
    expect(await exists(base)).toBe(true);
  });

  /**
   * Where this departs from chmod, which skips a protected path and changes the
   * rest. Skipping here would leave the parent non-empty, so the delete would
   * report success over a tree that is still standing.
   */
  it("refuses the whole delete when anything under it is protected, and removes nothing", async () => {
    const dir = await fixture("mixed", ["ordinary"]);
    await mkdir(join(dir, "protected"));
    await writeFile(join(dir, "protected", "keep"), "keep");
    // Realpath'd, because the walk yields resolved paths and the denylist is
    // compared against those. On macOS the temp directory is a symlink, so an
    // unresolved entry here silently matches nothing.
    const service = serviceFor(writeRoot(), [await realpath(join(dir, "protected"))]);

    const error = await service.remove(USER_ID, HOST_ID, [dir], "mixed").catch((thrown: unknown) => thrown);

    expect(codeOf(error)).toBe("EDENYLISTED");
    expect(await exists(join(dir, "ordinary"))).toBe(true);
    expect(await exists(join(dir, "protected", "keep"))).toBe(true);
  });
});

describe("planning", () => {
  it("walks before anything is confirmed, so the number shown is the number removed", async () => {
    const dir = await fixture("counted", ["one", "two", "three"]);
    const service = serviceFor(writeRoot());

    const plan = await service.plan(USER_ID, HOST_ID, [dir]);

    expect(plan.entries).toBe(4);
    expect(plan.token).toBe("counted");
    expect(plan.risk.directories).toBe(1);
    expect(plan.bytes).toBe("one".length + "two".length + "three".length);

    const result = await service.remove(USER_ID, HOST_ID, [dir], plan.token);
    expect(result.entriesRemoved).toBe(plan.entries);
  });
});
