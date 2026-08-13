import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { HttpException } from "@nestjs/common";
import { RateLimitService } from "@audit/rate-limit.service";
import { numberedName, partialName, safeFilename } from "@fs/upload-name";
import { UploadRefused, UploadService } from "@fs/upload.service";
import { LocalDriver } from "@hosts/drivers/local.driver";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";

import type { AuditService } from "@audit/audit.service";
import type { HostDriver } from "@hosts/drivers/host-driver";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "@redis/redis.service";

/**
 * TRE-65, against the real LocalDriver on a real tree.
 *
 * Every claim in this ticket is about what is left on disk afterwards — no
 * partial file under the real name, nothing behind after an abort, the `.part`
 * gone either way — and none of those can be checked by asking a mock what it
 * was told. So each test reads the destination directory back.
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

function serviceFor(roots: { path: string; access: "READ" | "WRITE" }[]): UploadService {
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

  const guard = new PathGuardService(prisma, [], memoryLimits(), silentAudit);
  const factory = { forHost: () => Promise.resolve(new LocalDriver(HOST_ID)) } as unknown as HostDriverFactory;
  return new UploadService(factory, guard, memoryLimits());
}

const writeRoot = () => [{ path: base, access: "WRITE" as const }];
const driver = (): HostDriver => new LocalDriver(HOST_ID);

/** A body that ends normally. */
function body(contents: string): Readable {
  return Readable.from([Buffer.from(contents)]);
}

/** A body that dies partway, the way a closed laptop lid does. */
function brokenBody(prefix: string): Readable {
  return new Readable({
    read() {
      this.push(Buffer.from(prefix));
      this.destroy(new Error("socket hang up"));
    },
  });
}

async function entries(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 0;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "trekker-upload-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
  delete process.env.TREKKER_UPLOAD_MAX_BYTES;
});

describe("the filename", () => {
  it("keeps an ordinary one", () => {
    expect(safeFilename("report.txt")).toBe("report.txt");
    expect(safeFilename("Rapport financier (2024).pdf")).toBe("Rapport financier (2024).pdf");
  });

  it("takes the last segment, so a traversal is a name and not a path", () => {
    // The attack, and the reason this function exists. `filename` is the one
    // string in an upload the server did not choose.
    expect(safeFilename("../../etc/cron.d/backdoor")).toBe("backdoor");
    expect(safeFilename("/etc/passwd")).toBe("passwd");
  });

  it("takes the last segment of a Windows path too", () => {
    // A backslash is a legal character in a POSIX filename, so a name arriving
    // from Windows would otherwise become one very odd file rather than a path.
    expect(safeFilename("C:\\Users\\me\\Desktop\\notes.txt")).toBe("notes.txt");
  });

  it("refuses a name that is only dots, including one wearing camouflage", () => {
    expect(safeFilename("..")).toBe("");
    expect(safeFilename(".")).toBe("");
    // Trimmed before the check, not after. `" .. "` is `..` with two spaces on
    // it, and a check made on the untrimmed string lets it straight through.
    expect(safeFilename(" .. ")).toBe("");
    expect(safeFilename("....")).toBe("");
    // Truncated before the check too: 300 dots must not pass by being long.
    expect(safeFilename(`${".".repeat(300)}a`)).toBe("");
  });

  it("keeps a leading dot, because a dotfile is an ordinary file", () => {
    expect(safeFilename(".bashrc")).toBe(".bashrc");
  });

  it("removes a NUL, a newline and every shell metacharacter", () => {
    expect(safeFilename("a\0b.txt")).toBe("a_b.txt");
    expect(safeFilename("a\nb.txt")).toBe("a_b.txt");
    for (const char of ["$", "`", ";", "|", "&", ">", "<", "*", "?", "!", "~", '"']) {
      expect(safeFilename(`a${char}b.txt`)).toBe("a_b.txt");
    }
  });

  it("keeps the punctuation real filenames are full of", () => {
    // Parentheses because `numberedName` generates them, and the apostrophe
    // because `John's report.txt` is a file people have. It is a shell
    // metacharacter and it is kept anyway: no path in this application reaches
    // a shell — `exec` takes an argv array — so the reason to drop it would be
    // a danger that does not exist here, against a cost that plainly does.
    expect(safeFilename("John's report (2).txt")).toBe("John's report (2).txt");
    expect(safeFilename("photo [raw]#3.jpg")).toBe("photo [raw]#3.jpg");
  });

  it("keeps a non-Latin name intact — the filesystem takes UTF-8", () => {
    // Unlike the download header, which has to reduce to ASCII, this is a
    // filename on a POSIX host and there is nothing to protect it from.
    expect(safeFilename("報告書.pdf")).toBe("報告書.pdf");
    expect(safeFilename("rapport-écrit.pdf")).toBe("rapport-écrit.pdf");
  });

  it("trims trailing space, which makes two files look identical in a listing", () => {
    expect(safeFilename("report.txt   ")).toBe("report.txt");
  });

  it("bounds the length at what a filesystem takes", () => {
    expect(safeFilename(`${"a".repeat(400)}.txt`)).toHaveLength(255);
  });

  it("numbers a copy before the extension, so it still opens", () => {
    expect(numberedName("report.txt", 2)).toBe("report (2).txt");
    expect(numberedName("archive.tar.gz", 3)).toBe("archive.tar (3).gz");
    expect(numberedName("Makefile", 2)).toBe("Makefile (2)");
    // A dotfile has no extension to sit in front of.
    expect(numberedName(".bashrc", 2)).toBe(".bashrc (2)");
  });

  it("hides the partial and says what it is", () => {
    expect(partialName("abc123")).toBe(".trekker-abc123.part");
  });
});

describe("the destination", () => {
  it("is validated as a write, so a read-only root refuses", async () => {
    const service = serviceFor([{ path: base, access: "READ" }]);
    const error = await service.destination(USER_ID, HOST_ID, base).catch((thrown: unknown) => thrown);
    expect(statusOf(error)).toBe(403);
  });

  it("refuses a path outside the roots", async () => {
    const outside = await mkdtemp(join(tmpdir(), "trekker-elsewhere-"));
    try {
      const error = await serviceFor(writeRoot())
        .destination(USER_ID, HOST_ID, outside)
        .catch((thrown: unknown) => thrown);
      expect(statusOf(error)).toBe(403);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a file, because an upload goes into a directory", async () => {
    await writeFile(join(base, "afile"), "x");
    const error = await serviceFor(writeRoot())
      .destination(USER_ID, HOST_ID, join(base, "afile"))
      .catch((thrown: unknown) => thrown);
    expect(statusOf(error)).toBe(400);
  });
});

describe("receiving a file", () => {
  it("writes it, under its own name, with no partial left over", async () => {
    const outcome = await serviceFor(writeRoot()).receive(
      USER_ID,
      driver(),
      base,
      "notes.txt",
      body("the contents"),
      "keepBoth",
    );

    expect(outcome).toMatchObject({ ok: true, name: "notes.txt", bytes: 12 });
    expect(await readFile(join(base, "notes.txt"), "utf8")).toBe("the contents");
    expect(await entries(base)).toEqual(["notes.txt"]);
  });

  it("sanitises the name on the way in, so a traversal lands in the directory", async () => {
    await mkdir(join(base, "dest"));
    const outcome = await serviceFor(writeRoot()).receive(
      USER_ID,
      driver(),
      join(base, "dest"),
      "../../../owned.sh",
      body("#!/bin/sh"),
      "keepBoth",
    );

    expect(outcome.name).toBe("owned.sh");
    expect(await entries(join(base, "dest"))).toEqual(["owned.sh"]);
    // The directory two levels up is untouched, which is the property.
    expect(await entries(base)).toEqual(["dest"]);
  });

  it("refuses a name with nothing usable in it, and writes nothing", async () => {
    const outcome = await serviceFor(writeRoot()).receive(USER_ID, driver(), base, "..", body("x"), "keepBoth");

    expect(outcome).toMatchObject({ ok: false, code: "EBADNAME" });
    expect(await entries(base)).toEqual([]);
  });

  it("leaves nothing behind when the upload dies partway", async () => {
    const outcome = await serviceFor(writeRoot()).receive(
      USER_ID,
      driver(),
      base,
      "big.bin",
      brokenBody("half of it"),
      "keepBoth",
    );

    // No `big.bin`, and no `.part` either. The first is the property the
    // temporary name buys; the second is the tidying that makes a surviving
    // `.part` mean something.
    expect(outcome.ok).toBe(false);
    expect(await entries(base)).toEqual([]);
  });

  it("never replaces a good file with a broken one", async () => {
    await writeFile(join(base, "important.csv"), "the original");

    await serviceFor(writeRoot()).receive(
      USER_ID,
      driver(),
      base,
      "important.csv",
      brokenBody("truncated"),
      "overwrite",
    );

    // The whole reason for writing under a temporary name: an upload that died
    // must not have destroyed what was there.
    expect(await readFile(join(base, "important.csv"), "utf8")).toBe("the original");
    expect(await entries(base)).toEqual(["important.csv"]);
  });
});

describe("the size limit", () => {
  it("cuts a file off at the byte, not after buffering it", async () => {
    process.env.TREKKER_UPLOAD_MAX_BYTES = "10";
    const error = await serviceFor(writeRoot())
      .receive(USER_ID, driver(), base, "big.bin", body("x".repeat(50)), "keepBoth")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UploadRefused);
    expect((error as UploadRefused).code).toBe("ETOOLARGE");
    expect((error as UploadRefused).status).toBe(413);
    expect(await entries(base)).toEqual([]);
  });

  it("counts the bytes that arrive, so a lying Content-Length buys nothing", async () => {
    // The header is never consulted — this service is only ever handed a
    // stream, and the count comes off the chunks. A client claiming one byte
    // and sending fifty is refused at the same place as an honest one.
    process.env.TREKKER_UPLOAD_MAX_BYTES = "10";
    const chunks = Readable.from([Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)]);

    const error = await serviceFor(writeRoot())
      .receive(USER_ID, driver(), base, "lied.bin", chunks, "keepBoth")
      .catch((thrown: unknown) => thrown);

    expect((error as UploadRefused).code).toBe("ETOOLARGE");
    expect(await entries(base)).toEqual([]);
  });

  it("allows a file exactly at the limit", async () => {
    process.env.TREKKER_UPLOAD_MAX_BYTES = "10";
    const outcome = await serviceFor(writeRoot()).receive(
      USER_ID,
      driver(),
      base,
      "exact.bin",
      body("0123456789"),
      "keepBoth",
    );

    expect(outcome).toMatchObject({ ok: true, bytes: 10 });
  });
});

describe("a name that is already taken", () => {
  it("overwrite replaces it", async () => {
    await writeFile(join(base, "a.txt"), "old");
    const outcome = await serviceFor(writeRoot()).receive(USER_ID, driver(), base, "a.txt", body("new"), "overwrite");

    expect(outcome.name).toBe("a.txt");
    expect(await readFile(join(base, "a.txt"), "utf8")).toBe("new");
    expect(await entries(base)).toEqual(["a.txt"]);
  });

  it("skip leaves it alone and moves no bytes", async () => {
    await writeFile(join(base, "a.txt"), "old");
    const outcome = await serviceFor(writeRoot()).receive(USER_ID, driver(), base, "a.txt", body("new"), "skip");

    expect(outcome).toMatchObject({ ok: true, code: "ESKIPPED", bytes: 0 });
    expect(await readFile(join(base, "a.txt"), "utf8")).toBe("old");
  });

  it("keepBoth numbers the new one and keeps counting", async () => {
    await writeFile(join(base, "a.txt"), "first");
    const service = serviceFor(writeRoot());

    expect((await service.receive(USER_ID, driver(), base, "a.txt", body("second"), "keepBoth")).name).toBe(
      "a (2).txt",
    );
    expect((await service.receive(USER_ID, driver(), base, "a.txt", body("third"), "keepBoth")).name).toBe("a (3).txt");

    expect(await entries(base)).toEqual(["a (2).txt", "a (3).txt", "a.txt"]);
    expect(await readFile(join(base, "a.txt"), "utf8")).toBe("first");
  });

  it("keepBoth is the default a caller falls into, and it destroys nothing", async () => {
    await writeFile(join(base, "a.txt"), "original");
    await serviceFor(writeRoot()).receive(USER_ID, driver(), base, "a.txt", body("new"), "keepBoth");

    expect(await readFile(join(base, "a.txt"), "utf8")).toBe("original");
  });
});
