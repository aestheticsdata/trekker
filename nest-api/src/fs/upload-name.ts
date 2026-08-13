/**
 * What an uploaded file is allowed to be called (TRE-65).
 *
 * Pure, and its own file for the same reason `download-headers.ts` is: this is
 * the one string in an upload the server did not choose, and it decides a path
 * on somebody else's machine. `../../etc/cron.d/x` arriving as a filename is
 * the whole attack, and it is a string problem — so it is solved here, where it
 * can be tested exhaustively without a filesystem.
 *
 * The path guard is still the authority and still runs: this narrows the name
 * before it is ever joined to a directory, so the guard is never asked to
 * adjudicate something that should not have been built.
 */

/** A name with nothing left. Never silently used — the caller refuses instead. */
export const NO_NAME = "";

/**
 * Characters a filename may keep.
 *
 * An allowlist. The dangerous ones are `/` and the `..` pair, but a name
 * carrying a newline, a NUL or a shell metacharacter is a name that goes wrong
 * somewhere downstream — in a log line, in an `ls` someone pastes, in the one
 * place a path does reach a shell. Nothing is lost that a person will miss.
 */
const SAFE = /[^\p{L}\p{N}._ ()[\]#@+,'-]/gu;

/**
 * The last segment of whatever the client sent, made safe.
 *
 * Browsers send a bare filename in `filename=`, but a directory upload sends
 * `webkitRelativePath` in some clients and `curl` sends whatever it is told, so
 * the separators are stripped rather than trusted absent. Both separators: a
 * Windows client sends backslashes and a POSIX host would keep them as part of
 * the name.
 */
export function safeFilename(raw: string): string {
  const last = raw.split(/[\\/]/).filter(Boolean).at(-1) ?? "";

  // The order is the whole function, and each step has to come after the one
  // before it or it checks the wrong string:
  //
  //   substitute — every character that is not on the allowlist becomes `_`
  //   truncate   — before the checks, so 300 dots do not pass by being long
  //   trim       — `" .. "` is `..` with camouflage, and only trimming shows it
  //   refuse     — a leading dot is fine (dotfiles are ordinary); nothing but
  //                dots is not, because that is `.` or `..` or a name no
  //                listing can distinguish from them
  const truncated = last.replace(SAFE, "_").slice(0, 255).trim();
  return /^\.+$/.test(truncated) ? NO_NAME : truncated;
}

/**
 * `report.txt` → `report (2).txt`, for the "keep both" conflict answer.
 *
 * The suffix goes before the extension, which is what every desktop does and
 * what keeps the file openable by whatever opens that extension. A dotfile has
 * no extension to sit before — `.bashrc (2)` is right and `.bashrc (2)rc` is
 * not — so the split deliberately ignores a leading dot.
 */
export function numberedName(name: string, attempt: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} (${attempt})`;
  return `${name.slice(0, dot)} (${attempt})${name.slice(dot)}`;
}

/**
 * The name a partial upload is written under.
 *
 * In the destination directory, not in a temp directory of the API's: the
 * rename that follows has to be on the same filesystem to be atomic, and
 * `/tmp` on the API host is not even on the same *machine* as a remote
 * destination. This is the whole reason the ticket asks for a temporary name
 * rather than a temporary file.
 *
 * Leading dot so it is hidden from a listing, `.part` so anything that finds
 * one knows what it is, and the random middle so two uploads of the same name
 * at the same moment do not write over each other.
 */
export function partialName(token: string): string {
  return `.trekker-${token}.part`;
}
