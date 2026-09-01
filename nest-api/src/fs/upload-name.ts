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
 * One segment, made safe. The rule both callers share.
 *
 * The order is the whole function, and each step has to come after the one
 * before it or it checks the wrong string:
 *
 *   substitute — every character that is not on the allowlist becomes `_`
 *   truncate   — before the checks, so 300 dots do not pass by being long
 *   trim       — `" .. "` is `..` with camouflage, and only trimming shows it
 *   refuse     — a leading dot is fine (dotfiles are ordinary); nothing but
 *                dots is not, because that is `.` or `..` or a name no
 *                listing can distinguish from them
 */
function safeSegment(raw: string): string {
  const truncated = raw.replace(SAFE, "_").slice(0, 255).trim();
  return /^\.+$/.test(truncated) ? NO_NAME : truncated;
}

/** How deep a folder upload may recreate. */
const MAX_DEPTH = 32;

/** And how long the whole relative path may be once joined. */
const MAX_LENGTH = 4096;

export interface RelativeUpload {
  /** Directories to create under the destination, outermost first. */
  readonly directories: readonly string[];
  /** What the file is called inside them. */
  readonly name: string;
}

/**
 * A whole relative path, made safe — the folder upload's version of the
 * function above (TRE-126).
 *
 * This replaced a `safeFilename` that threw the path away and kept the last
 * segment. That was exactly right while a client could only send one file and
 * exactly wrong once it can send a tree: `photos/2019/a.jpg` has to stay three
 * things, and `../a.jpg` must not quietly become `a.jpg`.
 *
 * Every segment goes through the same `safeSegment` as a bare filename, so a
 * path cannot smuggle through a character a name could not. What it adds is the
 * refusal: **any** segment that reduces to nothing takes the whole path with
 * it. Dropping the bad segment instead would quietly relocate the file — a
 * `..` in the middle would land it one directory up from where the client said,
 * which is the traversal this file exists to prevent, arriving by way of a
 * repair rather than a hole.
 *
 * Traversal is therefore not a case handled here so much as one that cannot be
 * constructed: no segment survives as `..`, and none can contain a separator.
 * The path guard still runs on the joined directory, because a segment that is
 * a **symlink** on the host is a way out of the roots that no amount of string
 * work can see.
 */
export function safeRelativePath(raw: string): RelativeUpload | null {
  // A relative path is relative. `/etc/passwd` reaching here is a client that
  // has been told what to send and sent something else, and the honest answer
  // is to refuse it rather than to quietly reinterpret it as `etc/passwd`
  // underneath the destination. A drive letter is the same claim in the other
  // dialect, and would otherwise become four directories called `C_`, `Users`
  // and so on.
  if (/^[\\/]/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return null;

  const segments = raw.split(/[\\/]/).filter(Boolean).map(safeSegment);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === NO_NAME)) return null;

  const directories = segments.slice(0, -1);
  if (directories.length > MAX_DEPTH) return null;
  if (segments.join("/").length > MAX_LENGTH) return null;

  return { directories, name: segments[segments.length - 1] };
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
 * Leading dot so it is hidden from a listing, and `.part` so anything that
 * finds one knows what it is.
 *
 * The middle is the caller's, and which caller it is decides everything about
 * the file's life. An ordinary upload passes random bytes: nothing can name
 * that file again, so it is removed when the attempt ends, and two uploads of
 * one name at one moment cannot write over each other. A resumable upload
 * passes `resumeToken`, which is derived from the file — so the same file
 * offered twice names the same partial, which is the whole of how TRE-142
 * continues rather than restarts, and why the sweep exists.
 */
export function partialName(token: string): string {
  return `${PARTIAL_PREFIX}${token}${PARTIAL_SUFFIX}`;
}

const PARTIAL_PREFIX = ".trekker-";
const PARTIAL_SUFFIX = ".part";

/**
 * Whether a listing entry is one of ours (TRE-142).
 *
 * Since TRE-142 a partial outlives the attempt that made it, so that a second
 * attempt can continue where the first stopped. That is only safe paired with
 * something that takes away the ones nobody comes back for, and this is what
 * that sweep recognises.
 *
 * Deliberately narrow. It matches the shape this file writes and nothing else,
 * because the sweep it feeds *deletes*, and a predicate that also matched
 * `.partial` or `.trekker-notes` would be a data-loss bug wearing a tidying
 * function's clothes.
 */
export function isPartialName(name: string): boolean {
  return (
    name.startsWith(PARTIAL_PREFIX) &&
    name.endsWith(PARTIAL_SUFFIX) &&
    name.length > PARTIAL_PREFIX.length + PARTIAL_SUFFIX.length
  );
}
