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
 *   1. The program comes from ALLOWED_PROGRAMS, or from SUDO_ONLY_PROGRAMS
 *      when sudo was asked for. It is never user-supplied.
 *   2. Every argument goes through `quoteArgument`.
 *
 * A command assembled by concatenation anywhere else in the codebase is a
 * blocking review failure (TRE-9).
 *
 * `nice` and `sudo` are prefixes rather than entries on either list, for the
 * same reason in both cases — see `buildRemoteCommand`.
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
 * Programs that exist only for sudo, and are refused without it (TRE-29).
 *
 * These *can* write, which is why they are not on the list above. Keeping them
 * separate is the whole design: `ALLOWED_PROGRAMS` remains a list of things
 * that cannot change anything, its header stays true as written, and the
 * ability to run `rm` on a host does not exist outside an open sudo window.
 *
 * Why these six and no others. Everything Trekker does to a file — read,
 * write, rename, delete, chmod, chown — normally goes over SFTP, and **SFTP
 * cannot be elevated**: it authenticates as the login user and stays that user
 * for the session. So for root-owned paths each of those operations needs a
 * command instead, and this is the smallest set that covers them: `cat` reads,
 * `tee` writes, `rm` deletes, `chmod` and `chown` do what SFTP would have done,
 * and `mv` renames — which is not a sixth capability but the second half of the
 * first: a save writes a `.partial` and moves it into place, so that an
 * interrupted write leaves the original file rather than a truncated one. Doing
 * it without `mv` would mean writing straight over the target, and losing
 * atomicity on precisely the files that are hardest to restore.
 *
 * The same rule as above still governs additions, and more strictly: nothing
 * that can spawn or interpret. No `sh`, no `find`, no `awk` — and note that
 * `sudo` itself is not here either. It is a literal prefix written by
 * `buildRemoteCommand`, never a name a caller can supply.
 */
export const SUDO_ONLY_PROGRAMS = ["cat", "tee", "rm", "chmod", "chown", "mv"] as const;

export type SudoOnlyProgram = (typeof SUDO_ONLY_PROGRAMS)[number];

export function isSudoOnlyProgram(program: string): program is SudoOnlyProgram {
  return (SUDO_ONLY_PROGRAMS as readonly string[]).includes(program);
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
  /**
   * Run it as root, and admit `SUDO_ONLY_PROGRAMS` (TRE-29). Absent means no
   * sudo at all, and those names are then refused exactly as `sh` is.
   *
   * The caller is responsible for having a live sudo window before setting
   * this — the builder renders a command, it does not decide who may ask.
   */
  sudo?: SudoMode;
}

/**
 * The two ways the prefix is rendered, which are not interchangeable.
 *
 * `"password"` is the real thing: `sudo -S -p ''` reads the password from
 * stdin and prints no prompt. It is also correct on a host that asks for no
 * password — sudo simply never reads what was sent — so operations use this
 * form whatever kind of host they are on.
 *
 * `"probe"` is `sudo -n`, which fails rather than prompting. That is how
 * Trekker finds out *which* kind of host it is talking to before deciding
 * whether to ask the person for a password at all. Sending a password to a
 * host that never wanted one would make the prompt theatre, and `-n` is the
 * question that avoids it.
 */
export type SudoMode = "password" | "probe";

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
  program: AllowedProgram | SudoOnlyProgram,
  args: readonly string[],
  options: RemoteCommandOptions = {},
): string {
  // Widened deliberately: the parameter type already excludes anything else, so
  // TypeScript narrows the failing branch to `never`. The check still has to
  // exist — types are erased, and this is the last thing between an argv array
  // and a remote shell.
  const name: string = program;
  const sudo = options.sudo !== undefined;
  // Without sudo the sudo-only names are refused exactly as `sh` is, so there
  // is no route to `rm` on a host at all unless a window is open.
  if (!(isAllowedProgram(name) || (sudo && isSudoOnlyProgram(name)))) {
    // Defence in depth: the type already prevents this, but types are erased
    // and this function is the last thing between an argv and a remote shell.
    throw new Error(
      isSudoOnlyProgram(name)
        ? `Program "${name}" is on the sudo allowlist only and needs sudo to run.`
        : `Program "${name}" is not on the allowlist.`,
    );
  }

  const command = [program, ...args.map(quoteArgument)].join(" ");
  // `-S` takes the password from stdin rather than the terminal, which is the
  // only way it can be given over an exec channel. `-p ''` silences the prompt,
  // so nothing sudo writes can be mistaken for the command's own output. `-n`
  // is the probe: never prompt, fail instead.
  //
  // The password is in neither form and must never be: argv is readable by
  // every account on the host. It goes to stdin — see `ExecOptions.stdin`.
  const payload = sudo ? `${options.sudo === "probe" ? "sudo -n" : "sudo -S -p ''"} ${command}` : command;
  if (options.nice === undefined) return payload;

  const nice = options.nice;
  if (!Number.isInteger(nice) || nice < NICE_MIN || nice > NICE_MAX) {
    throw new Error(`nice must be an integer between ${NICE_MIN} and ${NICE_MAX}.`);
  }
  // Outside sudo, not inside: niceness is inherited by whatever sudo launches,
  // so this way round needs nothing re-niced after the fact.
  return `nice -n ${quoteArgument(String(nice))} ${payload}`;
}
