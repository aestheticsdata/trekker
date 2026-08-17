"use client";

import { Tooltip } from "@components/ui/tooltip";
import { clampBase, UI_BASE_DEFAULT, UI_BASE_KEY, UI_BASE_MAX, UI_BASE_MIN } from "@helpers/ui-scale";
import { useEffect, useState } from "react";

/**
 * The size stepper, in the status bar's right corner (TRE-44 §5).
 *
 * Density is the point of this UI, and 11px mono is also genuinely hard to
 * read — so the answer is not a looser design, it is the same design bigger.
 * One button per pixel, and everything moves at once.
 */
export function UiScale() {
  const [base, setBase] = useState(UI_BASE_DEFAULT);

  // The inline script has already applied the stored value to the root, so
  // this only catches the label up after hydration — it writes nothing back,
  // and the server can keep rendering the default without a mismatch.
  useEffect(() => {
    setBase(clampBase(read()));
  }, []);

  const step = (delta: number) => {
    const next = clampBase(base + delta);
    if (next === base) return;
    setBase(next);
    document.documentElement.style.setProperty("--ui-base", String(next));
    write(next);
  };

  return (
    <span className="flex flex-none items-center gap-0.5 whitespace-nowrap">
      <span className="text-ink-faint mr-0.5">ui</span>
      <Step
        glyph="−"
        label="Smaller interface"
        disabled={base <= UI_BASE_MIN}
        onSelect={() => step(-1)}
      />
      <span className="text-ink-muted tabular-nums">{base}px</span>
      <Step
        glyph="+"
        label="Larger interface"
        disabled={base >= UI_BASE_MAX}
        onSelect={() => step(1)}
      />
    </span>
  );
}

function Step({
  glyph,
  label,
  disabled,
  onSelect,
}: {
  glyph: string;
  label: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    // `disabled` stays rather than becoming `aria-disabled` (TRE-76): the hint
    // is this step's *name*, not a reason it cannot be pressed, so a step at the
    // end of its range loses nothing by going quiet with the control.
    <Tooltip content={label}>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-label={label}
        className={`px-1 ${disabled ? "text-line-strong cursor-not-allowed" : "text-ink-dim hover:text-ink"}`}
      >
        {glyph}
      </button>
    </Tooltip>
  );
}

/** Both sides of storage are wrapped: it throws outright under some privacy settings. */
function read(): string | null {
  try {
    return localStorage.getItem(UI_BASE_KEY);
  } catch {
    return null;
  }
}

function write(base: number): void {
  try {
    localStorage.setItem(UI_BASE_KEY, String(base));
  } catch {
    // A preference that cannot be remembered still applies for this session.
  }
}
