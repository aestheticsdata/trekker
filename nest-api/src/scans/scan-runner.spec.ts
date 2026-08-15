import { Readable } from "node:stream";
import { DriverError } from "@hosts/drivers/driver-error";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { ExecResult, ExecStream, ExecStreamOptions, HostDriver } from "@hosts/drivers/host-driver";
import type { AllowedProgram } from "@hosts/drivers/shell-quote";
import { forgetAllFlavours } from "@scans/du-flavour";
import { ScanEventsService, type ScanProgress } from "@scans/scan-events.service";
import { ScanRunnerService } from "@scans/scan-runner.service";
import { CANCELLED_BY_SHUTDOWN, CANCELLED_BY_USER } from "@scans/scan-signals";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * One scan, end to end, with a fake host and a strict fake database (TRE-32).
 *
 * The properties worth holding are the ones that decide whether a scan can be
 * *trusted*, and each of them has an appealing wrong answer:
 *
 *   - `du` exiting 1 is a **success** with unreadable directories counted, not
 *     a failure. It is the commonest outcome on any system directory.
 *   - A walk with no root record is a **failure** whatever the exit code, and
 *     nothing about it may be stored as a finished scan.
 *   - Entries appear **only** in the terminal transaction, so a cancelled or
 *     failed scan leaves none at all.
 *   - The stored error is our English, never the host's text.
 */

const SCAN = { id: "scan-1", hostId: "host-1", userId: "user-1", root: "/srv", realPath: "/srv", depth: 3 };

/** `du -a -0 -B1 --time` output for a small tree, root last. */
const GNU_OUTPUT =
  [
    "100\t1700000000\t/srv/a/deep/f3",
    "100\t1700000000\t/srv/a/deep",
    "5000\t1700000000\t/srv/a/f1",
    "5100\t1700000000\t/srv/a",
    "5000\t1700000000\t/srv/b",
    "10200\t1700000000\t/srv",
  ].join("\x00") + "\x00";

interface Answer {
  stdout: string;
  code: number | null;
  stderr?: string;
}

/**
 * A host whose `du` replays a fixture, recording the argv it was asked for.
 *
 * `version` decides the flavour probe, and `walk` may be a list so a demotion
 * can be exercised: each `execStream` takes the next answer.
 */
class FakeDriver implements Partial<HostDriver> {
  readonly hostId = "host-1";
  readonly calls: Array<{ program: string; args: string[]; nice: number | undefined }> = [];
  private index = 0;

  constructor(
    private readonly walks: Answer[],
    private readonly version: ExecResult = { code: 0, signal: null, stdout: "du (GNU coreutils) 9.4", stderr: "" },
  ) {}

  exec = (): Promise<ExecResult> => Promise.resolve(this.version);

  execStream = (
    program: AllowedProgram,
    args: readonly string[],
    options: ExecStreamOptions = {},
  ): Promise<ExecStream> => {
    this.calls.push({ program, args: [...args], nice: options.nice });
    const answer = this.walks[Math.min(this.index, this.walks.length - 1)];
    this.index += 1;

    return Promise.resolve({
      stdout: Readable.from([Buffer.from(answer.stdout, "utf8")]),
      done: Promise.resolve({
        code: answer.code,
        signal: null,
        stderr: answer.stderr ?? "",
        stderrTruncated: false,
      }),
    });
  };

  dispose = () => Promise.resolve();
}

/**
 * Records every write. Unimplemented shapes throw rather than returning
 * undefined, so a call this spec did not anticipate fails loudly instead of
 * passing as a no-op.
 */
class FakePrisma {
  readonly updates: Array<Record<string, unknown>> = [];
  readonly entries: Array<Record<string, unknown>> = [];
  transactions = 0;

  readonly diskScans = {
    update: ({ data }: { data: Record<string, unknown> }) => {
      this.updates.push(data);
      return Promise.resolve({ id: SCAN.id, ...data });
    },
    findUnique: () => Promise.resolve({ supersedesId: null }),
    findMany: () => Promise.resolve([]),
    deleteMany: () => Promise.resolve({ count: 0 }),
  };

  readonly diskScanEntries = {
    createMany: ({ data }: { data: Array<Record<string, unknown>> }) => {
      this.entries.push(...data);
      return Promise.resolve({ count: data.length });
    },
  };

  // The runner builds an array of unawaited Prisma promises and hands it to
  // $transaction. The fakes above have already run by then, which is what makes
  // "how many statements" observable without a database.
  $transaction = (operations: unknown[]) => {
    this.transactions += 1;
    return Promise.all(operations as Promise<unknown>[]);
  };
}

function build(driver: FakeDriver) {
  const prisma = new FakePrisma();
  const events = new ScanEventsService();
  const emitted: ScanProgress[] = [];
  events.subscribe(SCAN.userId, (progress) => emitted.push(progress));

  const factory = { forHost: () => Promise.resolve(driver as unknown as HostDriver) } as unknown as HostDriverFactory;
  const runner = new ScanRunnerService(prisma as unknown as PrismaService, factory, events);

  return { prisma, runner, emitted };
}

/** The terminal write — the last update the runner made. */
function terminal(prisma: FakePrisma): Record<string, unknown> {
  return prisma.updates[prisma.updates.length - 1];
}

beforeEach(() => {
  // The probe caches per host for the life of the process, so a spec that did
  // not clear it would have its second case answered by its first.
  forgetAllFlavours();
});

describe("a scan that works", () => {
  it("stores the total, the entries and the facts in one transaction", async () => {
    const driver = new FakeDriver([{ stdout: GNU_OUTPUT, code: 0 }]);
    const { prisma, runner } = build(driver);

    await runner.run(SCAN, new AbortController().signal);

    expect(terminal(prisma)).toMatchObject({ status: "DONE", totalBytes: 10_200n, runningSlot: null, error: null });
    expect(prisma.transactions).toBe(1);
    expect(prisma.entries.length).toBeGreaterThan(0);
  });

  it("asks for the GNU form, niced, with -- before the root", async () => {
    const driver = new FakeDriver([{ stdout: GNU_OUTPUT, code: 0 }]);
    await build(driver).runner.run(SCAN, new AbortController().signal);

    const walk = driver.calls[0];
    expect(walk.program).toBe("du");
    expect(walk.args).toEqual(["-x", "-a", "-0", "-B1", "--time", "--time-style=+%s", "--", "/srv"]);
    expect(walk.nice).toBe(15);
  });

  it("treats exit 1 as a success and counts the directories it could not read", async () => {
    // GNU `du` exits 1 on an unreadable subtree and still prints everything it
    // could. Reading that as a failure would fail nearly every scan of /.
    const driver = new FakeDriver([
      { stdout: GNU_OUTPUT, code: 1, stderr: "du: cannot read directory '/srv/private': Permission denied" },
    ]);
    const { prisma, runner } = build(driver);

    await runner.run(SCAN, new AbortController().signal);

    expect(terminal(prisma)).toMatchObject({ status: "DONE", unreadableCount: 1 });
  });

  it("records the flavour so an absent fact is explained", async () => {
    const driver = new FakeDriver([{ stdout: GNU_OUTPUT, code: 0 }]);
    const { prisma, runner } = build(driver);

    await runner.run(SCAN, new AbortController().signal);

    expect(terminal(prisma)).toMatchObject({ flavour: "GNU", niced: true });
    expect(terminal(prisma).oldFileBefore).toBeInstanceOf(Date);
  });
});

describe("a walk that never reached the root", () => {
  it("fails, whatever the exit code said", async () => {
    // The last record is the authoritative total. Without it there is a prefix
    // of a filesystem, and storing it as finished would head a panel with a
    // confident number nothing produced.
    const truncated = "100\t1700000000\t/srv/a/deep/f3\x00";
    const driver = new FakeDriver([{ stdout: truncated, code: 0 }]);
    const { prisma, runner } = build(driver);

    await runner.run(SCAN, new AbortController().signal);

    expect(terminal(prisma)).toMatchObject({ status: "FAILED", runningSlot: null });
    expect(prisma.entries).toHaveLength(0);
  });
});

describe("the portable ladder", () => {
  it("starts at -k on a host whose du has no --version, and converts the unit", async () => {
    // A BSD or busybox `du`. The probe refuses `--version`, so the ladder skips
    // the two GNU rungs outright rather than spending a failed walk finding
    // out — and it asks for `-k`, never `-B 1`, which BSD accepts and silently
    // answers in 512-byte blocks. That is the whole reason the probe exists.
    const driver = new FakeDriver([{ stdout: ["4\t/srv/a", "24\t/srv"].join("\n") + "\n", code: 0 }], {
      code: 1,
      signal: null,
      stdout: "",
      stderr: "du: unrecognized option `--version'",
    });
    const { prisma, runner } = build(driver);

    await runner.run(SCAN, new AbortController().signal);

    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0].args).toEqual(["-x", "-a", "-k", "--", "/srv"]);
    expect(terminal(prisma)).toMatchObject({ status: "DONE", totalBytes: 24_576n, flavour: "PORTABLE" });
    // No mtime on this rung, so the age fact is absent rather than reported as
    // zero old files — which would be a claim about the disk, not about `du`.
    expect(terminal(prisma).oldFileCount).toBeNull();
    expect(terminal(prisma).oldFileBefore).toBeNull();
  });

  it("demotes one rung when a GNU host refuses a flag", async () => {
    // Coreutils older than 8.6 has `--time` but not `-0`. The probe says GNU,
    // so the ladder starts at the top and steps down on the refusal.
    const driver = new FakeDriver([
      { stdout: "", code: 1, stderr: "du: unrecognized option '-0'" },
      { stdout: GNU_OUTPUT.split("\x00").join("\n"), code: 0 },
    ]);
    const { prisma, runner } = build(driver);

    await runner.run(SCAN, new AbortController().signal);

    expect(driver.calls[0].args).toContain("-0");
    expect(driver.calls[1].args).not.toContain("-0");
    expect(terminal(prisma)).toMatchObject({ status: "DONE", totalBytes: 10_200n, flavour: "GNU" });
  });

  it("retries without the nice prefix on a host that has no nice", async () => {
    const driver = new FakeDriver([
      { stdout: "", code: 127, stderr: "sh: nice: command not found" },
      { stdout: GNU_OUTPUT, code: 0 },
    ]);
    const { prisma, runner } = build(driver);

    await runner.run(SCAN, new AbortController().signal);

    expect(driver.calls[0].nice).toBe(15);
    expect(driver.calls[1].nice).toBeUndefined();
    // The same rung, retried — not a demotion. `du` was never asked anything.
    expect(driver.calls[1].args).toEqual(driver.calls[0].args);
    expect(terminal(prisma)).toMatchObject({ status: "DONE", niced: false });
  });
});

describe("cancelling", () => {
  it("records CANCELLED and writes no entries at all", async () => {
    const driver = new FakeDriver([{ stdout: GNU_OUTPUT, code: null }]);
    const { prisma, runner } = build(driver);

    const controller = new AbortController();
    controller.abort(CANCELLED_BY_USER);
    await runner.run(SCAN, controller.signal);

    expect(terminal(prisma)).toMatchObject({ status: "CANCELLED", runningSlot: null, error: null });
    expect(prisma.entries).toHaveLength(0);
    expect(prisma.transactions).toBe(0);
  });
});

describe("shutting down", () => {
  it("writes nothing, leaving the row for the next boot to sweep", async () => {
    const driver = new FakeDriver([{ stdout: GNU_OUTPUT, code: null }]);
    const { prisma, runner } = build(driver);

    const controller = new AbortController();
    controller.abort(CANCELLED_BY_SHUTDOWN);
    await runner.run(SCAN, controller.signal);

    // The same path a `kill -9` takes, which is why it is the one exercised.
    expect(prisma.updates).toHaveLength(0);
    expect(prisma.entries).toHaveLength(0);
  });
});

describe("a host that fails", () => {
  it("stores our English, never the host's text", async () => {
    const driver = new FakeDriver([{ stdout: "", code: 0 }]);
    driver.execStream = () =>
      Promise.reject(new DriverError("EACCES", "du: /srv/secret: Permission denied for uid 1234 on prod-db-07"));
    const { prisma, runner } = build(driver);

    await runner.run(SCAN, new AbortController().signal);

    expect(terminal(prisma)).toMatchObject({ status: "FAILED", error: "Permission denied on the host." });
    expect(String(terminal(prisma).error)).not.toContain("prod-db-07");
  });

  it("clamps the stored error to the column", async () => {
    const driver = new FakeDriver([{ stdout: "", code: 0 }]);
    driver.execStream = () => Promise.reject(new Error("x".repeat(5_000)));
    const { prisma, runner } = build(driver);

    await runner.run(SCAN, new AbortController().signal);

    expect(String(terminal(prisma).error).length).toBeLessThanOrEqual(500);
  });
});

describe("the progress feed", () => {
  it("reports a terminal event with the final status", async () => {
    const driver = new FakeDriver([{ stdout: GNU_OUTPUT, code: 0 }]);
    const { runner, emitted } = build(driver);

    await runner.run(SCAN, new AbortController().signal);

    const last = emitted[emitted.length - 1];
    expect(last).toMatchObject({ id: SCAN.id, hostId: SCAN.hostId, status: "DONE" });
    // BigInt over the wire as a string: a filesystem outgrows a double.
    expect(typeof last.bytes).toBe("string");
  });
});
