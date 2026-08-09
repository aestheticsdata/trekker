/**
 * One error vocabulary for both drivers (TRE-9).
 *
 * `node:fs` raises libuv errno strings; SFTP raises numeric status codes that
 * do not line up with them. If either leaks upward, every caller grows a switch
 * on both — so both are mapped here, at the driver boundary, and nothing above
 * this layer ever sees an SFTP status or an `NodeJS.ErrnoException`.
 */

export type DriverErrorCode =
  // Filesystem
  | "ENOENT" // no such path
  | "EACCES" // permission denied
  | "ENOTDIR" // a path component is not a directory
  | "EISDIR" // expected a file, found a directory
  | "EEXIST" // already exists
  | "ENOTEMPTY" // rmdir on a non-empty directory
  | "ENOSPC" // out of space
  | "EPERM" // operation not permitted (ownership, immutability)
  // Connection — four distinct states the UI renders differently
  | "EUNREACHABLE" // no route, refused, DNS failure
  | "EAUTH" // credentials refused
  | "EHOSTKEY" // host key does not match the pin
  | "ETIMEDOUT" // connect, handshake or operation timed out
  // Everything else
  | "EIO";

export class DriverError extends Error {
  constructor(
    readonly code: DriverErrorCode,
    message: string,
    readonly path?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DriverError";
  }

  /** True for the four connection states, which the pool treats differently. */
  get isConnectionError(): boolean {
    return (
      this.code === "EUNREACHABLE" || this.code === "EAUTH" || this.code === "EHOSTKEY" || this.code === "ETIMEDOUT"
    );
  }
}

const FS_CODES = new Set<string>([
  "ENOENT",
  "EACCES",
  "ENOTDIR",
  "EISDIR",
  "EEXIST",
  "ENOTEMPTY",
  "ENOSPC",
  "EPERM",
  "ETIMEDOUT",
]);

/** libuv errno → our vocabulary. Unknown codes become EIO rather than leaking. */
export function fromNodeError(error: unknown, path?: string): DriverError {
  const errno = error as NodeJS.ErrnoException;
  const raw = errno?.code ?? "";

  if (FS_CODES.has(raw)) {
    return new DriverError(raw as DriverErrorCode, describe(raw as DriverErrorCode, path), path, error);
  }
  // EROFS, EMFILE, EBUSY and friends: real, but nothing above here acts on them
  // differently, and inventing a code per errno is how the vocabulary rots.
  return new DriverError("EIO", errno?.message ?? "Filesystem error", path, error);
}

/**
 * SFTP protocol status → our vocabulary.
 *
 * Version 3 is what OpenSSH speaks, and it has four usable codes. There is no
 * ENOTDIR, no EEXIST and no ENOSPC on the wire — they all arrive as FAILURE(4).
 * `refine` in the SSH driver stats the path to tell them apart, which costs a
 * round trip only on the error path.
 */
export const SFTP_STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

export function fromSftpError(error: unknown, path?: string): DriverError {
  const code = (error as { code?: number })?.code;

  switch (code) {
    case SFTP_STATUS.NO_SUCH_FILE:
      return new DriverError("ENOENT", describe("ENOENT", path), path, error);
    case SFTP_STATUS.PERMISSION_DENIED:
      return new DriverError("EACCES", describe("EACCES", path), path, error);
    case SFTP_STATUS.NO_CONNECTION:
    case SFTP_STATUS.CONNECTION_LOST:
      return new DriverError("EUNREACHABLE", "Connection to the host was lost", path, error);
    default:
      return new DriverError("EIO", (error as Error)?.message ?? "Remote filesystem error", path, error);
  }
}

function describe(code: DriverErrorCode, path?: string): string {
  const where = path ? `: ${path}` : "";
  switch (code) {
    case "ENOENT":
      return `No such file or directory${where}`;
    case "EACCES":
      return `Permission denied${where}`;
    case "ENOTDIR":
      return `Not a directory${where}`;
    case "EISDIR":
      return `Is a directory${where}`;
    case "EEXIST":
      return `Already exists${where}`;
    case "ENOTEMPTY":
      return `Directory not empty${where}`;
    case "ENOSPC":
      return `No space left on device${where}`;
    case "EPERM":
      return `Operation not permitted${where}`;
    case "ETIMEDOUT":
      return `Timed out${where}`;
    default:
      return `I/O error${where}`;
  }
}

export function isDriverError(error: unknown): error is DriverError {
  return error instanceof DriverError;
}
