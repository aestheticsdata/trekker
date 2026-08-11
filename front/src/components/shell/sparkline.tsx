/**
 * The load sparkline in the top bar (TRE-14 §2, restyled by TRE-42).
 *
 * Discrete 2px bars, per the mockup — not a line. Each bar's colour follows
 * its drawn height, so a spike is brighter as well as taller and the ramp
 * reads at sparkline size where a line would not.
 */

/**
 * Bar heights in px inside the 11px strip the mockup gives the sparkline.
 *
 * The maths stays in the mockup's pixels — the colour thresholds below are
 * read off its own bars — and only the emitted height converts to `rem`, so
 * the strip follows `--ui-base` (TRE-44) without the ramp shifting under it.
 */
const STRIP_HEIGHT = 11;
const MIN_BAR = 2;

/** Tailwind's rem base. The px above are all drawn against it. */
const REM = 16;

/** Bars cost width; the strip shows the newest samples and stays chrome-sized. */
const MAX_BARS = 20;

/** Thresholds taken from the mockup's own bars: 3-4px dim, 5-7px soft, 9px bright. */
function barClass(height: number): string {
  if (height >= 9) return "bg-ink-dim";
  if (height >= 5) return "bg-accent-soft";
  return "bg-accent-dim";
}

export function Sparkline({
  values,
  label,
  className = "",
}: {
  values: readonly number[];
  /** What a screen reader gets instead of the shape. */
  label: string;
  className?: string;
}) {
  if (values.length < 2) return null;

  const shown = values.slice(-MAX_BARS);
  const max = Math.max(...shown, 1);

  return (
    <span
      role="img"
      aria-label={label}
      // The gap is an arbitrary rem rather than a scale step: Tailwind's
      // numeric scale stops at two decimals, and 1.5px is 0.09375rem.
      className={`flex h-2.75 items-end gap-[0.09375rem] ${className}`}
    >
      {shown.map((value, index) => {
        const height = Math.max(MIN_BAR, Math.round((value / max) * STRIP_HEIGHT));
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered samples, never reordered
            key={index}
            className={`w-0.5 ${barClass(height)}`}
            style={{ height: `${height / REM}rem` }}
          />
        );
      })}
    </span>
  );
}
