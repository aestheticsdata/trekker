import { apiRequest } from "@lib/api/client";

/**
 * Signed links (TRE-66).
 *
 * Unlike the download beside it, minting a link *is* an ordinary JSON call —
 * what comes back is a URL, not a file. The URL is the whole product: it
 * carries the grant, so anything that can read it can fetch the file, which is
 * why this is the one API response in the app worth being careful about where
 * it is put.
 */

export interface MintedLink {
  url: string;
  /** ISO 8601. Rendered as a time rather than a countdown. */
  expiresAt: string;
  expiresInSeconds: number;
  filename: string;
}

export async function mintLink(
  hostId: string,
  path: string,
  csrfToken: string | null,
  ttlSeconds?: number,
): Promise<MintedLink> {
  return (await apiRequest("/link/mint", {
    method: "POST",
    body: { hostId, path, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) },
    csrfToken,
  })) as MintedLink;
}
