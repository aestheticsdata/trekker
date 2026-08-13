"use client";

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

export interface ToolbarAction {
  id: string;
  label: string;
  /** "F5", "⌦" — rendered next to the label, and how the app teaches itself. */
  hint?: string;
  /** Absent means enabled. Present means disabled, and this is the tooltip. */
  unavailableReason?: string;
  danger?: boolean;
  onSelect?: () => void;
}

/** Everything M2 owns, declared once so the toolbar and the palette agree. */
export const M2_ACTIONS: readonly ToolbarAction[] = [
  { id: "copy", label: "copy", hint: "F5", unavailableReason: "Transfers arrive in TRE-23" },
  { id: "move", label: "move", hint: "F6", unavailableReason: "Transfers arrive in TRE-23" },
  { id: "compare", label: "compare", hint: "⇄", unavailableReason: "Pane comparison arrives in TRE-28" },
  { id: "chmod", label: "permissions", unavailableReason: "chmod and chown arrive in TRE-21" },
  { id: "rename", label: "regex rename", hint: "F2", unavailableReason: "Regex rename arrives in TRE-22" },
  { id: "rm", label: "rm", hint: "⌦", danger: true },
];

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
  actions = M2_ACTIONS,
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
  actions?: readonly ToolbarAction[];
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
        <span className="text-accent-soft font-mono text-2xs">glob</span>
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

      <span
        className="hidden items-center gap-2.25 font-mono text-2xs whitespace-nowrap stats:flex"
        title="Column visibility arrives in TRE-16"
      >
        <span className="text-ink-dim">columns</span>
        <span className="text-brand">{DEFAULT_COLUMNS.join(" · ")}</span>
      </span>

      <Toggle
        label="heat"
        pressed={heat}
        onChange={() => onHeatChange?.(!heat)}
      />

      {/* Hidden exactly where the panel is, rather than left as a switch with
          nothing to open below the inspector breakpoint. */}
      <Toggle
        label="inspector"
        title="Show the inspector (⌘I)"
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

function ActionButton({ action }: { action: ToolbarAction }) {
  const disabled = action.unavailableReason !== undefined;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={action.onSelect}
      // `title` carries the reason on hover; aria-describedby would need an
      // element per button for the same sentence the title already says.
      title={action.unavailableReason}
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
      {action.hint && <span>{action.hint}</span>}
    </button>
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
              active ? "bg-accent-soft text-on-accent font-medium" : "text-ink-muted hover:text-ink"
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
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            aria-label={option.label}
            title={option.label}
            onClick={() => onChange(option.value)}
            className={`flex h-4.5 w-6 border ${
              active ? "border-accent bg-line text-ink-soft" : "border-line-strong text-ink-faint hover:text-ink-muted"
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
  title,
  pressed,
  tone = "warning",
  className = "flex",
  onChange,
}: {
  label: string;
  title?: string;
  pressed: boolean;
  tone?: "warning" | "accent";
  className?: string;
  onChange: () => void;
}) {
  const lit =
    tone === "accent" ? "border-accent-soft text-brand bg-accent/20" : "border-warning text-warning bg-warning/10";

  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onChange}
      className={`h-5 items-center rounded-sm border px-2 font-mono text-xs ${className} ${
        pressed ? lit : "border-line-strong text-ink-faint hover:text-ink-muted"
      }`}
    >
      {label}
    </button>
  );
}
