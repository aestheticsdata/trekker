import type { Readable, Writable } from "node:stream";
import type { ClientChannel, Stats } from "ssh2";
import { DriverError, fromSftpError } from "@hosts/drivers/driver-error";
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
import type { HostConnectionSpec, Lease, PoolSettings, SshConnectionPool } from "@hosts/drivers/ssh-connection.pool";
import {
  type AllowedProgram,
  buildRemoteCommand,
  isAllowedProgram,
  isSudoOnlyProgram,
  type SudoOnlyProgram,
} from "@hosts/drivers/shell-quote";

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** As LocalDriver's: the head of stderr says what kind of thing went wrong. */
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/**
 * How long a cancelled command is given to close its channel before the lease
 * is taken back anyway.
 *
 * The remote process dies of SIGPIPE the next time it writes to a closed
 * channel, which for a command that prints steadily is immediate. Three seconds
 * is for the one that does not — and the slot matters more than the tidiness of
 * waiting, because a lease held by a channel nobody is reading is a slot the
 * next pane queues behind forever.
 */
const KILL_GRACE_MS = 3_000;

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

    const command = buildRemoteCommand(program, args, { nice: options.nice, sudo: options.sudo });
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

        // Standard input, then EOF — the same contract the local driver keeps,
        // through the same function so the two cannot drift. The channel is a
        // duplex stream: closing the write side sends EOF to the remote
        // program's stdin and leaves its output coming back untouched.
        //
        // Attached last on purpose. The listeners above are what settle this
        // promise, and a command that exits the instant it reads its input has
        // to find them already in place.
        sendStdin(channel, options.stdin);
      });
    });
  }

  /**
   * The streaming form (TRE-32). Same allowlist, same quoting, one channel held
   * for as long as the command runs.
   *
   * **The channel is the stream.** ssh2's Channel is a Duplex whose receive
   * window is only re-opened from `_read`, so a caller that stops reading
   * genuinely stops the remote process rather than letting it buffer a
   * filesystem's worth of records into this one's memory.
   *
   * **stderr is drained here and never handed out.** ssh2 shares one drain flag
   * between a channel's stdout and its stderr: an unread stderr latches it, the
   * window is never re-adjusted, and *stdout stops too*. `du /` prints a
   * permission denial per unreadable directory, so leaving that to the caller
   * is a stall waiting to happen. The driver keeps the head and drops the rest.
   *
   * **The lease is released on `close`, never on `exit`.** `exit` can arrive
   * before the final data does, and on some paths never arrives at all — which
   * is also why a `close` with no `exit` is reported as a failure here rather
   * than as a successful command with no exit code. That combination means the
   * connection went away underneath a running command, and calling it success
   * would hand the caller a truncated walk labelled complete.
   */
  async execStream(
    program: AllowedProgram | SudoOnlyProgram,
    args: readonly string[],
    options: ExecStreamOptions = {},
  ): Promise<ExecStream> {
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
    if (options.signal?.aborted) {
      throw new DriverError("EIO", `${program} was cancelled before it started`);
    }

    const command = buildRemoteCommand(program, args, { nice: options.nice, sudo: options.sudo });
    const stderrLimit = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    const lease = await this.pool.acquire(this.spec, { background: true });

    let channel: Awaited<ReturnType<typeof openChannel>>;
    try {
      channel = await openChannel(lease, command, program);
    } catch (error) {
      lease.release();
      throw error;
    }

    let stderr = "";
    let stderrTruncated = false;
    channel.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length >= stderrLimit) {
        stderrTruncated = true;
        return;
      }
      stderr += chunk.toString("utf8");
    });

    // The password, then EOF — the same contract `exec` keeps, through the same
    // function. Closing the write side leaves the output coming back untouched,
    // which is the whole reason a `cat` of a large file can stream through here
    // rather than being collected into a string first.
    // Either the driver closes it, or the caller does — never neither.
    if (options.stdinOpen === true) openStdin(channel, options.stdin);
    else sendStdin(channel, options.stdin);

    const done = new Promise<ExecStreamResult>((resolve, reject) => {
      let settled = false;
      let code: number | null = null;
      let signal: string | null = null;
      let exited = false;
      let cancelled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", abort);
        lease.release();
        fn();
      };

      let graceTimer: NodeJS.Timeout | undefined;
      let deadline: NodeJS.Timeout | undefined;

      const abort = (): void => {
        cancelled = true;
        // `signal()` before `close()`, and never `end()` first: ssh2 clears the
        // channel's writable side on finish and its `signal()` requires it, so
        // ending first silently swallows the request. The signal is best effort
        // — OpenSSH's sshd does not implement the RFC 4254 request at all — and
        // the actual kill is `close()`: the remote process takes SIGPIPE the
        // next time it writes to a channel that is gone.
        try {
          channel.signal("TERM");
        } catch {
          // A channel already closing. `close()` below is the part that matters.
        }
        try {
          channel.close();
        } catch {
          // Same.
        }
        // Never `client.end()` or `destroy()`: that connection is shared with
        // every other pane on this host.
        graceTimer = setTimeout(() => {
          finish(() => resolve({ code, signal: signal ?? "SIGTERM", stderr, stderrTruncated }));
        }, KILL_GRACE_MS);
        graceTimer.unref();
      };

      if (options.timeoutMs !== undefined) {
        deadline = setTimeout(() => {
          abort();
        }, options.timeoutMs);
        deadline.unref();
      }

      options.signal?.addEventListener("abort", abort, { once: true });

      channel.on("exit", (exitCode: number | null, exitSignal?: string) => {
        exited = true;
        code = exitCode;
        signal = exitSignal ?? null;
      });

      channel.on("close", () => {
        // A cancelled command closes without exiting, which is expected and not
        // a failure — the caller asked for it.
        if (!exited && !cancelled) {
          finish(() =>
            reject(new DriverError("EUNREACHABLE", "The connection dropped while the command was running.")),
          );
          return;
        }
        finish(() => resolve({ code, signal, stderr, stderrTruncated }));
      });
    });

    // The channel is duplex, so it is both halves: the caller reads output from
    // it and, under `stdinOpen`, writes the payload back down the same object.
    return options.stdinOpen === true ? { stdout: channel, done, stdin: channel } : { stdout: channel, done };
  }

  async dispose(): Promise<void> {
    // The pool owns the connection's lifetime; a driver instance is per request.
  }
}

/**
 * `client.exec` as a promise, so the channel's own failure mode is separated
 * from everything that can go wrong once it is open (TRE-32).
 *
 * The lease is the caller's to release — this function borrows nothing and
 * therefore returns nothing to clean up if it throws.
 */
function openChannel(lease: Lease, command: string, program: AllowedProgram | SudoOnlyProgram): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    lease.client.exec(command, (error, channel) => {
      if (error) {
        reject(new DriverError("EIO", `Could not start ${program}: ${error.message}`, undefined, error));
        return;
      }
      resolve(channel);
    });
  });
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
