import { createHash } from "node:crypto";

/**
 * Which partial belongs to which upload (TRE-142).
 *
 * The `.part` file predates this by a long way, and it was never built for
 * resume: it exists so that an interrupted upload cannot leave a truncated
 * file under the name somebody is about to open. That is a statement about the
 * *destination name*, and it is why the partial was given a random middle and
 * deleted on the way out — half a tar is worth nothing to anybody.
 *
 * Resume reuses the mechanism rather than the bytes. The awkward part of
 * continuing a transfer is having somewhere to accumulate that is not the real
 * filename, on the same filesystem, with an atomic hand-off at the end; that is
 * exactly what the partial already is. What it lacked was a name a second
 * attempt could find, and this file is that name.
 *
 * **The token is the fingerprint.** Rather than record what the partial holds
 * in a sidecar and compare it later, everything that decides identity is hashed
 * into the name itself. A file whose size, mtime or leading megabyte differs
 * hashes to a different token, finds no partial, and uploads from zero — with
 * no comparison to get wrong and no second file to keep in step. The
 * consequence worth stating: a stale partial is not overwritten, it is
 * orphaned, and the sweep in `upload.service.ts` is what takes it away.
 */

/** What the browser says about the file it is offering. */
export interface ResumeClaim {
  /** Bytes, as `File.size` reports them. */
  size: number;
  /** `File.lastModified`, in milliseconds. */
  mtimeMs: number;
  /** Hex digest of the file's first megabyte, computed in the browser. */
  digest: string;
}

/** The claim, plus everything the server knows without being told. */
export interface ResumeSubject extends ResumeClaim {
  /**
   * Included so that two people uploading into one shared directory cannot
   * continue each other's transfer. Neither could read the other's partial
   * usefully, but appending to it would corrupt a file for somebody who never
   * did anything wrong, and the fix costs one field.
   */
  userId: string;
  hostId: string;
  /** The request's validated destination — the real path, after the guard. */
  root: string;
  /**
   * The relative path as sent, before sanitising.
   *
   * The path and not the name, so that `photos/2019/a.jpg` and
   * `photos/2020/a.jpg` are two transfers rather than one. This is the whole
   * reason a folder resumes file by file instead of resuming its first file
   * over and over.
   */
  requested: string;
}

/**
 * Enough hex to be a name, not enough to be a hash people read.
 *
 * 128 bits of SHA-256. A collision would mean appending one file's bytes to
 * another's, which is the worst failure this design has — and at 128 bits it is
 * not a risk being accepted so much as one being ruled out.
 */
const TOKEN_LENGTH = 32;

/** How long a digest the caller may hand over, so a query cannot be a payload. */
export const MAX_DIGEST_LENGTH = 128;

export function resumeToken(subject: ResumeSubject): string {
  // NUL-joined rather than concatenated. Every field here is either an integer
  // or a path, and a path may contain anything else — including the separator
  // that would otherwise let `a/b` + `c` and `a` + `b/c` hash the same.
  const material = [
    subject.userId,
    subject.hostId,
    subject.root,
    subject.requested,
    String(subject.size),
    String(subject.mtimeMs),
    subject.digest,
  ].join("\u0000");

  return createHash("sha256").update(material).digest("hex").slice(0, TOKEN_LENGTH);
}
