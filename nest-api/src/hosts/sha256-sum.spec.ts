import { Readable } from "node:stream";
import { DriverError } from "@hosts/drivers/driver-error";
import { parseSumLines, sumChunk } from "@hosts/sha256-sum";

import type { ExecStream, HostDriver } from "@hosts/drivers/host-driver";

/**
 * Running `sha256sum` and reading it (TRE-27 §1, TRE-32 §3).
 *
 * The property that carries the most weight here is the one that decides
 * *which machine does the reading*: "this host has no `sha256sum`" and "this
 * host refused" are different answers, and confusing them either drags twenty
 * gigabytes across a network that had no reason to see them, or reports a file
 * as unhashable when the fallback would have hashed it fine.
 *
 * The chunker is exercised by `duplicate-finder.spec.ts`, which has covered it
 * since TRE-32 and still does.
 */

const DIGEST = "a".repeat(64);
const OTHER = "b".repeat(64);

interface Frames {
  /** stdout, in the pieces it arrives in — which is what `onDigest` is about. */
  out?: string[];
  code?: number;
  /** Rejects `done` with this instead of resolving. */
  fails?: Error;
  /** Rejects `execStream` itself with this. */
  refuses?: Error;
}

function driverOf(frames: Frames): HostDriver {
  return {
    hostId: "host-1",
    execStream: (): Promise<ExecStream> => {
      if (frames.refuses) return Promise.reject(frames.refuses);
      return Promise.resolve({
        stdout: Readable.from((frames.out ?? []).map((piece) => Buffer.from(piece, "utf8"))),
        done: frames.fails
          ? Promise.reject(frames.fails)
          : Promise.resolve({ code: frames.code ?? 0, signal: null, stderr: "", stderrTruncated: false }),
      });
    },
  } as unknown as HostDriver;
}

describe("what one call comes back with", () => {
  it("reads the digests a normal run prints", async () => {
    const outcome = await sumChunk(driverOf({ out: [`${DIGEST}  /srv/a\n${OTHER}  /srv/b\n`] }), ["/srv/a", "/srv/b"]);

    expect(outcome.kind).toBe("digests");
    if (outcome.kind !== "digests") return;
    expect(outcome.digests.get("/srv/a")).toBe(DIGEST);
    expect(outcome.digests.get("/srv/b")).toBe(OTHER);
  });

  it("keeps what a partly-failed run did print", async () => {
    // GNU `sha256sum` exits non-zero when one path was unreadable and still
    // prints the others. Discarding that output would lose good digests over a
    // file that was not being asked about.
    const outcome = await sumChunk(driverOf({ out: [`${DIGEST}  /srv/a\n`], code: 1 }), ["/srv/a", "/srv/gone"]);

    expect(outcome.kind).toBe("digests");
    if (outcome.kind !== "digests") return;
    expect(outcome.digests.get("/srv/a")).toBe(DIGEST);
    // The unreadable one simply has no line, which is how a caller learns it
    // was not hashed.
    expect(outcome.digests.has("/srv/gone")).toBe(false);
  });

  it("calls a silent 127 a missing program, not a failure", async () => {
    // How a host with no `sha256sum` answers over SSH: there is no exception to
    // catch, only the shell's own exit code. This is the branch that decides
    // whether the fallback runs at all.
    const outcome = await sumChunk(driverOf({ code: 127 }), ["/srv/a"]);

    expect(outcome.kind).toBe("absent");
  });

  it("calls a 127 that printed digests a real run", async () => {
    // A command that produced output and then exited 127 for its own reasons is
    // not a missing command, and treating it as one would send a host that can
    // hash locally down the network path.
    const outcome = await sumChunk(driverOf({ out: [`${DIGEST}  /srv/a\n`], code: 127 }), ["/srv/a"]);

    expect(outcome.kind).toBe("digests");
  });

  it("calls an ENOENT rejection a missing program too", async () => {
    // The local driver has no shell in the way, so it reports the same fact as
    // a rejected promise. Both transports have to reach the same answer or the
    // fallback would exist on one of them only.
    const outcome = await sumChunk(
      driverOf({ refuses: new DriverError("ENOENT", "sha256sum is not installed on this host") }),
      ["/srv/a"],
    );

    expect(outcome.kind).toBe("absent");
  });

  it("calls a silent non-zero exit a failure", async () => {
    const outcome = await sumChunk(driverOf({ code: 1 }), ["/srv/a"]);

    expect(outcome.kind).toBe("failed");
  });

  it("calls a dropped channel a failure, not a missing program", async () => {
    // The distinction with teeth: a link that dropped would drop again, and
    // reading the file across it instead is the slowest possible way to find
    // that out.
    const outcome = await sumChunk(driverOf({ fails: new DriverError("EUNREACHABLE", "gone") }), ["/srv/a"]);

    expect(outcome.kind).toBe("failed");
  });

  it("treats a driver that cannot stream as a host that cannot hash", async () => {
    const outcome = await sumChunk({ hostId: "host-1" } as unknown as HostDriver, ["/srv/a"]);

    expect(outcome.kind).toBe("absent");
  });
});

describe("progress while it runs", () => {
  it("reports each file as its line arrives, not at the end", async () => {
    // The whole reason `onDigest` exists. `sha256sum` says nothing while it
    // reads and prints one line per file when that file is done, so this is the
    // only per-file progress a remote hash can have — and a chunk of sixty-four
    // large files is minutes of silence without it.
    const seen: string[] = [];

    await sumChunk(driverOf({ out: [`${DIGEST}  /srv/a\n`, `${OTHER}  /srv/b\n`] }), ["/srv/a", "/srv/b"], {
      onDigest: (path) => seen.push(path),
    });

    expect(seen).toEqual(["/srv/a", "/srv/b"]);
  });

  it("waits for the rest of a line split across two reads", async () => {
    // A digest is 64 characters and a path can be long, so a line straddling a
    // chunk boundary is ordinary rather than exotic. Parsing the halves
    // separately would drop the file silently — it would look unhashable.
    const seen: string[] = [];

    const outcome = await sumChunk(driverOf({ out: [`${DIGEST}  /srv/lo`, "ng/name\n"] }), ["/srv/long/name"], {
      onDigest: (path) => seen.push(path),
    });

    expect(seen).toEqual(["/srv/long/name"]);
    expect(outcome.kind === "digests" && outcome.digests.get("/srv/long/name")).toBe(DIGEST);
  });

  it("parses a final line that never got its newline", async () => {
    const outcome = await sumChunk(driverOf({ out: [`${DIGEST}  /srv/a`] }), ["/srv/a"]);

    expect(outcome.kind === "digests" && outcome.digests.get("/srv/a")).toBe(DIGEST);
  });
});

describe("the line format", () => {
  it("undoes the escaping sha256sum applies to awkward names", () => {
    // A backslash-prefixed line is the command telling us it escaped the path.
    // Storing the escaped form would key the cache under a name no `stat` will
    // ever match, so the file would be re-hashed on every job forever.
    const digests = parseSumLines(`\\${DIGEST}  /srv/od\\nd\\\\name\n`);

    expect([...digests.keys()]).toEqual(["/srv/od\nd\\name"]);
  });

  it("ignores anything that is not a sum line", () => {
    const digests = parseSumLines(`sha256sum: /srv/x: Permission denied\n${DIGEST}  /srv/a\n`);

    expect([...digests.keys()]).toEqual(["/srv/a"]);
  });
});
