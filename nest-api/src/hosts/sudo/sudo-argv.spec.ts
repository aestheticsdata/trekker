import { chmodArgv, chownArgv, mvArgv, rmArgv } from "@hosts/sudo/sudo-argv";

/**
 * Turning a syscall's arguments into a command's (TRE-29).
 *
 * Everything Trekker does to a file normally goes over SFTP, which takes
 * numbers: `chmod(path, 0o644)`, `chown(path, uid, gid)`. **SFTP cannot be
 * elevated** — it authenticates as the login user and stays that user — so the
 * root-owned case has to go through `sudo chmod` and `sudo chown` instead, and
 * those take strings. This is the translation, and it is its own file because
 * two of its rules are silent when broken.
 */

describe("chmod argv", () => {
  it("writes the mode as octal, not decimal", () => {
    // The trap. `0o644` is 420 in decimal, and `chmod 420` is a real command
    // that succeeds — it means `0o644`... no: it means mode 420 octal, which is
    // `--w-r----x`. Wrong, silently, on every file it touches.
    expect(chmodArgv(0o644, "/srv/app")).toEqual(["0644", "--", "/srv/app"]);
    expect(chmodArgv(0o755, "/srv/app")).toEqual(["0755", "--", "/srv/app"]);
    expect(chmodArgv(0o600, "/srv/app")).toEqual(["0600", "--", "/srv/app"]);
  });

  it("keeps the leading zero and any special bits", () => {
    // Four digits always, so setuid is visible in the audit row's command and
    // a reader is never left deciding whether `755` had a fourth digit.
    expect(chmodArgv(0o4755, "/x")).toEqual(["4755", "--", "/x"]);
    expect(chmodArgv(0o000, "/x")).toEqual(["0000", "--", "/x"]);
  });

  it("puts `--` before the path", () => {
    // A file called `-R` is a legal filename. Without the separator `chmod`
    // reads it as a flag and recurses over the working directory instead.
    expect(chmodArgv(0o644, "-R")).toEqual(["0644", "--", "-R"]);
    expect(chmodArgv(0o644, "--reference=/etc/shadow")).toEqual(["0644", "--", "--reference=/etc/shadow"]);
  });
});

describe("chown argv", () => {
  it("writes both ids when both are given", () => {
    expect(chownArgv(1000, 1000, "/srv/app")).toEqual(["1000:1000", "--", "/srv/app"]);
    expect(chownArgv(0, 0, "/srv/app")).toEqual(["0:0", "--", "/srv/app"]);
  });

  it("writes only the owner when the group is left alone", () => {
    // -1 is POSIX for "do not change this one" and it is what the driver
    // interface passes. `chown -1:1000` would try to find a user called "-1".
    expect(chownArgv(1000, -1, "/srv/app")).toEqual(["1000", "--", "/srv/app"]);
  });

  it("writes only the group when the owner is left alone", () => {
    // The leading colon is the whole difference between changing the group and
    // changing the owner to a user whose name happens to be the group's.
    expect(chownArgv(-1, 1000, "/srv/app")).toEqual([":1000", "--", "/srv/app"]);
  });

  it("refuses a call that would change nothing", () => {
    // `chown -- /path` with no spec is a usage error from the command. Caught
    // here so it cannot reach a host as a confusing failure on every entry of
    // a recursive walk.
    expect(() => chownArgv(-1, -1, "/srv/app")).toThrow(/owner or a group/);
  });

  it("puts `--` before the path", () => {
    expect(chownArgv(1000, 1000, "-R")).toEqual(["1000:1000", "--", "-R"]);
  });

  it("never emits a name, only a number", () => {
    // Names are resolved to ids before anything is changed (TRE-21), and they
    // must not reappear here: `chown deploy` on a host where that account does
    // not exist fails, and on a host where it means somebody else succeeds
    // wrongly. Every argument this produces is digits, a colon, or `--`.
    for (const argv of [chownArgv(1000, 50, "/x"), chownArgv(1000, -1, "/x"), chownArgv(-1, 50, "/x")]) {
      expect(argv[0]).toMatch(/^\d*(:\d+)?$|^\d+$/);
    }
  });
});

describe("rm argv", () => {
  it("removes a file with -f and no recursion", () => {
    expect(rmArgv("file", "/srv/app/x.log")).toEqual(["-f", "--", "/srv/app/x.log"]);
  });

  it("removes a directory with -d, never -r", () => {
    // **The one that matters.** The walk is post-order, so by the time a
    // directory is reached everything inside it has already been removed one
    // entry at a time, each through the denylist filter. `-d` removes an empty
    // directory and fails on a non-empty one, which is exactly the safety the
    // per-entry walk exists to provide.
    //
    // `-r` here would hand the whole subtree to `rm` in one call, as root,
    // stepping over every check the walk applies — including the denylist that
    // keeps `~/.ssh` out of a recursive delete of a home directory (TRE-52). A
    // non-empty directory failing its `rmdir` is the truth and must stay one.
    expect(rmArgv("directory", "/srv/app")).toEqual(["-d", "--", "/srv/app"]);
  });

  it("treats a symlink as a file, so the target is untouched", () => {
    // `rm` on a symlink removes the link. `-r` on one would not follow it
    // either, but there is no reason to be near that question.
    expect(rmArgv("symlink", "/srv/link")).toEqual(["-f", "--", "/srv/link"]);
  });

  it("puts `--` before the path", () => {
    expect(rmArgv("file", "-rf")).toEqual(["-f", "--", "-rf"]);
  });

  it("never emits -r or -R for anything", () => {
    for (const kind of ["file", "directory", "symlink", "fifo", "socket", "block", "character", "unknown"] as const) {
      expect(rmArgv(kind, "/x")).not.toContain("-r");
      expect(rmArgv(kind, "/x")).not.toContain("-R");
      expect(rmArgv(kind, "/x")).not.toContain("-rf");
    }
  });
});

describe("mv argv", () => {
  it("renames with -f and a separator", () => {
    expect(mvArgv("/srv/app/x.conf.partial", "/srv/app/x.conf")).toEqual([
      "-f",
      "--",
      "/srv/app/x.conf.partial",
      "/srv/app/x.conf",
    ]);
  });

  it("puts `--` before both paths, not just the first", () => {
    // Either end can be a filename beginning with a dash, and `mv` reads both
    // as operands only after the separator.
    expect(mvArgv("-source", "-dest")).toEqual(["-f", "--", "-source", "-dest"]);
  });

  it("never emits -r, -T or anything recursive", () => {
    // `-T` would be the correct GNU flag for "treat the destination as a name,
    // never as a directory to move into" — and macOS `mv` does not have it, so
    // using it would work on every server and break the local host on the
    // machine this is developed on. The upload path already knows its
    // destination is a file.
    const argv = mvArgv("/a", "/b");
    expect(argv).not.toContain("-r");
    expect(argv).not.toContain("-R");
    expect(argv).not.toContain("-T");
  });
});
