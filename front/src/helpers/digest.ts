/**
 * What a file looks like from the front (TRE-142).
 *
 * The server decides which partial belongs to which upload by hashing what the
 * browser says about the file — its path, its size, its stamp — and one of
 * those is a lie often enough to matter. A file edited by a tool that preserves
 * timestamps has the same name, the same length and the same mtime as the one
 * whose bytes are already half on the host, and appending to that partial makes
 * a file that is corrupt and looks complete.
 *
 * So the leading megabyte goes into the token too. Not integrity in any
 * cryptographic sense — the tail is never hashed and does not need to be — but
 * enough that two different files are two different transfers, which is the
 * only question being asked.
 */

/** Enough to tell two files apart, and small enough to read in a moment. */
const HEAD_BYTES = 1024 * 1024;

/**
 * Null rather than a throw, for every reason it can fail.
 *
 * `crypto.subtle` exists only in a secure context, so a page served over plain
 * HTTP has none — and the honest answer there is that this upload cannot be
 * resumed, not that it cannot happen. Every caller reads null as "send the
 * whole file", which is what the app did before this existed.
 */
export async function headDigest(file: File): Promise<string | null> {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) return null;

  try {
    const head = await file.slice(0, HEAD_BYTES).arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", head);

    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    // A file that moved or was revoked between the pick and here. The upload
    // will fail on its own terms in a moment and say so properly.
    return null;
  }
}
