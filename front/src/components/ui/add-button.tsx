"use client";

/**
 * The dashed button at the foot of a sidebar section: `＋ save current view…`
 * and `＋ new host…` (TRE-102, TRE-104).
 *
 * One component rather than the same twenty classes in two files. They are the
 * same control and read as one — a 176px rail showing two dashed buttons that
 * differ by a pixel looks like a mistake, and the copy nobody diffs is the copy
 * that drifts.
 *
 * `leading-none` is load-bearing rather than tidy. 2a writes this button
 * `400 10px/1` inside `padding:6px 0`, which is a 24px box — exactly the height
 * of the rows above it. `text-2xs` carries a 16px line box of its own, so
 * without this it stands 30px and reads heavier than the section it belongs to.
 * `volumes.tsx` makes the same correction on the same step.
 */
export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="mt-1.5 px-2.5">
      <button
        type="button"
        onClick={onClick}
        className="border-line-strong text-ink-muted hover:bg-raised hover:border-accent hover:text-ink flex w-full justify-center border border-dashed py-1.5 font-mono text-2xs leading-none"
      >
        {label}
      </button>
    </div>
  );
}
