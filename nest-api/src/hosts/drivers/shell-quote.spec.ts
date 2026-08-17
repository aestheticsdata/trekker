import {
  ALLOWED_PROGRAMS,
  buildRemoteCommand,
  isAllowedProgram,
  isSudoOnlyProgram,
  NICE_MAX,
  NICE_MIN,
  quoteArgument,
  SUDO_ONLY_PROGRAMS,
} from "@hosts/drivers/shell-quote";

/**
 * The one place an argv array becomes a shell string (TRE-9, TRE-32).
 *
 * Everything here is load-bearing in the same way: over SSH there is no
 * `execFile` to hide behind, the remote sshd hands this string to a login
 * shell, and a mistake is remote command execution rather than a wrong answer.
 */

describe("quoting", () => {
  it("neutralises everything a shell would read", () => {
    expect(quoteArgument("$(id)")).toBe("'$(id)'");
    expect(quoteArgument("a; rm -rf /")).toBe("'a; rm -rf /'");
    expect(quoteArgument("`whoami`")).toBe("'`whoami`'");
    expect(quoteArgument("a\nb")).toBe("'a\nb'");
  });

  it("closes, escapes and reopens around a single quote", () => {
    expect(quoteArgument("it's")).toBe(`'it'\\''s'`);
  });

  it("keeps the empty string as an argument", () => {
    // Dropping it would silently remove an argument and shift every one after.
    expect(quoteArgument("")).toBe("''");
  });

  it("refuses a NUL rather than truncating at it", () => {
    expect(() => quoteArgument("/home/user\0/keep")).toThrow(/NUL/);
  });
});

describe("buildRemoteCommand", () => {
  it("renders the program and its quoted arguments", () => {
    expect(buildRemoteCommand("du", ["-x", "/srv/data"])).toBe("du '-x' '/srv/data'");
  });

  it("refuses a program that is not on the allowlist", () => {
    // The type already prevents this; types are erased, and this function is
    // the last thing between an argv and a remote shell.
    expect(() => buildRemoteCommand("sh" as never, ["-c", "id"])).toThrow(/allowlist/);
  });

  it("is byte-identical to its old output when no nice is asked for", () => {
    // A regression guard on every caller that predates TRE-32. The nice prefix
    // must be invisible unless somebody asked for it.
    for (const program of ALLOWED_PROGRAMS) {
      expect(buildRemoteCommand(program, ["-a", "b c"], {})).toBe(buildRemoteCommand(program, ["-a", "b c"]));
      expect(buildRemoteCommand(program, ["-a", "b c"])).toBe(`${program} '-a' 'b c'`);
    }
  });
});

describe("the nice prefix", () => {
  it("wraps the allowlisted program without becoming one", () => {
    // `nice` is a literal in the builder, never a name a caller can supply —
    // which is the whole difference between a prefix and an allowlist entry.
    expect(buildRemoteCommand("du", ["-x", "/srv"], { nice: 15 })).toBe("nice -n '15' du '-x' '/srv'");
  });

  it("still refuses a program that is not allowlisted", () => {
    // The prefix must not become a way past the check it sits in front of.
    expect(() => buildRemoteCommand("bash" as never, ["-c", "id"], { nice: 0 })).toThrow(/allowlist/);
  });

  it("accepts the whole range and nothing outside it", () => {
    expect(() => buildRemoteCommand("du", [], { nice: NICE_MIN })).not.toThrow();
    expect(() => buildRemoteCommand("du", [], { nice: NICE_MAX })).not.toThrow();
    // Negative niceness raises priority and needs privilege. Refusing it is why
    // the range exists, not a validation detail.
    expect(() => buildRemoteCommand("du", [], { nice: -1 })).toThrow(/between/);
    expect(() => buildRemoteCommand("du", [], { nice: NICE_MAX + 1 })).toThrow(/between/);
  });

  it("refuses anything that is not an integer", () => {
    expect(() => buildRemoteCommand("du", [], { nice: 1.5 })).toThrow(/between/);
    expect(() => buildRemoteCommand("du", [], { nice: Number.NaN })).toThrow(/between/);
    // Types are erased, so a string reaching here is a live possibility — and
    // it is the one token in the command that would otherwise be unquoted.
    expect(() => buildRemoteCommand("du", [], { nice: "15; id" as never })).toThrow(/between/);
  });
});

/**
 * The sudo prefix (TRE-29).
 *
 * Built exactly like `nice` and for the same reason: `sudo` runs a program
 * named by its argument, so an entry on the allowlist would turn the list into
 * an allowlist with a universal escape hatch. It is a literal written by this
 * function, and the program that actually runs is still the one the caller
 * named and the checker checked.
 *
 * The programs sudo exists for are a separate list, because they are the ones
 * that can write. `ALLOWED_PROGRAMS` stays a list of things that cannot, and
 * its header stays true as written.
 */
describe("the sudo prefix", () => {
  it("wraps the program without becoming one", () => {
    expect(buildRemoteCommand("cat", ["/etc/shadow"], { sudo: "password" })).toBe("sudo -S -p '' cat '/etc/shadow'");
  });

  it("is not on either list itself", () => {
    // The name a caller cannot supply. Both checks refuse it, so the only way
    // `sudo` reaches a command line is as the literal above.
    expect(isAllowedProgram("sudo")).toBe(false);
    expect(isSudoOnlyProgram("sudo")).toBe(false);
    expect(() => buildRemoteCommand("sudo" as never, ["rm", "-rf", "/"], { sudo: "password" })).toThrow(/allowlist/);
  });

  it("keeps ALLOWED_PROGRAMS free of anything that writes", () => {
    // The guarantee the header of shell-quote.ts makes. If a future ticket
    // moves one of these across, this is what says so.
    for (const program of SUDO_ONLY_PROGRAMS) {
      expect(ALLOWED_PROGRAMS).not.toContain(program);
    }
  });

  it("refuses a writing program when sudo was not asked for", () => {
    // `rm` exists for sudo and nothing else. Without the prefix there is no
    // route to it at all, which is what keeps the ability from existing outside
    // an open window.
    expect(() => buildRemoteCommand("rm", ["-rf", "/srv"])).toThrow(/allowlist/);
    expect(() => buildRemoteCommand("tee", ["/etc/passwd"], { nice: 5 })).toThrow(/allowlist/);
  });

  it("still allows a reading program under sudo", () => {
    // Reading /var/log as root is the other half of what the window is for.
    expect(buildRemoteCommand("tail", ["-n", "50", "/var/log/auth.log"], { sudo: "password" })).toBe(
      "sudo -S -p '' tail '-n' '50' '/var/log/auth.log'",
    );
  });

  it("still refuses a program on neither list, with or without sudo", () => {
    expect(() => buildRemoteCommand("bash" as never, ["-c", "id"], { sudo: "password" })).toThrow(/allowlist/);
    expect(() => buildRemoteCommand("find" as never, ["-exec", "id", ";"], { sudo: "password" })).toThrow(/allowlist/);
  });

  it("quotes every argument under sudo exactly as it does without", () => {
    // The prefix must not become a place where quoting is skipped.
    expect(buildRemoteCommand("rm", ["-f", "a; rm -rf /"], { sudo: "password" })).toBe(
      "sudo -S -p '' rm '-f' 'a; rm -rf /'",
    );
  });

  it("puts nice outside sudo when both are asked for", () => {
    // The order matters: niceness is inherited by what sudo launches, so the
    // other way round would need sudo's own child to be re-niced.
    expect(buildRemoteCommand("cat", ["/etc/hosts"], { sudo: "password", nice: 10 })).toBe(
      "nice -n '10' sudo -S -p '' cat '/etc/hosts'",
    );
  });

  it("is byte-identical to its old output when sudo is not asked for", () => {
    // The same regression guard the nice prefix has. Every caller that predates
    // TRE-29 must see no change at all.
    for (const program of ALLOWED_PROGRAMS) {
      expect(buildRemoteCommand(program, ["-a", "b c"], {})).toBe(`${program} '-a' 'b c'`);
      expect(buildRemoteCommand(program, ["-a", "b c"], {})).toBe(`${program} '-a' 'b c'`);
    }
  });

  it("renders the probe with -n, which never prompts", () => {
    // How Trekker finds out which kind of host it is talking to. `-n` makes
    // sudo fail rather than ask, so a host that would have prompted says so by
    // exiting non-zero instead of hanging on a terminal that is not there.
    expect(buildRemoteCommand("id", ["-u"], { sudo: "probe" })).toBe("sudo -n id '-u'");
  });

  it("keeps the probe under the same allowlist as everything else", () => {
    // A mode is not a way past the check. `-n` still cannot reach `sh`, and it
    // still admits the sudo-only names because it is a sudo call.
    expect(() => buildRemoteCommand("sh" as never, ["-c", "id"], { sudo: "probe" })).toThrow(/allowlist/);
    expect(buildRemoteCommand("cat", ["/etc/shadow"], { sudo: "probe" })).toBe("sudo -n cat '/etc/shadow'");
  });

  it("sends no password prompt to the terminal", () => {
    // `-S` reads the password from stdin and `-p ''` silences the prompt, so
    // nothing sudo writes can be mistaken for the command's own output. The
    // password itself never appears here — it goes to stdin, never to argv,
    // because argv is readable by every account on the host.
    const command = buildRemoteCommand("cat", ["/etc/shadow"], { sudo: "password" });
    expect(command).toContain("-S");
    expect(command).toContain("-p ''");
    expect(command).not.toContain("hunter2");
  });
});
