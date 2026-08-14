import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { RateLimitService } from "@audit/rate-limit.service";
import { CreateService } from "@fs/create.service";
import { CreateEntryDto } from "@fs/dto/create-entry.dto";
import { entryNameProblem, MAX_NAME_BYTES } from "@fs/entry-name";
import { FsService } from "@fs/fs.service";
import { IdResolverService } from "@fs/id-resolver.service";
import { OPEN_FLAGS, writeFlags } from "@hosts/drivers/host-driver";
import { LocalDriver } from "@hosts/drivers/local.driver";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";

import type { AuditService } from "@audit/audit.service";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "@redis/redis.service";

/**
 * TRE-69, against the real LocalDriver on a real tree — the trade
 * `upload.spec.ts` and `rename.spec.ts` already make, and the one this ticket
 * needs most.
 *
 * The claim that matters here cannot be checked by asking a mock what it was
 * told: **a create must not empty the file already under that name.** Both
 * drivers resolved `createWriteStream` to `O_CREAT|O_TRUNC` before this ticket,
 * so the mistake would have been invisible in every test that asserts on a
 * status code. So the test writes bytes, points a create at them, and reads
 * them back afterwards.
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

function serviceFor(
  roots: Array<{ path: string; access: "READ" | "WRITE" }>,
  denylist: string[] = [],
): { service: CreateService; guard: PathGuardService } {
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
  const fs = new FsService(factory, guard, new IdResolverService());
  return { service: new CreateService(factory, guard, fs), guard };
}

const writeRoot = () => [{ path: base, access: "WRITE" as const }];

/** A directory per test, so one test's leftovers are never another's collision. */
async function fixture(name: string): Promise<string> {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 0;
}

async function refusal(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("Expected a refusal, got a result.");
    },
    (error: unknown) => error,
  );
}

beforeEach(async () => {
  // Resolved, because the guard compares resolved paths and macOS hands out a
  // temp directory under `/var` that is really `/private/var`. A root that is
  // not the real path refuses everything inside it, which reads as the guard
  // being broken rather than the fixture being.
  base = await realpath(await mkdtemp(join(tmpdir(), "trekker-create-")));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/* ---- the name rules ------------------------------------------------------ */

describe("what may be a name", () => {
  it("takes an ordinary one, a dotfile and one with punctuation", () => {
    expect(entryNameProblem("report.txt")).toBeNull();
    expect(entryNameProblem(".bashrc")).toBeNull();
    expect(entryNameProblem("Rapport financier (2024).pdf")).toBeNull();
    expect(entryNameProblem("a b")).toBeNull();
  });

  it("refuses anything that is trying to be a path", () => {
    // The attack this function exists for: `name` is joined onto a directory
    // the guard has already adjudicated, so a separator in it would build a
    // path nobody validated.
    expect(entryNameProblem("../evil")?.code).toBe("separator");
    expect(entryNameProblem("a/b")?.code).toBe("separator");
    expect(entryNameProblem("..")?.code).toBe("relative");
    expect(entryNameProblem(".")?.code).toBe("relative");
  });

  it("refuses an empty name, a NUL and one over the byte ceiling", () => {
    expect(entryNameProblem("")?.code).toBe("empty");
    expect(entryNameProblem("a\0b")?.code).toBe("nul");
    expect(entryNameProblem("é".repeat(MAX_NAME_BYTES))?.code).toBe("toolong");
    // Bytes, not characters: 255 accented letters are 510 bytes and refused,
    // while 255 plain ones fit exactly.
    expect(entryNameProblem("a".repeat(MAX_NAME_BYTES))).toBeNull();
    expect(entryNameProblem("a".repeat(MAX_NAME_BYTES + 1))?.code).toBe("toolong");
  });

  it("refuses a leading or trailing space, rather than trimming one away", () => {
    // Trimming would create an entry under a name the operator did not type,
    // and a listing draws `report ` and `report` identically.
    expect(entryNameProblem(" report")?.code).toBe("space");
    expect(entryNameProblem("report ")?.code).toBe("space");
    expect(entryNameProblem(" .. ")).not.toBeNull();
  });

  it("refuses a trailing dot", () => {
    expect(entryNameProblem("report.")?.code).toBe("dot");
  });

  it("refuses the same names at the DTO, before the guard is ever asked", () => {
    const problems = (name: string) =>
      validateSync(plainToInstance(CreateEntryDto, { hostId: HOST_ID, path: "/tmp", name })).length;

    expect(problems("report.txt")).toBe(0);
    for (const bad of ["", "..", ".", "a/b", "../evil", " report", "report ", "report.", "a".repeat(300)]) {
      expect(problems(bad)).toBeGreaterThan(0);
    }
  });

  it("refuses a relative path at the DTO", () => {
    const errors = validateSync(plainToInstance(CreateEntryDto, { hostId: HOST_ID, path: "relative", name: "x" }));
    expect(errors).toHaveLength(1);
  });

  it("is refused by the service too, before it reaches the guard", async () => {
    // The DTO guards the HTTP boundary; this guards the function. A later
    // caller reaching the service from somewhere else must not be able to join
    // an unchecked segment onto a validated path.
    const { service, guard } = serviceFor(writeRoot());
    const validate = jest.spyOn(guard, "validate");

    expect(statusOf(await refusal(service.mkdir(USER_ID, HOST_ID, base, "../escape")))).toBe(400);
    expect(validate).not.toHaveBeenCalled();
  });
});

/* ---- mkdir --------------------------------------------------------------- */

describe("mkdir", () => {
  it("creates one directory and describes it back", async () => {
    const dir = await fixture("plain");
    const { service } = serviceFor(writeRoot());

    const entry = await service.mkdir(USER_ID, HOST_ID, dir, "reports");

    expect((await stat(join(dir, "reports"))).isDirectory()).toBe(true);
    // Statted, so the caller can put the cursor on it without re-listing to
    // find out what it looks like.
    expect(entry.name).toBe("reports");
    expect(entry.type).toBe("dir");
    expect(entry.path).toBe(join(dir, "reports"));
  });

  it("answers 409 when the name is already a directory", async () => {
    const dir = await fixture("taken");
    await mkdir(join(dir, "reports"));
    const { service } = serviceFor(writeRoot());

    const error = await refusal(service.mkdir(USER_ID, HOST_ID, dir, "reports"));
    expect(statusOf(error)).toBe(409);
  });

  it("answers 409 when the name is already a file", async () => {
    // One namespace: a file called `logs` blocks a directory called `logs`, and
    // the refusal has to say so rather than reporting an unexpected error.
    const dir = await fixture("taken-by-file");
    await writeFile(join(dir, "logs"), "not a directory");
    const { service } = serviceFor(writeRoot());

    expect(statusOf(await refusal(service.mkdir(USER_ID, HOST_ID, dir, "logs")))).toBe(409);
    expect(await readFile(join(dir, "logs"), "utf8")).toBe("not a directory");
  });

  it("does not create the path leading to it", async () => {
    // Not recursive, which is only observable from outside as "the containing
    // directory has to exist". `mkdir -p` is a different feature.
    const { service } = serviceFor(writeRoot());
    const missing = join(base, "no", "such", "place");

    expect(statusOf(await refusal(service.mkdir(USER_ID, HOST_ID, missing, "child")))).toBe(404);
    expect(await readdir(base)).toEqual([]);
  });
});

/* ---- create -------------------------------------------------------------- */

describe("create", () => {
  it("writes an empty file", async () => {
    const dir = await fixture("empty");
    const { service } = serviceFor(writeRoot());

    const entry = await service.createFile(USER_ID, HOST_ID, dir, "notes.md");

    expect((await stat(join(dir, "notes.md"))).size).toBe(0);
    expect(entry.name).toBe("notes.md");
    expect(entry.type).toBe("file");
    // The driver's default, not a mode this route invented. Bits at creation
    // time are TRE-21's modal, one step later.
    expect(entry.mode).toBe("0644");
  });

  it("cannot empty the file already under that name", async () => {
    // The ticket. `createWriteStream` meant O_CREAT|O_TRUNC on both transports
    // before `exclusive` existed, so this route would have answered success by
    // destroying the thing the operator was about to open — and on a host
    // reached over SSH there is nothing to undo it with.
    const dir = await fixture("occupied");
    await writeFile(join(dir, "config.yml"), "port: 6800\n");
    const { service } = serviceFor(writeRoot());

    expect(statusOf(await refusal(service.createFile(USER_ID, HOST_ID, dir, "config.yml")))).toBe(409);
    expect(await readFile(join(dir, "config.yml"), "utf8")).toBe("port: 6800\n");
  });

  it("answers 409 when a directory holds the name", async () => {
    const dir = await fixture("occupied-by-dir");
    await mkdir(join(dir, "logs"));
    const { service } = serviceFor(writeRoot());

    expect(statusOf(await refusal(service.createFile(USER_ID, HOST_ID, dir, "logs")))).toBe(409);
    expect((await stat(join(dir, "logs"))).isDirectory()).toBe(true);
  });

  it("leaves nothing behind when it refuses", async () => {
    const dir = await fixture("no-litter");
    await writeFile(join(dir, "config.yml"), "port: 6800\n");
    const { service } = serviceFor(writeRoot());

    await refusal(service.createFile(USER_ID, HOST_ID, dir, "config.yml"));
    expect(await readdir(dir)).toEqual(["config.yml"]);
  });
});

/* ---- the flag itself ----------------------------------------------------- */

describe("WriteOptions.exclusive", () => {
  it("resolves to one flag, for both drivers", () => {
    // The single point of agreement between the two transports. One character
    // separates "empty what is there" from "refuse", which is why neither
    // driver spells it out for itself any more.
    expect(writeFlags({})).toBe(OPEN_FLAGS.TRUNCATE);
    expect(writeFlags({ exclusive: true })).toBe(OPEN_FLAGS.EXCLUSIVE);
    expect(writeFlags({ append: true })).toBe(OPEN_FLAGS.APPEND);
    // Opposite requests, and nothing in this application sends both. Stated so
    // that a caller which somehow does gets the half that keeps the bytes.
    expect(writeFlags({ append: true, exclusive: true })).toBe(OPEN_FLAGS.APPEND);
  });

  it("is honoured by the local driver, and the ordinary write still truncates", async () => {
    // Both halves, because the second is what every other caller depends on:
    // an upload replacing a file has to keep truncating.
    const dir = await fixture("flags");
    const driver = new LocalDriver(HOST_ID);
    const path = join(dir, "there.txt");
    await writeFile(path, "original");

    const exclusive = await driver.createWriteStream(path, { exclusive: true });
    const failure = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      exclusive.once("error", (error: NodeJS.ErrnoException) => resolve(error));
      exclusive.once("close", () => resolve(null));
      exclusive.end();
    });

    expect(failure?.code).toBe("EEXIST");
    expect(await readFile(path, "utf8")).toBe("original");

    const plain = await driver.createWriteStream(path);
    await new Promise<void>((resolve) => {
      plain.once("close", () => resolve());
      plain.end("replaced");
    });
    expect(await readFile(path, "utf8")).toBe("replaced");
  });
});

/* ---- the guards ---------------------------------------------------------- */

describe("the guards", () => {
  it("refuses a directory outside the roots", async () => {
    const outside = await mkdtemp(join(tmpdir(), "trekker-elsewhere-"));
    const { service } = serviceFor(writeRoot());

    try {
      expect(statusOf(await refusal(service.mkdir(USER_ID, HOST_ID, outside, "x")))).toBe(403);
      expect(statusOf(await refusal(service.createFile(USER_ID, HOST_ID, outside, "x")))).toBe(403);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a read-only root — creating an entry is a write to its directory", async () => {
    const dir = await fixture("read-only");
    const { service } = serviceFor([{ path: base, access: "READ" }]);

    expect(statusOf(await refusal(service.mkdir(USER_ID, HOST_ID, dir, "x")))).toBe(403);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a directory the local denylist covers", async () => {
    // TRE-52's lesson: the guard saw the directory, and the denylist has to be
    // asked about the path the *name* produces inside it.
    const dir = await fixture("secrets");
    const { service } = serviceFor(writeRoot(), [join(dir, "master.key")]);

    expect(statusOf(await refusal(service.createFile(USER_ID, HOST_ID, dir, "master.key")))).toBe(400);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a path that is not a directory", async () => {
    const dir = await fixture("not-a-directory");
    await writeFile(join(dir, "file.txt"), "x");
    const { service } = serviceFor(writeRoot());

    expect(statusOf(await refusal(service.mkdir(USER_ID, HOST_ID, join(dir, "file.txt"), "child")))).toBe(400);
  });
});
