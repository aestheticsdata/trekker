import { createHash } from "node:crypto";

/**
 * Deterministic identifiers and randomness for the fixtures (TRE-140).
 *
 * Two `pnpm mock` runs must leave the database in the same state, and the
 * ids are part of that state — a view whose id changes on every load is a
 * bookmark in somebody's browser that stops working every morning. So every
 * id here is a function of a name, never of the clock or of `randomUUID`.
 *
 * `ActivityLog` is the one table with a second requirement: the API pages it
 * by `id` and calls that time-ordered, because Prisma hands it a uuid v7. Its
 * fixture ids are built as uuid v7 from the manifest's fixed reference plus
 * each row's offset — a time, but not the clock — with the random half
 * derived from the row's name. The rows sort among themselves as their
 * timestamps do, everything the app writes later sorts after them, and the
 * ids are the same on every load.
 */

/** A uuid whose first 48 bits are the millisecond, RFC 9562 version 7 shape. */
export function uuidV7(timestampMs: number, key: string): string {
  const ms = Math.max(0, Math.trunc(timestampMs));
  const time = ms.toString(16).padStart(12, "0");
  // 74 bits of "random", taken from a hash of the key so they are stable.
  const tail = createHash("sha256").update(`v7:${key}`).digest("hex");
  const rand12 = tail.slice(0, 3);
  const rand62 = tail.slice(3, 19);
  const variant = ((parseInt(rand62[0], 16) & 0x3) | 0x8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${rand12}-${variant}${rand62.slice(1, 4)}-${rand62.slice(4, 16)}`;
}

/**
 * A stable uuid-shaped id for rows that carry no time of their own — hosts,
 * views, bookmarks, jobs. Version 4 shape so nothing downstream reads a
 * timestamp out of it.
 */
export function stableUuid(key: string): string {
  const hex = createHash("sha256").update(`v4:${key}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A small seeded generator, so a log file with three thousand lines is the
 * same three thousand lines on every machine and every run. mulberry32: not
 * cryptographic, not meant to be.
 */
export function seededRandom(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in `[min, max]` from a generator. */
export function pick(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** One of the items, weighted by the numbers beside them. */
export function choose<T>(random: () => number, items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = random() * total;
  for (const [item, weight] of items) {
    cursor -= weight;
    if (cursor <= 0) return item;
  }
  return items[items.length - 1][0];
}
