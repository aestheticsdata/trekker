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
}

export interface WriteOptions {
  /** Permission bits for a newly created file. */
  mode?: number;
  /** Append instead of truncating. */
  append?: boolean;
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

  createReadStream(path: string): Promise<Readable>;
  createWriteStream(path: string, options?: WriteOptions): Promise<Writable>;

  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;

  /**
   * Runs an allowlisted program with an argv array. Never a shell string from
   * the caller's point of view — see shell-quote.ts for how that is upheld on
   * the SSH side, where the protocol forces a string.
   */
  exec(program: AllowedProgram, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;

  /** Releases anything the driver holds. The local driver holds nothing. */
  dispose(): Promise<void>;
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
