import { ALLOWED_PROGRAMS, buildRemoteCommand, NICE_MAX, NICE_MIN, quoteArgument } from "@hosts/drivers/shell-quote";

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
