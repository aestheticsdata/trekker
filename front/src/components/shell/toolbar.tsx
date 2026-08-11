"use client";

/**
 * The 30px toolbar (TRE-14 §3).
 *
 * The action buttons are here before the actions are. M2 implements copy,
 * move, compare, chmod, rename and rm; until then each renders disabled and
 * says why on hover. Visible and inert beats absent — the shortcut hints are
 * how anyone learns this app has an F5 and an F6 at all, and a toolbar that
 * grows buttons over three milestones never looks like a finished product.
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
  { id: "copy", label: "Copy", hint: "F5", unavailableReason: "Transfers arrive in TRE-23" },
  { id: "move", label: "Move", hint: "F6", unavailableReason: "Transfers arrive in TRE-23" },
  { id: "compare", label: "Compare", unavailableReason: "Pane comparison arrives in TRE-28" },
  { id: "chmod", label: "Permissions", unavailableReason: "chmod and chown arrive in TRE-21" },
  { id: "rename", label: "Rename", hint: "F2", unavailableReason: "Regex rename arrives in TRE-22" },
  { id: "rm", label: "Delete", hint: "⌦", danger: true, unavailableReason: "Delete arrives in TRE-25" },
];

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
  actions?: readonly ToolbarAction[];
}) {
  return (
    <div className="bg-chrome border-line flex h-toolbar shrink-0 items-center gap-2 border-b px-2">
      <Segmented
        label="View mode"
        value={viewMode}
        onChange={(value) => onViewModeChange?.(value as ViewMode)}
        options={[
          { value: "list", label: "List" },
          { value: "detail", label: "Detail" },
        ]}
      />

      <Segmented
        label="Split"
        value={splitMode}
        onChange={(value) => onSplitModeChange?.(value as SplitMode)}
        options={[
          { value: "left", label: "◧" },
          { value: "split", label: "◫" },
          { value: "right", label: "◨" },
        ]}
      />

      <div className="flex min-w-0 items-center gap-1">
        <input
          type="text"
          value={glob}
          onChange={(event) => onGlobChange?.(event.target.value)}
          placeholder="*.log"
          aria-label="Filter by glob"
          className="border-line-strong bg-app text-ink placeholder:text-ink-faint focus:border-accent-soft w-28 rounded-xs border px-1.5 py-0.5 font-mono text-2xs outline-none"
        />
        {globMatches !== null && (
          <span className="text-ink-faint font-mono text-2xs whitespace-nowrap">{globMatches} hit</span>
        )}
      </div>

      <Toggle
        label="Heat"
        pressed={heat}
        onChange={() => onHeatChange?.(!heat)}
      />

      <div className="flex-1" />

      <div className="flex items-center gap-1">
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
        "flex items-center gap-1 rounded-xs border px-1.5 py-0.5 text-2xs",
        disabled
          ? "border-line text-ink-faint cursor-not-allowed opacity-60"
          : action.danger
            ? "border-danger text-danger-soft hover:border-danger-mid hover:bg-danger/20"
            : "border-line-strong text-ink-muted hover:text-ink hover:border-accent-soft",
      ].join(" ")}
    >
      {action.label}
      {action.hint && <span className="text-ink-faint font-mono">{action.hint}</span>}
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
      className="border-line-strong flex overflow-hidden rounded-xs border"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`px-1.5 py-0.5 text-2xs ${
              active ? "bg-raised text-ink" : "text-ink-faint hover:text-ink-muted"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

function Toggle({ label, pressed, onChange }: { label: string; pressed: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onChange}
      className={`rounded-xs border px-1.5 py-0.5 text-2xs ${
        pressed ? "border-warning text-warning bg-warning/10" : "border-line-strong text-ink-faint hover:text-ink-muted"
      }`}
    >
      {label}
    </button>
  );
}
