import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  constants as FS,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { chmod, chown } from "node:fs/promises";
import { setPriority } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { DriverError, fromNodeError } from "@hosts/drivers/driver-error";
import { openStdin, sendStdin } from "@hosts/drivers/exec-stdin";
import {
  type ExecOptions,
  type ExecResult,
  type ExecStream,
  type ExecStreamOptions,
  type ExecStreamResult,
  type FileEntry,
  type FileStat,
  type HostDriver,
  kindFromMode,
  type MkdirOptions,
  PERMISSION_MASK,
  rangeOf,
  type ReadOptions,
  writeFlags,
  type WriteOptions,
} from "@hosts/drivers/host-driver";
import {
  type AllowedProgram,
  isAllowedProgram,
  isSudoOnlyProgram,
  type SudoMode,
  type SudoOnlyProgram,
} from "@hosts/drivers/shell-quote";

/**
 * What `assertReadable` asks `access` about. Its own name because the answer
 * it gives is the whole difference between a refusal at open time and an
 * `ErrnoException` escaping the driver from inside a stream.
 */
export const LOCAL_READ_FLAGS = FS.R_OK;

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * How much of a streamed command's stderr is kept.
 *
 * `du /` prints a permission denial per unreadable directory and there can be
 * thousands. The head is what says *what kind* of thing went wrong, which is
 * all any caller does with it; the rest is the same sentence again.
 */
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/**
 * The machine the API runs on, reached through `node:fs` (TRE-9).
 *
 * It runs as whatever unix user the API runs as, and that is the ceiling on
 * what it can see. EACCES is surfaced as a real state rather than swallowed
 * into an empty directory — "you cannot read this" and "this is empty" are
 * different facts and the UI shows them differently.
 */
export class LocalDriver implements HostDriver {
  constructor(readonly hostId: string) {}

  async list(path: string): Promise<FileEntry[]> {
    let names: string[];
    try {
      names = await readdir(path);
    } catch (error) {
      throw fromNodeError(error, path);
    }

    // lstat, not stat: a broken symlink must still appear in the listing rather
    // than making the whole directory unreadable.
    const entries = await Promise.all(names.map((name) => this.entryFor(path, name)));
    return entries.filter((entry): entry is FileEntry => entry !== null);
  }

  private async entryFor(directory: string, name: string): Promise<FileEntry | null> {
    const full = join(directory, name);
    try {
      const info = await lstat(full);
      const entry: FileEntry = {
        name,
        kind: kindFromMode(info.mode),
        size: info.size,
        mode: info.mode & PERMISSION_MASK,
        uid: info.uid,
        gid: info.gid,
        mtimeMs: info.mtimeMs,
      };

      if (entry.kind === "symlink") {
        entry.linkTarget = await readlink(full).catch(() => undefined);
      }
      return entry;
    } catch {
      // The entry vanished between readdir and lstat, or we cannot stat it.
      // Dropping one row beats failing the whole listing.
      return null;
    }
  }

  async stat(path: string): Promise<FileStat> {
    try {
      const info = await lstat(path);
      const result: FileStat = {
        path,
        name: path.split("/").pop() ?? path,
        kind: kindFromMode(info.mode),
        size: info.size,
        mode: info.mode & PERMISSION_MASK,
        uid: info.uid,
        gid: info.gid,
        mtimeMs: info.mtimeMs,
        inode: Number(info.ino),
        nlink: info.nlink,
        atimeMs: info.atimeMs,
        ctimeMs: info.ctimeMs,
      };
      if (result.kind === "symlink") {
        result.linkTarget = await readlink(path).catch(() => undefined);
      }
      return result;
    } catch (error) {
      throw fromNodeError(error, path);
    }
  }

  async realpath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch (error) {
      throw fromNodeError(error, path);
    }
  }

  async createReadStream(path: string, options: ReadOptions = {}): Promise<Readable> {
    // Opened eagerly so a missing or unreadable file is a rejected promise
    // rather than an 'error' event the caller has to remember to attach to.
    await this.assertReadable(path);
    return createReadStream(path, rangeOf(options));
  }

  /**
   * That the file is there, is not a directory, and can actually be opened.
   *
   * The third check was missing until TRE-23 and the gap had teeth: `stat`
   * succeeds on a file whose mode is `0o000` — statting needs permission on the
   * *directory*, not on the file — so the eager open this method exists to
   * perform was not eager at all for the one failure it matters most for. The
   * EACCES surfaced later, from inside the stream, as a raw
   * `NodeJS.ErrnoException` that never went through `fromNodeError`. Callers
   * above the driver are promised they will never see one of those, and a
   * transfer that met it reported "The host refused" instead of naming the
   * permission.
   *
   * `access(R_OK)` answers the question the caller is actually asking. It is
   * checked against the real uid, which is the account the API runs as and the
   * one that will do the reading.
   */
  private async assertReadable(path: string): Promise<void> {
    try {
      const info = await stat(path);
      if (info.isDirectory()) {
        throw new DriverError("EISDIR", `Is a directory: ${path}`, path);
      }
      await access(path, LOCAL_READ_FLAGS);
    } catch (error) {
      throw error instanceof DriverError ? error : fromNodeError(error, path);
    }
  }

  createWriteStream(path: string, options: WriteOptions = {}): Promise<Writable> {
    // Not async: node's createWriteStream opens lazily, so there is nothing to
    // await. The interface stays a promise because the SSH side needs one.
    return Promise.resolve(
      createWriteStream(path, {
        // Resolved by the interface both drivers implement, so the two cannot
        // disagree about what `exclusive` means. `EXCLUSIVE` is O_CREAT|O_EXCL:
        // the open fails rather than truncating what is already there (TRE-69),
        // and because the stream opens lazily that refusal arrives as an
        // `error` event rather than as a rejection here.
        flags: writeFlags(options),
        mode: options.mode ?? 0o644,
      }),
    );
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    try {
      await mkdir(path, { recursive: options.recursive ?? false, mode: options.mode });
    } catch (error) {
      throw fromNodeError(error, path);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch (error) {
      throw fromNodeError(error, from);
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    try {
      await chmod(path, mode);
    } catch (error) {
      throw fromNodeError(error, path);
    }
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    try {
      await chown(path, uid, gid);
    } catch (error) {
      throw fromNodeError(error, path);
    }
  }

  /**
   * `Date` objects rather than seconds: node accepts both, and a number here is
   * read as seconds — passing milliseconds would stamp files in the year 56000
   * with no error to notice.
   */
  async utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void> {
    try {
      await utimes(path, new Date(atimeMs), new Date(mtimeMs));
    } catch (error) {
      throw fromNodeError(error, path);
    }
  }

  async unlink(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      throw fromNodeError(error, path);
    }
  }

  async rmdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    try {
      if (options.recursive) {
        await rm(path, { recursive: true, force: false });
      } else {
        await rmdir(path);
      }
    } catch (error) {
      throw fromNodeError(error, path);
    }
  }

  /**
   * `execFile`, never `exec`: no shell is spawned, so the argv array is passed
   * to the program verbatim. A `$(...)` in an argument is eight characters, not
   * a subshell.
   */
  async exec(
    program: AllowedProgram | SudoOnlyProgram,
    args: readonly string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    // Widened so the runtime guard survives type erasure — see shell-quote.ts.
    const name: string = program;
    const sudo = options.sudo !== undefined;
    if (!(isAllowedProgram(name) || (sudo && isSudoOnlyProgram(name)))) {
      throw new DriverError(
        "EPERM",
        isSudoOnlyProgram(name)
          ? `Program "${name}" is on the sudo allowlist only and needs sudo to run.`
          : `Program "${name}" is not on the allowlist.`,
      );
    }

    // The local equivalent of the remote prefix, and a literal for the same
    // reason: `sudo` is written here, never named by a caller. There is no
    // shell either way, so the real program stays an element of the argv array
    // rather than a word in a string.
    const binary = sudo ? "sudo" : program;
    const argv = sudo ? [...sudoFlags(options.sudo), program, ...args] : [...args];

    return new Promise<ExecResult>((resolve, reject) => {
      const child = execFile(
        binary,
        argv,
        {
          timeout: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
          maxBuffer: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          cwd: options.cwd,
          encoding: "utf8",
          // Belt and braces: even if someone changes execFile to exec, there is
          // no shell configured to interpret anything.
          shell: false,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ code: 0, signal: null, stdout, stderr });
            return;
          }

          const failure = error as NodeJS.ErrnoException & {
            code?: number | string;
            signal?: string;
            killed?: boolean;
          };
          if (failure.killed || failure.signal === "SIGTERM") {
            reject(new DriverError("ETIMEDOUT", `${program} timed out`, undefined, error));
            return;
          }
          if (failure.code === "ENOENT") {
            reject(new DriverError("ENOENT", `${program} is not installed on this host`, undefined, error));
            return;
          }
          if (failure.code === "EACCES") {
            reject(new DriverError("EACCES", `Not permitted to run ${program}`, undefined, error));
            return;
          }

          // A non-zero exit is a result, not a failure: `du` on an unreadable
          // subtree exits 1 and still prints everything it could read.
          resolve({
            code: typeof failure.code === "number" ? failure.code : 1,
            signal: failure.signal ?? null,
            stdout,
            stderr,
          });
        },
      );

      deprioritise(child.pid, options.nice);
      sendStdin(child.stdin, options.stdin);
    });
  }

  /**
   * The streaming form (TRE-32). `spawn`, for the same reason `exec` uses
   * `execFile`: an argv array and no shell anywhere.
   *
   * Three things differ from `exec` above, each of them the point:
   *
   * **No `maxBuffer`.** Nothing is collected, so there is nothing to overflow —
   * which also removes the conflation above, where a buffer overrun and a
   * timeout both arrive as `killed` and both report as `ETIMEDOUT`.
   *
   * **No default timeout.** A scan is minutes. The caller's `AbortSignal` is
   * what stops it, and a driver-level ceiling would be a number chosen by
   * somebody thinking about `stat`.
   *
   * **`close`, not `exit`.** `exit` fires when the process goes; `close` fires
   * when its pipes have ended, which is the first moment the last record has
   * certainly been read.
   */
  execStream(
    program: AllowedProgram | SudoOnlyProgram,
    args: readonly string[],
    options: ExecStreamOptions = {},
  ): Promise<ExecStream> {
    // Widened so the runtime guard survives type erasure — see shell-quote.ts.
    const name: string = program;
    const sudo = options.sudo !== undefined;
    if (!(isAllowedProgram(name) || (sudo && isSudoOnlyProgram(name)))) {
      return Promise.reject(
        new DriverError(
          "EPERM",
          isSudoOnlyProgram(name)
            ? `Program "${name}" is on the sudo allowlist only and needs sudo to run.`
            : `Program "${name}" is not on the allowlist.`,
        ),
      );
    }
    // `spawn` with an already-aborted signal produces a child that never runs
    // and an AbortError on a listener nobody has attached yet. Refusing here is
    // the same answer, said in the vocabulary above this line.
    if (options.signal?.aborted) {
      return Promise.reject(new DriverError("EIO", `${program} was cancelled before it started`));
    }

    // Piped only when something will be written. `"ignore"` gives the child
    // /dev/null, which already reads as an immediate EOF — so the default stays
    // exactly what it was for every caller that predates TRE-29.
    // stdin piped and then closed immediately, always. It used to be `"ignore"`,
    // which hands the child /dev/null — and an immediately-closed pipe is the
    // same EOF, so nothing changes for `du` and the rest. Keeping it one shape
    // avoids a conditional stdio tuple, which node's overloads answer by typing
    // every stream as possibly null.
    const child = spawn(sudo ? "sudo" : program, sudo ? [...sudoFlags(options.sudo), program, ...args] : [...args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
      killSignal: "SIGTERM",
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });

    deprioritise(child.pid, options.nice);
    // Either the driver closes it, or the caller does — never neither.
    if (options.stdinOpen === true) openStdin(child.stdin, options.stdin);
    else sendStdin(child.stdin, options.stdin);

    const stdout = child.stdout;
    const stderrLimit = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    let stderr = "";
    let stderrTruncated = false;

    // Drained whether the caller looks at it or not. An unread pipe fills its
    // kernel buffer and the child blocks writing to it — with stdout still
    // flowing, that is a walk which stops partway through for no visible
    // reason.
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length >= stderrLimit) {
        stderrTruncated = true;
        return;
      }
      stderr += chunk.toString("utf8");
    });

    const done = new Promise<ExecStreamResult>((resolve, reject) => {
      let failure: DriverError | null = null;

      // ENOENT and EACCES arrive here rather than in a callback, because there
      // is no callback. An aborted spawn also lands here as an AbortError,
      // which is not a failure to report: the caller asked for it, and `close`
      // still follows with the real exit.
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.name === "AbortError") return;
        if (error.code === "ENOENT") {
          failure = new DriverError("ENOENT", `${program} is not installed on this host`, undefined, error);
          return;
        }
        if (error.code === "EACCES") {
          failure = new DriverError("EACCES", `Not permitted to run ${program}`, undefined, error);
          return;
        }
        failure = new DriverError("EIO", `Could not run ${program}: ${error.message}`, undefined, error);
      });

      child.on("close", (code, signal) => {
        if (failure) {
          reject(failure);
          return;
        }
        resolve({ code, signal, stderr, stderrTruncated });
      });
    });

    return Promise.resolve(options.stdinOpen === true ? { stdout, done, stdin: child.stdin } : { stdout, done });
  }

  async dispose(): Promise<void> {
    // Nothing held open.
  }
}

/**
 * Lower a child's priority, best effort (TRE-32).
 *
 * `os.setPriority` rather than an `execFile("nice", …)`: locally there is no
 * shell to prefix, `nice` is not an allowlisted program and must not become
 * one, and a syscall needs neither. See shell-quote.ts, which does the same job
 * for the remote side where a string is unavoidable.
 *
 * Swallowed on failure, deliberately. A kernel that refuses the change, a
 * process that has already exited, a platform with no notion of niceness — none
 * of those is a reason to fail a `du` that is otherwise about to run correctly.
 * The scan records whether it was niced; it does not depend on it.
 */
/**
 * The sudo flags, as an argv fragment (TRE-29).
 *
 * The local mirror of what `buildRemoteCommand` writes into a string, and it
 * has to stay in step with it: a probe that asked the remote host one question
 * and the local host another would report two different kinds of machine for
 * the same configuration. `sudo` itself is a literal in both, never a name a
 * caller supplies.
 */
function sudoFlags(mode: SudoMode | undefined): string[] {
  return mode === "probe" ? ["-n"] : ["-S", "-p", ""];
}

function deprioritise(pid: number | undefined, nice: number | undefined): void {
  if (nice === undefined || pid === undefined) return;
  try {
    setPriority(pid, nice);
  } catch {
    // Best effort, and the caller is told by `niced` on the row.
  }
}
