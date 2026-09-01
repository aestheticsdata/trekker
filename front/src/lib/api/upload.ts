import { API_ORIGIN, ApiError, apiRequest } from "@lib/api/client";

import type { PickedFile } from "@helpers/picked";
import type { DiskSpace } from "@helpers/space";

/**
 * Upload (TRE-65, TRE-126, TRE-142), the second call this app does not make
 * through `apiRequest`.
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
 *
 * TRE-142 adds the other half of that: a file large enough to travel alone is
 * also a file large enough to be worth continuing, so it asks what the host
 * already holds and sends only the rest. Nothing here decides when to do that —
 * `uploads.tsx` does, because it is the thing that knows a transfer just died.
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

/**
 * What the browser says about a file it may want to continue (TRE-142).
 *
 * These three go into the query, and the server hashes them into the name of
 * the partial. The name itself never travels — a client that could choose which
 * temporary file on the host to append to would be choosing which file to
 * corrupt.
 */
export interface ResumeClaim {
  size: number;
  mtimeMs: number;
  /** `headDigest`'s answer. Its absence is what makes a file unresumable. */
  digest: string;
}

export interface ResumeSend {
  claim: ResumeClaim;
  /** Where the body was sliced. The server refuses if its partial disagrees. */
  from: number;
}

/**
 * How much of this file the host already holds (TRE-142).
 *
 * Zero for everything: no partial, a folder not made yet, a server that would
 * not answer. Each of those means "send the whole file", and none of them is a
 * failure worth showing anybody — a resume that quietly does not happen is an
 * upload, which is what was asked for.
 */
export async function resumeOffset(
  hostId: string,
  directory: string,
  file: PickedFile,
  claim: ResumeClaim,
): Promise<number> {
  const query = new URLSearchParams({
    hostId,
    path: directory,
    name: file.path,
    size: String(claim.size),
    mtime: String(claim.mtimeMs),
    digest: claim.digest,
  });

  try {
    const answer = (await apiRequest(`/fs/upload/resume?${query.toString()}`)) as { offset?: unknown };
    const offset = answer.offset;

    // Bounded here as well as on the server. This number decides which bytes
    // are never sent, and a wrong one is a file with a hole in it.
    if (typeof offset !== "number" || !Number.isInteger(offset)) return 0;
    return offset > 0 && offset <= claim.size ? offset : 0;
  } catch {
    return 0;
  }
}

/**
 * What is free where an upload is going (TRE-144).
 *
 * Nulls for a host that could not be asked, and the caller must not draw a zero
 * for them: the modal shows nothing and blocks nothing rather than claiming a
 * disk is full because `df` was missing.
 *
 * Swallows its failures for the same reason. This runs to decorate a modal that
 * works without it, and an error banner about a disk-space lookup would be a
 * worse answer than the silence.
 */
export async function uploadSpace(hostId: string, directory: string): Promise<DiskSpace> {
  const query = new URLSearchParams({ hostId, path: directory });

  try {
    const answer = (await apiRequest(`/fs/space?${query.toString()}`)) as { free?: unknown; total?: unknown };

    return {
      free: typeof answer.free === "number" ? answer.free : null,
      total: typeof answer.total === "number" ? answer.total : null,
    };
  } catch {
    return { free: null, total: null };
  }
}

/** One file's standing on the host, as `surveyUploads` reports it. */
export interface SurveyAnswer {
  /** Echoed exactly as asked, so a caller can pair without re-deriving. */
  name: string;
  /** Something already holds that name. Under any policy, do not send it. */
  there: boolean;
  /** What a partial holds, when a claim was given. Zero otherwise. */
  offset: number;
}

/**
 * What the host already has, for a whole batch (TRE-143).
 *
 * Asked after a request died without answering. The route writes its parts one
 * at a time, so a batch that returned nothing still landed some of its files,
 * and the retry has to know which — sending them again would duplicate them
 * under `keepBoth` and spend the uplink twice under any policy.
 *
 * A POST for its body: a hundred relative paths do not belong in a query
 * string. It writes nothing.
 */
export async function surveyUploads(
  hostId: string,
  directory: string,
  files: ReadonlyArray<{ name: string; claim?: ResumeClaim }>,
  csrfToken: string | null,
): Promise<SurveyAnswer[]> {
  const answer = (await apiRequest("/fs/upload/survey", {
    method: "POST",
    csrfToken,
    body: {
      hostId,
      path: directory,
      files: files.map(({ name, claim }) =>
        claim === undefined ? { name } : { name, size: claim.size, mtime: claim.mtimeMs, digest: claim.digest },
      ),
    },
  })) as { results?: unknown };

  return Array.isArray(answer.results) ? (answer.results as SurveyAnswer[]) : [];
}

export interface UploadHandle {
  /** Resolves with what the server did to every part. */
  done: Promise<UploadResult>;
  /**
   * Stops it.
   *
   * What is left behind depends on whether this was resumable: an ordinary
   * upload's partial is removed, and a resumed one's is kept under a name the
   * next attempt can find (TRE-142). Cancelling is not deleting, and a file
   * somebody cancelled at 80% is one they may well come back to.
   */
  abort: () => void;
}

export function uploadBatch(
  hostId: string,
  directory: string,
  files: readonly PickedFile[],
  csrfToken: string | null,
  conflict: ConflictPolicy,
  onProgress: (fraction: number) => void,
  /** Set only for a single-file batch; the route refuses a second part. */
  resume?: ResumeSend,
): UploadHandle {
  const query = new URLSearchParams({ hostId, path: directory, conflict });
  if (resume !== undefined) {
    query.set("resumeDigest", resume.claim.digest);
    query.set("resumeSize", String(resume.claim.size));
    query.set("resumeMtime", String(resume.claim.mtimeMs));
    query.set("resumeFrom", String(resume.from));
  }
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
      if (!event.lengthComputable || event.total <= 0) return;

      // The bytes an earlier attempt left on the host count towards the bar
      // (TRE-142). The browser is measuring the tail this request carries and
      // knows nothing about them, so a resumed file would otherwise start again
      // at zero and read as work being done twice.
      const carried = resume?.from ?? 0;
      onProgress((carried + event.loaded) / (carried + event.total));
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
      //
      // Sliced when continuing (TRE-142). `Blob.slice` costs nothing — it is a
      // window onto the file on disk, not a copy — so a 9 GiB file resumed at
      // 8 GiB puts one gigabyte on the wire and nothing at all in memory.
      form.append("file", resume === undefined ? picked.file : picked.file.slice(resume.from), picked.path);
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
