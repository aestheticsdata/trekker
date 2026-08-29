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

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WARN_CHIP_FILL, WARN_CHIP_INK } from "../src/helpers/disks.ts";
import { AGE_BUCKETS, HEAT, HEAT_OFF_INK, PANE_SURFACES } from "../src/helpers/heat.ts";
import { MARK_ON_PANE, MARK_ON_PANEL, MOCKUP_LINK_HEX } from "../src/helpers/listing.ts";
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
  FALLBACK_INK,
  ICON_INK,
  ICON_ON_INK,
  KEY_INK,
  PALETTE_INPUT_INK,
  PALETTE_LABEL_INK,
  PALETTE_QUIET_INK,
  PALETTE_SURFACE,
  ROW_DANGER_INK,
  ROW_DETAIL_INK,
  ROW_DETAIL_ON_INK,
  ROW_FILL,
  ROW_LABEL_INK,
  ROW_LABEL_ON_INK,
  ROW_OFF_INK,
} from "../src/helpers/palette.ts";
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
import {
  TOOLTIP_INK,
  TOOLTIP_LABEL_INK,
  TOOLTIP_SUBJECT_INK,
  TOOLTIP_SURFACE,
  TOOLTIP_WARNING_INK,
} from "../src/helpers/tooltip.ts";
import {
  CHIP_HOVER_FILL,
  CHIP_INK,
  CHIP_KEY_INK,
  CHIP_ON_FILL,
  CHIP_ON_INK,
  CHIP_ON_KEY_INK,
  DIRTY_DOT,
  FORM_LABEL_INK,
  FORM_QUIET_INK,
  FORM_SURFACE,
  FORM_VALUE_INK,
  MOCKUP_CHIP_FILL_HEX,
  MOCKUP_CHIP_INK_HEX,
  MOCKUP_QUIET_HEX,
  ROW_INK,
  ROW_KEY_INK,
  ROW_ON_FILL,
  ROW_ON_INK,
} from "../src/helpers/views.ts";
import { BAND_CLASS, BAND_LABEL_INK, BAND_REST_CLASS, BAND_SIZE_INK } from "../src/helpers/treemap.ts";

/** WCAG 2.1 AA for text below 18.66px bold / 24px regular, which is all of it. */
const AA = 4.5;

/**
 * 1.4.11, for the things in this app that are a shape rather than a string.
 *
 * There is exactly one set of them and it arrived with TRE-108: the folder
 * silhouette in the listing's gutter, and the 1px edge that is the whole of a
 * file's hollow pastille. They carry meaning — which of these can I walk into —
 * and they carry it with no text at all, which is the case 1.4.11 is written
 * for. Every other pair in this file is text and is measured at `AA`.
 */
const GRAPHIC = 3;

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readTokens(join(here, "..", "styles", "globals.css"));
const SRC = join(here, "..", "src");
const inkCache = new Map<string, Set<string>>();

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
// The collapsed strip (TRE-85) is the prompt row on the panel's own ground, so
// its parts are measured above. This one is the strip's alone: the hint that
// names the chord. It wears an ink already checked on this surface — named
// again here because the row it sits in is the one a person reads without
// opening anything, and a later change to the constant should fail under its
// own name rather than under the header's. The placeholder that once said what
// the terminal last answered went with TRE-115 — the strip invites now, it
// does not report.
check("the strip's `⌥↩ expand to terminal` hint", TERMINAL_LABEL_INK, TERMINAL_SURFACE);

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
 * on the delete button: dark navy on dark red, 1.83:1, the worst pair in the
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
 * pane. It cleared there at 4.74:1 and failed one step down onto the strip at
 * 4.35:1, which is why the note ink is `label` — and TRE-82 then darkened
 * `muted` far enough that it clears the sunk ground too. Still printed, and
 * still not a pair that ships: `tail.ts` keeps `label` for the reason it gives
 * itself, that the box has one voice, and the number no longer decides it.
 */
const muted = ratio(hexOf("text-on-pane-muted"), hexOf(TAIL_SURFACE));
console.log(`  --   on-pane-muted, which no longer fails  ${muted.toFixed(2).padStart(5)}:1  ${verdict(muted)}`);

/*
 * The ⌘K palette (TRE-36 §4), which has two grounds rather than one.
 *
 * Every row is drawn on the panel, and the row under the cursor is drawn on
 * `--color-line` — so the ink that says what an entry does has to clear on both
 * or it is illegible for exactly one row at a time, which is the row being read.
 *
 * Nothing between `ink-faint` and `ink-dim` clears anything on that fill: the
 * whole span from 2.61 to 4.82 is a wall. So the second line switches ink with
 * the row, as 2a already switches the icon and the label, rather than settling
 * on one value that is either too bright at rest or too dim when chosen.
 */
console.log("\n--- the ⌘K palette (TRE-36) ---");
check("what has been typed", PALETTE_INPUT_INK, PALETTE_SURFACE);
check("the `\u203a` and the group headers", PALETTE_LABEL_INK, PALETTE_SURFACE);
check("the count, the footer, the empty state", PALETTE_QUIET_INK, PALETTE_SURFACE);
check("what a row is called", ROW_LABEL_INK, PALETTE_SURFACE);
check("what it does", ROW_DETAIL_INK, PALETTE_SURFACE);
check("its glyph", ICON_INK, PALETTE_SURFACE);
check("a row that cannot run now", ROW_OFF_INK, PALETTE_SURFACE);
check("`rm`, which stays red in a list", ROW_DANGER_INK, PALETTE_SURFACE);
check("the key beside it", KEY_INK, PALETTE_SURFACE);
check("and the way out when nothing matched", FALLBACK_INK, PALETTE_SURFACE);
// The same rows again, on the fill the cursor puts under them.
check("the chosen row's name", ROW_LABEL_ON_INK, ROW_FILL);
check("what it does, lifted for that fill", ROW_DETAIL_ON_INK, ROW_FILL);
check("its glyph, lit", ICON_ON_INK, ROW_FILL);
check("a chosen row that cannot run", ROW_OFF_INK, ROW_FILL);
check("`rm` chosen", ROW_DANGER_INK, ROW_FILL);
check("the key beside a chosen row", KEY_INK, ROW_FILL);

console.log("\n--- the tooltip bubble (TRE-76) ---");
check("subject", TOOLTIP_SUBJECT_INK, TOOLTIP_SURFACE);
check("value", TOOLTIP_INK, TOOLTIP_SURFACE);
check("label and note", TOOLTIP_LABEL_INK, TOOLTIP_SURFACE);
check("a note that refuses", TOOLTIP_WARNING_INK, TOOLTIP_SURFACE);

/*
 * Saved views (TRE-37 §4). Two surfaces, and the chrome is the ground for both:
 * the strip lives in the top bar and the list lives in the sidebar, which are
 * the same colour. A chip and a row each have a second state, and the second
 * state is a different ground.
 */
console.log("\n--- the saved-views strip and list (TRE-37) ---");
const CHROME = "bg-chrome";
check("a view's name in the strip", CHIP_INK, CHROME);
check("its chord", CHIP_KEY_INK, CHROME);
check("the same, under the pointer", CHIP_INK, CHIP_HOVER_FILL);
check("and its chord there", CHIP_KEY_INK, CHIP_HOVER_FILL);
check("the restored view's name", CHIP_ON_INK, CHIP_ON_FILL);
check("and its chord", CHIP_ON_KEY_INK, CHIP_ON_FILL);
check("a view's name in the sidebar", ROW_INK, CHROME);
check("its chord", ROW_KEY_INK, CHROME);
check("the restored one's name", ROW_ON_INK, ROW_ON_FILL);
check("and its chord", ROW_KEY_INK, ROW_ON_FILL);

console.log("\n--- and the form that saves one ---");
check("the small caps above a field", FORM_LABEL_INK, FORM_SURFACE);
check("what each pane is on", FORM_VALUE_INK, FORM_SURFACE);
check("and how it is sorted", FORM_QUIET_INK, FORM_SURFACE);

/*
 * The unsaved marker, which is not text.
 *
 * WCAG 1.4.11 asks 3:1 of a graphical object against what is beside it, not the
 * 4.5:1 this file checks everything else at — so it is printed rather than run
 * through `check`, which would fail it on `line` at 3.90 and be wrong to.
 *
 * All three grounds are measured because the dot lands on all three: the bare
 * chrome of the top bar, the `raised` of a sidebar row, and the `line` fill of
 * the chip for the view currently restored.
 */
console.log("\n--- the amber dot, held to 1.4.11's 3:1 rather than 4.5:1 ---");
for (const ground of [CHROME, ROW_ON_FILL, CHIP_ON_FILL]) {
  const measured = ratio(hexOf(DIRTY_DOT), hexOf(ground));
  const enough = measured >= 3 ? "ok" : "FAILS 1.4.11";
  console.log(`  --   dot on ${ground.replace("bg-", "").padEnd(20)} ${measured.toFixed(2).padStart(5)}:1  ${enough}`);
}

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

/*
 * And the palette's own two (TRE-36 §4), on the two grounds it draws on.
 *
 * Same treatment: the mockup's number beside ours, so the correction stays
 * reviewable rather than becoming a colour somebody once changed.
 */
console.log("\n--- for the record: 2a's own palette inks, which is why ours differ ---");
for (const [what, mockup, ground, ours] of [
  ["group headers, ›", "#3e8fae", PALETTE_SURFACE, PALETTE_LABEL_INK],
  ["count, footer, empty state", "#4d7f99", PALETTE_SURFACE, PALETTE_QUIET_INK],
  ["a row's second line", "#4d7f99", PALETTE_SURFACE, ROW_DETAIL_INK],
  ["the same, on the chosen row", "#4d7f99", ROW_FILL, ROW_DETAIL_ON_INK],
] as const) {
  const theirs = ratio(mockup, hexOf(ground));
  const mine = ratio(hexOf(ours), hexOf(ground));
  console.log(
    `  ${what.padEnd(28)} ${mockup}  ${theirs.toFixed(2).padStart(5)} ${verdict(theirs).padEnd(15)}` +
      `→ ours ${mine.toFixed(2).padStart(5)} ${verdict(mine)}`,
  );
}

/*
 * 2a's own views strip, which is why ours is drawn differently (TRE-37 §4).
 *
 * Two separate corrections, and the second one is the interesting one. The
 * mockup fills the chip for the restored view with `#1f7cab` and writes its
 * name in `#04202f` — the pair TRE-78 took out of fourteen other places for
 * measuring 3.62:1 — and it also draws the amber unsaved dot *inside* that
 * chip, where amber measures 1.25:1. The mockup's own two decisions cannot both
 * be drawn, so the chip takes the treatment this app already has for "the
 * current row": TRE-36's `line` fill with an accent edge.
 */
console.log("\n--- for the record: 2a's own views strip, which is why ours differs ---");
for (const [what, mockup, ground, ours] of [
  ["a chord beside a name", MOCKUP_QUIET_HEX, CHROME, CHIP_KEY_INK],
  ["a chord in the sidebar", MOCKUP_QUIET_HEX, ROW_ON_FILL, ROW_KEY_INK],
  ["the small caps in the form", MOCKUP_QUIET_HEX, FORM_SURFACE, FORM_LABEL_INK],
  ["the restored chip's name", MOCKUP_CHIP_INK_HEX, MOCKUP_CHIP_FILL_HEX, CHIP_ON_INK],
] as const) {
  const theirs = ratio(mockup, ground.startsWith("#") ? ground : hexOf(ground));
  const mine = ratio(hexOf(ours), hexOf(ours === CHIP_ON_INK ? CHIP_ON_FILL : ground));
  console.log(
    `  ${what.padEnd(28)} ${mockup}  ${theirs.toFixed(2).padStart(5)} ${verdict(theirs).padEnd(15)}` +
      `→ ours ${mine.toFixed(2).padStart(5)} ${verdict(mine)}`,
  );
}
const mockupDot = ratio("#c98a3e", MOCKUP_CHIP_FILL_HEX);
console.log(
  `  ${"the dot inside that chip".padEnd(28)} #c98a3e  ${mockupDot.toFixed(2).padStart(5)} ${verdict(mockupDot).padEnd(15)}` +
    `→ ours ${ratio(hexOf(DIRTY_DOT), hexOf(CHIP_ON_FILL)).toFixed(2).padStart(5)} (1.4.11 wants 3:1)`,
);


/*
 * And every colour the components write inline (TRE-81).
 *
 * Everything above this line is measured because somebody put the pair in a
 * table in `src/helpers` first. That is how `press.ts`, `tail.ts`, `palette.ts`
 * and the rest came to exist, and it is also how this file spent five tickets
 * being confident about the surfaces it knew and blind to the rest: a class
 * name written straight into a component was a pair no check could see. It hid
 * 114 uses of an ink that clears AA on none of this app's grounds.
 *
 * So the components are read too. The scan finds every `text-*` that resolves
 * to a token; the table below says which ground each one is drawn on; and a
 * file whose inks and the table disagree fails, in either direction. That last
 * part is the point — the next inline colour someone adds is not measured
 * against a guess, it stops the check until a human says what it sits on.
 *
 * Two things the scan cannot know, and both are declared rather than inferred:
 *
 *   `on` is the ground, and a component cannot be asked for it. A row's colour
 *   comes from a parent, often in another file, so every box here is somebody's
 *   reading of the tree rather than something the regex found. A box may name
 *   several grounds, and then every ink in it is checked against all of them —
 *   which over-checks rather than under-checks, so a box that is too coarse
 *   fails loudly instead of passing quietly.
 *
 *   `exempt` is the handful of inks WCAG asks nothing of: an inactive control
 *   (1.4.3 sets no ratio for one) and pure decoration. Each says which, in
 *   writing, next to the ink. `disabled:` is stripped before the scan for the
 *   same reason and needs no entry.
 */

type Box = {
  /** The ground, or grounds, this box's text is drawn on. */
  readonly on: readonly string[];
  readonly inks: readonly string[];
  /** Why this box is separate from the rest of the file, when it is not obvious. */
  readonly note?: string;
};

type Room = {
  /** Path under `src/`. */
  readonly file: string;
  readonly boxes: readonly Box[];
  /** Ink → the reason 1.4.3 does not reach it. */
  readonly exempt?: Readonly<Record<string, string>>;
};

/** The three depths quiet text rests on, and the two a row turns when it lifts. */
const APP = "bg-app";
const CHROME_BG = "bg-chrome";
const STRIP = "bg-strip";
const RAISED = "bg-raised";
const LINE = "bg-line";
const DANGER_WASH = "bg-danger-wash";
const WARNING_WASH = "bg-warning-wash";

/** What a modal is: a panel, its inputs and footer, and its refusal box. */
const PANEL = [APP, CHROME_BG, DANGER_WASH];
const INACTIVE = "an inactive control — 1.4.3 sets no ratio for one";

const ROOMS: readonly Room[] = [
  { file: "app/(public)/about/page.tsx", boxes: [{ on: [APP], inks: ["ink-faint", "ink-muted"] }] },
  { file: "app/(public)/login/page.tsx", boxes: [{ on: [APP], inks: ["ink"] }] },
  { file: "app/(public)/recover/page.tsx", boxes: [{ on: [APP], inks: ["ink", "ink-muted"] }] },
  { file: "app/(public)/signup/page.tsx", boxes: [{ on: [APP], inks: ["ink"] }] },
  { file: "app/error.tsx", boxes: [{ on: [APP], inks: ["ink", "ink-dim", "ink-faint"] }] },
  {
    file: "app/global-error.tsx",
    boxes: [{ on: [APP], inks: ["ink", "ink-dim", "ink-faint"], note: "the backstop, which paints its own document" }],
  },
  { file: "app/layout.tsx", boxes: [{ on: [APP], inks: ["ink"] }] },

  {
    // The card's header and footer are chrome and its body is the app surface,
    // but only the two bars carry text of their own — the body is the fields.
    file: "components/auth/auth-card.tsx",
    boxes: [{ on: [CHROME_BG], inks: ["danger-soft", "ink", "ink-faint", "ink-muted", "success", "warning"] }],
  },
  {
    file: "components/auth/auth-field.tsx",
    boxes: [
      { on: [APP], inks: ["danger-soft", "ink-faint", "ink-muted"], note: "label, hint and error, on the card's body" },
      { on: [CHROME_BG], inks: ["ink", "ink-faint", "ink-muted"], note: "the input, its placeholder and the reveal" },
    ],
  },

  {
    file: "components/explorer/compare-modal.tsx",
    boxes: [
      { on: [STRIP], inks: ["brand", "ink-muted", "ink-faint"], note: "this modal's header is the sunk ground" },
      {
        on: [...PANEL, WARNING_WASH],
        inks: ["brand", "danger-soft", "ink", "ink-dim", "ink-faint", "ink-muted", "ink-soft", "success", "warning"],
      },
    ],
    exempt: { "ink-ghost": INACTIVE },
  },
  {
    file: "components/explorer/create-modal.tsx",
    boxes: [
      { on: [LINE], inks: ["ink"], note: "the header bar" },
      { on: PANEL, inks: ["danger-soft", "ink", "ink-dim", "ink-faint", "ink-muted", "ink-soft"] },
    ],
  },
  {
    file: "components/explorer/delete-modal.tsx",
    boxes: [
      {
        on: [APP, CHROME_BG, DANGER_WASH],
        inks: ["danger-soft", "ink", "ink-dim", "ink-faint", "ink-muted", "ink-soft", "success", "warning"],
      },
    ],
  },
  {
    file: "components/explorer/inspector.tsx",
    boxes: [
      { on: [LINE], inks: ["brand", "ink-dim"], note: "the panel's own header bar" },
      { on: [RAISED], inks: ["ink-muted"], note: "a permission cell that is not granted" },
      { on: [CHROME_BG], inks: ["brand", "ink", "ink-dim", "ink-faint", "ink-label", "ink-muted", "ink-soft"] },
    ],
  },
  {
    file: "components/explorer/pane.tsx",
    boxes: [
      { on: [LINE], inks: ["brand", "ink", "ink-dim", "ink-muted"], note: "the tab strip, which is the one dark box in a light pane" },
      { on: ["bg-on-pane-muted"], inks: ["ink"], note: "the badge that says a mount is nearly full" },
      {
        on: ["bg-pane", "bg-pane-active"],
        inks: ["danger", "on-pane", "on-pane-data", "on-pane-faint", "on-pane-label", "on-pane-muted"],
      },
      {
        on: ["bg-pane-hover", "bg-pane-sel", "bg-pane-sel-idle"],
        inks: ["danger", "on-pane", "on-pane-data", "on-pane-faint", "on-pane-muted"],
        note: "the same row, hovered and selected",
      },
      {
        on: ["bg-pane-bar", "bg-pane-bar-active"],
        inks: ["on-pane", "on-pane-data", "on-pane-label", "on-pane-muted"],
        note: "the path row, the column header and the footer — the pane's three bars, which carry the ordinary quiet ink and not the quietest one (TRE-82)",
      },
      { on: ["bg-pane-chip"], inks: ["on-pane"] },
    ],
    exempt: {
      "pane-line": INACTIVE,
      "ink-faint": "the dot beside an inactive tab, which is a graphic — 1.4.11 wants 3:1 of it and it has 3.62",
    },
  },
  {
    file: "components/explorer/permissions-modal.tsx",
    boxes: [
      { on: [LINE], inks: ["ink", "ink-muted"], note: "the header bar" },
      { on: ["bg-warning"], inks: ["on-accent"], note: "the chip that says the change is recursive" },
      { on: [APP, CHROME_BG], inks: ["danger-soft", "ink", "ink-dim", "ink-faint", "ink-muted", "ink-soft", "warning"] },
    ],
  },
  {
    file: "components/explorer/rename-modal.tsx",
    boxes: [
      { on: [LINE], inks: ["ink", "ink-muted"], note: "the header bar" },
      { on: ["bg-line-strong"], inks: ["ink"], note: "the run of a name the pattern matched" },
      { on: PANEL, inks: ["danger-soft", "ink", "ink-dim", "ink-faint", "ink-muted", "ink-soft"] },
    ],
    exempt: { "ink-ghost": "the `·` on a row nothing happens to, which is `aria-hidden` decoration beside the word `unchanged`" },
  },
  {
    file: "components/explorer/tail-strip.tsx",
    boxes: [
      { on: ["bg-pane-sunk"], inks: ["log-client", "log-server", "on-pane-data"] },
      { on: ["bg-pane-hover"], inks: ["on-pane-data"], note: "its picker buttons under the pointer" },
    ],
  },
  {
    file: "components/explorer/terminal-panel.tsx",
    boxes: [
      {
        on: ["bg-terminal"],
        inks: ["ink"],
        note: "the input the prompt row carries (TRE-85; its placeholder went with TRE-115)",
      },
    ],
  },
  {
    file: "components/explorer/transfer-modal.tsx",
    boxes: [
      {
        on: PANEL,
        inks: ["brand", "danger-soft", "ink", "ink-faint", "ink-label", "ink-muted", "ink-soft", "warning"],
      },
    ],
  },

  {
    // No danger wash: this modal refuses nothing of its own. What it can say
    // goes in the footer's count, and the server's refusals land in the tray.
    file: "components/explorer/upload-modal.tsx",
    boxes: [{ on: [APP, CHROME_BG], inks: ["ink-dim", "ink-faint", "ink-label", "ink-muted", "ink-soft"] }],
  },

  {
    file: "components/hosts/field.tsx",
    boxes: [
      { on: [APP], inks: ["danger-soft", "ink-faint", "ink-muted", "ink-soft"], note: "label, hint and error" },
      { on: [CHROME_BG], inks: ["ink", "ink-faint", "ink-soft"], note: "the input and its placeholder" },
    ],
  },
  {
    file: "components/hosts/host-form.tsx",
    boxes: [
      {
        on: [APP, CHROME_BG],
        inks: ["danger-soft", "ink-faint", "ink-label", "ink-muted", "ink-soft", "success", "warning"],
      },
    ],
  },
  {
    file: "components/hosts/host-manager.tsx",
    boxes: [
      { on: [APP, CHROME_BG], inks: ["ink", "ink-faint", "ink-muted", "ink-soft"] },
      { on: [RAISED], inks: ["ink-dim", "ink-muted", "ink-soft"], note: "a host row, which is raised when it is current or hovered" },
    ],
  },
  {
    file: "components/hosts/roots-editor.tsx",
    boxes: [{ on: [APP], inks: ["danger-soft", "ink-faint", "ink-label", "ink-muted"] }],
    exempt: { "line-strong": INACTIVE },
  },
  { file: "components/hosts/sudo-badge.tsx", boxes: [{ on: [CHROME_BG], inks: ["ink-faint", "warning"] }] },
  {
    file: "components/hosts/sudo-modal.tsx",
    boxes: [
      {
        on: [APP, CHROME_BG, WARNING_WASH],
        inks: ["danger-soft", "ink", "ink-faint", "ink-muted", "ink-soft", "warning"],
      },
    ],
  },

  {
    file: "components/shell/account-menu.tsx",
    boxes: [{ on: [CHROME_BG, RAISED], inks: ["ink-muted"], note: "the account chip, which raises under the pointer" }],
  },
  { file: "components/shell/app-shell.tsx", boxes: [{ on: [APP], inks: ["ink", "ink-faint", "ink-muted"] }] },
  { file: "components/shell/disk-usage.tsx", boxes: [{ on: [STRIP], inks: ["ink"], note: "the rescan control under the pointer; the rest of the strip is declared in `disks.ts`" }] },
  { file: "components/shell/palette.tsx", boxes: [{ on: [STRIP], inks: ["ink-faint"], note: "the input's placeholder; the rest of the panel is declared in `palette.ts`" }] },
  {
    file: "components/shell/status-bar.tsx",
    boxes: [{ on: [CHROME_BG], inks: ["brand", "ink", "ink-dim", "ink-faint", "ink-muted", "ink-soft"] }],
  },
  {
    file: "components/shell/toolbar.tsx",
    boxes: [
      { on: [LINE], inks: ["ink-soft"], note: "the current cell of the split control" },
      // A pressed filter is `bg-warning/10` or `bg-accent/20` over the bar, and a
      // composite is a colour this file cannot resolve — the note at the top says
      // why. Both were measured by hand and both clear: amber over `app` at
      // 4.69:1, and `brand` over the blue tint at 8.18:1. The inks below are
      // checked on the bar itself, which is where the same controls sit unpressed.
      {
        on: [APP, CHROME_BG],
        inks: ["brand", "danger-soft", "ink", "ink-dim", "ink-faint", "ink-label", "ink-muted", "ink-soft", "warning"],
      },
    ],
  },
  {
    file: "components/shell/top-bar.tsx",
    boxes: [{ on: [CHROME_BG, LINE], inks: ["brand", "ink", "ink-dim", "ink-muted", "ink-soft"] }],
  },
  {
    file: "components/shell/ui-scale.tsx",
    boxes: [{ on: [CHROME_BG], inks: ["ink", "ink-dim", "ink-faint", "ink-muted"] }],
    exempt: { "line-strong": INACTIVE },
  },

  {
    file: "components/sidebar/activity-strip.tsx",
    boxes: [{ on: [CHROME_BG], inks: ["ink", "ink-faint", "ink-muted"] }],
  },
  {
    file: "components/sidebar/sidebar.tsx",
    boxes: [
      { on: [CHROME_BG], inks: ["danger-soft", "ink", "ink-dim", "ink-faint", "ink-label", "ink-soft"] },
      { on: [RAISED], inks: ["danger-soft", "ink", "ink-dim", "ink-soft"], note: "a host row and a favourite, which raise under the pointer" },
    ],
  },
  {
    file: "components/sidebar/volumes.tsx",
    boxes: [
      { on: [CHROME_BG], inks: ["ink-faint"], note: "the line that says there are none" },
      { on: [RAISED], inks: ["ink", "ink-dim", "warning"], note: "a mount row, which raises under the pointer" },
    ],
  },

  {
    file: "components/ui/add-button.tsx",
    boxes: [
      {
        on: [CHROME_BG, RAISED],
        inks: ["ink", "ink-muted"],
        note: "the dashed ＋ at the foot of a rail section, which raises under the pointer",
      },
    ],
  },
  { file: "components/ui/command-line.tsx", boxes: [{ on: [CHROME_BG], inks: ["ink-muted"] }] },
  {
    file: "components/ui/context-menu.tsx",
    boxes: [
      { on: [STRIP], inks: ["brand", "danger-soft", "ink-dim", "ink-faint", "ink-soft"] },
      {
        on: [LINE],
        inks: ["brand", "danger-soft", "ink-dim", "ink-soft"],
        note: "the row under the cursor, where the quiet step steps up",
      },
    ],
  },
  {
    file: "components/ui/host-path.tsx",
    boxes: [{ on: [CHROME_BG], inks: ["ink-muted"], note: "both modal headers that draw it are chrome" }],
  },
  {
    file: "components/ui/toast.tsx",
    boxes: [{ on: [RAISED], inks: ["danger-soft", "ink", "ink-dim", "ink-muted", "ink-soft", "success", "warning"] }],
  },
  {
    file: "components/ui/transfers.tsx",
    boxes: [{ on: [CHROME_BG], inks: ["brand", "danger-soft", "ink", "ink-faint", "ink-label", "ink-soft"] }],
  },
  {
    file: "components/ui/uploads.tsx",
    boxes: [
      {
        on: [APP],
        inks: ["danger-soft", "ink", "ink-dim", "ink-faint", "ink-label", "ink-muted", "success"],
        note: "the panel; its only chrome is the progress track, which carries nothing",
      },
    ],
  },

  {
    file: "components/views/view-form.tsx",
    boxes: [
      { on: [LINE], inks: ["ink", "ink-muted"], note: "the header bar" },
      { on: [RAISED], inks: ["ink-muted"], note: "a slot button under the pointer" },
      { on: PANEL, inks: ["danger-soft", "ink", "ink-dim", "ink-muted", "ink-soft"] },
    ],
  },
  {
    file: "components/views/view-list.tsx",
    boxes: [{ on: [CHROME_BG, RAISED], inks: ["ink", "ink-dim", "warning"] }],
  },
  {
    file: "components/views/view-rebind.tsx",
    boxes: [
      { on: [LINE], inks: ["ink", "ink-muted"], note: "the header bar" },
      { on: [APP, CHROME_BG], inks: ["ink", "ink-dim", "ink-muted", "ink-soft"] },
    ],
  },
  {
    file: "components/views/view-strip.tsx",
    boxes: [
      { on: [CHROME_BG], inks: ["ink-label", "ink-muted"] },
      { on: [RAISED, LINE], inks: ["ink-muted"], note: "the two buttons at the end of the strip, under the pointer" },
    ],
  },
];

/*
 * The twelve pairs the sweep found on the light panes, with what each was
 * beside what it became (TRE-82). Thirteen lines for twelve pairs, because two
 * different things were failing in the same ink on the same ground.
 *
 * They were one finding rather than twelve. A pane is light, so its ink runs
 * dark, and every step *down* in the surface family is a step *towards* the
 * ink standing on it — which made the furniture bars, the darkest grounds in
 * the app's lightest region, seven of the twelve, and five of the six inks
 * they carry unreadable. Four of the remaining five are `on-pane-faint`, a
 * fourth quiet step the pane had never had the room for. The last is a red
 * that missed by four ten-thousandths.
 *
 * The left-hand pair is a literal, because that is what it was: the palette
 * ported 2a's hexes and 2a's hexes are what failed. Only `#31607f` is the
 * app's own — 2a writes a symlink's target `#255473`, which measures 4.07:1
 * and does not clear either.
 */
const CORRECTED: readonly (readonly [string, string, string, string, string])[] = [
  ["the ▾ on the host chip", "#31607f", "#7fa3c2", "text-on-pane-muted", "bg-pane-bar"],
  ["  the same, keyboard here", "#31607f", "#8badc9", "text-on-pane-muted", "bg-pane-bar-active"],
  ["a symlink's target", "#31607f", "#9bbcd7", "text-on-pane-faint", "bg-pane"],
  ["  the same, keyboard here", "#31607f", "#a5c4dd", "text-on-pane-faint", "bg-pane-active"],
  ["  the same, hovered", "#31607f", "#b6d0e4", "text-on-pane-faint", "bg-pane-hover"],
  ["  the same, selected", "#31607f", "#b9d3e6", "text-on-pane-faint", "bg-pane-sel-idle"],
  ["an owner that would not resolve", "#31607f", "#9bbcd7", "text-on-pane-faint", "bg-pane"],
  ["the footer", "#1f4d69", "#7fa3c2", "text-on-pane-muted", "bg-pane-bar"],
  ["  the same, keyboard here", "#1f4d69", "#8badc9", "text-on-pane-muted", "bg-pane-bar-active"],
  ["every crumb but the last", "#1c4a68", "#7fa3c2", "text-on-pane-muted", "bg-pane-bar"],
  ["  the same, keyboard here", "#1c4a68", "#8badc9", "text-on-pane-muted", "bg-pane-bar-active"],
  ["the column header", "#123e59", "#7fa3c2", "text-on-pane-label", "bg-pane-bar"],
  ["a symlink out of the root", "#7f2f2f", "#9bbcd7", "text-danger", "bg-pane"],
];

/*
 * The type mark, which replaced the type tag (TRE-108).
 *
 * What was measured here before was twenty one-off fills carrying white
 * letters, and all twenty passed — 6.92:1 to 10.89:1. They were dropped anyway,
 * because the thing that failed was never the contrast: every row in the gutter
 * drew the same 14px box and only the tint said which was a directory, and a
 * tint is not perceivable at that size whatever it measures. Shape replaced it.
 *
 * So the pairs are different in kind, and so is the threshold. The folder body,
 * its tab and the hollow pastille's edge are graphics — they say what a row is
 * with no text at all — and 1.4.11 asks 3:1 of them. The letters inside the
 * pastille are text and are held at AA like everything else.
 *
 * The edge is the one translucent colour in the app, and the reason is that it
 * has to sit on five row colours: solid, it would shout on `pane-sel` and
 * disappear on nothing. `.65` rather than the `.55` the design asked for —
 * `.55` composites to 2.78:1 on `bg-pane`, which is under 3:1 on the default
 * ground and on the active one, and this edge is the entire shape.
 */
console.log(`\n--- the type mark, on the light panes (graphics at ${GRAPHIC}:1) ---`);
for (const surface of PANE_SURFACES) {
  const on = surface.replace("bg-", "");
  check(`a folder on ${on}`, MARK_ON_PANE.folder, surface, GRAPHIC);
  check(`a symlink on ${on}`, MARK_ON_PANE.link, surface, GRAPHIC);
  check(`the pastille's edge on ${on}`, blend(MARK_ON_PANE.edge, surface), surface, GRAPHIC);
  check(`its letters on ${on}`, MARK_ON_PANE.letters, surface);
}

console.log("\n--- and on the two panels that list entries: the copy plan, the delete confirmation ---");
for (const surface of PANEL) {
  const on = surface.replace("bg-", "");
  check(`a folder on ${on}`, MARK_ON_PANEL.folder, surface, GRAPHIC);
  check(`a symlink on ${on}`, MARK_ON_PANEL.link, surface, GRAPHIC);
  check(`the pastille's edge on ${on}`, blend(MARK_ON_PANEL.edge, surface), surface, GRAPHIC);
  check(`its letters on ${on}`, MARK_ON_PANEL.letters, surface);
}

/*
 * What it replaced, kept as a measurement rather than a memory — the same
 * reason `--color-accent` still has its number printed above.
 */
const wasTint = ratio(hexOf("#1d5230"), hexOf("bg-pane-active"));
const isNeutral = ratio(hexOf(MARK_ON_PANE.letters), hexOf("bg-pane-active"));
console.log(
  `  --   a type tint as ink, which is what a colour code costs  ${wasTint.toFixed(2).padStart(5)}:1  ${verdict(wasTint)}`,
);
console.log(
  `  --   the one neutral that replaced all twenty             ${isNeutral.toFixed(2).padStart(5)}:1  ${verdict(isNeutral)}`,
);

/*
 * And 2a's own symlink blue, which is why ours differs (TRE-108).
 *
 * The same treatment every corrected mockup colour in this file gets: their
 * number beside ours, so the correction stays reviewable rather than becoming a
 * colour somebody once changed. Only the lightness moved — 44.7% to 36% — which
 * is the least that clears 1.4.11 on all five row colours.
 *
 * The third number is the one that decided it. This mark's job is to be a
 * folder that is not the folder beside it, so what it has to hold is a ratio to
 * `on-pane`, not only to the ground: 2.33:1, against 1.63 for the token this
 * first shipped as — two solids nobody could tell apart.
 */
console.log("\n--- for the record: 2a's own symlink blue, which is why ours differs ---");
{
  const theirs = ratio(MOCKUP_LINK_HEX, hexOf("bg-pane"));
  const mine = ratio(hexOf(MARK_ON_PANE.link), hexOf("bg-pane"));
  const apart = ratio(hexOf(MARK_ON_PANE.link), hexOf(MARK_ON_PANE.folder));
  console.log(
    `  the symlink's mark, on bg-pane  ${MOCKUP_LINK_HEX}  ${theirs.toFixed(2).padStart(5)} ${verdict(theirs).padEnd(15)}` +
      `→ ours ${mine.toFixed(2).padStart(5)} ${verdict(mine)}`,
  );
  console.log(`  and away from the folder beside it                 ${apart.toFixed(2).padStart(5)}:1`);
}

/*
 * The sweep prints only what fails. Five hundred `ok` lines would bury the
 * sections above, which are the ones somebody reads when they are choosing a
 * colour; this one is read when it stops passing.
 */
console.log("\n--- every inline pair in `src/components` and `src/app` ---");

let swept = 0;

for (const room of ROOMS) {
  const found = inksOf(room.file);
  const declared = new Set(room.boxes.flatMap((box) => box.inks));
  const exempt = new Set(Object.keys(room.exempt ?? {}));

  checked += 1;
  const undeclared = [...found].filter((ink) => !declared.has(ink) && !exempt.has(ink));
  const stale = [...declared].filter((ink) => !found.has(ink));
  if (undeclared.length > 0 || stale.length > 0) {
    failures += 1;
    if (undeclared.length > 0) {
      console.log(`  FAIL ${room.file} writes ${undeclared.map((i) => `text-${i}`).join(", ")}, which no box here names`);
    }
    if (stale.length > 0) {
      console.log(`  FAIL ${room.file} no longer writes ${stale.map((i) => `text-${i}`).join(", ")}, which a box still claims`);
    }
  }

  for (const box of room.boxes) {
    for (const ink of box.inks) {
      if (!found.has(ink)) continue;
      for (const ground of box.on) {
        const measured = ratio(hexOf(`text-${ink}`), hexOf(ground));
        swept += 1;
        checked += 1;
        if (measured >= AA) continue;
        failures += 1;
        console.log(`  FAIL ${room.file} · text-${ink} on ${ground}  ${measured.toFixed(2)}:1 — needs ${AA}:1`);
      }
    }
  }
}

/*
 * A file that writes a colour and is in no room is the case this whole section
 * exists for: the next inline pair somebody adds. It fails here rather than
 * shipping unmeasured.
 */
const uncovered = componentFiles().filter((file) => !ROOMS.some((room) => room.file === file) && inksOf(file).size > 0);
checked += 1;
if (uncovered.length === 0) {
  console.log(`  ok   ${swept} inline pairs across ${ROOMS.length} files, and every file that writes one is in the table`);
} else {
  failures += 1;
  console.log(`  FAIL these write a colour and belong to no room: ${uncovered.join(", ")}`);
}

console.log("\n--- the light panes, as they were and as they are (TRE-82) ---");
for (const [what, wasInk, wasGround, ink, ground] of CORRECTED) {
  const before = ratio(hexOf(wasInk), hexOf(wasGround));
  const after = ratio(hexOf(ink), hexOf(ground));
  checked += 1;
  if (after < AA) failures += 1;
  console.log(
    `  ${after >= AA ? "ok  " : "FAIL"} ${what.padEnd(32)} ${before.toFixed(2).padStart(5)} → ${after.toFixed(2).padStart(5)}:1`,
  );
}

console.log(`\n${checked - failures}/${checked} pairs pass — text at ${AA}:1, the type mark's shapes at ${GRAPHIC}:1.`);
process.exit(failures === 0 ? 0 : 1);

/* ---- the checks -------------------------------------------------------- */

function check(what: string, inkClass: string, backgroundClass: string, threshold: number = AA): void {
  checked += 1;

  const ink = hexOf(inkClass);
  const background = hexOf(backgroundClass);
  const measured = ratio(ink, background);
  const line = `${what.padEnd(34)} ${ink} on ${background}  ${measured.toFixed(2).padStart(5)}:1`;

  if (measured >= threshold) {
    console.log(`  ok   ${line}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL ${line}  — needs ${threshold}:1`);
}

/**
 * A colour with an opacity modifier, resolved against what it is drawn on.
 *
 * The note at the top of this file said such a pair "has to be composited
 * against its backdrop first, which is why none are here". One is here now: the
 * hollow pastille's edge is deliberately translucent so that it keeps the same
 * relationship to all five row colours instead of shouting on the two light
 * ones. Tailwind writes `border-x/65` as a `color-mix` with `transparent`,
 * which leaves the colour where it was and takes the alpha to 0.65, so what
 * lands on screen is the straight sRGB blend this computes.
 */
function blend(utility: string, groundClass: string): string {
  const [name, percent] = utility.split("/");
  const alpha = Number(percent) / 100;
  const ink = hexOf(name);
  const ground = hexOf(groundClass);

  const channel = (offset: number) => {
    const front = (Number.parseInt(ink.slice(1), 16) >> offset) & 255;
    const back = (Number.parseInt(ground.slice(1), 16) >> offset) & 255;
    return Math.round(front * alpha + back * (1 - alpha));
  };

  return `#${[16, 8, 0].map((offset) => channel(offset).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Tailwind's own rule: `bg-x` and `text-x` both resolve `--color-x`.
 *
 * A literal hex passes through, because two of the surfaces measured here are
 * not tokens at all — the mockup's own values, kept as literals precisely so
 * the correction beside them stays readable, and the type tag's one-off fills.
 */
function hexOf(utility: string): string {
  if (utility.startsWith("#")) return utility.toLowerCase();

  // `bg-[#4d7f99]` — a colour with no token, which is a literal wearing a
  // utility's clothes. Two of them ship, both the mockup's own.
  const arbitrary = utility.match(/^[a-z-]+-\[(#[0-9a-f]{6})\]$/i);
  if (arbitrary) return arbitrary[1].toLowerCase();

  const token = `--color-${utility.replace(/^(bg|text|border)-/, "")}`;
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

/* ---- reading the components -------------------------------------------- */

/** A class name written in prose is not a pair that ships. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every token a file writes as text, with the variants stripped.
 *
 * `disabled:` is dropped rather than collected: 1.4.3 asks no ratio of an
 * inactive control, so a greyed-out button is the one place this app may write
 * an ink that fails. Every other variant — `hover:`, `placeholder:`,
 * `group-hover:`, `focus-visible:` — is text somebody reads, and is kept.
 */
function inksOf(file: string): Set<string> {
  const cached = inkCache.get(file);
  if (cached !== undefined) return cached;

  const found = new Set<string>();
  for (const [, variants, token] of code(readFileSync(join(SRC, file), "utf8")).matchAll(
    /(?:^|["'\s`{])((?:[a-z-]+:)*)text-([a-z0-9-]+)/g,
  )) {
    if (!tokens.has(`--color-${token}`)) continue;
    if (variants.includes("disabled:")) continue;
    found.add(token);
  }

  inkCache.set(file, found);
  return found;
}

/** Every component, as a path under `src` — the two trees that render. */
function componentFiles(): readonly string[] {
  const found: string[] = [];
  for (const tree of ["components", "app"]) {
    for (const entry of readdirSync(join(SRC, tree), { recursive: true, encoding: "utf8" })) {
      if (entry.endsWith(".tsx")) found.push(`${tree}/${entry}`);
    }
  }
  return found.sort();
}
