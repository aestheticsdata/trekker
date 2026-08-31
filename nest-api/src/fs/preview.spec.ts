import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HttpException } from "@nestjs/common";
import { RateLimitService } from "@audit/rate-limit.service";
import { DownloadService } from "@fs/download.service";
import { PreviewService, previewCeiling } from "@fs/preview.service";
import { LocalDriver } from "@hosts/drivers/local.driver";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { SudoRunnerService } from "@hosts/sudo/sudo-runner.service";
import { SudoService } from "@hosts/sudo/sudo.service";

import type { AuditOpening, AuditService } from "@audit/audit.service";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "@redis/redis.service";

/**
 * TRE-138, against the real LocalDriver on a real tree, the way download.spec
 * already works.
 *
 * The claims worth proving are the ones that make a preview not a download:
 * that it spends its own limit and leaves the download's untouched, that it
 * opens no audit row, and that its refusals — a directory, a fifo, a file over
 * the ceiling — happen before a byte could have been sent. The bytes
 * themselves ride the download's own streaming path, which download.spec
 * already measures; here they only have to arrive intact.
 */

const HOST_ID = "host-under-test";
const USER_ID = "user-1";
const run = promisify(execFile);

let base: string;
/** Rows an AuditService would have opened. A preview must leave this empty. */
let rows: AuditOpening[];

/** As download.spec's, plus the counts map, so a test can see which key spent. */
function memoryLimits(maxPreviews?: number): { service: RateLimitService; counts: Map<string, number> } {
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

  if (maxPreviews !== undefined) {
    // A shrunken ceiling, so the refusal is reachable without 240 requests.
    const original: RateLimitService["consume"] = service.consume.bind(service);
    service.consume = (rule, scope, amount) =>
      original(rule.key === "limit:pv" ? { ...rule, max: maxPreviews } : rule, scope, amount);
  }
  return { service, counts };
}

function recordingAudit(): AuditService {
  return {
    open: (opening: AuditOpening) => {
      rows.push(opening);
      return Promise.resolve(String(rows.length - 1));
    },
    settle: () => Promise.resolve(),
    refused: () => Promise.resolve(),
  } as unknown as AuditService;
}

function serviceFor(maxPreviews?: number): { preview: PreviewService; counts: Map<string, number> } {
  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? {
                id: HOST_ID,
                userId: USER_ID,
                transport: "LOCAL",
                roots: [{ path: base, access: "READ" }],
                user: { role: "MEMBER" },
              }
            : null,
        ),
    },
  } as unknown as PrismaService;

  const { service: limits, counts } = memoryLimits(maxPreviews);
  const guard = new PathGuardService(prisma, [], limits, {
    refused: () => Promise.resolve(),
  } as unknown as AuditService);
  const factory = { forHost: () => Promise.resolve(new LocalDriver(HOST_ID)) } as unknown as HostDriverFactory;
  const download = new DownloadService(
    factory,
    guard,
    limits,
    recordingAudit(),
    new SudoRunnerService(new SudoService()),
  );

  return { preview: new PreviewService(download, limits), counts };
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 0;
}

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  return (error.getResponse() as { code?: string }).code;
}

/** As download.spec's: the refusal a call was supposed to produce, by status. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a refusal; the call resolved");
    },
    (error: unknown) => error,
  );
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "trekker-preview-"));
  rows = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
  delete process.env.TREKKER_PREVIEW_BYTE_CEILING;
});

describe("planning a preview", () => {
  it("plans a file under the ceiling as itself", async () => {
    await writeFile(join(base, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const plan = await serviceFor().preview.plan(USER_ID, HOST_ID, join(base, "photo.png"));

    expect(plan.kind).toBe("file");
    expect(plan.size).toBe(4);
  });

  it("refuses a directory — a preview reads one file, never an archive", async () => {
    await mkdir(join(base, "album"));
    const error = await refusal(serviceFor().preview.plan(USER_ID, HOST_ID, join(base, "album")));

    expect(statusOf(error)).toBe(422);
    expect(codeOf(error)).toBe("EISDIR");
  });

  it("refuses a fifo the way the download does, because the plan is the download's", async () => {
    await run("mkfifo", [join(base, "pipe")]);
    const error = await refusal(serviceFor().preview.plan(USER_ID, HOST_ID, join(base, "pipe")));

    expect(statusOf(error)).toBe(422);
    expect(codeOf(error)).toBe("ENOTREGULAR");
  });

  it("refuses a file over the ceiling, naming the size and the ceiling", async () => {
    process.env.TREKKER_PREVIEW_BYTE_CEILING = "16";
    await writeFile(join(base, "big.png"), Buffer.alloc(17));
    const error = await refusal(serviceFor().preview.plan(USER_ID, HOST_ID, join(base, "big.png")));

    expect(statusOf(error)).toBe(422);
    expect(codeOf(error)).toBe("EPREVIEWTOOBIG");
    const body = (error as HttpException).getResponse() as { size?: number; ceiling?: number };
    expect(body.size).toBe(17);
    expect(body.ceiling).toBe(16);
  });

  it("reads the ceiling from the environment, with the default when unset", () => {
    expect(previewCeiling()).toBe(8_000_000);
    process.env.TREKKER_PREVIEW_BYTE_CEILING = "1024";
    expect(previewCeiling()).toBe(1024);
    process.env.TREKKER_PREVIEW_BYTE_CEILING = "nonsense";
    expect(previewCeiling()).toBe(8_000_000);
  });

  it("refuses a path outside the roots, before a byte could be sent", async () => {
    const outside = await mkdtemp(join(tmpdir(), "trekker-outside-"));
    try {
      await writeFile(join(outside, "secret.png"), Buffer.alloc(1));
      const error = await refusal(serviceFor().preview.plan(USER_ID, HOST_ID, join(outside, "secret.png")));
      expect(statusOf(error)).toBe(403);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("what a preview spends and records", () => {
  it("spends its own limit and leaves the download's untouched", async () => {
    await writeFile(join(base, "a.png"), Buffer.alloc(1));
    const { preview, counts } = serviceFor();

    await preview.plan(USER_ID, HOST_ID, join(base, "a.png"));
    await preview.plan(USER_ID, HOST_ID, join(base, "a.png"));

    const spentKeys = [...counts.keys()];
    expect(spentKeys.some((key) => key.startsWith("limit:pv"))).toBe(true);
    expect(spentKeys.some((key) => key.startsWith("limit:dl"))).toBe(false);
  });

  it("refuses with 429 once the budget is spent, before the guard runs", async () => {
    await writeFile(join(base, "a.png"), Buffer.alloc(1));
    const { preview } = serviceFor(2);

    await preview.plan(USER_ID, HOST_ID, join(base, "a.png"));
    await preview.plan(USER_ID, HOST_ID, join(base, "a.png"));
    const error = await refusal(preview.plan(USER_ID, HOST_ID, join(base, "a.png")));

    expect(statusOf(error)).toBe(429);
  });

  it("opens no audit row, planned and streamed alike", async () => {
    const bytes = Buffer.from("not a real png, and that is not this side's business");
    await writeFile(join(base, "a.png"), bytes);
    const { preview } = serviceFor();

    const plan = await preview.plan(USER_ID, HOST_ID, join(base, "a.png"));
    const opened = await preview.open(plan, "sess");
    const drained = await drain(opened.stream);
    await opened.settle(drained.length, "success");

    expect(drained.equals(bytes)).toBe(true);
    expect(rows).toEqual([]);
  });
});
