import type { Readable, Writable } from "node:stream";
import type { AllowedProgram } from "@hosts/drivers/shell-quote";

/**
 * One interface, two implementations (TRE-9). This is the structural decision
 * of the project: everything above it is written once, so a pane bound to the
 * local host and a pane bound to a remote host are the same component, and a
 * cross-host copy is `src.createReadStream() → dst.createWriteStream()` with no
 * branch for "is one of these local".
 *
 * The driver executes what it is given. Deciding whether a path is *allowed*
 * belongs to TRE-11, one layer up — a driver that also policed paths would be
 * a driver you cannot reuse for the transfer engine's internal moves.
 */

export type FileKind = "file" | "directory" | "symlink" | "block" | "character" | "fifo" | "socket" | "unknown";

export interface FileEntry {
  name: string;
  kind: FileKind;
  size: number;
  /** Permission bits only, already masked — 0o755, not the raw st_mode. */
  mode: number;
  uid: number;
  gid: number;
  mtimeMs: number;
  /** Present only for symlinks, and only when the driver could read it. */
  linkTarget?: string;
}

export interface FileStat extends FileEntry {
  /** Absolute path this stat describes. */
  path: string;

  /**
   * The inspector's extra fields (TRE-13 §4). Optional because SFTP v3 has no
   * attribute for an inode or a link count — a remote host simply does not
   * report them, and the panel shows what it has rather than inventing a zero.
   */
  inode?: number;
  nlink?: number;
  atimeMs?: number;
  /** Inode change time. Not a creation time — nothing POSIX gives us is. */
  ctimeMs?: number;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Kill the command after this many ms. Defaults to the driver's setting. */
  timeoutMs?: number;
  /** Truncate captured output at this many bytes. `du /` is not a small string. */
  maxOutputBytes?: number;
  cwd?: string;
  /**
   * Run it de-prioritised, 0–19 (TRE-32). Rendered as a `nice` prefix over SSH
   * and applied with `os.setPriority` locally — see shell-quote.ts for why the
   * prefix is not an allowlist entry.
   */
  nice?: number;
}

/**
 * A command whose output is read as it arrives rather than collected (TRE-32).
 *
 * `exec` above is the right shape for `df`: a short answer, wanted whole. It is
 * the wrong shape for a `du` of a filesystem, which runs for minutes and prints
 * hundreds of megabytes — buffering that means holding all of it in a string to
 * hand back at the end, so there is no progress to report until there is
 * nothing left to report, and no way to stop it.
 */
export interface ExecStreamOptions {
  /**
   * Stops the command. There is deliberately no default timeout: a scan of a
   * few terabytes is minutes, and a driver-level ceiling would kill it at a
   * number chosen by somebody thinking about `stat`.
   */
  signal?: AbortSignal;
  /** As `ExecOptions.nice`. */
  nice?: number;
  /** Ceiling on the stderr the driver keeps. `stdout` is never buffered. */
  maxStderrBytes?: number;
  /** A ceiling for callers that do want one. Absent means none. */
  timeoutMs?: number;
}

export interface ExecStreamResult {
  code: number | null;
  signal: string | null;
  /** The head of stderr, capped. Drained by the driver whether you read it or not. */
  stderr: string;
  stderrTruncated: boolean;
}

export interface ExecStream {
  /**
   * Backpressured: stop reading and the command stops producing, which is the
   * point — a parser that falls behind must slow the walk down rather than let
   * the process buffer a filesystem's worth of records on its behalf.
   */
  stdout: Readable;
  /**
   * Settles when the process or channel has closed, never merely when it
   * exited: exit can arrive before the last bytes do.
   */
  done: Promise<ExecStreamResult>;
}

export interface WriteOptions {
  /** Permission bits for a newly created file. */
  mode?: number;
  /** Append instead of truncating. */
  append?: boolean;
  /**
   * Fail if the path already exists, rather than truncating it (TRE-69).
   *
   * Both drivers resolved this interface to `flags: append ? "a" : "w"` until
   * TRE-69, and `"w"` is `O_CREAT|O_TRUNC`: a route that meant "make an empty
   * file called config.yml" would have *emptied* the config.yml already there,
   * successfully and with nothing to notice. On a host reached over SSH that is
   * unrecoverable, so the flag exists rather than a check before the open —
   * a check is a race and `O_EXCL` is not.
   *
   * Ignored when `append` is set; the two ask for opposite things and appending
   * to a file that must not exist is not a request anything here makes.
   */
  exclusive?: boolean;
}

/**
 * A byte window, for HTTP range requests (TRE-26 §1).
 *
 * `end` is **inclusive**, which is what `node:fs` and ssh2's SFTP both mean by
 * it and also what `Range: bytes=0-99` means. Three definitions that agree is
 * worth more than one that reads more naturally, because the off-by-one here
 * shows up as a resumed download that is one byte short and nothing says so.
 *
 * Both drivers implement this natively — the range is applied by the reader, so
 * a ranged read over SFTP transfers the requested window and not the file.
 */
export interface ReadOptions {
  /** First byte, inclusive. */
  start?: number;
  /** Last byte, inclusive. Absent means "to the end". */
  end?: number;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

export interface HostDriver {
  readonly hostId: string;

  list(path: string): Promise<FileEntry[]>;
  stat(path: string): Promise<FileStat>;
  /** Resolves symlinks and `..` to an absolute real path. TRE-11 depends on this. */
  realpath(path: string): Promise<string>;

  createReadStream(path: string, options?: ReadOptions): Promise<Readable>;
  createWriteStream(path: string, options?: WriteOptions): Promise<Writable>;

  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  /**
   * Access and modification times, in milliseconds — the unit everything else
   * on this interface uses, converted per driver rather than at each call site.
   *
   * Added for TRE-23, which has to preserve an mtime across a copy. It is the
   * one attribute a stream cannot carry: the bytes arrive identical and the
   * file is stamped with the moment they landed, so a directory copied to a
   * backup host looks entirely new and every "what changed" question about it
   * answers wrong from then on.
   */
  utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;

  /**
   * Runs an allowlisted program with an argv array. Never a shell string from
   * the caller's point of view — see shell-quote.ts for how that is upheld on
   * the SSH side, where the protocol forces a string.
   */
  exec(program: AllowedProgram, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;

  /**
   * The same, read as it arrives (TRE-32). Same allowlist, same quoting.
   *
   * Optional because it is needed by one caller and implementing it is real
   * work: a test double standing in for a driver should not have to grow a
   * channel lifecycle to keep compiling. Callers check for it and say so when
   * a driver cannot stream, rather than assuming.
   */
  execStream?(program: AllowedProgram, args: readonly string[], options?: ExecStreamOptions): Promise<ExecStream>;

  /** Releases anything the driver holds. The local driver holds nothing. */
  dispose(): Promise<void>;
}

/**
 * The three ways a file may be opened for writing, named.
 *
 * `node:fs` and ssh2 both take the same POSIX-ish flag strings, which is the
 * only reason one table can serve both — and the whole of the difference
 * between them is one character in a string literal. `"w"` truncates and
 * `"wx"` refuses; a typo between the two is a file emptied on somebody else's
 * machine with nothing in the response to say so.
 */
export const OPEN_FLAGS = {
  /** Create it, and empty it if it is already there. */
  TRUNCATE: "w",
  /** Create it, and fail if it is already there — `O_EXCL` (TRE-69). */
  EXCLUSIVE: "wx",
  /** Create it, and write past whatever is already in it. */
  APPEND: "a",
} as const;

/**
 * `WriteOptions` as the two stream constructors want it — the sibling of
 * `rangeOf` below, and here for the same reason.
 *
 * Both drivers resolve the same options object, so the resolution is done once
 * rather than written out twice: two copies of this expression are two places
 * for `exclusive` to be forgotten, and the transport where it is forgotten is
 * the transport that quietly truncates.
 *
 * `append` wins over `exclusive`. They ask for opposite things — one keeps what
 * is there, the other insists nothing is — and nothing in this application ever
 * sets both; the order is stated so that a caller which somehow does gets the
 * conservative half.
 */
export type WriteFlag = (typeof OPEN_FLAGS)[keyof typeof OPEN_FLAGS];

// Narrowed to the three literals rather than widened to `string`, because that
// is what ssh2's own `OpenMode` is: a `string` here compiles on the local side
// and fails on the remote one, which is the wrong half to find out from.
export function writeFlags(options: WriteOptions): WriteFlag {
  if (options.append) return OPEN_FLAGS.APPEND;
  return options.exclusive ? OPEN_FLAGS.EXCLUSIVE : OPEN_FLAGS.TRUNCATE;
}

/**
 * `ReadOptions` as the two stream constructors want it.
 *
 * Keys are omitted rather than set to `undefined`: both `node:fs` and ssh2 read
 * `options.start` with a `typeof`/`!= null` test in some places and a plain
 * truthiness test in others, and a present-but-undefined key has been read as a
 * zero often enough to be worth not finding out again.
 */
export function rangeOf(options: ReadOptions): { start?: number; end?: number } {
  return {
    ...(options.start === undefined ? {} : { start: options.start }),
    ...(options.end === undefined ? {} : { end: options.end }),
  };
}

/** Raw permission bits from a st_mode, e.g. 0o100644 → 0o644. */
export const PERMISSION_MASK = 0o7777;

export function kindFromMode(mode: number): FileKind {
  switch (mode & 0o170000) {
    case 0o100000:
      return "file";
    case 0o040000:
      return "directory";
    case 0o120000:
      return "symlink";
    case 0o060000:
      return "block";
    case 0o020000:
      return "character";
    case 0o010000:
      return "fifo";
    case 0o140000:
      return "socket";
    default:
      return "unknown";
  }
}
