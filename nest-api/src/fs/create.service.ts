import { posix } from "node:path";
import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { DriverError, fromNodeError, isDriverError } from "@hosts/drivers/driver-error";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { toHttp } from "@fs/driver-http";
import { entryNameProblem } from "@fs/entry-name";
import type { FileRowDetail } from "@fs/file-row";
import { FsService } from "@fs/fs.service";

import type { HostDriver } from "@hosts/drivers/host-driver";
import type { Writable } from "node:stream";

/**
 * Making one directory, or one empty file (TRE-69).
 *
 * The two routes are nearly the same sentence and differ in the one place that
 * matters. `mkdir` fails on an existing name because that is what `mkdir(2)`
 * does. `create` has to *ask* for that failure — `createWriteStream` has meant
 * `O_CREAT|O_TRUNC` since the driver interface existed, so a create built on
 * what was there would have answered 200 by emptying the file already under
 * that name. `WriteOptions.exclusive` is the flag that closes it, and this
 * service is its only caller.
 *
 * Everything else follows the shape `RenameService` already established: the
 * *containing directory* is what the guard validates, and the name is joined
 * onto the real path it returned. Resolving the entry itself would be wrong for
 * the reason it is wrong there — `realpath` follows symlinks, and there is
 * nothing to resolve yet anyway.
 */
@Injectable()
export class CreateService {
  constructor(
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly fs: FsService,
  ) {}

  /**
   * One directory, not recursive.
   *
   * `mkdir -p` is a different feature and nothing here wants it: the modal
   * offers one name in the directory a pane is showing, and a recursive flag
   * would let one field create four levels the operator never looked at. An
   * existing name is a 409 whatever it is — a file called `logs` blocks a
   * directory called `logs`, because the filesystem has one namespace.
   */
  async mkdir(userId: string, hostId: string, directory: string, name: string): Promise<FileRowDetail> {
    const { driver, full } = await this.place(userId, hostId, directory, name);

    try {
      await driver.mkdir(full, { recursive: false });
    } catch (error) {
      this.rethrow(error, name);
    }

    return this.fs.stat(userId, hostId, posix.join(directory, name));
  }

  /**
   * One empty file, exclusively.
   *
   * Zero bytes are written and the mode is the driver's default (0o644).
   * Setting bits at creation time is TRE-21's modal, one step later, and a
   * create that also took a mode would be two decisions on one field.
   */
  async createFile(userId: string, hostId: string, directory: string, name: string): Promise<FileRowDetail> {
    const { driver, full } = await this.place(userId, hostId, directory, name);

    try {
      await writeNothing(driver, full);
    } catch (error) {
      this.rethrow(error, name);
    }

    return this.fs.stat(userId, hostId, posix.join(directory, name));
  }

  /**
   * The driver, and the resolved path this entry will be created at.
   *
   * The name is checked again here even though the DTO already refused a bad
   * one. The DTO guards the HTTP boundary; this guards the *function*, and the
   * two are not the same promise — a later caller reaching this service from
   * somewhere other than a controller would otherwise be joining an unchecked
   * segment onto a validated path, which is precisely the mistake the rule
   * exists to prevent.
   */
  private async place(
    userId: string,
    hostId: string,
    directory: string,
    name: string,
  ): Promise<{ driver: HostDriver; full: string }> {
    const invalid = entryNameProblem(name);
    if (invalid) throw new BadRequestException(invalid.message);

    const driver = await this.run(() => this.factory.forHost(hostId, userId));
    // WRITE: creating an entry is a write to the directory holding it, so a
    // read-only root must refuse this exactly as it refuses a rename.
    const validated = await this.guard.validate({ driver, userId, path: directory, intent: "write" });

    const stat = await this.run(() => driver.stat(validated.realPath));
    if (stat.kind !== "directory") {
      throw new BadRequestException(`${directory} is not a directory.`);
    }

    const full = posix.join(validated.realPath, name);

    // TRE-52's lesson in its smallest form: the guard saw the directory, not
    // the path a name would produce inside it. Asked about `full`, which is the
    // entry about to be made, and not about the directory the guard already
    // judged.
    const denied = await this.guard.localDenial(driver, userId);
    if (denied(full)) {
      throw new BadRequestException("That name lands on Trekker's own key material and cannot be created here.");
    }

    return { driver, full };
  }

  /**
   * A driver failure as an HTTP one.
   *
   * `EEXIST` is the only code lifted out of the shared table, and only for the
   * message: 409 is what `toHttp` now answers for it everywhere, but "Already
   * exists" cannot name the entry and this can. The name is what the modal
   * shows on the field the operator just typed into.
   */
  private rethrow(error: unknown, name: string): never {
    if (isDriverError(error) && error.code === "EEXIST") {
      throw new ConflictException(`“${name}” already exists in this directory.`);
    }
    if (isDriverError(error)) throw toHttp(error);
    throw error;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }
}

/**
 * Opens the file exclusively, writes nothing, and waits for the close.
 *
 * The wait is the point. Both drivers open lazily, so `createWriteStream`
 * resolving proves nothing at all — the `O_EXCL` refusal, the permission
 * denial and the full disk all arrive afterwards as an `error` event, and a
 * function that returned before that would report success for a file that was
 * never created.
 *
 * `end()` before the listeners would be a race on the local driver, where an
 * error can be emitted in the same tick; it is called after them.
 */
async function writeNothing(driver: HostDriver, path: string): Promise<void> {
  const target: Writable = await driver.createWriteStream(path, { exclusive: true });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve();
      else reject(error);
    };

    // An `error` event carries an Error on both transports — a libuv
    // `ErrnoException` from `node:fs`, an ssh2 failure from SFTP — and the
    // catch below is what turns either into this application's vocabulary.
    target.once("error", (error: Error) => {
      target.destroy();
      finish(error);
    });
    target.once("close", () => finish());
    target.end();
  }).catch(async (raw: unknown) => {
    // Into one vocabulary first. `node:fs` raises a libuv errno — which for an
    // exclusive open on a taken name is `EEXIST`, said plainly — and SFTP has
    // no EEXIST on the wire at all, so a remote refusal arrives as the generic
    // failure this driver calls EIO.
    const error = isDriverError(raw) ? raw : fromNodeError(raw, path);
    if (error.code !== "EIO") throw error;

    // The one question worth a round trip, asked only where the transport
    // could not answer it: is the name taken? It is still the filesystem
    // deciding, after the attempt failed rather than before it was made.
    const taken = await driver.stat(path).then(
      () => true,
      () => false,
    );
    if (taken) throw new DriverError("EEXIST", `Already exists: ${path}`, path, error);
    throw error;
  });
}
