import { API_ORIGIN, ApiError } from "@lib/api/client";

import type { PickedFile } from "@helpers/picked";

/**
 * Upload (TRE-65, TRE-126), the second call this app does not make through
 * `apiRequest`.
 *
 * `fetch` cannot report upload progress. There is no event for it, the
 * `ReadableStream` request body that would give you one is not implemented in
 * Safari, and progress is the whole point of the tray — so this is an
 * `XMLHttpRequest`, which has had `upload.onprogress` since 2008 and is the
 * only thing in the platform that answers the question.
 *
 * It used to send **one request per file**, which made per-file progress a
 * number the browser already knew rather than one this code had to apportion.
 * That stopped being affordable the moment a folder could be picked: the rate
 * limit is spent per request, thirty a minute, so a hundred-file folder was
 * seventy refusals. The route has always taken up to two hundred parts and
 * streamed them one at a time under backpressure — only the client's choice
 * kept it to one — so files now share a request and the per-file answers come
 * out of the `results[]` it already returned.
 *
 * What that costs is the per-file *bar*: `upload.onprogress` counts the
 * request, not the part inside it. A packed batch therefore reports one
 * fraction and the caller decides what to draw with it, and a large file is
 * never packed with anything — precisely so it keeps a bar of its own.
 */

export type ConflictPolicy = "overwrite" | "skip" | "keepBoth";

export interface UploadOutcome {
  /** The path as sent, before sanitising — so the UI can pair it with its row. */
  requested: string;
  /** What it ended up called on the host, or null when nothing was written. */
  name: string | null;
  ok: boolean;
  bytes: number;
  code?: string;
  message?: string;
}

export interface UploadResult {
  results: UploadOutcome[];
  uploaded: number;
  bytes: number;
  failed: number;
}

/**
 * A refusal that says when to come back (TRE-126).
 *
 * The per-minute limit sends `Retry-After`, and a caller that reads it can
 * pause and go on. The hourly byte budget sends none, and means it: there is
 * nothing useful to wait for inside one sitting, so the absence of the header
 * is the signal to stop rather than a value to guess at.
 */
export class UploadRefusal extends ApiError {
  constructor(
    status: number,
    message: string,
    code: string | undefined,
    readonly retryAfterSeconds: number | null,
  ) {
    super(status, message, code);
    this.name = "UploadRefusal";
  }
}

export interface UploadHandle {
  /** Resolves with what the server did to every part. */
  done: Promise<UploadResult>;
  /** Stops it. The server removes the partial files it was writing. */
  abort: () => void;
}

export function uploadBatch(
  hostId: string,
  directory: string,
  files: readonly PickedFile[],
  csrfToken: string | null,
  conflict: ConflictPolicy,
  onProgress: (fraction: number) => void,
): UploadHandle {
  const query = new URLSearchParams({ hostId, path: directory, conflict });
  const request = new XMLHttpRequest();

  const done = new Promise<UploadResult>((resolve, reject) => {
    request.open("POST", `${API_ORIGIN}/api/fs/upload?${query.toString()}`);
    // The session cookie is httpOnly, so this is the only way it travels — the
    // same reason `apiRequest` sets `credentials: "include"`.
    request.withCredentials = true;
    if (csrfToken) request.setRequestHeader("x-csrf-token", csrfToken);

    request.upload.addEventListener("progress", (event) => {
      // `lengthComputable` is false for a body the browser is still measuring.
      // Reporting 0 then would make the bar jump backwards, so it is left where
      // it was until there is a real number.
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    });

    request.addEventListener("load", () => {
      const payload = parse(request.responseText);
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve(payload as UploadResult);
        return;
      }
      const body = payload as { message?: string; code?: string } | null;
      reject(
        new UploadRefusal(
          request.status,
          body?.message ?? `Upload failed (${request.status})`,
          body?.code,
          retryAfterOf(request),
        ),
      );
    });

    // Distinguished on purpose: a network failure is the host or the tunnel,
    // an abort is the person, and a tray row saying "failed" for something
    // somebody cancelled is a small lie that costs them a second of worry.
    request.addEventListener("error", () => reject(new ApiError(0, "The upload could not reach the server.")));
    request.addEventListener("abort", () => reject(new ApiError(0, "Cancelled.", "EABORTED")));

    const form = new FormData();
    for (const picked of files) {
      // The path, not `file.name`: it is what tells the server which directory
      // to make under the destination, and `safeRelativePath` is what reads it.
      // A flat pick sends one segment and behaves exactly as it always did.
      form.append("file", picked.file, picked.path);
    }
    request.send(form);
  });

  return { done, abort: () => request.abort() };
}

/**
 * The reset, in seconds, when the server sent one.
 *
 * Readable only because `main.ts` names it in `exposedHeaders` — a header a
 * different origin has not been given is invisible to the page, and this would
 * silently be null forever.
 */
function retryAfterOf(request: XMLHttpRequest): number | null {
  const header = request.getResponseHeader("Retry-After");
  if (header === null) return null;
  const seconds = Number.parseInt(header, 10);
  return Number.isNaN(seconds) || seconds < 0 ? null : seconds;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
