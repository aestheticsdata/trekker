/**
 * The app's one size knob (TRE-44).
 *
 * `--ui-base` is the pixel size Trekker's body text renders at. The stylesheet
 * turns it into the root font size, and since every length in the app is `rem`
 * or a Tailwind utility built on `rem`, the whole interface follows it in
 * proportion — a listing at 12 is the same design as at 11, 9% larger, not a
 * looser one.
 *
 * 11 is the mockup exactly, and the default. The range stops at 10 because
 * below it the mono column alignment stops being legible at all, and at 14
 * because past that a pane no longer fits its eight columns on a laptop.
 */
export const UI_BASE_DEFAULT = 11;
export const UI_BASE_MIN = 10;
export const UI_BASE_MAX = 14;

/** Per device, deliberately: the same person on a laptop and a 27" wants different values. */
export const UI_BASE_KEY = "trekker:ui-base";

/** Anything that is not a number in range becomes the default, never the nearest bound. */
export function clampBase(value: unknown): number {
  if (value === null || value === undefined || value === "") return UI_BASE_DEFAULT;
  const base = Math.round(Number(value));
  if (!Number.isFinite(base)) return UI_BASE_DEFAULT;
  return Math.min(UI_BASE_MAX, Math.max(UI_BASE_MIN, base));
}

/**
 * Run from the top of `<body>`, before anything paints.
 *
 * Reading the preference in an effect would render the whole app at 11 and
 * then jump, which is worse than not having the setting. Blocking and inline
 * is the price of not seeing that. It writes nothing when the stored value is
 * missing or out of range — the stylesheet's own default already covers that
 * case — and `localStorage` itself can throw under a strict privacy setting,
 * so the whole thing sits in a `try`.
 */
export const UI_BASE_SCRIPT =
  `try{var b=Math.round(Number(localStorage.getItem(${JSON.stringify(UI_BASE_KEY)})));` +
  `if(b>=${UI_BASE_MIN}&&b<=${UI_BASE_MAX})` +
  `document.documentElement.style.setProperty("--ui-base",String(b))}catch(e){}`;
