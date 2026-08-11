"use client";

import { STRENGTH_LABELS, scoreKey } from "@schemas/auth";
import { useId, useState } from "react";

import type { UseFormRegisterReturn } from "react-hook-form";

/**
 * One labelled field (TRE-15 §1).
 *
 * **The error shares the label's line and nothing is ever inserted or removed.**
 * A message that appears below a field pushes everything under it down, so the
 * button someone is reaching for moves as they are told why they cannot press
 * it. Both spans render always — the error one simply has no text — which
 * costs no reserved gap and makes a shift structurally impossible rather than
 * merely unlikely.
 *
 * These screens are four fields on an empty page, not ten thousand rows in a
 * pane, so they use the readable end of the type scale.
 */
export function AuthField({
  label,
  type = "text",
  autoComplete,
  registration,
  error,
  secret = false,
  autoFocus = false,
  hint,
}: {
  label: string;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  registration: UseFormRegisterReturn;
  error?: string;
  /** Adds the reveal toggle. */
  secret?: boolean;
  autoFocus?: boolean;
  hint?: string;
}) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const inputType = secret && !revealed ? "password" : secret ? "text" : type;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={id}
          className="text-ink-muted shrink-0 text-xs tracking-label"
        >
          {label}
        </label>
        {/* Always rendered, empty when valid: this is what keeps the height fixed. */}
        <span
          id={`${id}-error`}
          // `alert` only once it has something to say, so an empty span is not
          // announced as a blank message.
          role={error ? "alert" : undefined}
          title={error}
          className="text-danger-soft min-w-0 truncate text-right text-xs"
        >
          {error ?? ""}
        </span>
      </div>

      <div className="relative">
        <input
          {...registration}
          id={id}
          type={inputType}
          autoComplete={autoComplete}
          // biome-ignore lint/a11y/noAutofocus: focus belongs on the first field of a sign-in form, and TRE-15 asks for it
          autoFocus={autoFocus}
          aria-invalid={error !== undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`bg-chrome text-ink placeholder:text-ink-faint focus:border-accent-soft w-full rounded-xs border px-2.5 py-1.5 font-mono text-base outline-none ${
            error ? "border-danger-mid" : "border-line-strong"
          } ${secret ? "pr-14" : ""}`}
        />
        {secret && (
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            aria-pressed={revealed}
            className="text-ink-faint hover:text-ink-muted absolute top-1/2 right-2 -translate-y-1/2 text-xs tracking-label"
          >
            {revealed ? "hide" : "show"}
          </button>
        )}
      </div>

      {/* Unconditional when the field has one — toggling it would shift too. */}
      {hint && <p className="text-ink-faint text-xs leading-snug">{hint}</p>}
    </div>
  );
}

/**
 * The four-cell meter from the mockup. Guidance, not a gate: the length
 * minimum is the only hard rule, and a meter that blocked submission would
 * push people toward whatever pattern lights all four cells.
 */
export function StrengthMeter({ value }: { value: string }) {
  const score = scoreKey(value);
  const colour = ["bg-line-strong", "bg-danger-mid", "bg-warning", "bg-accent", "bg-success"][score];

  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((cell) => (
          <span
            key={cell}
            className={`h-0.5 flex-1 rounded-xs ${cell < score ? colour : "bg-line"}`}
          />
        ))}
      </div>
      {/* Fixed width, so the bar does not resize as the word changes. */}
      <span className="text-ink-faint w-12 text-right text-xs tracking-label">{STRENGTH_LABELS[score]}</span>
    </div>
  );
}
