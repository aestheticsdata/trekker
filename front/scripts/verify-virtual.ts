/**
 * The row window, checked against the question it is answering (TRE-19).
 *
 * `rowWindow` is arithmetic pretending to be an optimisation, and the failure
 * mode of getting it wrong is not a crash — it is a row that is on screen and
 * not in the DOM, at one scroll position, at one row height, which nobody finds
 * by scrolling around for a minute. So it is checked by brute force instead:
 * for every position on a grid, walk all the rows, work out which ones actually
 * intersect the viewport, and insist the window contains them.
 *
 *   node scripts/verify-virtual.ts        (or: pnpm verify:virtual)
 *
 * The heights are not round numbers on purpose. `--ui-base` (TRE-44) turns a
 * 1.375rem row into 20px at the bottom of the range and 28 at the top, by way
 * of a percentage — so what the browser measures is fractional far more often
 * than not, and integer-only arithmetic passes a test that lies.
 *
 * There is no test runner in `front/` yet; TRE-39 brings one, and this moves
 * into it. Until then it follows the convention nest-api already uses.
 */
import { OVERSCAN, rowWindow } from "../src/helpers/virtual.ts";

let failures = 0;
let checks = 0;

function fail(what: string) {
  failures += 1;
  if (failures <= 12) console.log(`FAIL ${what}`);
}

/** Which rows genuinely touch the viewport, worked out one row at a time. */
function onScreen(count: number, height: number, scrollTop: number, viewport: number): number[] {
  const visible: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const top = index * height;
    if (top < scrollTop + viewport && top + height > scrollTop) visible.push(index);
  }
  return visible;
}

const COUNTS = [0, 1, 2, 17, 100, 999, 1_000, 10_000];
/** 20 / 22 / 28 are `--ui-base` 10, 11 and 14; the rest is what percentages do. */
const HEIGHTS = [20, 22, 23.454_5, 26.181_8, 28, 30.7];
const VIEWPORTS = [0, 19, 180, 421.5, 900];

for (const count of COUNTS) {
  for (const height of HEIGHTS) {
    for (const viewport of VIEWPORTS) {
      const total = count * height;
      // Every row boundary, every midpoint, plus the two ends and one position
      // past the end — the browser hands out all of those during a rubber-band.
      const positions = new Set<number>([0, -40, total, total + 60, Math.max(0, total - viewport)]);
      for (let index = 0; index <= count; index += Math.max(1, Math.floor(count / 40))) {
        positions.add(index * height);
        positions.add(index * height + height / 2);
        positions.add(index * height - 0.5);
      }

      for (const scrollTop of positions) {
        const window = rowWindow(count, height, scrollTop, viewport);
        checks += 1;
        const where = `count=${count} h=${height} vp=${viewport} top=${scrollTop.toFixed(1)}`;

        if (window.total !== count * height) fail(`${where}: total ${window.total}`);
        if (window.start < 0 || window.end > count || window.start > window.end) {
          fail(`${where}: range ${window.start}..${window.end}`);
        }
        if (window.offset !== window.start * height) fail(`${where}: offset ${window.offset}`);

        // The one that matters: nothing visible may be left unrendered.
        for (const index of onScreen(count, height, scrollTop, viewport)) {
          if (index < window.start || index >= window.end) fail(`${where}: row ${index} visible but not rendered`);
        }

        // And the other half of the bargain — a window that renders everything
        // is always correct and never virtualised.
        const ceiling = Math.ceil(viewport / height) + 2 * OVERSCAN + 2;
        if (window.end - window.start > Math.min(count, ceiling)) {
          fail(`${where}: rendered ${window.end - window.start}, ceiling ${ceiling}`);
        }
      }

      // The property the scroll listener leans on: two positions inside the
      // same row must produce the same window, or dropping those events drops
      // a render that would have changed something.
      if (count > 20) {
        const base = 7 * height;
        const a = rowWindow(count, height, base + 0.01, viewport);
        const b = rowWindow(count, height, base + height - 0.01, viewport);
        checks += 1;
        if (a.start !== b.start || a.end !== b.end) {
          fail(`count=${count} h=${height} vp=${viewport}: window moved inside one row`);
        }
      }
    }
  }
}

// Scrolled to the bottom, the last row has to be rendered — the case a reader
// meets by pressing End, and the one an off-by-one in `visible` hides from.
for (const count of [17, 1_000, 10_000]) {
  for (const height of HEIGHTS) {
    const viewport = 421.5;
    const window = rowWindow(count, height, count * height - viewport, viewport);
    checks += 1;
    if (window.end !== count) fail(`bottom count=${count} h=${height}: end ${window.end}`);
  }
}

// An unmeasured probe renders nothing rather than guessing a height.
for (const height of [0, -1]) {
  const window = rowWindow(500, height, 0, 400);
  checks += 1;
  if (window.end !== 0 || window.start !== 0) fail(`height=${height}: rendered ${window.start}..${window.end}`);
}

console.log("\n--- how much stays in the DOM ---");
for (const count of [100, 1_000, 10_000]) {
  const window = rowWindow(count, 22, 0, 421.5);
  console.log(`${String(count).padStart(6)} entries -> ${window.end - window.start} rows rendered`);
}

console.log(`\n${checks - failures}/${checks} assertions held.`);
if (failures > 12) console.log(`(${failures - 12} further failures not printed)`);
process.exit(failures === 0 ? 0 : 1);
