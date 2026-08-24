"use client";

import { Tooltip } from "@components/ui/tooltip";
import { SELECTED } from "@helpers/press";

import type { Action } from "@components/shell/actions";

/**
 * The 30px toolbar (TRE-14 §3, trued up against mockup 2a by TRE-42).
 *
 * The bar sits on the app surface and its controls sink into chrome — the
 * inverse of the top bar — so the toolbar reads as part of the workspace, not
 * the frame. Control text is mono and lowercase: these are commands, and the
 * mockup writes commands the way a terminal does.
 *
 * The action buttons are here before the actions are. M2 implements copy,
 * move, compare, chmod, rename and rm; until then each renders disabled and
 * says why on hover. Visible and inert beats absent — the shortcut hints are
 * how anyone learns this app has an F5 and an F6 at all, and a toolbar that
 * grows buttons over three milestones never looks like a finished product.
 *
 * The bar joins the degradation ladder (TRE-14 §5): the columns readout goes
 * below `stats:` with the glob narrowing alongside it, and the action row goes
 * below `panes:` — a single pane has nothing for a pane-to-pane action to do.
 */

export type ViewMode = "list" | "detail";
export type SplitMode = "split" | "left" | "right";

/**
 * The action row's entries come from `components/shell/actions.ts` (TRE-70 §4),
 * resolved against the active pane's selection before they get here. This file
 * draws them and decides nothing: which exist and which are live is one
 * registry, so the row, the context menu and TRE-36's palette cannot disagree
 * about what is possible right now.
 */

/** The listing columns the glob sits beside. Placeholder until TRE-16's table owns them. */
const DEFAULT_COLUMNS: readonly string[] = ["share", "mode", "owner", "age"];

export function Toolbar({
  viewMode = "detail",
  onViewModeChange,
  splitMode = "split",
  onSplitModeChange,
  glob = "",
  onGlobChange,
  globMatches = null,
  heat = false,
  onHeatChange,
  inspector = false,
  onInspectorChange,
  actions = [],
}: {
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  splitMode?: SplitMode;
  onSplitModeChange?: (mode: SplitMode) => void;
  glob?: string;
  onGlobChange?: (glob: string) => void;
  /** How many rows the glob matches, or null when there is no glob. */
  globMatches?: number | null;
  heat?: boolean;
  onHeatChange?: (heat: boolean) => void;
  /** The inspector's other switch (TRE-17 §4); ⌘I is the first. */
  inspector?: boolean;
  onInspectorChange?: (open: boolean) => void;
  actions?: readonly Action[];
}) {
  return (
    <div className="bg-app border-line flex h-toolbar shrink-0 items-center gap-2.25 border-b px-2.5">
      <Segmented
        label="View mode"
        value={viewMode}
        onChange={(value) => onViewModeChange?.(value as ViewMode)}
        options={[
          { value: "list", label: "list" },
          { value: "detail", label: "detail" },
        ]}
      />

      <SplitControl
        value={splitMode}
        onChange={(value) => onSplitModeChange?.(value)}
      />

      <Rule />

      <label className="border-line-strong bg-chrome focus-within:border-accent-soft flex h-5 w-40 items-center gap-1.5 rounded-sm border px-2 stats:w-52.5">
        <span className="text-ink-label font-mono text-2xs">glob</span>
        <input
          type="text"
          value={glob}
          onChange={(event) => onGlobChange?.(event.target.value)}
          placeholder="*.log"
          aria-label="Filter by glob"
          className="text-ink-soft placeholder:text-ink-faint caret-brand min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
        />
        {globMatches !== null && (
          <span className="text-ink-dim font-mono text-2xs whitespace-nowrap">
            {globMatches} {globMatches === 1 ? "hit" : "hits"}
          </span>
        )}
      </label>

      <Tooltip content="Column visibility isn't configurable yet">
        <span className="hidden items-center gap-2.25 font-mono text-2xs whitespace-nowrap stats:flex">
          <span className="text-ink-dim">columns</span>
          <span className="text-brand">{DEFAULT_COLUMNS.join(" · ")}</span>
        </span>
      </Tooltip>

      <Toggle
        label="heat"
        pressed={heat}
        onChange={() => onHeatChange?.(!heat)}
      />

      {/* Hidden exactly where the panel is, rather than left as a switch with
          nothing to open below the inspector breakpoint. */}
      <Toggle
        label="inspector"
        hint="Show the inspector (⌘I)"
        tone="accent"
        className="hidden inspector:flex"
        pressed={inspector}
        onChange={() => onInspectorChange?.(!inspector)}
      />

      <div className="flex-1" />

      <div className="hidden items-center gap-1.25 panes:flex">
        {actions.map((action) => (
          <ActionButton
            key={action.id}
            action={action}
          />
        ))}
      </div>
    </div>
  );
}

function ActionButton({ action }: { action: Action }) {
  const disabled = action.unavailableReason !== undefined;

  return (
    // The tooltip carries the reason, and it is `aria-describedby` rather than
    // an attribute now — the bubble is one element portalled to the body and
    // pointed at by id, not one per button (TRE-76).
    <Tooltip content={action.unavailableReason}>
      <button
        type="button"
        // ⚠️ `aria-disabled`, not `disabled`. This is the button whose hint
        // matters most in the file — it is the reason a destructive action
        // cannot be pressed — and a control disabled by the attribute fires no
        // mouse event and is not a tab stop, so that reason reached nobody at
        // all. Inert either way: the click below returns before `onSelect`.
        aria-disabled={disabled}
        onClick={disabled ? undefined : action.onSelect}
        className={[
          "flex h-5 items-center gap-1 rounded-sm border px-2 font-mono text-xs whitespace-nowrap",
          // Danger stays red even while disabled: rm should never look routine.
          action.danger
            ? `border-danger text-danger-soft ${disabled ? "cursor-not-allowed" : "hover:border-danger-mid hover:bg-danger/20"}`
            : disabled
              ? "border-line-strong text-ink-dim cursor-not-allowed"
              : "border-line-strong text-ink-muted hover:text-ink hover:border-accent-soft",
        ].join(" ")}
      >
        {action.label}
        {/* The chord if a key reaches this, and 2a's glyph if none does — never
            both, and never the glyph dressed as a chord. `compare ⇄` and
            `upload ↑` used to be written into the same field as `copy F5`,
            which is how the action registry came to advertise an arrow key that
            has never started an upload (TRE-36 §2). */}
        {(action.hint ?? action.mark) && <span>{action.hint ?? action.mark}</span>}
      </button>
    </Tooltip>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    // A fieldset rather than role="group": it groups related controls natively,
    // and the label rides on aria-label so no legend takes up a row of a 30px bar.
    <fieldset
      aria-label={label}
      className="border-line-strong flex h-5 overflow-hidden rounded-sm border"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`border-line-strong flex items-center border-l px-2.25 font-mono text-xs first:border-l-0 ${
              active ? `${SELECTED} font-medium` : "text-ink-muted hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/**
 * The pane-split picker, drawn rather than typed: the mockup builds these as
 * little bordered boxes, and a box that shows its filled half says more at
 * 18px than ◧ ever did.
 */
function SplitControl({ value, onChange }: { value: SplitMode; onChange: (mode: SplitMode) => void }) {
  const options: ReadonlyArray<{ value: SplitMode; label: string }> = [
    { value: "left", label: "Left pane only" },
    { value: "split", label: "Both panes" },
    { value: "right", label: "Right pane only" },
  ];

  return (
    <fieldset
      aria-label="Split"
      className="flex gap-0.75"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Tooltip
            key={option.value}
            content={option.label}
          >
            <button
              type="button"
              aria-pressed={active}
              aria-label={option.label}
              onClick={() => onChange(option.value)}
              className={`flex h-4.5 w-6 border ${
                active
                  ? "border-accent bg-line text-ink-soft"
                  : "border-line-strong text-ink-faint hover:text-ink-muted"
              }`}
            >
              <span className={`flex-1 ${option.value === "left" ? "bg-current" : ""}`} />
              {/* The divider matches the active border, as the mockup draws it. */}
              <span
                aria-hidden
                className={`w-px ${active ? "bg-accent" : "bg-current opacity-60"}`}
              />
              <span className={`flex-1 ${option.value === "right" ? "bg-current" : ""}`} />
            </button>
          </Tooltip>
        );
      })}
    </fieldset>
  );
}

/** The thin vertical rule the mockup puts between toolbar clusters. */
function Rule() {
  return (
    <span
      aria-hidden
      className="bg-line-strong h-4 w-px"
    />
  );
}

/**
 * The heat map's switch, and the inspector's.
 *
 * Two tones because they mean different things: the heat map recolours the
 * listing, which is a warning-coloured thing to have done to it, while the
 * inspector is a panel and takes the accent every other panel in the app does.
 */
function Toggle({
  label,
  hint,
  pressed,
  tone = "warning",
  className = "flex",
  onChange,
}: {
  label: string;
  /** `hint`, not `title`: a prop called `title` that is not one is how the
   *  attribute finds its way back into this file (TRE-76). */
  hint?: string;
  pressed: boolean;
  tone?: "warning" | "accent";
  className?: string;
  onChange: () => void;
}) {
  const lit =
    tone === "accent" ? "border-accent-soft text-brand bg-accent/20" : "border-warning text-warning bg-warning/10";

  return (
    <Tooltip content={hint}>
      <button
        type="button"
        aria-pressed={pressed}
        onClick={onChange}
        className={`h-5 items-center rounded-sm border px-2 font-mono text-xs ${className} ${
          pressed ? lit : "border-line-strong text-ink-faint hover:text-ink-muted"
        }`}
      >
        {label}
      </button>
    </Tooltip>
  );
}
