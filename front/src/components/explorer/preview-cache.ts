/**
 * The preview cache (TRE-138): the last few images, held as object URLs, so
 * stepping back to the file just left does not cross SSH again.
 *
 * Bounded twice, on purpose. A count alone is not a bound on memory — four
 * entries of a megabyte and four of eight are different amounts of it — and a
 * byte bound alone would let a run of tiny icons evict nothing forever. The
 * cache owns every URL it holds: eviction revokes, and nothing else may,
 * because a URL revoked while cached would hand the next recall a string that
 * draws nothing. `scripts/verify-preview-cache.ts` measures both bounds and
 * the revocations rather than assuming them.
 *
 * The one deliberate leniency: the newest entry is never evicted, even over
 * the byte bound, so a single image bigger than the whole budget still shows.
 * With the server's default 8 MB ceiling that case cannot arise; an install
 * that raises the ceiling past the budget gets a cache of one rather than a
 * preview of nothing.
 */

export const CACHE_MAX_ENTRIES = 8;
export const CACHE_MAX_BYTES = 32_000_000;

interface CacheEntry {
  url: string;
  bytes: number;
}

/** Insertion order is recency order: recall re-inserts, eviction takes oldest. */
const entries = new Map<string, CacheEntry>();
let heldBytes = 0;

/** The cached URL for this key, freshened, or null and the caller fetches. */
export function recallPreview(key: string): string | null {
  const entry = entries.get(key);
  if (entry === undefined) return null;
  entries.delete(key);
  entries.set(key, entry);
  return entry.url;
}

export function rememberPreview(key: string, url: string, bytes: number): void {
  // Two fetches of one key can race through an unmount; the loser's URL must
  // not be orphaned, so the incumbent is revoked before being replaced.
  const previous = entries.get(key);
  if (previous !== undefined) {
    entries.delete(key);
    heldBytes -= previous.bytes;
    URL.revokeObjectURL(previous.url);
  }

  entries.set(key, { url, bytes });
  heldBytes += bytes;

  for (const [oldKey, old] of entries) {
    if (entries.size <= CACHE_MAX_ENTRIES && heldBytes <= CACHE_MAX_BYTES) break;
    if (oldKey === key) break;
    entries.delete(oldKey);
    heldBytes -= old.bytes;
    URL.revokeObjectURL(old.url);
  }
}

/** For the verify script: what is alive right now. */
export function previewCacheState(): { count: number; bytes: number } {
  return { count: entries.size, bytes: heldBytes };
}
