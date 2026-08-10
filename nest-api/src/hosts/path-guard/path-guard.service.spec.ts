import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForbiddenException } from "@nestjs/common";
import { LocalDriver } from "@hosts/drivers/local.driver";
import { PathGuardService, PATH_REFUSED_MESSAGE } from "@hosts/path-guard/path-guard.service";
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

function guardFor(roots: RootFixture[], options: { transport?: "LOCAL" | "SSH"; denylist?: string[] } = {}) {
  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? { id: HOST_ID, userId: USER_ID, transport: options.transport ?? "LOCAL", roots }
            : null,
        ),
    },
  } as unknown as PrismaService;
  return new PathGuardService(prisma, options.denylist ?? [join(base, "install")]);
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
