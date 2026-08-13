import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import type { OpenedDownload } from "@fs/download.service";
import type { Response } from "express";

/**
 * Sending a download, and closing its audit row afterwards (TRE-26 §1).
 *
 * Its own file because the session route and TRE-66's tokened one send bytes
 * the same way and must go on doing so — this is where "the response ends when
 * the stream does, the row says how many bytes actually left, and a client that
 * hangs up does not leak a driver handle" is written down once.
 *
 * The rule that shapes all of it: **once a byte is written the status line is
 * spent.** A failure discovered afterwards cannot become a 500, because the
 * client has already been told 200 and is holding half a file. So every refusal
 * happens before this function is called, and everything here can do about a
 * mid-stream failure is stop, destroy the socket so the client sees a truncated
 * body rather than a complete one, and say so in the log.
 */

export interface DownloadHeaders {
  status: number;
  /** Header name to value. Written before the first byte and never after. */
  headers: Record<string, string>;
  /**
   * How many bytes this response promised, where it promised a number.
   *
   * Null for an archive, whose size is not known until it is over. Where it is
   * known it settles the one question the pipeline cannot answer on its own —
   * see the `complete` check below.
   */
  expectBytes?: number | null;
}

/**
 * Counts what goes past without holding any of it.
 *
 * The audit row wants the bytes that actually reached the client, which is not
 * the size the plan predicted — an interrupted download differs from a finished
 * one by exactly this number, and that difference is the interesting part of
 * the row.
 */
class ByteCounter extends Transform {
  bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.bytes += chunk.length;
    this.push(chunk);
    callback();
  }
}

/**
 * Pipe an opened download at the response and settle its row.
 *
 * Resolves when the exchange is over, however it ended. It never throws: by the
 * time it runs there is nothing left to report an error *to*, and a rejected
 * promise here would reach Nest's exception filter, which would try to write a
 * JSON body onto a response that has already sent half a zip.
 */
export async function sendDownload(
  response: Response,
  opened: OpenedDownload,
  { status, headers, expectBytes = null }: DownloadHeaders,
): Promise<void> {
  const counter = new ByteCounter();

  response.writeHead(status, headers);

  try {
    // `pipeline` rather than `.pipe()`: it propagates backpressure, and — the
    // part that matters on a remote host — it destroys the source when the
    // destination dies. A client that closes the tab mid-archive would
    // otherwise leave the SFTP channel open until the pool ran out of them.
    await pipeline(opened.stream, counter, response);
    await opened.settle(counter.bytes, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // **A finished download that the client hung up on is not a failure**, and
    // this branch exists because the first version of this file recorded it as
    // one. When the response carries a `Content-Length`, a client is entitled
    // to close the socket the moment it has that many bytes — `curl` does,
    // every time — and Node then rejects the pipeline with a premature-close
    // long after every byte has left. The row would have said "failure" about a
    // download that worked, which is the one thing an audit log must never do.
    //
    // The byte count is what settles it: the response promised a number, that
    // number went out, and there is nothing left that could have gone wrong.
    // An archive promises no number, so an early close there stays a failure —
    // which is right, because nothing here can tell a complete zip from a
    // truncated one.
    if (expectBytes !== null && counter.bytes === expectBytes) {
      await opened.settle(counter.bytes, "success");
      return;
    }

    // Destroyed rather than ended. A truncated body with no terminating chunk
    // is how a chunked response says "this is incomplete"; ending it cleanly
    // would hand the client a zip that looks whole and is not.
    if (!response.writableEnded) response.destroy();

    await opened.settle(counter.bytes, "failure", message);
  }
}
