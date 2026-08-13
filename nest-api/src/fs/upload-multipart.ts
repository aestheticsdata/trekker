import { BadRequestException } from "@nestjs/common";
import busboy from "busboy";
import { UploadRefused } from "@fs/upload.service";

import type { UploadOutcome } from "@fs/upload.service";
import type { Request } from "express";
import type { Readable } from "node:stream";

/**
 * Reading a multipart body without ever holding one (TRE-65).
 *
 * `@nestjs/platform-express` bundles multer, and multer's whole design is to
 * have the file somewhere before your handler runs — in memory or on the API's
 * own disk. Both are wrong here: the destination may be a machine this process
 * has no disk in common with, and the file may be larger than anything this
 * process should be asked to hold. busboy hands over a `Readable` per part
 * while the body is still arriving, which is the shape the driver wants.
 *
 * The sequencing falls out of backpressure and is worth stating because it
 * looks accidental: busboy cannot move past a part until that part's stream has
 * been consumed, so the handler below runs one file at a time even though
 * nothing here queues them. Several files in one request go up in order, and at
 * no point are two write streams open on the destination host.
 */

/**
 * Files in one request. A drag-and-drop of a directory can name thousands, and
 * the answer to that is a transfer job (TRE-23) rather than one HTTP request
 * that takes an hour and cannot be resumed.
 */
const MAX_FILES = 200;

export interface MultipartResult {
  outcomes: UploadOutcome[];
  /** Set when the request was cut off. Everything in `outcomes` still landed. */
  refusal: UploadRefused | null;
}

export function receiveMultipart(
  request: Request,
  onFile: (filename: string, stream: Readable) => Promise<UploadOutcome>,
): Promise<MultipartResult> {
  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: request.headers,
        // No fields at all. Everything the route needs — host, directory,
        // conflict policy — arrives in the query string, so that it can be
        // validated before this function is called. A field would arrive in
        // whatever order the client chose, which for the destination directory
        // means possibly after the file it decides the fate of.
        limits: { files: MAX_FILES, fields: 0 },
      });
    } catch {
      // Thrown for a missing or unparseable Content-Type, which is a malformed
      // request rather than a server fault.
      reject(new BadRequestException("Expected a multipart/form-data body."));
      return;
    }

    const outcomes: UploadOutcome[] = [];
    const pending: Array<Promise<void>> = [];
    let refusal: UploadRefused | null = null;

    const stopReading = (): void => {
      // Unpiped and drained rather than destroyed. Nothing further is written
      // to the host — which is the refusal the ticket asks for — but the socket
      // is left able to carry the response that says so, and a client told
      // "too large" learns more than one handed a connection reset.
      request.unpipe(parser);
      request.resume();
    };

    parser.on("file", (_field, stream, info) => {
      if (refusal !== null) {
        stream.resume();
        return;
      }

      pending.push(
        onFile(info.filename, stream).then(
          (outcome) => {
            outcomes.push(outcome);
          },
          (error: unknown) => {
            if (!(error instanceof UploadRefused)) throw error;
            refusal = error;
            stopReading();
          },
        ),
      );
    });

    parser.on("filesLimit", () => {
      refusal ??= new UploadRefused("ETOOMANYFILES", `At most ${MAX_FILES} files in one upload.`);
      stopReading();
    });

    parser.on("error", (error: unknown) => {
      reject(error instanceof Error ? error : new BadRequestException("The multipart body could not be read."));
    });

    // `close` is the parser finishing, which is not the same as the writes
    // finishing: the last file's rename is still in flight when it fires.
    const finish = (): void => {
      Promise.all(pending).then(() => resolve({ outcomes, refusal }), reject);
    };
    parser.on("close", finish);
    // A refusal unpipes the parser, so `close` may never come. The request's own
    // end is the backstop, and `Promise.all` is idempotent enough that both
    // firing is harmless — the promise is already settled.
    request.on("close", finish);

    request.pipe(parser);
  });
}
