/**
 * A wait being drawn rather than typed (TRE-110), shared since TRE-139.
 *
 * Born in the pane's size column for a directory still being measured, then
 * wanted by the inspector's preview box for an image still crossing SSH — the
 * same statement both times: something is being fetched and no number or
 * picture exists yet. One ring, so the app has one way of saying it.
 *
 * The design reasons live here with it. The first attempt animated a character
 * — a dash through `- \ | /`, advanced by an interval the pane owned — which
 * failed twice over: it collided with the two dashes the size column already
 * prints, and it re-rendered the pane eight times a second to move one glyph.
 * A ring costs neither. It is not a character, so it cannot be misread as one,
 * and the rotation is a compositor transform: forty of these turning is no
 * main-thread work at all.
 *
 * `currentColor`, so the wrapper's ink governs it and a muted tone applies
 * without this knowing what muted means. `aria-hidden`, because every call
 * site says what is happening in its own words — "Measuring…" in the size
 * cell, the entry's name under the preview box. The global
 * `prefers-reduced-motion` rule stops the turn after one frame, leaving a
 * static ring — the right answer for someone who asked for less motion, and
 * still visibly not a number.
 *
 * `className` carries the size and nothing else; the rotation class is this
 * component's own, because a caller that composes another animation onto the
 * svg would silently cancel it — `animation` is one property.
 */
export function MeasuringRing({ className = "size-2.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`animate-measuring ${className}`}
    >
      {/* The track, faint: without it a lone arc reads as a fragment rather
          than as something going round. */}
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="2"
      />
      {/* A quarter turn of it, solid — the part that is visibly moving. */}
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
