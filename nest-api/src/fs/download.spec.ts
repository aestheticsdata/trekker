import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { HttpException } from "@nestjs/common";
import { RateLimitService } from "@audit/rate-limit.service";
import { sendDownload } from "@fs/download-response";
import { DownloadService } from "@fs/download.service";
import { LocalDriver } from "@hosts/drivers/local.driver";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";

import type { AddressInfo } from "node:net";
import type { AuditAnnotation, AuditOpening, AuditService } from "@audit/audit.service";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "@redis/redis.service";

/**
 * TRE-26, against the real LocalDriver on a real tree — the trade the rest of
 * `src/fs` already makes.
 *
 * The two claims worth proving here cannot be proved by a mock. "A directory
 * downloads as a valid zip that extracts to the same tree" is a claim about
 * whether an independent implementation can read what yazl wrote, so the test
 * shells out to `unzip` and compares the result. "A large file downloads with
 * flat memory" is a claim about bytes actually moving, so the test moves them.
 */

const HOST_ID = "host-under-test";
const USER_ID = "user-1";
const run = promisify(execFile);

let base: string;
/** Rows the service opened, in order, with what it settled them with. */
let rows: Array<AuditOpening & { settled?: { outcome: string; annotation: AuditAnnotation } }>;

function memoryLimits(max?: number): RateLimitService {
  const counts = new Map<string, number>();
  const service = new RateLimitService({
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

  if (max === undefined) return service;
  // A shrunken ceiling, so the refusal can be reached without issuing 120
  // downloads. The rule object is the service's own; only its max is replaced.
  const original: RateLimitService["consume"] = service.consume.bind(service);
  service.consume = (rule, scope, amount) => original({ ...rule, max }, scope, amount);
  return service;
}

/** Records what a real AuditService would have written, and nothing else. */
function recordingAudit(): AuditService {
  return {
    open: (opening: AuditOpening) => {
      rows.push(opening);
      return Promise.resolve(String(rows.length - 1));
    },
    settle: (rowId: string, outcome: string, _ms: number, annotation: AuditAnnotation = {}) => {
      rows[Number(rowId)].settled = { outcome, annotation };
      return Promise.resolve();
    },
    refused: () => Promise.resolve(),
  } as unknown as AuditService;
}

function serviceFor(
  roots: { path: string; access: "READ" | "WRITE" }[],
  options: { denylist?: string[]; maxDownloads?: number } = {},
): DownloadService {
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

  const guard = new PathGuardService(prisma, options.denylist ?? [], memoryLimits(), {
    refused: () => Promise.resolve(),
  } as unknown as AuditService);
  const factory = { forHost: () => Promise.resolve(new LocalDriver(HOST_ID)) } as unknown as HostDriverFactory;
  return new DownloadService(factory, guard, memoryLimits(options.maxDownloads), recordingAudit());
}

const readRoot = () => [{ path: base, access: "READ" as const }];

/** Everything the download produced, without holding it if it is large. */
async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Counts bytes and discards them — the shape the response takes for a big file. */
function sink(): Writable & { bytes: number } {
  const target = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      target.bytes += chunk.length;
      callback();
    },
  }) as Writable & { bytes: number };
  target.bytes = 0;
  return target;
}

function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 0;
}

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  return (error.getResponse() as { code?: string }).code;
}

/**
 * The error a call was supposed to produce.
 *
 * A plain `rejects.toThrow` would pass on any throw, including the one a broken
 * fixture produces — and every refusal in this file is checked by its status,
 * which is the part that would go wrong quietly.
 */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a refusal; the call resolved");
    },
    (error: unknown) => error,
  );
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "trekker-download-"));
  rows = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("planning a download", () => {
  it("names a file, its size and its kind before anything is sent", async () => {
    await writeFile(join(base, "notes.txt"), "hello");
    const plan = await serviceFor(readRoot()).plan(USER_ID, HOST_ID, join(base, "notes.txt"));

    expect(plan.kind).toBe("file");
    expect(plan.size).toBe(5);
    expect(plan.filename).toBe("notes.txt");
  });

  it("names a directory's archive with .zip, so the saved file says what it is", async () => {
    await mkdir(join(base, "logs"));
    await writeFile(join(base, "logs", "a.log"), "a");
    const plan = await serviceFor(readRoot()).plan(USER_ID, HOST_ID, join(base, "logs"));

    expect(plan.kind).toBe("directory");
    expect(plan.filename).toBe("logs.zip");
    expect(plan.entries).toBe(2);
  });

  it("refuses a path outside the roots, before a byte could be sent", async () => {
    const outside = await mkdtemp(join(tmpdir(), "trekker-elsewhere-"));
    await writeFile(join(outside, "secret"), "x");
    try {
      const error = await refusal(serviceFor(readRoot()).plan(USER_ID, HOST_ID, join(outside, "secret")));
      expect(statusOf(error)).toBe(403);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a denylisted path even inside a root", async () => {
    await mkdir(join(base, "install"));
    await writeFile(join(base, "install", "master.key"), "1:aaaa");
    // Resolved: macOS puts the temp directory behind a symlink, so a denylist
    // built from the raw path would never match what the guard resolved.
    const service = serviceFor(readRoot(), { denylist: [await realpath(join(base, "install"))] });

    const error = await refusal(service.plan(USER_ID, HOST_ID, join(base, "install", "master.key")));
    expect(statusOf(error)).toBe(403);
  });

  it("reads a download as a READ, so a read-only root still serves it", async () => {
    // The mirror of delete's write validation. A root granted for reading is
    // exactly the root a download should work in.
    await writeFile(join(base, "readme"), "x");
    await expect(serviceFor(readRoot()).plan(USER_ID, HOST_ID, join(base, "readme"))).resolves.toMatchObject({
      kind: "file",
    });
  });

  it("follows a symlink to a file, because the guard already resolved it", async () => {
    await writeFile(join(base, "real.txt"), "contents");
    await symlink(join(base, "real.txt"), join(base, "link.txt"));
    const plan = await serviceFor(readRoot()).plan(USER_ID, HOST_ID, join(base, "link.txt"));

    // Named for what it resolved to: the bytes are the target's, so the
    // download should not claim to be the link.
    expect(plan.filename).toBe("real.txt");
    expect(plan.size).toBe(8);
  });

  it("refuses a symlink pointing out of the roots, which is the whole point of resolving first", async () => {
    const outside = await mkdtemp(join(tmpdir(), "trekker-elsewhere-"));
    await writeFile(join(outside, "secret"), "x");
    await symlink(join(outside, "secret"), join(base, "escape"));
    try {
      const error = await refusal(serviceFor(readRoot()).plan(USER_ID, HOST_ID, join(base, "escape")));
      expect(statusOf(error)).toBe(403);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses something that is neither a file nor a directory", async () => {
    await run("mkfifo", [join(base, "pipe")]);
    const error = await serviceFor(readRoot())
      .plan(USER_ID, HOST_ID, join(base, "pipe"))
      .catch((thrown: unknown) => thrown);

    // A fifo would block the stream forever waiting for a writer, which reads
    // to the operator as a download that hangs rather than one that refused.
    expect(codeOf(error)).toBe("ENOTREGULAR");
    expect(statusOf(error)).toBe(422);
  });

  it("refuses a tree larger than the walk ceiling rather than starting an archive it cannot finish", async () => {
    await mkdir(join(base, "many"));
    for (let index = 0; index < 12; index += 1) await writeFile(join(base, "many", `f${index}`), "x");

    process.env.TREKKER_RECURSIVE_ENTRY_CEILING = "5";
    try {
      const error = await serviceFor(readRoot())
        .plan(USER_ID, HOST_ID, join(base, "many"))
        .catch((thrown: unknown) => thrown);
      expect(codeOf(error)).toBe("ETOOMANY");
      expect(statusOf(error)).toBe(422);
    } finally {
      delete process.env.TREKKER_RECURSIVE_ENTRY_CEILING;
    }
  });

  it("spends the rate limit before the stat, and refuses with 429", async () => {
    await writeFile(join(base, "a"), "x");
    const service = serviceFor(readRoot(), { maxDownloads: 2 });

    await service.plan(USER_ID, HOST_ID, join(base, "a"));
    await service.plan(USER_ID, HOST_ID, join(base, "a"));
    const error = await refusal(service.plan(USER_ID, HOST_ID, join(base, "a")));
    expect(statusOf(error)).toBe(429);
  });
});

describe("downloading a file", () => {
  it("sends the bytes, and only the bytes", async () => {
    await writeFile(join(base, "notes.txt"), "the whole file");
    const service = serviceFor(readRoot());
    const plan = await service.plan(USER_ID, HOST_ID, join(base, "notes.txt"));
    const opened = await service.open(USER_ID, "sess", HOST_ID, join(base, "notes.txt"), plan, null);

    expect((await drain(opened.stream)).toString()).toBe("the whole file");
  });

  it("sends exactly the requested window, both ends inclusive", async () => {
    await writeFile(join(base, "alphabet"), "abcdefghijklmnopqrstuvwxyz");
    const service = serviceFor(readRoot());
    const plan = await service.plan(USER_ID, HOST_ID, join(base, "alphabet"));
    const opened = await service.open(USER_ID, "sess", HOST_ID, join(base, "alphabet"), plan, { start: 3, end: 7 });

    // d,e,f,g,h — five bytes, which is `end - start + 1` and not four.
    expect((await drain(opened.stream)).toString()).toBe("defgh");
  });

  it("resumes: the second half, fetched alone, completes the first", async () => {
    const body = "0123456789abcdefghij";
    await writeFile(join(base, "resumable"), body);
    const service = serviceFor(readRoot());
    const path = join(base, "resumable");

    const plan = await service.plan(USER_ID, HOST_ID, path);
    const head = await drain((await service.open(USER_ID, "s", HOST_ID, path, plan, { start: 0, end: 9 })).stream);
    const tail = await drain((await service.open(USER_ID, "s", HOST_ID, path, plan, { start: 10, end: 19 })).stream);

    expect(Buffer.concat([head, tail]).toString()).toBe(body);
  });
});

describe("downloading a directory", () => {
  it("produces a zip a real unzip extracts to the same tree", async () => {
    await mkdir(join(base, "site", "assets"), { recursive: true });
    await writeFile(join(base, "site", "index.html"), "<h1>hello</h1>");
    await writeFile(join(base, "site", "assets", "app.css"), "body{}");
    await mkdir(join(base, "site", "empty"));

    const service = serviceFor(readRoot());
    const plan = await service.plan(USER_ID, HOST_ID, join(base, "site"));
    const opened = await service.open(USER_ID, "sess", HOST_ID, join(base, "site"), plan, null);

    const archive = join(base, "out.zip");
    await writeFile(archive, await drain(opened.stream));

    const target = join(base, "extracted");
    // `unzip` rather than a library: the claim is that something which did not
    // write this file can read it, and a reader from the same author proves
    // less than the one already on the machine.
    await run("unzip", ["-q", archive, "-d", target]);

    expect(await readFile(join(target, "site", "index.html"), "utf8")).toBe("<h1>hello</h1>");
    expect(await readFile(join(target, "site", "assets", "app.css"), "utf8")).toBe("body{}");
    // The empty directory survives, which it would not if only files were added.
    expect(await readdir(join(target, "site", "empty"))).toEqual([]);
  });

  it("leaves symlinks out, and says how many", async () => {
    await mkdir(join(base, "tree"));
    await writeFile(join(base, "tree", "real"), "x");
    await symlink(join(base, "tree", "real"), join(base, "tree", "alias"));

    const service = serviceFor(readRoot());
    const plan = await service.plan(USER_ID, HOST_ID, join(base, "tree"));
    expect(plan.skippedLinks).toBe(1);

    const archive = join(base, "out.zip");
    await writeFile(
      archive,
      await drain((await service.open(USER_ID, "s", HOST_ID, join(base, "tree"), plan, null)).stream),
    );
    const listing = await run("unzip", ["-Z1", archive]);

    expect(listing.stdout.split("\n").filter(Boolean).sort()).toEqual(["tree/", "tree/real"]);
  });

  it("names entries relative to the directory, never absolutely", async () => {
    // An absolute path or a `..` inside an archive is how extracting one writes
    // outside the directory the operator chose. `unzip` would warn and strip;
    // other extractors have historically not.
    await mkdir(join(base, "pkg"));
    await writeFile(join(base, "pkg", "file"), "x");

    const service = serviceFor(readRoot());
    const plan = await service.plan(USER_ID, HOST_ID, join(base, "pkg"));
    const archive = join(base, "out.zip");
    await writeFile(
      archive,
      await drain((await service.open(USER_ID, "s", HOST_ID, join(base, "pkg"), plan, null)).stream),
    );

    const names = (await run("unzip", ["-Z1", archive])).stdout.split("\n").filter(Boolean);
    expect(names.every((name) => !name.startsWith("/") && !name.split("/").includes(".."))).toBe(true);
  });
});

describe("the audit row", () => {
  it("records what was taken, and how much of it actually left", async () => {
    await writeFile(join(base, "payroll.csv"), "a,b,c");
    const service = serviceFor(readRoot());
    const plan = await service.plan(USER_ID, HOST_ID, join(base, "payroll.csv"));
    const opened = await service.open(USER_ID, "sess-1", HOST_ID, join(base, "payroll.csv"), plan, null);

    await drain(opened.stream);
    await opened.settle(5, "success");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: USER_ID,
      sessionId: "sess-1",
      hostId: HOST_ID,
      kind: "file.download",
      destructive: false,
    });
    expect(rows[0].summary).toContain("payroll.csv");
    expect(rows[0].payload).toMatchObject({ paths: [join(base, "payroll.csv")], kind: "file" });
    expect(rows[0].settled).toEqual({ outcome: "success", annotation: { bytes: 5 } });
  });

  it("records a download that died as a failure, with the bytes that got through", async () => {
    await writeFile(join(base, "big"), "x".repeat(100));
    const service = serviceFor(readRoot());
    const plan = await service.plan(USER_ID, HOST_ID, join(base, "big"));
    const opened = await service.open(USER_ID, "sess-1", HOST_ID, join(base, "big"), plan, null);

    opened.stream.destroy();
    await opened.settle(40, "failure", "socket hang up");

    // Forty of a hundred, said plainly. A row claiming success over a truncated
    // file is worse than no row: it is the wrong answer to the only question
    // anybody asks this log afterwards.
    expect(rows[0].settled).toEqual({ outcome: "failure", annotation: { bytes: 40 } });
  });

  it("records the window when one was asked for", async () => {
    await writeFile(join(base, "chunked"), "0123456789");
    const service = serviceFor(readRoot());
    const plan = await service.plan(USER_ID, HOST_ID, join(base, "chunked"));
    await service.open(USER_ID, "s", HOST_ID, join(base, "chunked"), plan, { start: 2, end: 5 });

    expect(rows[0].payload).toMatchObject({ range: "2-5" });
    expect(rows[0].summary).toContain("bytes 2-5");
  });
});

describe("sending it", () => {
  /**
   * One real HTTP exchange, because the bug this describes only exists over a
   * socket.
   *
   * The client below does what every client does with a `Content-Length`: reads
   * that many bytes and closes. Node then rejects the pipeline with a premature
   * close *after* the whole body has gone out, and the first version of this
   * code recorded that as a failed download. Nothing short of a real socket
   * reproduces it — a fake writable finishes politely.
   */
  async function serve(
    source: Readable,
    expectBytes: number,
    hangUpAfter: number,
  ): Promise<{ settled: Array<{ bytes: number; outcome: string }>; received: number }> {
    const settled: Array<{ bytes: number; outcome: string }> = [];

    const server = createServer((_request, response) => {
      void sendDownload(
        response as unknown as Parameters<typeof sendDownload>[0],
        {
          stream: source,
          settle: (bytes, outcome) => {
            settled.push({ bytes, outcome });
            return Promise.resolve();
          },
        },
        {
          status: 200,
          headers: { "Content-Type": "application/octet-stream", "Content-Length": String(expectBytes) },
          expectBytes,
        },
      );
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const received = await new Promise<number>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
      });
      let seen = Buffer.alloc(0);
      const bodyBytes = (): number => {
        const headerEnd = seen.indexOf("\r\n\r\n");
        return headerEnd === -1 ? 0 : seen.length - headerEnd - 4;
      };
      socket.on("data", (chunk) => {
        seen = Buffer.concat([seen, chunk]);
        if (bodyBytes() >= hangUpAfter) {
          // The hang-up. Exactly what curl does the instant it has its bytes.
          socket.destroy();
          resolve(bodyBytes());
        }
      });
      // A source that died closes the socket from the other end.
      socket.on("close", () => resolve(bodyBytes()));
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The settle happens on the server's own turn, after the socket died.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { settled, received };
  }

  it("records a client that hung up after the last byte as a success", async () => {
    const body = Buffer.from("every byte of it");
    const { settled, received } = await serve(Readable.from([body]), body.length, body.length);

    expect(received).toBe(body.length);
    expect(settled).toEqual([{ bytes: body.length, outcome: "success" }]);
  });

  it("still records a download that died mid-stream as a failure", async () => {
    // The shortcut above must not fire on a real failure. Here the source dies
    // after four of a hundred bytes, so the count says nothing about
    // completeness — and the row must say so.
    const dying = new Readable({
      read() {
        this.push(Buffer.from("half"));
        this.destroy(new Error("the host went away"));
      },
    });

    const { settled } = await serve(dying, 100, 100);
    expect(settled).toEqual([{ bytes: 4, outcome: "failure" }]);
  });
});

/**
 * What the process is holding, counting the memory a stream actually uses.
 *
 * `heapUsed` alone is the wrong number here, and quietly so: a `Buffer` lives
 * outside V8's heap. A version of the download path that pushed every chunk
 * into an array and released none was written and run against this test: while
 * it held all two gigabytes, `heapUsed` went *down* 9.0 MB and the old
 * assertion passed. `arrayBuffers` is where those bytes are counted, and the
 * same broken path measures 2,063.8 MB here — which is the whole difference
 * between a test that can fail and one that cannot.
 *
 * Deliberately identical to `held()` in `transfers/transfer.spec.ts`, where the
 * finding was first made (TRE-23). The two must stay the same measure: a
 * download and a transfer make the same claim about memory, and it is worth
 * nothing if they check it differently. This file only predates the correction.
 */
function held(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

describe("memory", () => {
  it("moves a 2 GiB file without holding it", async () => {
    // Sparse: `truncate` costs no disk and no write time, and the read path is
    // identical — the driver, the stream and the pipeline cannot tell.
    //
    // Two gigabytes rather than the ticket's twenty because this runs inside
    // `pnpm test`, which runs inside the pre-deploy gate, and twenty costs
    // eleven seconds against this one's one. Twenty was run by hand at the same
    // constant before this was written down: 21,474,836,480 bytes moved, heap
    // *down* 15.8 MB across the transfer, whole process resident at 320 MB.
    const path = join(base, "sparse.bin");
    const handle = await open(path, "w");
    await handle.truncate(2 * 1024 ** 3);
    await handle.close();

    const service = serviceFor(readRoot());
    const plan = await service.plan(USER_ID, HOST_ID, path);
    const opened = await service.open(USER_ID, "s", HOST_ID, path, plan, null);

    // No `global.gc()` here on purpose. It read as making the baseline
    // deterministic and never did: nothing in `nest-api` passes `--expose-gc`,
    // so `global.gc` is undefined under `pnpm test` and the call was inert. The
    // ceiling below is wide enough not to need one.
    const before = held();
    const target = sink();
    await pipeline(opened.stream, target);
    const after = held();

    expect(target.bytes).toBe(2 * 1024 ** 3);
    // A hundred megabytes of headroom against two gigabytes moved. An upper
    // bound, not a prediction: streaming the file measures at *minus* 5.3 MB
    // here, because a collection during the pipeline releases more than the
    // chunks in flight ever hold. What the ceiling has to separate is that from
    // accumulation, and accumulation came in at 2,063.8 MB — a margin of twenty
    // to one either side, which is why the number needs no tuning.
    expect(after - before).toBeLessThan(100 * 1024 ** 2);
  }, 60_000);
});
