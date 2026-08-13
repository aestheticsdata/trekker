import { apiRequest } from "@lib/api/client";

/**
 * Rename, single and by pattern (TRE-22).
 *
 * Mirrors `nest-api/src/fs/rename-plan.ts` and `rename.service.ts`, restated
 * rather than imported for the same reason the listing types are: the two
 * packages share no types package, and a field that drifts should fail here at
 * the first render rather than render `undefined`.
 *
 * Note what is *not* here: any function that computes a new name. The preview
 * the modal draws comes from the server, from the same code that applies it.
 * A local implementation would be faster and would eventually disagree, and the
 * disagreement's first symptom is a file that no longer exists.
 */

export type ProblemCode = "duplicate" | "exists" | "empty" | "separator" | "relative" | "nul" | "toolong";

export interface RenameProblem {
  code: ProblemCode;
  message: string;
  collidesWith?: string;
}

export interface RenameMapping {
  name: string;
  next: string;
  changed: boolean;
  /** Character offsets into `name`, for the highlighted span. Null if unmatched. */
  match: { index: number; length: number } | null;
  problem: RenameProblem | null;
}

export interface RenamePlan {
  mappings: RenameMapping[];
  changed: number;
  /** The engine's message when the pattern will not compile, null otherwise. */
  error: string | null;
  directory: string;
}

export interface RenameOutcome {
  name: string;
  next: string;
  ok: boolean;
  code?: string;
  message?: string;
}

export interface RenameResult {
  directory: string;
  renamed: number;
  results: RenameOutcome[];
  rolledBack: string[];
  /** Entries left under a temporary name by a failure. Loud in the UI on purpose. */
  stranded: string[];
}

export interface PatternInput {
  hostId: string;
  paths: string[];
  pattern: string;
  replacement: string;
  global?: boolean;
  ignoreCase?: boolean;
}

export async function previewRename(input: PatternInput, csrfToken: string | null): Promise<RenamePlan> {
  return (await apiRequest("/fs/rename/preview", { method: "POST", body: input, csrfToken })) as RenamePlan;
}

export async function applyRename(input: PatternInput, csrfToken: string | null): Promise<RenameResult> {
  return (await apiRequest("/fs/rename/batch", { method: "POST", body: input, csrfToken })) as RenameResult;
}

export async function renameEntry(
  input: { hostId: string; path: string; newName: string },
  csrfToken: string | null,
): Promise<RenameResult> {
  return (await apiRequest("/fs/rename", { method: "POST", body: input, csrfToken })) as RenameResult;
}
