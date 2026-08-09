import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
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
} from "node:fs/promises";
import { chmod, chown } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { DriverError, fromNodeError } from "@hosts/drivers/driver-error";
import {
  type ExecOptions,
  type ExecResult,
  type FileEntry,
  type FileStat,
  type HostDriver,
  kindFromMode,
  type MkdirOptions,
  PERMISSION_MASK,
  type WriteOptions,
} from "@hosts/drivers/host-driver";
import { type AllowedProgram, isAllowedProgram } from "@hosts/drivers/shell-quote";

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

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

  async createReadStream(path: string): Promise<Readable> {
    // Opened eagerly so a missing or unreadable file is a rejected promise
    // rather than an 'error' event the caller has to remember to attach to.
    await this.assertReadable(path);
    return createReadStream(path);
  }

  private async assertReadable(path: string): Promise<void> {
    try {
      const info = await stat(path);
      if (info.isDirectory()) {
        throw new DriverError("EISDIR", `Is a directory: ${path}`, path);
      }
    } catch (error) {
      throw error instanceof DriverError ? error : fromNodeError(error, path);
    }
  }

  createWriteStream(path: string, options: WriteOptions = {}): Promise<Writable> {
    // Not async: node's createWriteStream opens lazily, so there is nothing to
    // await. The interface stays a promise because the SSH side needs one.
    return Promise.resolve(
      createWriteStream(path, {
        flags: options.append ? "a" : "w",
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
  async exec(program: AllowedProgram, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    // Widened so the runtime guard survives type erasure — see shell-quote.ts.
    const name: string = program;
    if (!isAllowedProgram(name)) {
      throw new DriverError("EPERM", `Program "${name}" is not on the allowlist.`);
    }

    return new Promise<ExecResult>((resolve, reject) => {
      execFile(
        program,
        [...args],
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
    });
  }

  async dispose(): Promise<void> {
    // Nothing held open.
  }
}

export const LOCAL_READ_FLAGS = FS.R_OK;
