import { apiRequest } from "@lib/api/client";

import type { FileRowDetail } from "@lib/api/fs";

/**
 * Making a new entry (TRE-69), against `POST /fs/mkdir` and `POST /fs/create`.
 *
 * Both take a containing directory and a single name, never a path — which is
 * the API's rule and not a convenience here. The modal has a name field and a
 * directory it did not choose; there is nothing on this side that would join
 * the two, and that is deliberate.
 *
 * Both answer with the created entry, statted, so the caller can put the cursor
 * on it without waiting for a listing to come back and tell it what it looks
 * like.
 */

export interface CreateEntryInput {
  hostId: string;
  /** The directory it goes in. */
  path: string;
  /** One segment. The server refuses `/`, `.`, `..` and the rest at its DTO. */
  name: string;
}

export async function createDirectory(input: CreateEntryInput, csrfToken: string | null): Promise<FileRowDetail> {
  return (await apiRequest("/fs/mkdir", { method: "POST", body: input, csrfToken })) as FileRowDetail;
}

export async function createFile(input: CreateEntryInput, csrfToken: string | null): Promise<FileRowDetail> {
  return (await apiRequest("/fs/create", { method: "POST", body: input, csrfToken })) as FileRowDetail;
}
