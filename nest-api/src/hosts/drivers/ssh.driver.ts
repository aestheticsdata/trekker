import type { Readable, Writable } from "node:stream";
import type { Stats } from "ssh2";
import { DriverError, fromSftpError } from "@hosts/drivers/driver-error";
import {
  type ExecOptions,
  type ExecResult,
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
import type { HostConnectionSpec, Lease, PoolSettings, SshConnectionPool } from "@hosts/drivers/ssh-connection.pool";
import { type AllowedProgram, buildRemoteCommand, isAllowedProgram } from "@hosts/drivers/shell-quote";

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * A remote machine over SFTP, with the same surface as LocalDriver (TRE-9 §3).
 *
 * Every call borrows a slot from the pool and returns it, including on failure
 * — a leaked slot is indistinguishable from a hung host after six of them.
 */
export class SshDriver implements HostDriver {
  readonly hostId: string;

  constructor(
    private readonly spec: HostConnectionSpec,
    private readonly pool: SshConnectionPool,
    private readonly settings: Pick<PoolSettings, "operationTimeoutMs">,
  ) {
    this.hostId = spec.hostId;
  }

  /**
   * Borrow, run, release. The timeout matters as much as the release: an SFTP
   * call against a hung NFS mount never calls its callback, and without a bound
   * it holds a pool slot forever.
   */
  private async withSftp<T>(operation: (lease: Lease) => Promise<T>, path?: string): Promise<T> {
    const lease = await this.pool.acquire(this.spec);
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        operation(lease),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new DriverError("ETIMEDOUT", `Remote operation timed out${path ? `: ${path}` : ""}`, path)),
            this.settings.operationTimeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      lease.release();
    }
  }

  /**
   * SFTP v3 has no ENOTDIR, EEXIST or ENOSPC — they all arrive as FAILURE(4).
   * When a generic failure comes back, one extra stat tells us which it was.
   * Only on the error path, so the cost never touches a working request.
   */
  private async refine(error: DriverError, path: string, lease: Lease): Promise<DriverError> {
    if (error.code !== "EIO") return error;

    const info = await statOrNull(lease, path);
    if (info === null) {
      const parent = path.replace(/\/[^/]*\/?$/, "") || "/";
      const parentInfo = await statOrNull(lease, parent);
      if (parentInfo && !isDirectory(parentInfo)) {
        return new DriverError("ENOTDIR", `Not a directory: ${parent}`, parent, error.cause);
      }
      return error;
    }
    return new DriverError("EEXIST", `Already exists: ${path}`, path, error.cause);
  }

  async list(path: string): Promise<FileEntry[]> {
    return this.withSftp(async (lease) => {
      const entries = await new Promise<FileEntry[]>((resolve, reject) => {
        lease.sftp.readdir(path, (error, list) => {
          if (error) {
            reject(fromSftpError(error, path));
            return;
          }
          resolve(
            list.map((item) => {
              const attrs = item.attrs;
              const entry: FileEntry = {
                name: item.filename,
                kind: kindFromMode(attrs.mode),
                size: attrs.size,
                mode: attrs.mode & PERMISSION_MASK,
                uid: attrs.uid,
                gid: attrs.gid,
                mtimeMs: attrs.mtime * 1000,
              };
              return entry;
            }),
          );
        });
      }).catch(async (error: DriverError) => {
        throw await this.refine(error, path, lease);
      });

      // readdir reports symlinks but not their targets. Resolving them is one
      // round trip each, so it is done for symlinks only.
      await Promise.all(
        entries
          .filter((entry) => entry.kind === "symlink")
          .map(async (entry) => {
            entry.linkTarget = await readlinkOrUndefined(lease, joinPath(path, entry.name));
          }),
      );

      return entries;
    }, path);
  }

  async stat(path: string): Promise<FileStat> {
    return this.withSftp(async (lease) => {
      const attrs = await new Promise<Stats>((resolve, reject) => {
        // lstat, so a broken symlink is reported as a symlink rather than ENOENT.
        lease.sftp.lstat(path, (error, stats) => (error ? reject(fromSftpError(error, path)) : resolve(stats)));
      });

      const result: FileStat = {
        path,
        name: path.split("/").filter(Boolean).pop() ?? path,
        kind: kindFromMode(attrs.mode),
        size: attrs.size,
        mode: attrs.mode & PERMISSION_MASK,
        uid: attrs.uid,
        gid: attrs.gid,
        mtimeMs: attrs.mtime * 1000,
        // atime is the only one of the four extras SFTP v3 carries; inode and
        // nlink have no attribute in the protocol, and ctime is not sent
        // either. Left undefined rather than guessed.
        atimeMs: attrs.atime * 1000,
      };
      if (result.kind === "symlink") {
        result.linkTarget = await readlinkOrUndefined(lease, path);
      }
      return result;
    }, path);
  }

  async realpath(path: string): Promise<string> {
    return this.withSftp(
      (lease) =>
        new Promise<string>((resolve, reject) => {
          lease.sftp.realpath(path, (error, resolved) =>
            error ? reject(fromSftpError(error, path)) : resolve(resolved),
          );
        }),
      path,
    );
  }

  /**
   * The stream outlives the operation, so it holds its pool slot until it ends
   * — a read that closed its slot early would let a seventh concurrent transfer
   * start while six are still moving bytes.
   */
  async createReadStream(path: string, options: ReadOptions = {}): Promise<Readable> {
    const lease = await this.pool.acquire(this.spec);
    try {
      // The window is applied by the reader, so a ranged read moves the window
      // and not the file — which is the whole point of supporting it over a
      // link where the bytes are the expensive part.
      const stream = lease.sftp.createReadStream(path, rangeOf(options));
      holdUntilClosed(stream, lease);
      return stream;
    } catch (error) {
      lease.release();
      throw fromSftpError(error, path);
    }
  }

  async createWriteStream(path: string, options: WriteOptions = {}): Promise<Writable> {
    const lease = await this.pool.acquire(this.spec);
    try {
      const stream = lease.sftp.createWriteStream(path, {
        // The same resolution the local driver uses, from the same function.
        // ssh2 maps `EXCLUSIVE` to WRITE|CREAT|EXCL, which is the promise
        // `O_EXCL` makes on the other side: the server refuses rather than
        // truncating (TRE-69).
        flags: writeFlags(options),
        mode: options.mode ?? 0o644,
      });
      holdUntilClosed(stream, lease);
      return stream;
    } catch (error) {
      lease.release();
      throw fromSftpError(error, path);
    }
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    if (options.recursive) {
      // SFTP has no recursive mkdir; walking it here keeps the interface honest
      // rather than making every caller do this.
      const parts = path.split("/").filter(Boolean);
      let current = path.startsWith("/") ? "" : ".";
      for (const part of parts) {
        current = `${current}/${part}`;
        await this.mkdirOne(current, options.mode).catch((error: DriverError) => {
          if (error.code !== "EEXIST" && error.code !== "EIO") throw error;
        });
      }
      return;
    }
    await this.mkdirOne(path, options.mode);
  }

  private async mkdirOne(path: string, mode?: number): Promise<void> {
    return this.withSftp(async (lease) => {
      await new Promise<void>((resolve, reject) => {
        lease.sftp.mkdir(path, mode === undefined ? {} : { mode }, (error) =>
          error ? reject(fromSftpError(error, path)) : resolve(),
        );
      }).catch(async (error: DriverError) => {
        throw await this.refine(error, path, lease);
      });
    }, path);
  }

  async rename(from: string, to: string): Promise<void> {
    return this.withSftp(
      (lease) =>
        new Promise<void>((resolve, reject) => {
          lease.sftp.rename(from, to, (error) => (error ? reject(fromSftpError(error, from)) : resolve()));
        }),
      from,
    );
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this.withSftp(
      (lease) =>
        new Promise<void>((resolve, reject) => {
          lease.sftp.chmod(path, mode, (error) => (error ? reject(fromSftpError(error, path)) : resolve()));
        }),
      path,
    );
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    return this.withSftp(
      (lease) =>
        new Promise<void>((resolve, reject) => {
          lease.sftp.chown(path, uid, gid, (error) => (error ? reject(fromSftpError(error, path)) : resolve()));
        }),
      path,
    );
  }

  /**
   * SFTP v3 carries times as whole seconds — there is no sub-second field in
   * the protocol — so the millisecond precision this interface speaks in is
   * floored on the way out. A copy between two hosts therefore agrees to the
   * second, which is as much as SFTP can promise.
   */
  async utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void> {
    return this.withSftp(
      (lease) =>
        new Promise<void>((resolve, reject) => {
          lease.sftp.utimes(path, Math.floor(atimeMs / 1000), Math.floor(mtimeMs / 1000), (error) =>
            error ? reject(fromSftpError(error, path)) : resolve(),
          );
        }),
      path,
    );
  }

  async unlink(path: string): Promise<void> {
    return this.withSftp(
      (lease) =>
        new Promise<void>((resolve, reject) => {
          lease.sftp.unlink(path, (error) => (error ? reject(fromSftpError(error, path)) : resolve()));
        }),
      path,
    );
  }

  async rmdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    if (!options.recursive) {
      return this.withSftp(
        (lease) =>
          new Promise<void>((resolve, reject) => {
            lease.sftp.rmdir(path, (error) => (error ? reject(fromSftpError(error, path)) : resolve()));
          }),
        path,
      );
    }

    // Depth first, one entry at a time. There is no remote `rm -rf` here on
    // purpose: shelling out for a recursive delete is exactly the shape of
    // command this driver refuses to build.
    for (const entry of await this.list(path)) {
      const child = joinPath(path, entry.name);
      if (entry.kind === "directory") {
        await this.rmdir(child, { recursive: true });
      } else {
        await this.unlink(child);
      }
    }
    await this.rmdir(path);
  }

  /**
   * The one place a command string exists, because `ssh2.exec` takes one and
   * the remote sshd hands it to a login shell. The program is allowlisted and
   * every argument goes through the single quoting helper — see shell-quote.ts.
   */
  async exec(program: AllowedProgram, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    // Widened so the runtime guard survives type erasure — see shell-quote.ts.
    const name: string = program;
    if (!isAllowedProgram(name)) {
      throw new DriverError("EPERM", `Program "${name}" is not on the allowlist.`);
    }

    const command = buildRemoteCommand(program, args);
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const lease = await this.pool.acquire(this.spec);

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lease.release();
        fn();
      };

      const timer = setTimeout(
        () => finish(() => reject(new DriverError("ETIMEDOUT", `${program} timed out`))),
        options.timeoutMs ?? this.settings.operationTimeoutMs,
      );
      timer.unref();

      lease.client.exec(command, { env: options.cwd ? undefined : undefined }, (error, channel) => {
        if (error) {
          finish(() =>
            reject(new DriverError("EIO", `Could not start ${program}: ${error.message}`, undefined, error)),
          );
          return;
        }

        let stdout = "";
        let stderr = "";
        let code: number | null = null;
        let signal: string | null = null;

        channel.on("data", (chunk: Buffer) => {
          if (stdout.length < limit) stdout += chunk.toString("utf8");
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < limit) stderr += chunk.toString("utf8");
        });
        channel.on("exit", (exitCode: number | null, exitSignal?: string) => {
          code = exitCode;
          signal = exitSignal ?? null;
        });
        channel.on("close", () => finish(() => resolve({ code, signal, stdout, stderr })));
      });
    });
  }

  async dispose(): Promise<void> {
    // The pool owns the connection's lifetime; a driver instance is per request.
  }
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

function isDirectory(stats: Stats): boolean {
  return (stats.mode & 0o170000) === 0o040000;
}

async function statOrNull(lease: Lease, path: string): Promise<Stats | null> {
  return new Promise((resolve) => {
    lease.sftp.lstat(path, (error, stats) => resolve(error ? null : stats));
  });
}

async function readlinkOrUndefined(lease: Lease, path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    lease.sftp.readlink(path, (error, target) => resolve(error ? undefined : target));
  });
}

/** Keeps the pool slot for as long as the stream is live. */
function holdUntilClosed(stream: Readable | Writable, lease: Lease): void {
  const release = (): void => lease.release();
  stream.once("close", release);
  stream.once("error", release);
  stream.once("end", release);
}
