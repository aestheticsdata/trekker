/**
 * The preview cache's two bounds, and its ownership of object URLs (TRE-138).
 *
 * The ticket's claim is measurable — "fifty selections in turn leave no more
 * than the cache's bound alive" — and this measures it rather than trusting
 * the eviction loop to have been read correctly. There is still no test
 * runner in `front/` (TRE-39), so it follows the verify-script convention:
 *
 *   node scripts/verify-preview-cache.ts     (or: pnpm verify:preview-cache)
 *
 * `URL.revokeObjectURL` is replaced with a recorder before anything runs, so
 * every URL the module ever holds ends the run in exactly one of two states:
 * alive in the cache, or revoked. A URL in both is a use-after-free waiting
 * for a rerender; a URL in neither is the leak the cache exists to prevent.
 */
import {
  CACHE_MAX_BYTES,
  CACHE_MAX_ENTRIES,
  previewCacheState,
  recallPreview,
  rememberPreview,
} from "../src/components/explorer/preview-cache.ts";

const revoked: string[] = [];
(URL as { revokeObjectURL: (url: string) => void }).revokeObjectURL = (url: string) => {
  revoked.push(url);
};

let checked = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  checked += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// --- fifty selections, one megabyte each --------------------------------
const MB = 1_000_000;
const urls: string[] = [];
for (let i = 0; i < 50; i += 1) {
  const url = `blob:trekker/fifty-${i}`;
  urls.push(url);
  rememberPreview(`fifty-${i}`, url, MB);
}

let state = previewCacheState();
check("fifty selections leave no more than the entry bound alive", state.count <= CACHE_MAX_ENTRIES, `${state.count} alive`);
check("…and no more than the byte bound", state.bytes <= CACHE_MAX_BYTES, `${state.bytes} bytes`);
check("every evicted URL was revoked, none twice", revoked.length === 50 - state.count, `${revoked.length} revoked`);
check(
  "each URL is alive or revoked, never both, never neither",
  urls.every((url, i) => revoked.includes(url) !== (recallPreview(`fifty-${i}`) === url)),
);

// --- the byte bound bites before the entry bound can --------------------
for (let i = 0; i < 5; i += 1) rememberPreview(`heavy-${i}`, `blob:trekker/heavy-${i}`, 8 * MB);
state = previewCacheState();
check("five 8 MB entries respect the byte bound", state.bytes <= CACHE_MAX_BYTES, `${state.bytes} bytes`);

// --- recall freshens: the entry just used is not the one evicted --------
for (let i = 0; i < CACHE_MAX_ENTRIES; i += 1) rememberPreview(`lru-${i}`, `blob:trekker/lru-${i}`, 1);
recallPreview("lru-0");
rememberPreview("lru-extra", "blob:trekker/lru-extra", 1);
check("recalling an entry saves it from the next eviction", recallPreview("lru-0") === "blob:trekker/lru-0");
check("…which falls on the least recently used instead", recallPreview("lru-1") === null);

// --- a raced double-fetch of one key orphans nothing --------------------
rememberPreview("race", "blob:trekker/race-loser", 1);
rememberPreview("race", "blob:trekker/race-winner", 1);
check("re-remembering a key revokes the superseded URL", revoked.includes("blob:trekker/race-loser"));
check("…and serves the newer one", recallPreview("race") === "blob:trekker/race-winner");

console.log(`\n${checked - failures}/${checked} checks passed.`);
process.exit(failures === 0 ? 0 : 1);
