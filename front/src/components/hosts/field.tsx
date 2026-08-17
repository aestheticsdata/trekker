"use client";

/**
 * The host form's field primitives (TRE-43), at app scale.
 *
 * Not the auth screens' `AuthField`: those are a landing page with room to
 * breathe and a deliberately larger type scale, while this sits inside the
 * chrome and has to read as part of it.
 *
 * The error rides on the label's own line and its span is always rendered, so
 * a message appearing never moves the field below it (TRE-15's rule, kept).
 */

import { Tooltip } from "@components/ui/tooltip";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  /** The quiet half-sentence that saves a support question. */
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <label
          htmlFor={htmlFor}
          className="text-ink-muted font-mono text-2xs tracking-label"
        >
          {label}
        </label>
        <span className="text-danger-soft truncate text-right font-mono text-2xs">{error ?? ""}</span>
      </div>
      {children}
      {hint && <span className="text-ink-faint font-mono text-2xs">{hint}</span>}
    </div>
  );
}

export const INPUT_CLASS =
  "bg-chrome border-line-strong text-ink-soft placeholder:text-ink-faint focus:border-accent-soft caret-brand w-full rounded-xs border px-2 py-1 font-mono text-xs outline-none disabled:opacity-50";

export function TextInput({ invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      className={`${INPUT_CLASS} ${invalid ? "border-danger-mid" : ""} ${props.className ?? ""}`}
    />
  );
}

/**
 * A segmented picker, the same control the toolbar uses for view mode — this
 * app already has one way to choose between two or three things.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  /** `hint`, not `title`: a prop called `title` that is not one is how the
   *  attribute finds its way back in (TRE-76). */
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean; hint?: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset
      aria-label={label}
      className="border-line-strong flex h-6 overflow-hidden rounded-xs border"
    >
      {options.map((option) => {
        const active = option.value === value;
        const off = disabled || option.disabled;
        return (
          <Tooltip
            key={option.value}
            content={option.hint}
          >
            <button
              type="button"
              aria-pressed={active}
              // `aria-disabled`, not `disabled` (TRE-76): an option that is off
              // is the one whose hint says why, and a control disabled by the
              // attribute is neither hoverable nor a tab stop.
              aria-disabled={off}
              onClick={() => !off && onChange(option.value)}
              className={`border-line-strong flex flex-1 items-center justify-center border-l px-2 font-mono text-xs first:border-l-0 ${
                active
                  ? "bg-accent-soft text-on-accent font-medium"
                  : off
                    ? "text-ink-faint cursor-not-allowed"
                    : "text-ink-muted hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          </Tooltip>
        );
      })}
    </fieldset>
  );
}

export function Button({
  tone = "quiet",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "quiet" | "danger";
  children: ReactNode;
}) {
  const TONE = {
    primary: "bg-accent text-on-accent hover:bg-accent-soft disabled:opacity-50",
    quiet: "border-line-strong text-ink-muted hover:text-ink hover:border-accent-soft border disabled:opacity-50",
    danger: "border-danger text-danger-soft hover:border-danger-mid hover:bg-danger/20 border disabled:opacity-50",
  } as const;

  return (
    <button
      {...props}
      className={`flex h-6 items-center gap-1 rounded-xs px-2.5 font-mono text-xs whitespace-nowrap disabled:cursor-not-allowed ${TONE[tone]} ${props.className ?? ""}`}
    >
      {children}
    </button>
  );
}
