import { isSudoRefusal, leadingInteger, refusalOf, visibleFirst } from "@fs/dir-size.service";

/**
 * The three decisions in a directory-size walk that do not need a host (TRE-107).
 *
 * The walk itself is `du` and a driver, and belongs in `verify:fs` against a
 * real tree. What is worth pinning here is the reasoning around it: which
 * directory is walked first, what counts as an answer, and what counts as a
 * refusal. Each of the three has a failure mode that is silent — a queue that
 * drops a name, a figure read out of a filename, an unreadable directory
 * reported as empty — and silent is what a spec is for.
 */

describe("visibleFirst", () => {
  const NAMES = ["a", "b", "c", "d", "e", "f"];

  it("walks the rows on screen before the rest", () => {
    expect(visibleFirst(NAMES, 2, 2)).toEqual(["c", "d", "a", "b", "e", "f"]);
  });

  /**
   * The invariant that matters more than the order: the queue is a permutation
   * of the listing. A directory dropped here is a row that spins for ever, and
   * one queued twice is a second `du` over the same tree.
   */
  it("keeps every name exactly once, whatever the window", () => {
    for (const from of [-5, 0, 1, 3, 6, 99]) {
      for (const count of [-1, 0, 1, 4, 99]) {
        expect(visibleFirst(NAMES, from, count).slice().sort()).toEqual(NAMES.slice().sort());
      }
    }
  });

  it("takes a window past the end as no window at all", () => {
    expect(visibleFirst(NAMES, 99, 10)).toEqual(NAMES);
  });

  it("has nothing to order in an empty directory", () => {
    expect(visibleFirst([], 0, 40)).toEqual([]);
  });
});

describe("leadingInteger", () => {
  it("reads the figure off a du -s record", () => {
    expect(leadingInteger("1958505472\t/var/www/app\n")).toBe(1_958_505_472);
  });

  /**
   * Why the `-s` rungs can do without `-0`, stated as a test: the number is
   * complete before any part of the name has been looked at, so nothing a
   * directory can be called reaches it.
   */
  it("cannot be fooled by a name that looks like a record", () => {
    expect(leadingInteger("12\t/tmp/9999999999\n")).toBe(12);
    expect(leadingInteger("4096\t/tmp/1\n999999\n")).toBe(4096);
  });

  it("treats no figure as no answer", () => {
    expect(leadingInteger("")).toBeNull();
    expect(leadingInteger("du: /root: Permission denied\n")).toBeNull();
  });

  /** Past 2^53 a total is no longer the total, and saying so beats rounding it. */
  it("refuses a figure too large to be exact", () => {
    expect(leadingInteger("9007199254740993\t/x")).toBeNull();
  });
});

describe("refusalOf", () => {
  it("names the refusals a listing can actually meet", () => {
    expect(refusalOf("du: cannot read directory '/root': Permission denied")).toBe("EACCES");
    expect(refusalOf("du: cannot access '/gone': No such file or directory")).toBe("ENOENT");
    expect(refusalOf("du: /etc/hosts: Not a directory")).toBe("ENOTDIR");
  });

  /** Anything unrecognised is still a refusal, and never silence. */
  it("falls back rather than inventing a cause", () => {
    expect(refusalOf("du: something nobody has seen before")).toBe("EIO");
    expect(refusalOf("")).toBe("EIO");
  });
});

describe("isSudoRefusal", () => {
  /**
   * The distinction this has to make, and why it matters more than it looks.
   *
   * `sudo` refusing means elevation is off for the rest of the listing — asking
   * a host with no sudoers entry once per directory would be a hundred pointless
   * prompts. `du` refusing means one subtree could not be read, which is the
   * ordinary case and must change nothing: getting it wrong the other way would
   * drop elevation at the first unreadable subdirectory and make every figure
   * after it a floor, which is precisely what opening the window was for.
   */
  it("recognises sudo refusing on its own behalf", () => {
    expect(isSudoRefusal("sudo: no tty present and no askpass program specified")).toBe(true);
    expect(isSudoRefusal("Sorry, user deploy is not in the sudoers file.")).toBe(true);
    expect(isSudoRefusal("sudo: 1 incorrect password attempt")).toBe(true);
  });

  it("does not mistake du's own refusal for sudo's", () => {
    expect(isSudoRefusal("du: cannot read directory '/root': Permission denied")).toBe(false);
    expect(isSudoRefusal("du: cannot access '/proc/1/fd/5': No such file or directory")).toBe(false);
  });

  /**
   * A directory named after the error message is still just a directory — and
   * `/tmp` is world-writable, so this name is something anyone with an account
   * on the host can create. Only the first line is read, and when sudo refuses,
   * `du` never ran to print one.
   */
  it("is not fooled by a path that quotes one", () => {
    expect(isSudoRefusal("du: cannot read directory '/tmp/sudo: incorrect password': Permission denied")).toBe(false);
    expect(isSudoRefusal("du: cannot read directory '/tmp/x\nsudo: 1 incorrect password attempt'")).toBe(false);
  });

  it("still sees sudo when du managed to print afterwards", () => {
    expect(isSudoRefusal("sudo: a terminal is required to read the password\ndu: /x: Permission denied")).toBe(true);
  });

  it("treats silence as nothing to react to", () => {
    expect(isSudoRefusal("")).toBe(false);
  });
});
