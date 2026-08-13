import { apiRequest } from "@lib/api/client";

/**
 * Delete (TRE-25).
 *
 * Mirrors `nest-api/src/fs/delete.service.ts`, restated rather than imported
 * for the same reason the rename types are: the two packages share no types
 * package, and a field that drifts should fail at the first render rather than
 * render `undefined`.
 *
 * Note what is *not* here, as in `rename.ts`: nothing in this file decides what
 * a delete would take, and nothing decides whether the confirmation is right.
 * The modal shows the server's plan and sends back what was typed; the server
 * derives the expected words again and compares. A local check would be the
 * same code twice, and the copy that drifts would be the one guarding the one
 * operation with no undo.
 */

export interface DeleteRisk {
  directories: number;
  rootOwned: number;
  unreadable: number;
  links: number;
}

export interface DeleteTarget {
  path: string;
  name: string;
  kind: string;
  /** Entries under this one, including itself. 1 for a plain file. */
  entries: number;
  bytes: number;
}

export interface DeletePlan {
  directory: string;
  targets: DeleteTarget[];
  entries: number;
  bytes: number;
  risk: DeleteRisk;
  /** What has to be typed, as the server will recompute it. */
  token: string;
  command: string;
  needsElevation: boolean;
  threshold: number;
}

export interface DeleteOutcome {
  path: string;
  ok: boolean;
  entries: number;
  bytes: number;
  code?: string;
  message?: string;
}

export interface DeleteResult {
  results: DeleteOutcome[];
  entriesRemoved: number;
  bytesFreed: number;
  failed: number;
}

export async function planDelete(
  hostId: string,
  paths: readonly string[],
  csrfToken: string | null,
): Promise<DeletePlan> {
  return (await apiRequest("/fs/delete/plan", {
    method: "POST",
    body: { hostId, paths },
    csrfToken,
  })) as DeletePlan;
}

export async function deletePaths(
  hostId: string,
  paths: readonly string[],
  confirmation: string,
  csrfToken: string | null,
): Promise<DeleteResult> {
  return (await apiRequest("/fs/delete", {
    method: "POST",
    body: { hostId, paths, confirmation },
    csrfToken,
  })) as DeleteResult;
}
