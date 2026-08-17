import { isDriverError } from "@hosts/drivers/driver-error";
import type { HostDriver } from "@hosts/drivers/host-driver";
import type { SudoOnlyProgram } from "@hosts/drivers/shell-quote";
import { SudoService } from "@hosts/sudo/sudo.service";
import { Injectable, Logger } from "@nestjs/common";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { chmodArgv } from "@hosts/sudo/sudo-argv";

/**
 * Running one operation as root, when the ordinary way was refused (TRE-29).
 *
 * **Escalation is a fallback, never a default.** An operation is attempted as
 * the login user first, and only a permission refusal sends it here. That is
 * what the ticket means by "only what could not be done otherwise", and it has
 * a consequence worth stating: with a window open, a change to a file you
 * already own runs exactly as it did before — same call, same code path, no
 * root involved. Root is reached for the files that needed it and no others.
 *
 * **This service does not decide whether the path is allowed.** It never sees
 * an unvalidated path: the guard runs above it, on the way in, and the walk's
 * denylist filter runs above it too. Sudo widens *permission*, never *reach* —
 * so the install directory, `~/.ssh` and `~/.pm2` stay refused with a window
 * open exactly as they are without one, and the roots allowlist is untouched.
 * If this file ever grows a path argument that has not been through the guard,
 * that is the bug.
 */
@Injectable()
export class SudoRunnerService {
  private readonly logger = new Logger(SudoRunnerService.name);

  constructor(private readonly sudo: SudoService) {}

  /** Whether this session could escalate on this host right now. */
  isOpen(sessionId: string | undefined, hostId: string): boolean {
    return sessionId !== undefined && this.sudo.isOpen(sessionId, hostId);
  }

  /**
   * Run an allowlisted program as root on an already-validated path.
   *
   * Throws if there is no live window, which is the case a caller reaches by
   * racing the expiry: `isOpen` said yes, fifteen minutes elapsed, and the
   * password is gone. Better as a refusal here than as a command sent with an
   * empty password for sudo to reject with a message about authentication.
   */
  async run(
    driver: HostDriver,
    sessionId: string | undefined,
    hostId: string,
    program: SudoOnlyProgram,
    args: readonly string[],
  ): Promise<void> {
    const password = sessionId === undefined ? null : this.sudo.passwordFor(sessionId, hostId);
    if (password === null) {
      throw new Error("The sudo window closed before this could run.");
    }

    // The password goes to stdin, never to argv — argv is readable by every
    // account on the host. On a host that asks for none this is the empty
    // string, and sudo never reads it.
    const result = await driver.exec(program, args, { sudo: "password", stdin: `${password}\n` });
    if (result.code === 0) return;

    // `stderr` is the command's, and it is what the caller reports. It has been
    // through nothing that could have put the password in it — the password was
    // never an argument, and sudo prints no prompt under `-p ''`.
    throw new Error(result.stderr.trim() || `${program} exited ${String(result.code)}`);
  }

  /**
   * Read something as root, as a stream (TRE-29).
   *
   * The window is checked here for the same reason `run` checks it: `isOpen`
   * and the call are two moments, and fifteen minutes can pass between them.
   */
  async stream(
    driver: HostDriver,
    sessionId: string | undefined,
    hostId: string,
    program: SudoOnlyProgram,
    args: readonly string[],
  ): Promise<Readable> {
    const password = sessionId === undefined ? null : this.sudo.passwordFor(sessionId, hostId);
    if (password === null) {
      throw new Error("The sudo window closed before this could run.");
    }
    return streamElevated(driver, password, program, args);
  }

  /**
   * Write a root-owned file as root (TRE-29). See `writeElevated`.
   *
   * The window is re-checked here, not merely at `isOpen`: a write is the
   * longest-running of these operations and the most likely to be started just
   * before the fifteen minutes run out.
   */
  write(driver: HostDriver, sessionId: string | undefined, hostId: string, path: string, mode: number | null = null) {
    const password = sessionId === undefined ? null : this.sudo.passwordFor(sessionId, hostId);
    if (password === null) {
      throw new Error("The sudo window closed before this could run.");
    }
    return writeElevated(driver, password, path, mode);
  }
}

/**
 * The same, streamed — for reading a root-owned file (TRE-29).
 *
 * `run` above collects output into a string under a ceiling, which is right for
 * `id -u` and wrong for `cat` on a real file. This returns the stdout stream
 * itself, so the bytes go to the socket as they arrive and nothing holds the
 * file.
 *
 * **A failed `cat` has to break the stream, not end it.** Left alone, a command
 * that exits non-zero having printed nothing produces an empty stdout that ends
 * cleanly — and the caller sends a successful, empty download. So the exit is
 * watched, and a non-zero one destroys the stream with the command's own
 * stderr. A truncated transfer is a visible failure; a silent empty file is not.
 */
export async function streamElevated(
  driver: HostDriver,
  password: string,
  program: SudoOnlyProgram,
  args: readonly string[],
): Promise<Readable> {
  if (!driver.execStream) {
    throw new Error("This host cannot stream a command, so a root-owned file cannot be read.");
  }

  const running = await driver.execStream(program, args, { sudo: "password", stdin: `${password}\n` });

  void running.done.then(
    (result) => {
      if (result.code !== 0) {
        running.stdout.destroy(new Error(result.stderr.trim() || `${program} exited ${String(result.code)}`));
      }
    },
    (error: unknown) => running.stdout.destroy(error instanceof Error ? error : new Error(String(error))),
  );

  return running.stdout;
}

/** A write in progress: where the bytes go, and how it ended. */
export interface ElevatedWrite {
  /** The caller writes the file's contents here, and **must** end it. */
  stdin: Writable;
  /** Settles once `tee` has exited. Rejects with its stderr if it failed. */
  done: Promise<void>;
}

/**
 * Write a root-owned file, through `sudo tee` (TRE-29).
 *
 * **The password and the payload share one pipe, and that is the whole trick.**
 * `sudo -S` reads exactly one line — the password — and then execs `tee`, which
 * reads everything after it. So the driver writes the first line, leaves the
 * pipe open, and hands the rest back here for the contents.
 *
 * **`tee` is the only allowlisted way to do this, and it costs double.** Its
 * job is to copy stdin to a file *and* to stdout, and it has no flag to stop
 * doing the second. Silencing it would need `> /dev/null`, which is shell
 * redirection and exactly what `shell-quote.ts` exists to prevent; `dd` and
 * `cp` are not on either list and adding them would widen the boundary for a
 * cosmetic gain. So over SSH the contents come back a second time and are
 * thrown away — fine for the config files this is really for, and worth knowing
 * before pointing it at a large upload.
 *
 * The echo is *drained*, not ignored. An unread pipe fills its buffer and the
 * command blocks writing to it, which would stall the write at whatever the
 * kernel buffer holds and look exactly like a hung host.
 */
export function writeElevated(driver: HostDriver, password: string, path: string, mode: number | null): ElevatedWrite {
  if (!driver.execStream) {
    throw new Error("This host cannot stream a command, so a root-owned file cannot be written.");
  }

  const started = driver.execStream("tee", ["--", path], {
    sudo: "password",
    stdin: `${password}\n`,
    stdinOpen: true,
  });

  // A pass-through, so the caller has something to write to before the channel
  // has finished opening. Piping it across once the command is up keeps
  // backpressure intact — the caller slows down when the host does.
  const stdin = new PassThrough();

  const done = started.then(async (running) => {
    if (!running.stdin) throw new Error("The host did not provide a writable input for tee.");

    // Drained and discarded. See above: this is `tee` echoing back what it was
    // given, and an unread pipe stalls the command that is filling it.
    running.stdout.resume();

    await pipeline(stdin, running.stdin);
    const result = await running.done;
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `tee exited ${String(result.code)}`);
    }

    // `tee` creates with the caller's umask and cannot be told otherwise, so a
    // mode the caller asked for is applied afterwards rather than not at all.
    if (mode !== null) {
      const chmod = await driver.exec("chmod", chmodArgv(mode, path), {
        sudo: "password",
        stdin: `${password}\n`,
      });
      if (chmod.code !== 0) {
        throw new Error(chmod.stderr.trim() || `chmod exited ${String(chmod.code)}`);
      }
    }
  });

  return { stdin, done };
}

/**
 * Whether a failure is the kind sudo could fix.
 *
 * Only these two. A missing file is still missing as root, a full disk is still
 * full, and retrying either one under sudo would turn one clear failure into
 * two — the second of them wearing root's name in the audit log for no reason.
 */
export function isPermissionRefusal(error: unknown): boolean {
  return isDriverError(error) && (error.code === "EACCES" || error.code === "EPERM");
}
