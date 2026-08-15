import { Readable } from "node:stream";
import type { ExecStream, HostDriver } from "@hosts/drivers/host-driver";
import type { AllowedProgram } from "@hosts/drivers/shell-quote";
import { chunkPaths, confirmDuplicates } from "@scans/duplicate-finder";
import type { DuplicateCandidate } from "@scans/scan-aggregator";
import {
  HASH_BUDGET_BYTES,
  MAX_ARGS_PER_CALL,
  MAX_ARGV_BYTES,
  MAX_DUP_GROUPS,
  MAX_HASH_BYTES,
} from "@scans/scan-limits";

/**
 * Confirming duplicates by hash (TRE-32 §3).
 *
 * The claim the panel makes from this is "you could get N gigabytes back", and
 * somebody deletes files on the strength of it. So the properties worth pinning
 * are the ones that make that claim honest: a group is only ever confirmed by
 * two files hashing the same, the reclaimable figure keeps one of each, and
 * everything the bounds stopped us checking is reported as unchecked rather
 * than quietly counted as clean.
 */

const MiB = 1024n * 1024n;

/**
 * A stand-in digest: deterministic, and hex, because the parser only accepts
 * sixty-four hex characters and a fixture that ignored that would be testing a
 * line shape `sha256sum` never emits.
 */
function digestFor(content: string): string {
  let accumulator = 0;
  for (let index = 0; index < content.length; index += 1) {
    accumulator = (accumulator * 31 + content.charCodeAt(index)) >>> 0;
  }
  return accumulator.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

/**
 * Answers `sha256sum` from a path → content map, and records every argv.
 *
 * Contents rather than digests, so two paths "being the same file" is stated in
 * the fixture the way it is on a disk.
 */
class FakeDriver implements Partial<HostDriver> {
  readonly hostId = "host-1";
  readonly calls: string[][] = [];

  constructor(
    private readonly contents: Record<string, string>,
    private readonly options: { failOn?: string } = {},
  ) {}

  execStream = (program: AllowedProgram, args: readonly string[]): Promise<ExecStream> => {
    this.calls.push([program, ...args]);
    const paths = args.filter((arg) => arg !== "--");

    if (this.options.failOn && paths.includes(this.options.failOn)) {
      return Promise.resolve({
        stdout: Readable.from([]),
        done: Promise.resolve({ code: 1, signal: null, stderr: "sha256sum: read error", stderrTruncated: false }),
      });
    }

    const lines = paths
      .filter((path) => this.contents[path] !== undefined)
      .map((path) => `${digestFor(this.contents[path])}  ${path}`)
      .join("\n");

    return Promise.resolve({
      stdout: Readable.from([Buffer.from(lines.length > 0 ? `${lines}\n` : "", "utf8")]),
      done: Promise.resolve({ code: 0, signal: null, stderr: "", stderrTruncated: false }),
    });
  };
}

function group(bytes: bigint, paths: string[]): DuplicateCandidate {
  return { bytes, paths };
}

function run(candidates: DuplicateCandidate[], driver: FakeDriver, dropped = 0, signal = new AbortController().signal) {
  return confirmDuplicates(candidates, dropped, { driver: driver as unknown as HostDriver, signal });
}

describe("confirming", () => {
  it("confirms a group only when two members hash the same", () => {
    const driver = new FakeDriver({ "/a": "same", "/b": "same", "/c": "different" });
    return run([group(4n * MiB, ["/a", "/b", "/c"])], driver).then((report) => {
      expect(report.candidates).toBe(1);
      expect(report.confirmed).toBe(1);
      // Two identical files: keeping one, the other's bytes come back.
      expect(report.reclaimableBytes).toBe(4n * MiB);
    });
  });

  it("confirms nothing when a shared size is a coincidence", () => {
    const driver = new FakeDriver({ "/a": "one", "/b": "two" });
    return run([group(9n * MiB, ["/a", "/b"])], driver).then((report) => {
      expect(report.candidates).toBe(1);
      expect(report.confirmed).toBe(0);
      expect(report.reclaimableBytes).toBe(0n);
    });
  });

  it("counts each digest separately inside one size group", () => {
    // Two pairs that happen to share a size. Four copies of one file and two
    // pairs of two are different answers, and the reclaimable figure differs.
    const driver = new FakeDriver({ "/a": "x", "/b": "x", "/c": "y", "/d": "y" });
    return run([group(2n * MiB, ["/a", "/b", "/c", "/d"])], driver).then((report) => {
      expect(report.confirmed).toBe(1);
      expect(report.reclaimableBytes).toBe(4n * MiB);
    });
  });

  it("keeps one of each — never counts the whole group", () => {
    const driver = new FakeDriver({ "/a": "s", "/b": "s", "/c": "s" });
    return run([group(3n * MiB, ["/a", "/b", "/c"])], driver).then((report) => {
      // Three copies, two removable. Counting all three would promise back
      // space that deleting them cannot give.
      expect(report.reclaimableBytes).toBe(6n * MiB);
    });
  });
});

describe("what it asks the host", () => {
  it("never puts two different sizes in one sha256sum call", () => {
    // The property the whole approach rests on: a hash is only ever spent
    // inside a group that already shares a size.
    const driver = new FakeDriver({ "/a": "1", "/b": "1", "/c": "2", "/d": "2" });
    return run([group(MiB, ["/a", "/b"]), group(2n * MiB, ["/c", "/d"])], driver).then(() => {
      expect(driver.calls).toHaveLength(2);
      expect(driver.calls[0]).toEqual(["sha256sum", "--", "/a", "/b"]);
      expect(driver.calls[1]).toEqual(["sha256sum", "--", "/c", "/d"]);
    });
  });

  it("passes -- so a path beginning with a dash is a path", () => {
    const driver = new FakeDriver({ "/-rf": "s", "/b": "s" });
    return run([group(MiB, ["/-rf", "/b"])], driver).then(() => {
      expect(driver.calls[0][1]).toBe("--");
    });
  });

  it("parses a path sha256sum escaped", () => {
    // GNU flags such a line with a leading backslash and escapes the newline.
    const driver = new FakeDriver({});
    driver.execStream = (program: AllowedProgram, args: readonly string[]) => {
      driver.calls.push([program, ...args]);
      return Promise.resolve({
        stdout: Readable.from([
          Buffer.from(`\\${"a".repeat(64)}  /srv/od\\nd\n${"a".repeat(64)}  /srv/plain\n`, "utf8"),
        ]),
        done: Promise.resolve({ code: 0, signal: null, stderr: "", stderrTruncated: false }),
      });
    };

    return run([group(MiB, ["/srv/od\nd", "/srv/plain"])], driver).then((report) => {
      // Both lines carry the same digest, so the group confirms — which only
      // happens if the escaped path was decoded back to the one we asked about.
      expect(report.confirmed).toBe(1);
    });
  });
});

describe("chunking", () => {
  it("stays under the argument count", () => {
    const paths = Array.from({ length: MAX_ARGS_PER_CALL * 2 + 5 }, (_, index) => `/srv/f${index}`);
    for (const chunk of chunkPaths(paths)) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_ARGS_PER_CALL);
    }
    expect(chunkPaths(paths).flat()).toEqual(paths);
  });

  it("stays under the argv budget even with few, very long paths", () => {
    // The other bound, and the one a count alone would miss.
    const paths = Array.from({ length: 8 }, (_, index) => `/srv/${"x".repeat(20_000)}/${index}`);
    for (const chunk of chunkPaths(paths)) {
      const rendered = chunk.reduce((total, path) => total + path.length * 2 + 4, 0);
      expect(rendered).toBeLessThanOrEqual(MAX_ARGV_BYTES);
    }
    expect(chunkPaths(paths).flat()).toEqual(paths);
  });

  it("never emits an empty chunk", () => {
    expect(chunkPaths([])).toEqual([]);
    expect(chunkPaths(["/one"])).toEqual([["/one"]]);
  });
});

describe("the bounds", () => {
  it("reports groups it never looked at rather than dropping them", () => {
    const contents: Record<string, string> = {};
    const groups: DuplicateCandidate[] = [];
    for (let index = 0; index < MAX_DUP_GROUPS + 12; index += 1) {
      contents[`/a${index}`] = `s${index}`;
      contents[`/b${index}`] = `s${index}`;
      // All one size, so it is the group ceiling this exercises and not the
      // byte budget — the two bounds are separate and deserve separate cases.
      groups.push(group(MiB, [`/a${index}`, `/b${index}`]));
    }

    return run(groups, new FakeDriver(contents)).then((report) => {
      expect(report.candidates).toBe(MAX_DUP_GROUPS + 12);
      expect(report.confirmed).toBe(MAX_DUP_GROUPS);
      expect(report.skipped).toBe(12);
    });
  });

  it("carries forward the candidates the walk itself dropped", () => {
    const driver = new FakeDriver({ "/a": "s", "/b": "s" });
    return run([group(MiB, ["/a", "/b"])], driver, 7).then((report) => {
      expect(report.skipped).toBe(7);
    });
  });

  it("stops when the byte budget is spent and reports the rest as unchecked", () => {
    // The other ceiling: few groups, each enormous. A count-based bound alone
    // would let this read a hundred gigabytes off somebody's disk.
    const contents: Record<string, string> = {};
    const groups: DuplicateCandidate[] = [];
    const each = MAX_HASH_BYTES;
    for (let index = 0; index < 40; index += 1) {
      contents[`/a${index}`] = `s${index}`;
      contents[`/b${index}`] = `s${index}`;
      groups.push(group(each, [`/a${index}`, `/b${index}`]));
    }

    return run(groups, new FakeDriver(contents)).then((report) => {
      const affordable = Number(HASH_BUDGET_BYTES / (each * 2n));
      expect(report.confirmed).toBe(affordable);
      expect(report.skipped).toBe(40 - affordable);
      expect(report.candidates).toBe(40);
    });
  });

  it("skips a file too large to be worth reading", () => {
    const driver = new FakeDriver({ "/a": "s", "/b": "s" });
    return run([group(MAX_HASH_BYTES + 1n, ["/a", "/b"])], driver).then((report) => {
      expect(report.confirmed).toBe(0);
      expect(report.skipped).toBe(1);
      expect(driver.calls).toHaveLength(0);
    });
  });

  it("loses one group to a failing host, not the whole pass", () => {
    const driver = new FakeDriver({ "/a": "s", "/b": "s", "/x": "t", "/y": "t" }, { failOn: "/x" });
    return run([group(MiB, ["/x", "/y"]), group(2n * MiB, ["/a", "/b"])], driver).then((report) => {
      expect(report.confirmed).toBe(1);
      expect(report.skipped).toBe(1);
    });
  });
});

describe("cancellation", () => {
  it("stops spending hashes and reports the rest as unchecked", () => {
    const controller = new AbortController();
    controller.abort();
    const driver = new FakeDriver({ "/a": "s", "/b": "s" });

    return run([group(MiB, ["/a", "/b"])], driver, 0, controller.signal).then((report) => {
      expect(driver.calls).toHaveLength(0);
      expect(report.confirmed).toBe(0);
      expect(report.skipped).toBe(1);
    });
  });
});

describe("a host that cannot stream", () => {
  it("reports every group as unchecked rather than claiming none are duplicates", () => {
    const driver = new FakeDriver({ "/a": "s", "/b": "s" });
    (driver as { execStream?: unknown }).execStream = undefined;

    return run([group(MiB, ["/a", "/b"])], driver).then((report) => {
      expect(report.candidates).toBe(1);
      expect(report.confirmed).toBe(0);
      expect(report.skipped).toBe(1);
    });
  });
});
