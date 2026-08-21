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
import {
  DANGER_FILL,
  DANGER_INK,
  ON_FILL,
  PRESS,
  PRESS_FILL,
  PRESS_HOVER_FILL,
  PRESS_INK,
  SELECTED,
  SELECTED_FILL,
} from "../src/helpers/press.ts";
import {
  COMMAND_SURFACE,
  ELEVATE_FILL,
  ELEVATE_INK,
  MODAL_SURFACE,
  PROMPT_ELEVATED_INK,
  PROMPT_INK,
  SUDO_INK,
  SUDO_SURFACE,
} from "../src/helpers/sudo.ts";
import {
  MOCKUP_STATUS_HEX,
  STATUS_INK,
  TAIL_BODY_INK,
  TAIL_BUTTON_FILL,
  TAIL_BUTTON_INK,
  TAIL_HEADER_INK,
  TAIL_NOTE_INK,
  TAIL_SURFACE,
} from "../src/helpers/tail.ts";
import {
  PROMPT_CHAR_INK,
  PROMPT_WHERE_INK,
  PROMPT_WHO_INK,
  TERMINAL_BAR,
  TERMINAL_DONE_INK,
  TERMINAL_ECHO_INK,
  TERMINAL_ERROR_INK,
  TERMINAL_HINT_INK,
  TERMINAL_LABEL_INK,
  TERMINAL_OUTPUT_INK,
  TERMINAL_QUIET_INK,
  TERMINAL_SURFACE,
  TERMINAL_TABLE_INK,
  TERMINAL_TITLE_INK,
} from "../src/helpers/terminal.ts";
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

/*
 * The sudo chrome (TRE-29). Every one of these says whether the next operation
 * runs as root, which makes an unreadable one worse than no indicator at all —
 * it would be an indicator somebody stops checking.
 */
console.log("\n--- the sudo chrome (TRE-29) ---");
check("badge and modal header", SUDO_INK, SUDO_SURFACE);
check("# on a command preview", PROMPT_ELEVATED_INK, COMMAND_SURFACE);
check("$ on a command preview", PROMPT_INK, COMMAND_SURFACE);
check("the elevated note", PROMPT_ELEVATED_INK, MODAL_SURFACE);
check("the elevate button", ELEVATE_INK, ELEVATE_FILL);

/*
 * The live tail's strip (TRE-34). The status inks are the reason this block
 * exists: a colour that says "this request failed" is worth nothing if the
 * reader has to squint at it, and all three of the mockup's fail AA on the
 * ground the mockup itself draws them on.
 *
 * The ground is the other half of it. `--color-pane-sunk` is one step below the
 * pane, and that one step is enough to break an ink that clears AA on the pane
 * — which is why every ink the strip carries is measured here rather than
 * inherited on the strength of already passing somewhere lighter.
 */
console.log("\n--- the live tail strip (TRE-34) ---");
check("the file name in the header", TAIL_HEADER_INK, TAIL_SURFACE);
check("a line of the log", TAIL_BODY_INK, TAIL_SURFACE);
check("a gap or rotation marker", TAIL_NOTE_INK, TAIL_SURFACE);
check("status 2xx and 3xx", STATUS_INK.ok, TAIL_SURFACE);
check("status 4xx", STATUS_INK.client, TAIL_SURFACE);
check("status 5xx", STATUS_INK.server, TAIL_SURFACE);
// The picker's buttons are the one thing in the strip that changes colour under
// the pointer, so both of their grounds have to hold.
check("a picker button, hovered", TAIL_BODY_INK, "bg-pane-hover");
check("retry and follow", TAIL_BUTTON_INK, TAIL_BUTTON_FILL);

console.log("\n--- the terminal (TRE-35) ---");
// Seven kinds of line on the panel's own ground, which is a step below every
// other surface in the app — so nothing measured elsewhere carries over.
check("the line somebody typed", TERMINAL_ECHO_INK, TERMINAL_SURFACE);
check("a scalar answer", TERMINAL_OUTPUT_INK, TERMINAL_SURFACE);
check("a table of them", TERMINAL_TABLE_INK, TERMINAL_SURFACE);
check("something that changed", TERMINAL_DONE_INK, TERMINAL_SURFACE);
check("a refusal", TERMINAL_ERROR_INK, TERMINAL_SURFACE);
check("the line under a refusal", TERMINAL_HINT_INK, TERMINAL_SURFACE);
check("the opening line", TERMINAL_QUIET_INK, TERMINAL_SURFACE);
// The prompt row sits on the panel; the header sits on `chrome`, one step up,
// because the mockup puts a lid on the hole rather than a sixth bar.
check("who the next line runs as", PROMPT_WHO_INK, TERMINAL_SURFACE);
check("where it runs", PROMPT_WHERE_INK, TERMINAL_SURFACE);
check("the `$`", PROMPT_CHAR_INK, TERMINAL_SURFACE);
// TRE-29's amber, unchanged and now on a second surface. This one is the
// signal, so it is the one that must not be marginal anywhere.
check("the `#`, elevated", PROMPT_ELEVATED_INK, TERMINAL_SURFACE);
check("the word TERMINAL", TERMINAL_TITLE_INK, TERMINAL_BAR);
check("the header beside it, and its two buttons", TERMINAL_LABEL_INK, TERMINAL_BAR);

/*
 * The pair those two buttons would have worn, which was somebody's next ticket
 * and is now TRE-78's answer.
 *
 * `bg-accent` with `text-on-accent` is what this app reached for whenever
 * something was the thing to press — the ⌘K chip, every modal's confirm, every
 * permission toggle — and it measured 3.62:1, under AA at every size in all
 * fourteen places. The fill moved rather than the ink, because nothing in this
 * palette clears 4.5:1 against `--color-accent` from either side.
 *
 * Both halves of the replacement are checked below, and so is the ink that was
 * on the delete button: dark navy on dark red, 1.88:1, the worst pair in the
 * app and on the one action it cannot undo.
 */
console.log("\n--- the thing to press (TRE-78) ---");
check("a filled control at rest", PRESS_INK, PRESS_FILL);
check("and under the pointer", PRESS_INK, PRESS_HOVER_FILL);
check("the destructive confirm", DANGER_INK, DANGER_FILL);
// The thinnest margin that ships here, and the reason it now has a name: as six
// inline literals it was a pair no check could see.
check("the current cell of a segmented control", PRESS_INK, SELECTED_FILL);

/*
 * And the composed string, which no amount of measuring would catch.
 *
 * `PRESS` has to be a literal — Tailwind's scanner reads source text, so a
 * class name built at runtime is one that never gets generated — which means
 * the app ships a string the checks above never look at. A typo in it would
 * leave a button with no fill at all and every ratio here still passing. So the
 * literal is asserted against the constants it is made of.
 */
for (const [name, composed, parts] of [
  ["PRESS", PRESS, [PRESS_FILL, PRESS_INK, `hover:${PRESS_HOVER_FILL}`]],
  // `ON_FILL` is the same fill and ink with no hover, so its ratios are the two
  // already checked above; what is worth asserting is that it is still made of
  // them, and has not drifted onto a colour nothing here measures.
  ["ON_FILL", ON_FILL, [PRESS_FILL, PRESS_INK]],
  ["SELECTED", SELECTED, [SELECTED_FILL, PRESS_INK]],
] as const) {
  const missing = parts.filter((part) => !composed.split(" ").includes(part));
  checked += 1;
  if (missing.length === 0) {
    console.log(`  ok   ${name} is made of the constants measured above`);
    continue;
  }
  failures += 1;
  console.log(`  FAIL ${name} is missing ${missing.join(", ")}`);
}

/*
 * What it replaced, kept as a measurement rather than a memory.
 *
 * `--color-accent` is still the right colour for an edge, a bar and the active
 * pane's border. It is only a fill carrying text that it cannot be, and the
 * number is the reason — printed so that the next person to reach for it finds
 * this line instead of shipping 3.62:1 again.
 */
const onAccent = ratio(hexOf("text-on-accent"), hexOf("bg-accent"));
console.log(
  `  --   what it replaced: on-accent over accent  ${onAccent.toFixed(2).padStart(5)}:1  ${verdict(onAccent)}`,
);
const onDanger = ratio(hexOf("text-on-accent"), hexOf(DANGER_FILL));
console.log(
  `  --   and on the delete button                 ${onDanger.toFixed(2).padStart(5)}:1  ${verdict(onDanger)}`,
);

/*
 * And the ink the strip would have inherited without being measured.
 *
 * `--color-on-pane-muted` is this app's ordinary colour for a quiet line on a
 * pane and clears AA there at 4.74:1. One step down onto the strip it is
 * 4.35:1 and does not. Printed rather than checked, like `ink-faint` in the
 * bubble above: it is not a pair that ships, it is the reason a pair that would
 * have shipped does not.
 */
const muted = ratio(hexOf("text-on-pane-muted"), hexOf(TAIL_SURFACE));
console.log(`  --   on-pane-muted, which the pane passes  ${muted.toFixed(2).padStart(5)}:1  ${verdict(muted)}`);

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

/**
 * The mockup's own three status inks, on the mockup's own ground.
 *
 * Same treatment as the band ramp above and for the same reason: three of these
 * are why the tokens differ from the drawing, and a decision to overrule a
 * mockup should be readable as a measurement rather than as taste.
 */
console.log("\n--- for the record: the mockup's own status inks, which is why ours differ ---");
for (const [name, hex] of Object.entries(MOCKUP_STATUS_HEX)) {
  const measured = ratio(hex, hexOf(TAIL_SURFACE));
  const ours = ratio(hexOf(STATUS_INK[name as keyof typeof STATUS_INK]), hexOf(TAIL_SURFACE));
  console.log(
    `  ${name.padEnd(7)} ${hex}  ${measured.toFixed(2).padStart(5)} ${verdict(measured).padEnd(15)}` +
      `→ ours ${ours.toFixed(2).padStart(5)} ${verdict(ours)}`,
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
