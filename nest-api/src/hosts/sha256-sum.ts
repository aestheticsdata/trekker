import { isDriverError } from "@hosts/drivers/driver-error";

import type { HostDriver } from "@hosts/drivers/host-driver";

/**
 * Running `sha256sum` on a host, and reading what it prints.
 *
 * Two callers, which is why this is a file rather than a private helper: the
 * duplicate pass of a disk scan (TRE-32 §3) confirms same-size groups with it,
 * and the checksum jobs of TRE-27 hash whatever somebody selected. The digests
 * they want are the same digests, `sha256sum`'s output format is the same
 * format, and `ARG_MAX` bites both at the same place — so the escaping rule and
 * the chunking rule live here once. Two copies of a parsing rule is two places
 * for the escaped-path case to be got right in one and forgotten in the other.
 *
 * It lives beside the drivers rather than in either feature module for the
 * reason `host-disks.service.ts` does: it is "run an allowlisted program on a
 * HostDriver and understand the answer", which is a fact about hosts, not about
 * scans or checksums.
 *
 * `sha256sum` takes many paths in one argv, which is exactly why it is on
 * `ALLOWED_PROGRAMS` and why no shell loop, `xargs` or `find -exec` appears
 * anywhere near it. The chunking below is about `ARG_MAX`, not about the
 * absence of a shell.
 */

/**
 * Paths per `sha256sum` call, and the argv budget that also bounds it.
 *
 * Two bounds because either can bite first: a hundred short paths are fine and
 * sixty-four very long ones are not. Linux caps a single argument at 128 KiB
 * and the whole argv well above that, but the command also has to survive being
 * rendered as a shell string and handed to a remote sshd, so the budget is well
 * under either.
 */
export const MAX_ARGS_PER_CALL = 64;
export const MAX_ARGV_BYTES = 96_000;

/**
 * GNU `sha256sum` prints `<64 hex><two spaces><path>`, and escapes the path
 * when it contains a backslash or a newline: the line is then prefixed with a
 * backslash and those two characters appear as `\\` and `\n`.
 */
const SUM_LINE = /^(\\?)([0-9a-f]{64})\s{2}(.+)$/;

/**
 * What one call came back with.
 *
 * `absent` and `failed` are kept apart because they lead somewhere different.
 * A host with no `sha256sum` can still be hashed — the bytes come across the
 * network and are hashed here instead (TRE-27 §1) — so `absent` is a route to
 * take rather than an error to report. `failed` is a host that refused, a
 * channel that dropped, a file that vanished: retrying it the slow way would
 * fail the same way and cost a great deal more.
 */
export type SumOutcome = { kind: "digests"; digests: Map<string, string> } | { kind: "absent" } | { kind: "failed" };

export interface SumOptions {
  signal?: AbortSignal;
  /** Run it de-prioritised, as the scan's walk does. */
  nice?: number;
  /**
   * Called as each line arrives, which is as each file finishes.
   *
   * `sha256sum` prints one line per path the moment it has read that path, so
   * a chunk of sixty-four files reports sixty-four times rather than once at
   * the end. That is the only per-file progress a remote hash can have — the
   * command says nothing at all while it is reading — and without it a chunk of
   * large files is several minutes in which a progress feed has nothing to
   * report and a reader cannot tell a slow job from a stuck one.
   */
  onDigest?: (path: string, digest: string) => void;
}

/**
 * Digest every path in one chunk, in one call.
 *
 * Streamed rather than buffered, and the reason is cancellation rather than
 * volume: the output is sixty-five bytes a file. A buffered `exec` would make
 * the cancel latency one whole chunk, and a chunk of sixty-four files at a
 * couple of gigabytes each is minutes.
 *
 * Never throws. Both callers are long-running jobs over other people's
 * machines, and every way this can fail is a thing one file did rather than a
 * thing the job did.
 */
export async function sumChunk(
  driver: HostDriver,
  chunk: readonly string[],
  options: SumOptions = {},
): Promise<SumOutcome> {
  // A driver with no `execStream` cannot run anything at all, which for this
  // purpose is indistinguishable from a host with no `sha256sum` on it: either
  // way the bytes have to be read some other way.
  if (!driver.execStream) return { kind: "absent" };

  try {
    const running = await driver.execStream("sha256sum", ["--", ...chunk], {
      signal: options.signal,
      ...(options.nice === undefined ? {} : { nice: options.nice }),
    });

    const digests = new Map<string, string>();
    let pending = "";
    let sawOutput = false;

    // Line by line as they arrive, rather than a buffer read at the end: the
    // whole output is sixty-five bytes a file, so this is not about memory. It
    // is what lets `onDigest` fire while the command is still running.
    for await (const piece of running.stdout) {
      const text = (piece as Buffer).toString("utf8");
      if (text.length > 0) sawOutput = true;
      pending += text;

      const lines = pending.split("\n");
      // The last element is whatever came after the final newline — an
      // incomplete line, or the empty string. Either way it waits for more.
      pending = lines.pop() ?? "";
      for (const line of lines) take(line, digests, options.onDigest);
    }
    // `sha256sum` always ends its last line, but a channel that dropped mid-run
    // may not have. Parsing what is left costs nothing and a truncated line
    // simply does not match.
    take(pending, digests, options.onDigest);

    const result = await running.done;

    // 127 is what a shell returns for a command it could not find, which is how
    // a missing `sha256sum` reaches us over SSH — there is no exception to
    // catch, only an exit code and a sentence on stderr. Guarded by "printed
    // nothing", because a real run that happened to exit 127 for its own
    // reasons would have printed digests first.
    if (result.code === 127 && !sawOutput) return { kind: "absent" };

    // A non-zero exit still prints the files it could read, exactly as `du`
    // does: what it could not read simply has no line. So output is worth
    // keeping whatever the code says, and a caller that finds a path missing
    // from the map knows that path was not hashed.
    if (result.code !== 0 && !sawOutput) return { kind: "failed" };

    return { kind: "digests", digests };
  } catch (error) {
    // The local driver reports a missing program as a rejection rather than an
    // exit code — there is no shell in the way to turn it into a 127.
    if (isDriverError(error) && error.code === "ENOENT") return { kind: "absent" };
    return { kind: "failed" };
  }
}

/** Every `<digest>  <path>` line in some output, as a path → digest map. */
export function parseSumLines(output: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const line of output.split("\n")) take(line, digests);
  return digests;
}

/** One line, if it is one. Anything else — a warning on stdout — is ignored. */
function take(line: string, into: Map<string, string>, onDigest?: (path: string, digest: string) => void): void {
  const fields = SUM_LINE.exec(line.trimEnd());
  if (!fields) return;

  const path = unescapePath(fields[3], fields[1] === "\\");
  into.set(path, fields[2]);
  onDigest?.(path, fields[2]);
}

/** Bounded by both the argument count and the total argv size. */
export function chunkPaths(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;

  for (const path of paths) {
    // Quoting can nearly double a path's rendered length, so the estimate is
    // deliberately pessimistic — running out of command line is a failure the
    // caller sees as "this host cannot hash", which is not what happened.
    const cost = path.length * 2 + 4;
    if (current.length > 0 && (current.length >= MAX_ARGS_PER_CALL || bytes + cost > MAX_ARGV_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(path);
    bytes += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Undo `sha256sum`'s own escaping, which it applies only to the flagged lines.
 *
 * One left-to-right pass, and it has to be. Two passes — newlines, then
 * backslashes — read `\\name` as an escaped backslash only if they get there
 * first, and the newline pass gets there first: it matches the *second*
 * backslash and the `n`, so a file literally called `od\name` comes back as
 * `od\` + a newline + `ame`. The consequence is quiet rather than loud, which
 * is why it survived TRE-32: the digest is right and the path it is filed under
 * is a name no `stat` will ever match, so that file is re-hashed by every job
 * forever and the cache silently never covers it.
 */
function unescapePath(path: string, escaped: boolean): string {
  if (!escaped) return path;
  return path.replace(/\\(n|\\)/g, (_, char: string) => (char === "n" ? "\n" : "\\"));
}
