/**
 * The load sparkline in the top bar (TRE-14 §2).
 *
 * Inline SVG with no library: it is a polyline over a fixed viewBox, and a
 * charting dependency for twenty points in a 34px bar would be absurd.
 */
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

  const max = Math.max(...values, 1);
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      // Inverted: SVG's y grows downward and a load spike should go up.
      const y = 100 - (value / max) * 100;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={`h-3 w-10 ${className}`}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={6}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
