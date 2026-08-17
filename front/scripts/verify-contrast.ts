/**
 * Every colour this app puts text on, measured (TRE-33 §3).
 *
 * The ticket asks for the heat map's buckets to pass WCAG AA "checked, not
 * eyeballed", and the reason is specific: the ramp runs dark to light across
 * seven steps on a pane that is already light, so the chip that is comfortably
 * legible at bucket 0 is the one that fails at bucket 3 — and it fails by a
 * margin no one notices while looking at it. The mockup flips the text colour
 * at the midpoint for exactly this reason, and that flip is load-bearing rather
 * than decorative. This is what says so.
 *
 *   node scripts/verify-contrast.ts        (or: pnpm verify:contrast)
 *
 * Node runs the TypeScript directly, so this costs the package no dependency.
 *
 * Two halves are checked, and both are read from the code that ships rather
 * than restated here — a check with its own copy of the palette is a check of
 * the copy. The class names come from the real tables in `src/helpers`, and the
 * hexes are parsed out of `styles/globals.css`, so a token edited in one place
 * and not the other fails here rather than in somebody's eyes.
 *
 * The one judgement in the file is the threshold: 4.5:1, AA for normal text.
 * Not the 3:1 large-text allowance — every string measured here is between 9px
 * and 11px, which is the opposite of large.
 *
 * NOTE for anyone extending it: the class-to-token rule below is Tailwind's own
 * (`bg-x` and `text-x` both read `--color-x`), and it only holds for colour
 * utilities. A class with an opacity modifier — `bg-warning/15` — is a
 * different colour from its token and cannot be checked this way; such a pair
 * has to be composited against its backdrop first, which is why none are here.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WARN_CHIP_FILL, WARN_CHIP_INK } from "../src/helpers/disks.ts";
import { AGE_BUCKETS, HEAT, HEAT_OFF_INK, PANE_SURFACES } from "../src/helpers/heat.ts";
import { TOOLTIP_INK, TOOLTIP_LABEL_INK, TOOLTIP_SUBJECT_INK, TOOLTIP_SURFACE } from "../src/helpers/tooltip.ts";
import { BAND_CLASS, BAND_LABEL_INK, BAND_REST_CLASS, BAND_SIZE_INK } from "../src/helpers/treemap.ts";

/** WCAG 2.1 AA for text below 18.66px bold / 24px regular, which is all of it. */
const AA = 4.5;

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readTokens(join(here, "..", "styles", "globals.css"));

let checked = 0;
let failures = 0;

console.log(`--- the age ramp, bucket by bucket (AA is ${AA}:1) ---`);

for (const [bucket, paint] of HEAT.entries()) {
  const label = `${bucket} ${AGE_BUCKETS[bucket].label}`;

  if (paint.chip) {
    // A filled chip has one background and it is its own, so there is one
    // number and it is the whole story for that bucket.
    check(label, paint.ink, paint.chip);
    continue;
  }

  // An unfilled age sits on the row, and a row is one of five colours depending
  // on selection, hover and which pane holds the keyboard. All five have to
  // hold, so all five are measured — the lightest is not always the safest.
  for (const surface of PANE_SURFACES) {
    check(`${label} on ${surface.replace("bg-", "")}`, paint.ink, surface);
  }
}

console.log("\n--- and with the heat map off, where every age is plain text ---");
for (const surface of PANE_SURFACES) {
  check(`off, on ${surface.replace("bg-", "")}`, HEAT_OFF_INK, surface);
}

console.log("\n--- treemap bands, both lines ---");
for (const [index, band] of [...BAND_CLASS, BAND_REST_CLASS].entries()) {
  const name = index === BAND_CLASS.length ? "rest" : `band ${index}`;
  check(`${name} name`, BAND_LABEL_INK, band);
  check(`${name} size`, BAND_SIZE_INK, band);
}

console.log("\n--- the chrome's warning chip ---");
check("stale marker", WARN_CHIP_INK, WARN_CHIP_FILL);

console.log("\n--- the tooltip bubble (TRE-76) ---");
check("subject", TOOLTIP_SUBJECT_INK, TOOLTIP_SURFACE);
check("value", TOOLTIP_INK, TOOLTIP_SURFACE);
check("label and note", TOOLTIP_LABEL_INK, TOOLTIP_SURFACE);

/*
 * And the one this app would otherwise have reached for. `ink-faint` is the
 * colour of a quiet second line everywhere else in the chrome, which is exactly
 * why it has to be refused here in writing rather than in somebody's memory.
 *
 * Printed rather than checked, like the mockup's band ramp above: it is not a
 * pair that ships, it is the reason a pair that would have shipped does not.
 */
const faint = ratio(hexOf("text-ink-faint"), hexOf(TOOLTIP_SURFACE));
console.log(`  --   ink-faint, refused in the bubble    ${faint.toFixed(2).padStart(5)}:1  ${verdict(faint)}`);

/**
 * What the mockup shipped, kept as a demonstration rather than as a check.
 *
 * These are the six band colours from 2a. Three of them fail, which is why the
 * ramp above is not them — and printing the numbers is the only way that
 * decision stays reviewable rather than looking like a preference.
 */
console.log("\n--- for the record: the mockup's own band ramp, which is why ours differs ---");
for (const band of ["#0a4487", "#0a54a8", "#0b63c5", "#2f3b52", "#5b6478", "#7d8496"]) {
  const name = ratio(hexOf(BAND_LABEL_INK), band);
  const size = ratio(hexOf(BAND_SIZE_INK), band);
  console.log(
    `  ${band}  name ${name.toFixed(2).padStart(5)} ${verdict(name)}   size ${size.toFixed(2).padStart(5)} ${verdict(size)}`,
  );
}

console.log(`\n${checked - failures}/${checked} pairs pass AA at ${AA}:1.`);
process.exit(failures === 0 ? 0 : 1);

/* ---- the checks -------------------------------------------------------- */

function check(what: string, inkClass: string, backgroundClass: string): void {
  checked += 1;

  const ink = hexOf(inkClass);
  const background = hexOf(backgroundClass);
  const measured = ratio(ink, background);
  const line = `${what.padEnd(34)} ${ink} on ${background}  ${measured.toFixed(2).padStart(5)}:1`;

  if (measured >= AA) {
    console.log(`  ok   ${line}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL ${line}  — needs ${AA}:1`);
}

/** Tailwind's own rule: `bg-x` and `text-x` both resolve `--color-x`. */
function hexOf(utility: string): string {
  const token = `--color-${utility.replace(/^(bg|text)-/, "")}`;
  const hex = tokens.get(token);
  if (!hex) {
    // A missing token is a failure of this script's assumptions, not a colour
    // that happens to be illegible, so it stops rather than being counted.
    console.error(`\n${token} is not defined in globals.css — the class-to-token rule no longer holds.`);
    process.exit(2);
  }
  return hex;
}

function readTokens(path: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, hex] of readFileSync(path, "utf8").matchAll(/(--color-[a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) {
    found.set(name, hex.toLowerCase());
  }
  return found;
}

/* ---- WCAG 2.1, relative luminance and contrast ------------------------- */

function ratio(one: string, other: string): number {
  const first = luminance(one);
  const second = luminance(other);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * Relative luminance, straight out of WCAG 2.1.
 *
 * Written out rather than approximated with a lightness value: the gamma
 * expansion is the whole reason two colours that look a step apart can be three
 * times apart in luminance, and an approximation here would agree with the eye
 * and disagree with the standard.
 */
function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((byte) => {
    const scaled = byte / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function verdict(measured: number): string {
  return measured >= AA ? "AA" : measured >= 3 ? "large text only" : "fails";
}
