import { apiRequest } from "@lib/api/client";

/**
 * chmod, chown, and the count behind the recursive checkbox (TRE-21).
 *
 * Mirrors `nest-api/src/fs/permissions.service.ts`, restated rather than
 * imported for the same reason the listing types are: the two packages share
 * no types package, and a field that drifts should fail here at the first
 * render rather than render `undefined`.
 */

export interface PathOutcome {
  path: string;
  ok: boolean;
  /** Entries changed under this path — more than one only when recursive. */
  entries: number;
  code?: string;
  message?: string;
}

export interface ChangeResult {
  results: PathOutcome[];
  changed: number;
  failed: number;
  skippedLinks: number;
  unreadable: string[];
  /** Entries left untouched because they are denylisted on the host (TRE-52). */
  refused: string[];
}

export interface CountResult {
  path: string;
  entries: number;
  /** True when the tree is bigger than the ceiling, so `entries` is a floor. */
  exceeded: boolean;
  ceiling: number;
  skippedLinks: number;
  unreadable: number;
  /** Denylisted entries a recursive change would step over, already excluded from `entries`. */
  refused: number;
}

export interface ModeChange {
  hostId: string;
  paths: string[];
  /** Octal digits, as typed: "0644". Never a number — see the DTO. */
  mode: string;
  recursive?: boolean;
}

export interface OwnerChange {
  hostId: string;
  paths: string[];
  owner?: string;
  group?: string;
  recursive?: boolean;
}

export async function changeMode(input: ModeChange, csrfToken: string | null): Promise<ChangeResult> {
  return (await apiRequest("/fs/chmod", { method: "POST", body: input, csrfToken })) as ChangeResult;
}

export async function changeOwner(input: OwnerChange, csrfToken: string | null): Promise<ChangeResult> {
  return (await apiRequest("/fs/chown", { method: "POST", body: input, csrfToken })) as ChangeResult;
}

export async function fetchEntryCount(hostId: string, path: string): Promise<CountResult> {
  const query = new URLSearchParams({ hostId, path });
  return (await apiRequest(`/fs/count?${query}`)) as CountResult;
}
