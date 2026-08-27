import type { ScanLevel } from "@lib/api/scans";

/**
 * One level of a scan, turned into the strip's bands (TRE-33 §2).
 *
 * Two rules run through this file.
 *
 * **The bands sum to the level, exactly.** A `du` level is a partition — the
 * server already folds everything it did not keep into an `OTHER` row so the
 * children add up to the parent — and a strip whose bands do not fill it is a
 * strip that has quietly lost a terabyte. So the tail is computed by
 * subtraction from `parentBytes` rather than by adding up what is drawn, and
 * the widths are flex shares rather than percentages: the gaps between bands
 * come out of the row's own width, so the sum stays exact at any size.
 *
 * **The geometry comes from the bytes, never from `percent`.** The server
 * rounds that field per row, and says so — "a percentage is a label and the
 * bytes are the truth". Six labels rounded to whole percent do not sum to a
 * hundred, and a strip built from them is a strip with a seam in it.
 *
 * The arithmetic is `BigInt` until the last step. A scan of a large array
 * outgrows a double, and a share computed from two numbers that have already
 * lost their low bits is a rectangle drawn from a rounding error.
 *
 * Deliberately a leaf module, importing nothing but a type: `verify-contrast.ts`
 * runs under bare `node`, where the `@helpers/…` aliases do not resolve, and it
 * has to read the band ramp below from the file that ships it. Anything needing
 * the rest of the app — deciding where clicking a band takes a pane, say —
 * belongs to the component and not here.
 */

/** Named bands before the rest folds together. Five plus the tail, as the mockup draws it. */
export const MAX_BANDS = 5;

/**
 * The band ramp, written out rather than composed as `bg-band-${index}`:
 * Tailwind reads the source for literal class names, and a token no utility
 * mentions is pruned from the stylesheet — a computed `var(--color-band-3)`
 * then resolves to nothing and the band is drawn in whatever is behind it.
 *
 * Here rather than in the component so that `verify-contrast.ts` can read it:
 * the ramp exists in this form *because* of a contrast failure in the mockup's
 * own colours, and a check looking at a second copy of it would be checking
 * nothing.
 *
 * Exactly `MAX_BANDS` entries, and the tail's neutral is deliberately not one
 * of them. A single seven-entry array indexed by loop position looks equivalent
 * and is not: the tail sits at index `named.length`, which is five only when
 * the level had five or more children to name. A directory with three would
 * have painted its fold the third ramp step — a saturated blue that reads as a
 * fourth finding rather than as the remainder.
 */
export const BAND_CLASS = ["bg-band-0", "bg-band-1", "bg-band-2", "bg-band-3", "bg-band-4"] as const;

/** The fold, whatever position it lands in. */
export const BAND_REST_CLASS = "bg-band-rest";

/** The two lines a band carries: its name, and its size with its share. */
export const BAND_LABEL_INK = "text-ink";
export const BAND_SIZE_INK = "text-brand";

/** Fixed-point scale for the one division, so a tiny child is a share and not a zero. */
const SCALE = 1_000_000n;

export interface TreemapBand {
  /**
   * The absolute path this band stands for, or null for the tail — which is a
   * sum rather than a directory and has no path on the host.
   */
  path: string | null;
  /**
   * Whether `path` is somewhere a pane can open.
   *
   * A band can stand for one enormous file, and a pane cannot be pointed at a
   * file — the caller sends it to the directory holding it instead. False for
   * the tail, which is a sum and not anywhere.
   */
  isDirectory: boolean;
  /**
   * The API refuses this path however a pane reaches it (TRE-105) — Trekker's
   * own install, on the local denylist because the master key sits in it.
   *
   * A separate flag from `isDirectory` because it says something different: the
   * band has a real path and a real size, and still goes nowhere. False when
   * the server said nothing, which includes every account that is not the
   * owner and every host that is not the local one.
   */
  denied: boolean;
  /** What to print: the last segment for a child, "rest" for the tail. */
  label: string;
  bytes: number;
  /** 0-1. The band's flex share, and what the printed percentage is rounded from. */
  share: number;
}

/**
 * The bands, largest first, with everything past the fifth folded into one.
 *
 * The fold is ours rather than the server's: it keeps up to twenty-four
 * children per parent so a client can choose, and a 30px strip has room for
 * about six labels. Folding here means the tail includes both the children we
 * dropped and the `OTHER` row the server had already folded, which is the only
 * way the arithmetic stays a partition.
 */
export function treemapBands(level: ScanLevel): TreemapBand[] {
  const total = toBytes(level.parentBytes);
  if (total <= 0n) return [];

  // The server already orders by bytes descending; sorted again here because
  // "largest first" is what makes the ramp mean anything, and inheriting an
  // order rather than establishing one is how a strip ends up shaded at random.
  const named = level.entries
    .filter((entry) => entry.kind !== "OTHER")
    .sort((left, right) => {
      const a = toBytes(left.bytes);
      const b = toBytes(right.bytes);
      return a > b ? -1 : a < b ? 1 : left.path.localeCompare(right.path);
    })
    .slice(0, MAX_BANDS);

  const bands: TreemapBand[] = named.map((entry) => ({
    path: entry.path,
    isDirectory: entry.kind === "DIRECTORY",
    denied: entry.denied === true,
    label: lastSegment(entry.path),
    bytes: Number(entry.bytes),
    share: shareOf(toBytes(entry.bytes), total),
  }));

  const rest = named.reduce((left, entry) => left - toBytes(entry.bytes), total);
  // Strictly positive: a level whose children already fill it has no tail, and a
  // zero-width band with a label is a sliver nobody can read or click.
  if (rest > 0n) {
    bands.push({
      path: null,
      isDirectory: false,
      denied: false,
      label: "rest",
      bytes: Number(rest),
      share: shareOf(rest, total),
    });
  }

  return bands;
}

/**
 * A byte count off the wire, and zero for anything that is not one.
 *
 * `BigInt("")` throws where `Number("")` merely gives `NaN`, and a throw inside
 * a render reaches the app's error boundary — so one malformed row in a scan
 * level would replace the whole explorer with an error page rather than one
 * missing rectangle. The server always sends `.toString()` of a bigint; this is
 * for the day it does not.
 */
function toBytes(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * A share as a ratio, computed in `BigInt` and converted once.
 *
 * Scaled by a million first, so a child worth a millionth of its parent is a
 * share rather than a zero — the division would otherwise floor to nothing long
 * before the band became invisible.
 */
function shareOf(bytes: bigint, total: bigint): number {
  return Number((bytes * SCALE) / total) / Number(SCALE);
}

/**
 * The last segment, which is what a band has room for.
 *
 * The full path is what the band's `title` carries; two levels down, every
 * child shares a prefix and the prefix is what would survive the ellipsis.
 */
function lastSegment(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
