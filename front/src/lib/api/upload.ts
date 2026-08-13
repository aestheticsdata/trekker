import { API_ORIGIN, ApiError } from "@lib/api/client";

/**
 * Upload (TRE-65), the second call this app does not make through `apiRequest`.
 *
 * `fetch` cannot report upload progress. There is no event for it, the
 * `ReadableStream` request body that would give you one is not implemented in
 * Safari, and the ticket asks for per-file progress — so this is an
 * `XMLHttpRequest`, which has had `upload.onprogress` since 2008 and is the
 * only thing in the platform that answers the question.
 *
 * One request per file rather than one carrying several. The route takes a
 * multipart body with any number of parts and would happily accept them, but a
 * per-file request is what makes per-file progress a number the browser already
 * knows rather than one this code has to apportion, and it means one file
 * failing does not take the other nine down with it.
 */

export type ConflictPolicy = "overwrite" | "skip" | "keepBoth";

export interface UploadOutcome {
  requested: string;
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

export interface UploadHandle {
  /** Resolves with what the server did. Rejects with an ApiError on refusal. */
  done: Promise<UploadResult>;
  /** Stops it. The server removes the partial file it was writing. */
  abort: () => void;
}

export function uploadFile(
  hostId: string,
  directory: string,
  file: File,
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
      reject(new ApiError(request.status, body?.message ?? `Upload failed (${request.status})`, body?.code));
    });

    // Distinguished on purpose: a network failure is the host or the tunnel,
    // an abort is the person, and a tray row saying "failed" for something
    // somebody cancelled is a small lie that costs them a second of worry.
    request.addEventListener("error", () => reject(new ApiError(0, "The upload could not reach the server.")));
    request.addEventListener("abort", () => reject(new ApiError(0, "Cancelled.", "EABORTED")));

    const form = new FormData();
    // `file.name` and not a path: the server takes the last segment anyway, and
    // a directory drop should not be able to suggest one.
    form.append("file", file, file.name);
    request.send(form);
  });

  return { done, abort: () => request.abort() };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
