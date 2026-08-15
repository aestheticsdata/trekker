import { DU_RUNGS, shouldDemote } from "@scans/du-flavour";
import { countUnreadable, DuParser } from "@scans/du-parse";

/**
 * `du`'s output read as an interface (TRE-32).
 *
 * The same discipline as `host-disks.service.spec.ts`: `du` is a formatting
 * program, so every case here is a parsing decision with one right answer and
 * several plausible wrong ones, none of which fails loudly. A misread record
 * becomes a rectangle with a wrong size or a wrong name, drawn perfectly.
 *
 * One case is not a formatting question at all. A filename may contain a
 * newline, and anybody who can write into the scanned tree can make one — so
 * under a line parser they can inject a record: a size of their choosing
 * against a path of their choosing. That is somebody else deciding what the
 * disk panel says about the machine, and it is what the `-0` rung is for.
 *
 * The newline rungs are tested for what they actually do, including the case
 * they cannot defend. A spec that only asserted the refusals would read as a
 * guarantee this parser does not make.
 */

const GNU = DU_RUNGS[0];
const GNU_NO_NUL = DU_RUNGS[1];
const PORTABLE = DU_RUNGS[2];

function feed(parser: DuParser, text: string) {
  return [...parser.push(Buffer.from(text, "utf8")), ...parser.end()];
}

describe("the GNU rung", () => {
  it("reads size, mtime and path from a NUL-terminated record", () => {
    const records = feed(new DuParser(GNU), "4096\t1700000000\t/srv/a\x00819200\t1700000060\t/srv\x00");

    expect(records).toEqual([
      { bytes: 4096n, mtimeMs: 1_700_000_000_000, path: "/srv/a" },
      { bytes: 819_200n, mtimeMs: 1_700_000_060_000, path: "/srv" },
    ]);
  });

  it("keeps a filename containing a newline intact", () => {
    // The whole reason `-0` is asked for. Under a line parser this is two
    // records, the second of which the file's owner wrote.
    const records = feed(new DuParser(GNU), "512\t1700000000\t/srv/od\nd\x00512\t1700000000\t/srv\x00");

    expect(records[0].path).toBe("/srv/od\nd");
    expect(records).toHaveLength(2);
  });

  it("keeps a filename containing a tab intact", () => {
    // Split on the first two tabs, not on whitespace: everything after the
    // second is the path, tabs and all.
    const records = feed(new DuParser(GNU), "512\t1700000000\t/srv/a\tb\x00");
    expect(records[0].path).toBe("/srv/a\tb");
  });

  it("reassembles a multi-byte character split across two chunks", () => {
    // A chunk boundary falls wherever the network put it. Decoding each chunk
    // independently turns the character into replacement characters and the
    // rectangle is labelled with a name nobody can find.
    const parser = new DuParser(GNU);
    const whole = Buffer.from("2048\t1700000000\t/srv/café\x00", "utf8");
    const cut = whole.indexOf(0xc3); // the first byte of "é"

    const records = [
      ...parser.push(whole.subarray(0, cut + 1)),
      ...parser.push(whole.subarray(cut + 1)),
      ...parser.end(),
    ];

    expect(records).toHaveLength(1);
    expect(records[0].path).toBe("/srv/café");
  });

  it("reassembles a record split across two chunks", () => {
    const parser = new DuParser(GNU);
    const records = [
      ...parser.push(Buffer.from("4096\t17000")),
      ...parser.push(Buffer.from("00000\t/srv\x00")),
      ...parser.end(),
    ];

    expect(records).toEqual([{ bytes: 4096n, mtimeMs: 1_700_000_000_000, path: "/srv" }]);
  });

  it("drops a truncated final record rather than half-reading it", () => {
    // What a cancelled walk leaves. Half a number is a plausible number.
    const parser = new DuParser(GNU);
    const records = feed(parser, "4096\t1700000000\t/srv/a\x00999");

    expect(records).toHaveLength(1);
    expect(parser.malformedCount).toBe(1);
  });
});

describe("the newline rungs", () => {
  it("truncates a name containing a newline rather than inventing a record", () => {
    // A `du` too old for `-0`. The real file is `/srv/od\nd`, and what comes
    // back is `/srv/od` — a shortened name, which is wrong but harmless. The
    // dangling `d` has no leading integer, so it is counted and dropped rather
    // than becoming a record.
    const parser = new DuParser(GNU_NO_NUL);
    const records = feed(parser, "512\t1700000000\t/srv/od\nd\n512\t1700000000\t/srv\n");

    expect(records.map((record) => record.path)).toEqual(["/srv/od", "/srv"]);
    expect(parser.malformedCount).toBe(1);
  });

  it("refuses a fabricated record whose path is relative", () => {
    // A file called $'x\n4096\t1700000000\tsrv/fake' parses as a size and a
    // path. It is refused because `du` is given an absolute root and prints
    // only absolute paths, so anything relative came from inside a filename.
    const parser = new DuParser(GNU_NO_NUL);
    const records = feed(parser, "512\t1700000000\t/srv/x\n4096\t1700000000\tsrv/fake\n512\t1700000000\t/srv\n");

    expect(records.map((record) => record.path)).toEqual(["/srv/x", "/srv"]);
  });

  it("cannot refuse a fabricated record whose path is absolute, which is why -0 is asked for first", () => {
    // The residual exposure of these rungs, asserted rather than hoped about.
    // A file named $'x\n999999999\t1700000000\t/srv/fake' produces a second
    // record this parser has no way to tell from a real one — a size of the
    // file owner's choosing against a path of their choosing.
    //
    // Nothing here can close that: the framing is ambiguous and no amount of
    // shape-checking recovers it. `-0` closes it, which is why it is the first
    // rung and why these two exist only for a `du` older than coreutils 8.6.
    // A fabricated path *outside* the scan root is still dropped, by the
    // aggregator, which knows the root this parser does not.
    const parser = new DuParser(GNU_NO_NUL);
    const records = feed(parser, "512\t1700000000\t/srv/x\n999999999\t1700000000\t/srv/fake\n512\t1700000000\t/srv\n");

    expect(records.map((record) => record.path)).toContain("/srv/fake");
  });
});

describe("the portable rung", () => {
  it("multiplies KiB into bytes and reports no mtime", () => {
    // Real BSD `du -a -x -k` output, captured from a temporary tree.
    const records = feed(
      new DuParser(PORTABLE),
      ["0\t/srv/empty", "4\t/srv/a/f1", "12\t/srv/a", "24\t/srv"].join("\n") + "\n",
    );

    expect(records).toEqual([
      { bytes: 0n, mtimeMs: null, path: "/srv/empty" },
      { bytes: 4096n, mtimeMs: null, path: "/srv/a/f1" },
      { bytes: 12_288n, mtimeMs: null, path: "/srv/a" },
      { bytes: 24_576n, mtimeMs: null, path: "/srv" },
    ]);
  });
});

describe("stderr", () => {
  it("counts the directories du could not read", () => {
    const stderr = [
      "du: cannot read directory '/srv/private': Permission denied",
      "du: cannot access '/srv/gone': No such file or directory",
      "du: fts_read failed: Permission denied",
      "some other line entirely",
    ].join("\n");

    expect(countUnreadable(stderr)).toBe(3);
  });

  it("counts nothing on a clean run", () => {
    expect(countUnreadable("")).toBe(0);
  });
});

describe("demotion", () => {
  it("never demotes on exit 1, which is an unreadable subtree", () => {
    // The commonest successful scan of a system directory there is. Demoting
    // here would drop every such host to the portable rung and lose the facts.
    expect(shouldDemote({ code: 1, stdout: "4096\t/srv\n", stderr: "du: cannot read directory '/srv/x'" })).toBe(false);
  });

  it("does not demote when the host produced output, whatever it said", () => {
    expect(shouldDemote({ code: 2, stdout: "4096\t/srv\n", stderr: "noise" })).toBe(false);
  });

  it("demotes on a usage complaint with nothing on stdout", () => {
    expect(shouldDemote({ code: 1, stdout: "", stderr: "du: unrecognized option '--time'" })).toBe(true);
    expect(shouldDemote({ code: 64, stdout: "", stderr: "usage: du [-Aclnx] ..." })).toBe(true);
    expect(shouldDemote({ code: 1, stdout: "", stderr: "du: illegal option -- 0" })).toBe(true);
  });
});
