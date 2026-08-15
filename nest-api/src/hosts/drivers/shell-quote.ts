/**
 * The one place in the codebase that turns an argv array into a shell string.
 *
 * `exec` is not a shell. Locally that is enforced by `execFile(program, argv)`,
 * which never invokes one. Over SSH there is no choice — `ssh2.exec` takes a
 * string and the remote sshd hands it to the login shell — so the string is
 * built here and nowhere else.
 *
 * Two rules make it safe:
 *
 *   1. The program comes from ALLOWED_PROGRAMS. It is never user-supplied.
 *   2. Every argument goes through `quoteArgument`.
 *
 * A command assembled by concatenation anywhere else in the codebase is a
 * blocking review failure (TRE-9).
 */

/**
 * Programs the API may run on a host. Adding one is a security decision:
 * anything that can write, spawn or interpret belongs nowhere near this list.
 * No `sh`, no `bash`, no `find -exec`, no `awk`, no `perl`.
 */
export const ALLOWED_PROGRAMS = ["du", "df", "stat", "tail", "sha256sum", "git", "readlink", "id"] as const;

export type AllowedProgram = (typeof ALLOWED_PROGRAMS)[number];

export function isAllowedProgram(program: string): program is AllowedProgram {
  return (ALLOWED_PROGRAMS as readonly string[]).includes(program);
}

/**
 * POSIX single-quoting.
 *
 * Inside single quotes the shell interprets nothing at all — no `$`, no
 * backtick, no backslash, no newline handling. The only character that cannot
 * appear is the single quote itself, which is closed, escaped and reopened:
 * `it's` becomes `'it'\''s'`.
 *
 * This is why the empty string still produces `''` — dropping it would silently
 * remove an argument and shift every one after it.
 */
export function quoteArgument(argument: string): string {
  if (argument.includes("\0")) {
    // A NUL cannot survive a command line, and truncating silently would turn
    // "delete /home/user\0/keep" into "delete /home/user".
    throw new Error("Argument contains a NUL byte and cannot be passed to a command.");
  }
  return `'${argument.split("'").join(`'\\''`)}'`;
}

/**
 * The niceness range this builder will render.
 *
 * Zero to nineteen, which is to say: lower the priority or leave it alone.
 * Negative niceness *raises* it and needs privilege, so the range is not a
 * validation detail — it is the reason the prefix cannot be turned into a way
 * of making Trekker's work outrank the machine's own (TRE-32).
 */
export const NICE_MIN = 0;
export const NICE_MAX = 19;

export interface RemoteCommandOptions {
  /** Run the program de-prioritised, via a `nice` prefix. See below. */
  nice?: number;
}

/**
 * Builds the full command string for `ssh2.exec`. The only caller is SshDriver.
 *
 * **On the `nice` prefix, which looks like an allowlist hole and is not.**
 * `nice` is not in ALLOWED_PROGRAMS and must never be added to it: its entire
 * purpose is to run a program named by its argument, so an entry there would
 * turn the list from an allowlist into an allowlist with a universal escape
 * hatch — `nice -n 0 sh -c '...'` past every check in this file.
 *
 * Here it is a **literal**, written into the string by this function and never
 * supplied by a caller. The program that actually runs is still the allowlisted
 * one, still checked below, and still the only thing a caller can name. The
 * only caller-supplied part of the prefix is an integer, range-checked, and
 * quoted anyway — belt and braces, since a number that reached here as a string
 * would otherwise be the one unquoted token in the command.
 */
export function buildRemoteCommand(
  program: AllowedProgram,
  args: readonly string[],
  options: RemoteCommandOptions = {},
): string {
  // Widened deliberately: the parameter type already excludes anything else, so
  // TypeScript narrows the failing branch to `never`. The check still has to
  // exist — types are erased, and this is the last thing between an argv array
  // and a remote shell.
  const name: string = program;
  if (!isAllowedProgram(name)) {
    // Defence in depth: the type already prevents this, but types are erased
    // and this function is the last thing between an argv and a remote shell.
    throw new Error(`Program "${name}" is not on the allowlist.`);
  }

  const payload = [program, ...args.map(quoteArgument)].join(" ");
  if (options.nice === undefined) return payload;

  const nice = options.nice;
  if (!Number.isInteger(nice) || nice < NICE_MIN || nice > NICE_MAX) {
    throw new Error(`nice must be an integer between ${NICE_MIN} and ${NICE_MAX}.`);
  }
  return `nice -n ${quoteArgument(String(nice))} ${payload}`;
}
