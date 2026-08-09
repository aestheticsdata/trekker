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

/** Builds the full command string for `ssh2.exec`. The only caller is SshDriver. */
export function buildRemoteCommand(program: AllowedProgram, args: readonly string[]): string {
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
  return [program, ...args.map(quoteArgument)].join(" ");
}
