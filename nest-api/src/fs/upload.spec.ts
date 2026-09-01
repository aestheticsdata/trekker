import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { HttpException } from "@nestjs/common";
import { RateLimitService } from "@audit/rate-limit.service";
import { isPartialName, numberedName, partialName, safeRelativePath } from "@fs/upload-name";
import { readFreeBytes, readSpace } from "@fs/mount-table";
import { resumeToken } from "@fs/upload-resume";
import { UploadRefused, UploadService } from "@fs/upload.service";
import { LocalDriver } from "@hosts/drivers/local.driver";
import { writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { DriverError } from "@hosts/drivers/driver-error";
import type { ExecStreamResult } from "@hosts/drivers/host-driver";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { SudoRunnerService } from "@hosts/sudo/sudo-runner.service";
import { SudoService } from "@hosts/sudo/sudo.service";

import type { AuditService } from "@audit/audit.service";
import type { HostDriver } from "@hosts/drivers/host-driver";
import type { ResumeClaim } from "@fs/upload-resume";
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
  // A real runner over an empty window store: nothing here opens a window, so
  // every upload takes the ordinary path — which TRE-29 must not have changed.
  return new UploadService(factory, guard, memoryLimits(), new SudoRunnerService(new SudoService()));
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

/**
 * The name a path ends in, or "" when the whole path is refused.
 *
 * These cases were written against `safeFilename`, which TRE-126 folded into
 * `safeRelativePath`: the character rules are the same rules, applied to every
 * segment instead of only the last one.
 */
function nameOf(raw: string): string {
  return safeRelativePath(raw)?.name ?? "";
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
    expect(nameOf("report.txt")).toBe("report.txt");
    expect(nameOf("Rapport financier (2024).pdf")).toBe("Rapport financier (2024).pdf");
  });

  it("refuses a traversal outright rather than repairing it into a name", () => {
    // The attack, and the reason this function exists. `filename` is the one
    // string in an upload the server did not choose.
    //
    // This used to keep the last segment, which was safe — `backdoor` landed in
    // the destination and nothing escaped it. It stopped being right when a
    // client gained the ability to send a real path (TRE-126): repairing
    // `../a.jpg` into `a.jpg` would put the file one directory away from where
    // the client said, silently, which is a traversal arriving as a fix.
    expect(safeRelativePath("../../etc/cron.d/backdoor")).toBeNull();
    expect(safeRelativePath("photos/../../../a.jpg")).toBeNull();
  });

  it("refuses an absolute path, in either dialect", () => {
    expect(safeRelativePath("/etc/passwd")).toBeNull();
    // A backslash is a legal character in a POSIX filename, so a Windows path
    // left alone would become one very odd file — and read as a relative path
    // it would become four directories starting with `C_`.
    expect(safeRelativePath("C:\\Users\\me\\Desktop\\notes.txt")).toBeNull();
  });

  it("refuses a name that is only dots, including one wearing camouflage", () => {
    expect(nameOf("..")).toBe("");
    expect(nameOf(".")).toBe("");
    // Trimmed before the check, not after. `" .. "` is `..` with two spaces on
    // it, and a check made on the untrimmed string lets it straight through.
    expect(nameOf(" .. ")).toBe("");
    expect(nameOf("....")).toBe("");
    // Truncated before the check too: 300 dots must not pass by being long.
    expect(nameOf(`${".".repeat(300)}a`)).toBe("");
  });

  it("keeps a leading dot, because a dotfile is an ordinary file", () => {
    expect(nameOf(".bashrc")).toBe(".bashrc");
  });

  it("removes a NUL, a newline and every shell metacharacter", () => {
    expect(nameOf("a\0b.txt")).toBe("a_b.txt");
    expect(nameOf("a\nb.txt")).toBe("a_b.txt");
    for (const char of ["$", "`", ";", "|", "&", ">", "<", "*", "?", "!", "~", '"']) {
      expect(nameOf(`a${char}b.txt`)).toBe("a_b.txt");
    }
  });

  it("keeps the punctuation real filenames are full of", () => {
    // Parentheses because `numberedName` generates them, and the apostrophe
    // because `John's report.txt` is a file people have. It is a shell
    // metacharacter and it is kept anyway: no path in this application reaches
    // a shell — `exec` takes an argv array — so the reason to drop it would be
    // a danger that does not exist here, against a cost that plainly does.
    expect(nameOf("John's report (2).txt")).toBe("John's report (2).txt");
    expect(nameOf("photo [raw]#3.jpg")).toBe("photo [raw]#3.jpg");
  });

  it("keeps a non-Latin name intact — the filesystem takes UTF-8", () => {
    // Unlike the download header, which has to reduce to ASCII, this is a
    // filename on a POSIX host and there is nothing to protect it from.
    expect(nameOf("報告書.pdf")).toBe("報告書.pdf");
    expect(nameOf("rapport-écrit.pdf")).toBe("rapport-écrit.pdf");
  });

  it("trims trailing space, which makes two files look identical in a listing", () => {
    expect(nameOf("report.txt   ")).toBe("report.txt");
  });

  it("bounds the length at what a filesystem takes", () => {
    expect(nameOf(`${"a".repeat(400)}.txt`)).toHaveLength(255);
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

  it("refuses a traversal on the way in, and writes nothing anywhere", async () => {
    await mkdir(join(base, "dest"));
    const outcome = await serviceFor(writeRoot()).receive(
      USER_ID,
      driver(),
      join(base, "dest"),
      "../../../owned.sh",
      body("#!/bin/sh"),
      "keepBoth",
    );

    // It used to land as `owned.sh` in the destination, which was safe and is
    // no longer what this promises (TRE-126): a path that cannot be honoured
    // as written is refused rather than trimmed into one that can.
    expect(outcome).toMatchObject({ ok: false, code: "EBADNAME" });
    expect(await entries(join(base, "dest"))).toEqual([]);
    // The directory two levels up is untouched, which is still the property.
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

/**
 * Uploading into a root-owned directory (TRE-29).
 *
 * Two failures have to be handled and they are not the same one: the directory
 * may be root-owned, so even the `.part` cannot be created; or the directory may
 * be writable while the *file being replaced* is not, so the write succeeds and
 * the rename is refused. Both reach sudo, by different routes.
 */
describe("uploading with sudo", () => {
  const SESSION_ID = "session-under-test";

  function elevatedServiceFor(refuse: { create?: boolean; rename?: boolean }) {
    const calls: Array<{ program: string; args: readonly string[] }> = [];
    const driver = new LocalDriver(HOST_ID) as LocalDriver & Record<string, unknown>;

    const realCreate = driver.createWriteStream.bind(driver) as LocalDriver["createWriteStream"];
    const realRename = driver.rename.bind(driver) as LocalDriver["rename"];

    if (refuse.create) {
      driver.createWriteStream = (path: string) => Promise.reject(new DriverError("EACCES", "denied", path));
    }
    if (refuse.rename) {
      driver.rename = (from: string) => Promise.reject(new DriverError("EACCES", "denied", from));
    }

    // `sudo tee` — swallows the password line, writes the rest for real.
    driver.execStream = (program: string, args: readonly string[], options: { stdin?: string } = {}) => {
      calls.push({ program, args });
      const target = args[args.length - 1];
      const input = new PassThrough();
      const output = new PassThrough();
      if (options.stdin !== undefined) input.write(options.stdin);

      let past = false;
      let buffer = "";
      input.on("data", (chunk: Buffer) => {
        output.write(chunk);
        buffer += chunk.toString("utf8");
        if (!past) {
          const cut = buffer.indexOf("\n");
          if (cut === -1) return;
          buffer = buffer.slice(cut + 1);
          past = true;
        }
      });

      const done = new Promise<ExecStreamResult>((resolve) => {
        input.on("end", () => {
          writeFileSync(target, buffer);
          output.end();
          resolve({ code: 0, signal: null, stderr: "", stderrTruncated: false });
        });
      });
      return Promise.resolve({ stdout: output, done, stdin: input });
    };

    // `sudo mv` and `sudo rm` — both performed for real, so the assertions are
    // about the filesystem and not about the recorder.
    driver.exec = async (program: string, args: readonly string[]) => {
      calls.push({ program, args });
      if (program === "mv") await realRename(args[2], args[3]);
      if (program === "rm") await rm(args[2], { force: true });
      return { code: 0, signal: null, stdout: "", stderr: "" };
    };

    const prisma = {
      hosts: {
        findFirst: ({ where }: { where: { id: string; userId: string } }) =>
          Promise.resolve(
            where.id === HOST_ID && where.userId === USER_ID
              ? { id: HOST_ID, userId: USER_ID, transport: "LOCAL", roots: writeRoot(), user: { role: "MEMBER" } }
              : null,
          ),
      },
    } as unknown as PrismaService;

    const guard = new PathGuardService(prisma, [], memoryLimits(), silentAudit);
    const factory = { forHost: () => Promise.resolve(driver) } as unknown as HostDriverFactory;
    const sudo = new SudoService();
    sudo.open(SESSION_ID, HOST_ID, "hunter2");

    return {
      service: new UploadService(factory, guard, memoryLimits(), new SudoRunnerService(sudo)),
      driver: driver as unknown as LocalDriver,
      calls,
      realCreate,
    };
  }

  it("writes through tee and renames through mv when the directory is root's", async () => {
    const { service, driver, calls } = elevatedServiceFor({ create: true, rename: true });

    const outcome = await service.receive(
      USER_ID,
      driver,
      base,
      "nginx.conf",
      Readable.from([Buffer.from("server {}\n")]),
      "keepBoth",
      { sessionId: SESSION_ID },
    );

    expect(outcome.ok).toBe(true);
    expect(await readFile(join(base, "nginx.conf"), "utf8")).toBe("server {}\n");
    expect(calls.map((call) => call.program)).toEqual(["tee", "mv"]);
  });

  it("does not put the password in the file", async () => {
    // `sudo -S` eats the first line. A driver that forwarded it instead would
    // put a root password at the top of a config file.
    const { service, driver } = elevatedServiceFor({ create: true, rename: true });

    await service.receive(
      USER_ID,
      driver,
      base,
      "secret.conf",
      Readable.from([Buffer.from("TOKEN=abc\n")]),
      "keepBoth",
      { sessionId: SESSION_ID },
    );

    expect(await readFile(join(base, "secret.conf"), "utf8")).toBe("TOKEN=abc\n");
  });

  it("escalates only the rename when the directory was writable", async () => {
    // The other route in: the `.part` is created normally and only the final
    // move needs root, because the file being replaced is root's.
    const { service, driver, calls } = elevatedServiceFor({ rename: true });

    const outcome = await service.receive(
      USER_ID,
      driver,
      base,
      "partly.conf",
      Readable.from([Buffer.from("data\n")]),
      "keepBoth",
      { sessionId: SESSION_ID },
    );

    expect(outcome.ok).toBe(true);
    expect(calls.map((call) => call.program)).toEqual(["mv"]);
  });

  it("refuses without a session, and leaves no part file behind", async () => {
    const { service, driver, calls } = elevatedServiceFor({ create: true, rename: true });

    const outcome = await service.receive(
      USER_ID,
      driver,
      base,
      "nope.conf",
      Readable.from([Buffer.from("data\n")]),
      "keepBoth",
    );

    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect((await readdir(base)).filter((name) => name.includes("part"))).toEqual([]);
  });
});

describe("uploading a folder", () => {
  it("recreates the tree under the destination", async () => {
    const outcome = await serviceFor(writeRoot()).receive(
      USER_ID,
      driver(),
      base,
      "photos/2019/a.jpg",
      body("jpeg"),
      "keepBoth",
    );

    expect(outcome).toMatchObject({ ok: true, name: "a.jpg" });
    // Inside the destination, not flattened into it.
    expect(await entries(base)).toEqual(["photos"]);
    expect(await entries(join(base, "photos", "2019"))).toEqual(["a.jpg"]);
    expect(await readFile(join(base, "photos", "2019", "a.jpg"), "utf8")).toBe("jpeg");
  });

  it("makes each directory once across the parts of one request", async () => {
    const service = serviceFor(writeRoot());
    // The memo the controller hands to every part of one request.
    const made = new Map<string, string>();

    for (const path of ["photos/a.jpg", "photos/b.jpg", "photos/2019/c.jpg"]) {
      const outcome = await service.receive(USER_ID, driver(), base, path, body("x"), "keepBoth", { made });
      expect(outcome.ok).toBe(true);
    }

    // Three files, two directories, and the memo holds exactly those two — the
    // second and third files did not re-walk `photos`.
    expect([...made.keys()].sort()).toEqual(["photos", "photos/2019"]);
    expect(await entries(join(base, "photos"))).toEqual(["2019", "a.jpg", "b.jpg"]);
  });

  it("refuses a segment that is a symlink out of the roots, and writes nothing into it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "trekker-outside-"));
    await symlink(outside, join(base, "escape"));

    try {
      const outcome = await serviceFor(writeRoot()).receive(
        USER_ID,
        driver(),
        base,
        "escape/owned.sh",
        body("#!/bin/sh"),
        "keepBoth",
      );

      // The string work cannot see this one: every segment is ordinary, and
      // what makes it an escape is the host's own filesystem. The guard is the
      // thing that catches it, which is why the walk asks it per level.
      expect(outcome).toMatchObject({ ok: false, code: "EPATH" });
      expect(await entries(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("fails the part alone when the folder cannot be made, so its siblings still land", async () => {
    // A file standing where a directory has to go.
    await writeFile(join(base, "photos"), "not a directory");
    const service = serviceFor(writeRoot());

    const refused = await service.receive(USER_ID, driver(), base, "photos/a.jpg", body("x"), "keepBoth");
    const landed = await service.receive(USER_ID, driver(), base, "ok.txt", body("y"), "keepBoth");

    expect(refused.ok).toBe(false);
    expect(landed).toMatchObject({ ok: true, name: "ok.txt" });
    expect(await readFile(join(base, "photos"), "utf8")).toBe("not a directory");
  });
});

/**
 * TRE-142, and the property every test here circles: **a resumed file is byte
 * for byte the file that was picked**.
 *
 * Appending is the easy half. The half worth testing is every way the server
 * could be talked into appending to the wrong prefix — a stale partial under a
 * reused name, an offset that does not match what is on disk, a file edited
 * between attempts without its mtime moving. Each of those produces a file that
 * is corrupt *and looks complete*, which is worse than the failure resume was
 * added to avoid, so each one has a test that reads the bytes back.
 */
describe("the resume token", () => {
  const subject = {
    userId: USER_ID,
    hostId: HOST_ID,
    root: "/srv/backup",
    requested: "photos/a.jpg",
    size: 1024,
    mtimeMs: 1_700_000_000_000,
    digest: "abc123",
  };

  it("is the same name twice, which is the whole of how a partial is found", () => {
    expect(resumeToken(subject)).toBe(resumeToken({ ...subject }));
  });

  it("changes with every field that decides which file this is", () => {
    const original = resumeToken(subject);

    expect(resumeToken({ ...subject, size: 1025 })).not.toBe(original);
    expect(resumeToken({ ...subject, mtimeMs: 1 })).not.toBe(original);
    expect(resumeToken({ ...subject, digest: "abc124" })).not.toBe(original);
    expect(resumeToken({ ...subject, requested: "photos/b.jpg" })).not.toBe(original);
    expect(resumeToken({ ...subject, userId: "user-2" })).not.toBe(original);
    expect(resumeToken({ ...subject, hostId: "host-b" })).not.toBe(original);
    expect(resumeToken({ ...subject, root: "/srv/other" })).not.toBe(original);
  });

  it("keeps the directory and the path apart, so two ways of joining cannot meet", () => {
    // `/srv/backup` + `photos/a.jpg` and `/srv` + `backup/photos/a.jpg` name the
    // same file and are not the same upload — one has a destination the other
    // is only passing through, and only one of them may be written into.
    expect(resumeToken({ ...subject, root: "/srv", requested: "backup/photos/a.jpg" })).not.toBe(resumeToken(subject));
  });

  it("is a filename whatever it was given", () => {
    expect(resumeToken(subject)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("recognising a partial", () => {
  it("knows its own", () => {
    expect(isPartialName(partialName("abcdef"))).toBe(true);
  });

  it("refuses everything else, because what reads this goes on to delete", () => {
    expect(isPartialName(".part")).toBe(false);
    expect(isPartialName(".trekker-.part")).toBe(false);
    expect(isPartialName(".trekker-abcdef")).toBe(false);
    expect(isPartialName("archive.part")).toBe(false);
    expect(isPartialName(".trekker-notes.txt")).toBe(false);
    expect(isPartialName("trekker-abcdef.part")).toBe(false);
  });
});

describe("resuming an interrupted upload", () => {
  /** What the browser says about `big.bin`: eleven bytes, hashed and stamped. */
  const claim: ResumeClaim = { size: 11, mtimeMs: 1_700_000_000_000, digest: "d00d" };

  /**
   * The realpath, not the temporary directory's own name.
   *
   * macOS puts `mkdtemp` under `/var/folders`, which is a symlink to
   * `/private/var/folders`. The controller hands `receive` the path the guard
   * resolved, so in production both sides of the token see the resolved one —
   * and a test that passed the unresolved name would compute a different token
   * on each side and prove nothing about either.
   */
  let real: string;

  beforeEach(async () => {
    real = await realpath(base);
  });

  const tokenFor = (requested: string, over: Partial<ResumeClaim> = {}): string =>
    resumeToken({ ...claim, ...over, userId: USER_ID, hostId: HOST_ID, root: real, requested });

  const partialFor = (requested: string, over: Partial<ResumeClaim> = {}): string =>
    partialName(tokenFor(requested, over));

  it("keeps what arrived, under a name the next attempt can find", async () => {
    const outcome = await serviceFor(writeRoot()).receive(
      USER_ID,
      driver(),
      real,
      "big.bin",
      brokenBody("hello "),
      "keepBoth",
      { resume: { claim, from: 0 } },
    );

    expect(outcome.ok).toBe(false);
    // The old promise still holds — nothing under the real name — and the new
    // one beside it. Without a resume claim this directory would be empty, as
    // "leaves nothing behind when the upload dies partway" above still asserts.
    expect(await entries(real)).toEqual([partialFor("big.bin")]);
    expect(await readFile(join(real, partialFor("big.bin")), "utf8")).toBe("hello ");
  });

  it("continues from where it stopped, and the file is whole", async () => {
    const service = serviceFor(writeRoot());
    await service.receive(USER_ID, driver(), real, "big.bin", brokenBody("hello "), "keepBoth", {
      resume: { claim, from: 0 },
    });

    const outcome = await service.receive(USER_ID, driver(), real, "big.bin", body("world"), "keepBoth", {
      resume: { claim, from: 6 },
    });

    expect(outcome.ok).toBe(true);
    expect(await readFile(join(real, "big.bin"), "utf8")).toBe("hello world");
    // The partial became the file. Resume leaves no more behind than an
    // uninterrupted upload does.
    expect(await entries(real)).toEqual(["big.bin"]);
  });

  it("refuses an offset that is not the length it holds, rather than splicing", async () => {
    const service = serviceFor(writeRoot());
    await service.receive(USER_ID, driver(), real, "big.bin", brokenBody("hello "), "keepBoth", {
      resume: { claim, from: 0 },
    });

    const outcome = await service.receive(USER_ID, driver(), real, "big.bin", body("world"), "keepBoth", {
      resume: { claim, from: 3 },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("ERESUME");
    // Nothing written under the real name, and the six bytes left exactly as
    // they were — a refusal that damaged the partial would have made the next
    // attempt wrong too.
    expect(await entries(real)).toEqual([partialFor("big.bin")]);
    expect(await readFile(join(real, partialFor("big.bin")), "utf8")).toBe("hello ");
  });

  it("does not continue a file whose bytes changed under an unchanged mtime", async () => {
    const service = serviceFor(writeRoot());
    await service.receive(USER_ID, driver(), real, "big.bin", brokenBody("hello "), "keepBoth", {
      resume: { claim, from: 0 },
    });

    // Same name, same size, same mtime, different leading megabyte. This is the
    // case the digest is in the token for: nothing else about the file has
    // moved, and appending would produce `hello goodbye`.
    const edited: ResumeClaim = { ...claim, digest: "beef" };
    const outcome = await service.receive(USER_ID, driver(), real, "big.bin", body("goodbye"), "keepBoth", {
      resume: { claim: edited, from: 0 },
    });

    expect(outcome.ok).toBe(true);
    expect(await readFile(join(real, "big.bin"), "utf8")).toBe("goodbye");
    // The first attempt's bytes are orphaned rather than appended to — left for
    // the sweep, which is the price of never guessing.
    expect(await entries(real)).toEqual(["big.bin", partialFor("big.bin")].sort());
  });

  it("counts what is already there against the per-file limit", async () => {
    process.env.TREKKER_UPLOAD_MAX_BYTES = "8";
    const service = serviceFor(writeRoot());

    await service.receive(USER_ID, driver(), real, "big.bin", brokenBody("hello "), "keepBoth", {
      resume: { claim, from: 0 },
    });

    await expect(
      service.receive(USER_ID, driver(), real, "big.bin", body("world"), "keepBoth", { resume: { claim, from: 6 } }),
    ).rejects.toBeInstanceOf(UploadRefused);

    // And the partial goes with it: eleven bytes will not fit in eight however
    // many times somebody comes back for it.
    expect(await entries(real)).toEqual([]);
  });

  it("resumes each file of a folder against its own partial", async () => {
    const service = serviceFor(writeRoot());

    for (const path of ["photos/a.jpg", "photos/b.jpg"]) {
      await service.receive(USER_ID, driver(), real, path, brokenBody("hi"), "keepBoth", {
        resume: { claim, from: 0 },
      });
    }

    // Two partials, not one written over twice. The relative path is in the
    // token precisely so that two files of the same size and stamp inside one
    // folder are two transfers.
    expect(await entries(join(real, "photos"))).toEqual(
      [partialFor("photos/a.jpg"), partialFor("photos/b.jpg")].sort(),
    );

    const outcome = await service.receive(USER_ID, driver(), real, "photos/a.jpg", body("!"), "keepBoth", {
      resume: { claim, from: 2 },
    });

    expect(outcome.ok).toBe(true);
    expect(await readFile(join(real, "photos", "a.jpg"), "utf8")).toBe("hi!");
    expect(await entries(join(real, "photos"))).toEqual(["a.jpg", partialFor("photos/b.jpg")].sort());
  });
});

describe("asking how much is already there", () => {
  const claim: ResumeClaim = { size: 11, mtimeMs: 1_700_000_000_000, digest: "d00d" };
  let real: string;

  beforeEach(async () => {
    real = await realpath(base);
  });

  it("answers with the partial's length", async () => {
    const service = serviceFor(writeRoot());
    await service.receive(USER_ID, driver(), real, "big.bin", brokenBody("hello "), "keepBoth", {
      resume: { claim, from: 0 },
    });

    expect(await service.resumeOffset(USER_ID, HOST_ID, base, "big.bin", claim)).toEqual({ offset: 6 });
  });

  it("answers zero when there is nothing to continue", async () => {
    const service = serviceFor(writeRoot());
    expect(await service.resumeOffset(USER_ID, HOST_ID, base, "big.bin", claim)).toEqual({ offset: 0 });
  });

  it("answers zero for a folder that has not been made yet", async () => {
    const service = serviceFor(writeRoot());
    expect(await service.resumeOffset(USER_ID, HOST_ID, base, "photos/2019/a.jpg", claim)).toEqual({ offset: 0 });
  });

  it("answers zero for a partial longer than the file it claims to be", async () => {
    const service = serviceFor(writeRoot());
    // Interrupted holding six bytes while claiming three — however that came
    // about, appending to it cannot produce the file being offered.
    const short: ResumeClaim = { ...claim, size: 3 };
    await service.receive(USER_ID, driver(), real, "big.bin", brokenBody("hello "), "keepBoth", {
      resume: { claim: short, from: 0 },
    });

    expect(await service.resumeOffset(USER_ID, HOST_ID, base, "big.bin", short)).toEqual({ offset: 0 });
  });

  it("finds one inside a subdirectory, so a folder is resumed file by file", async () => {
    const service = serviceFor(writeRoot());
    await service.receive(USER_ID, driver(), real, "photos/a.jpg", brokenBody("hi"), "keepBoth", {
      resume: { claim, from: 0 },
    });

    expect(await service.resumeOffset(USER_ID, HOST_ID, base, "photos/a.jpg", claim)).toEqual({ offset: 2 });
  });

  it("refuses to look outside the roots through a symlinked segment", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "trekker-elsewhere-"));
    await symlink(elsewhere, join(base, "photos"));

    try {
      const service = serviceFor(writeRoot());
      expect(await service.resumeOffset(USER_ID, HOST_ID, base, "photos/a.jpg", claim)).toEqual({ offset: 0 });
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("sweeping partials nobody came back for", () => {
  /** Older than the week a partial is kept for. */
  const ancient = (): number => Date.now() / 1000 - 8 * 24 * 60 * 60;

  it("takes the abandoned one and leaves the fresh one", async () => {
    const abandoned = partialName("a".repeat(32));
    const fresh = partialName("b".repeat(32));

    await writeFile(join(base, abandoned), "old");
    await writeFile(join(base, fresh), "new");
    // Named like ours and not ours. The predicate is narrow on purpose, and
    // this is the file that proves it: what runs here deletes.
    await writeFile(join(base, ".trekker-notes.txt"), "keep me");
    await utimes(join(base, abandoned), ancient(), ancient());
    await utimes(join(base, ".trekker-notes.txt"), ancient(), ancient());

    await serviceFor(writeRoot()).destination(USER_ID, HOST_ID, base, { sweep: true });

    expect(await entries(base)).toEqual([".trekker-notes.txt", fresh].sort());
  });

  it("leaves everything alone when only asked where to write", async () => {
    const abandoned = partialName("a".repeat(32));
    await writeFile(join(base, abandoned), "old");
    await utimes(join(base, abandoned), ancient(), ancient());

    // What the offset lookup does, once per large file. A listing per question
    // would be the cost of tidying paid by the transfers it is meant to help.
    await serviceFor(writeRoot()).destination(USER_ID, HOST_ID, base);

    expect(await entries(base)).toEqual([abandoned]);
  });

  it("reaches the subdirectories a folder upload walks into", async () => {
    await mkdir(join(base, "photos"));
    const abandoned = partialName("c".repeat(32));
    await writeFile(join(base, "photos", abandoned), "old");
    await utimes(join(base, "photos", abandoned), ancient(), ancient());

    await serviceFor(writeRoot()).receive(USER_ID, driver(), base, "photos/x.txt", body("x"), "keepBoth");

    // An interrupted folder leaves a partial wherever it had reached, and this
    // is the only moment anything looks in there.
    expect(await entries(join(base, "photos"))).toEqual(["x.txt"]);
  });
});

/**
 * TRE-143. What the host already has, asked about a whole batch at once.
 *
 * The thing this protects is the retry after a dropped connection: a request
 * that answered nothing still landed some of its files, because the route
 * writes them one at a time, and re-sending those would duplicate them under
 * `keepBoth` and spend the uplink twice under any policy. So the tests care
 * about two properties — that the answer is *right*, and that it comes back one
 * for one in the order asked, since a caller reconciling a shorter list against
 * its own is a caller with a new way to go wrong.
 */
describe("surveying a batch", () => {
  const claim: ResumeClaim = { size: 11, mtimeMs: 1_700_000_000_000, digest: "d00d" };
  let real: string;

  beforeEach(async () => {
    real = await realpath(base);
  });

  it("says which names are taken and which are free", async () => {
    await writeFile(join(base, "there.txt"), "already");

    const answers = await serviceFor(writeRoot()).survey(USER_ID, HOST_ID, base, [
      { name: "there.txt" },
      { name: "missing.txt" },
    ]);

    expect(answers).toEqual([
      { name: "there.txt", there: true, offset: 0 },
      { name: "missing.txt", there: false, offset: 0 },
    ]);
  });

  it("counts a directory as a name that is taken", async () => {
    // The upload would refuse to write here too, so reporting it free would
    // send a file that cannot land.
    await mkdir(join(base, "notes"));

    expect(await serviceFor(writeRoot()).survey(USER_ID, HOST_ID, base, [{ name: "notes" }])).toEqual([
      { name: "notes", there: true, offset: 0 },
    ]);
  });

  it("reports a partial's length, but only when asked with a claim", async () => {
    const service = serviceFor(writeRoot());
    await service.receive(USER_ID, driver(), real, "big.bin", brokenBody("hello "), "keepBoth", {
      resume: { claim, from: 0 },
    });

    expect(await service.survey(USER_ID, HOST_ID, base, [{ name: "big.bin", claim }])).toEqual([
      { name: "big.bin", there: false, offset: 6 },
    ]);

    // Without a claim there is no token, so there is nothing to look for —
    // which is the right answer for a packed file, whose partial is
    // random-named and was discarded when its request died.
    expect(await service.survey(USER_ID, HOST_ID, base, [{ name: "big.bin" }])).toEqual([
      { name: "big.bin", there: false, offset: 0 },
    ]);
  });

  it("answers across subdirectories in one go", async () => {
    await mkdir(join(base, "photos"));
    await writeFile(join(base, "photos", "a.jpg"), "landed");
    await writeFile(join(base, "top.txt"), "landed");

    const answers = await serviceFor(writeRoot()).survey(USER_ID, HOST_ID, base, [
      { name: "photos/a.jpg" },
      { name: "photos/b.jpg" },
      { name: "top.txt" },
      { name: "nowhere/c.jpg" },
    ]);

    expect(answers).toEqual([
      { name: "photos/a.jpg", there: true, offset: 0 },
      { name: "photos/b.jpg", there: false, offset: 0 },
      { name: "top.txt", there: true, offset: 0 },
      // A directory that does not exist yet holds nothing, which is not an
      // error — it is the ordinary answer for a folder about to be made.
      { name: "nowhere/c.jpg", there: false, offset: 0 },
    ]);
  });

  it("answers one for one and in order, including for a name it would refuse", async () => {
    await writeFile(join(base, "b.txt"), "landed");

    const answers = await serviceFor(writeRoot()).survey(USER_ID, HOST_ID, base, [
      { name: "a.txt" },
      { name: "../escape.txt" },
      { name: "b.txt" },
    ]);

    expect(answers.map((answer) => answer.name)).toEqual(["a.txt", "../escape.txt", "b.txt"]);
    expect(answers.map((answer) => answer.there)).toEqual([false, false, true]);
  });

  it("reports nothing through a segment that leaves the roots", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "trekker-elsewhere-"));
    await writeFile(join(elsewhere, "secret.txt"), "not yours");
    await symlink(elsewhere, join(base, "photos"));

    try {
      expect(await serviceFor(writeRoot()).survey(USER_ID, HOST_ID, base, [{ name: "photos/secret.txt" }])).toEqual([
        { name: "photos/secret.txt", there: false, offset: 0 },
      ]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses to answer at all for a destination outside the roots", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "trekker-elsewhere-"));

    try {
      await expect(
        serviceFor(writeRoot()).survey(USER_ID, HOST_ID, elsewhere, [{ name: "a.txt" }]),
      ).rejects.toBeTruthy();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

/**
 * TRE-144. Whether there is room, asked before anything is sent.
 *
 * The reason this is worth a check rather than a failure to recover from is in
 * `transfer-runner.service.ts`: **SFTP has no ENOSPC on the wire**, so a full
 * remote disk arrives as a bare `EIO` after however long it took to fill. The
 * numbers below are the only warning anybody gets.
 */
describe("room at the destination", () => {
  /** `df -Pk`, in the POSIX format `-P` exists to guarantee. */
  const DF = [
    "Filesystem 1024-blocks     Used Available Capacity Mounted on",
    "/dev/vda1     51475068 39675068  10800000      79% /",
  ].join("\n");

  /** A driver that answers `df` and nothing else, which is all this reads. */
  const speaking = (stdout: string): HostDriver =>
    ({ exec: () => Promise.resolve({ stdout, stderr: "", code: 0 }) }) as unknown as HostDriver;

  const refusing = (): HostDriver =>
    ({ exec: () => Promise.reject(new Error("df: not found")) }) as unknown as HostDriver;

  it("reads both figures off the line, in bytes", async () => {
    expect(await readSpace(speaking(DF), "/srv")).toEqual({
      freeBytes: 10_800_000 * 1024,
      totalBytes: 51_475_068 * 1024,
    });
  });

  it("skips the header rather than counting lines", async () => {
    // Some systems print a warning above it, and "drop the first line" would
    // then drop a filesystem and keep the header.
    const noisy = `df: /net: Operation not permitted\n${DF}`;
    expect((await readSpace(speaking(noisy), "/srv"))?.freeBytes).toBe(10_800_000 * 1024);
  });

  it("answers null when df says nothing usable, and null is not zero", async () => {
    // The distinction the callers rest on: null means the question could not be
    // asked and the upload proceeds. Zero would refuse every upload to a host
    // whose `df` is missing, which turns a safety check into an outage.
    expect(await readSpace(speaking("Filesystem 1024-blocks Used Available Capacity Mounted on"), "/srv")).toBeNull();
    expect(await readSpace(refusing(), "/srv")).toBeNull();
  });

  it("still answers the older question the transfer engine asks", async () => {
    expect(await readFreeBytes(speaking(DF), "/srv")).toBe(10_800_000 * 1024);
    expect(await readFreeBytes(refusing(), "/srv")).toBeNull();
  });

  it("keeps the free figure when the total will not parse", async () => {
    // The fraction is a nicety; the fit check is the point, and withholding it
    // over a missing denominator would refuse to answer the useful half.
    const odd = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 - 39675068 10800000 79% /";
    expect(await readSpace(speaking(odd), "/srv")).toEqual({ freeBytes: 10_800_000 * 1024, totalBytes: 0 });
  });

  it("reports the real volume behind a validated destination", async () => {
    const space = await serviceFor(writeRoot()).spaceAt(USER_ID, HOST_ID, base);

    expect(space.free).not.toBeNull();
    expect(space.free ?? 0).toBeGreaterThan(0);
    expect(space.total ?? 0).toBeGreaterThanOrEqual(space.free ?? 0);
  });

  it("refuses to describe a disk outside the roots", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "trekker-elsewhere-"));

    try {
      // A volume is a fact about a machine. Answering here would describe a
      // disk this user was never given access to.
      await expect(serviceFor(writeRoot()).spaceAt(USER_ID, HOST_ID, elsewhere)).rejects.toBeTruthy();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
