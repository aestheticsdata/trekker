/**
 * The arguments `sudo chmod` and `sudo chown` take (TRE-29).
 *
 * Everything Trekker does to a file normally goes over SFTP, whose calls take
 * numbers — `chmod(path, 0o644)`, `chown(path, uid, gid)`. **SFTP cannot be
 * elevated**: it authenticates as the login user and stays that user for the
 * session. So the root-owned case has to go through the commands instead, and
 * the commands take strings.
 *
 * Its own file, and its own spec, because two of the rules below are silent
 * when broken — a wrong mode and a wrong owner both succeed, on every entry of
 * a recursive walk, and say nothing.
 *
 * Every argument produced here is still quoted by `shell-quote.ts` on the way
 * out. Nothing in this file is a substitute for that.
 */

/**
 * `chmod`'s arguments, with the mode in octal.
 *
 * **The mode has to be rendered as octal and it is easy not to.** `0o644` is
 * the number 420, and `chmod 420 file` is not an error — it is a valid request
 * for mode `0o420`, which is `-r--w----`. Wrong permissions, applied
 * successfully, with nothing to notice.
 *
 * Four digits always, so the special bits are visible rather than implied: a
 * reader of the audit row should not have to work out whether `755` had a
 * fourth digit that happened to be zero.
 */
export function chmodArgv(mode: number, path: string): string[] {
  return [mode.toString(8).padStart(4, "0"), "--", path];
}

/**
 * `chown`'s arguments, from the pair the driver interface uses.
 *
 * `-1` is POSIX for "leave this one alone", which is what `chown(path, -1, gid)`
 * means at the syscall and what both drivers already pass through. The command
 * has no such convention — it has three *spellings* instead, and picking the
 * wrong one is the silent failure here:
 *
 *   - `1000:1000` — both
 *   - `1000`      — owner only
 *   - `:1000`     — group only
 *
 * `chown -1:1000` would look for an account named `-1`. And dropping the
 * leading colon from the group-only form turns "set the group to 1000" into
 * "set the owner to 1000", which succeeds whenever a user with that id exists.
 *
 * Ids only, never names. They are resolved before anything is changed (TRE-21)
 * precisely so a typo cannot leave half a selection owned by someone new, and
 * re-introducing a name here would put that back — a name means different
 * accounts on different hosts, or no account at all.
 */
/**
 * `rm`'s arguments for one entry — **never for a tree**.
 *
 * The delete walk is post-order and removes one entry at a time, each of them
 * filtered through the denylist. By the time a directory is reached it is
 * already empty, so `-d` is all it needs: it removes an empty directory and
 * fails on a non-empty one.
 *
 * **`-r` must never appear here, and the reason is not caution.** It would hand
 * a whole subtree to `rm` in a single call, as root, stepping over every check
 * the walk performs on the way down — including the denylist that keeps
 * `~/.ssh` out of a recursive delete of a home directory (TRE-52). The walk is
 * the security boundary; a recursive flag would make it decorative. A directory
 * that will not empty is a failure worth reporting, not one worth forcing.
 *
 * `-f` on the non-directory case suppresses the prompt a write-protected file
 * would otherwise trigger, on a channel with no terminal to answer it.
 */
export function rmArgv(kind: string, path: string): string[] {
  return [kind === "directory" ? "-d" : "-f", "--", path];
}

/**
 * `mv`'s arguments, for the rename half of an atomic write (TRE-29).
 *
 * A save writes to `x.conf.partial` and renames it over `x.conf`, so that an
 * interrupted upload leaves the original intact rather than a half-written
 * config. Under sudo both halves have to be root's: `tee` writes the partial,
 * this moves it into place.
 *
 * **No `-T`.** GNU's "treat the destination as a name, never as a directory to
 * move into" is the flag this would otherwise want, and macOS `mv` does not
 * have it — using it would work on every server and break the local host on the
 * machine this is developed on. The destination here is a file the caller has
 * already planned, not a directory.
 *
 * `-f` because there is no terminal to answer a prompt about overwriting, which
 * is the entire point of the operation.
 */
export function mvArgv(from: string, to: string): string[] {
  return ["-f", "--", from, to];
}

export function chownArgv(uid: number, gid: number, path: string): string[] {
  if (uid === -1 && gid === -1) {
    throw new Error("chown needs an owner or a group; both were left unchanged.");
  }

  const spec = uid === -1 ? `:${gid}` : gid === -1 ? `${uid}` : `${uid}:${gid}`;
  // `--` because a file may legitimately be called `-R`, and without it `chmod`
  // and `chown` read the path as a flag and act on the working directory.
  return [spec, "--", path];
}
