"use client";

import { Sparkline } from "@components/shell/sparkline";

/**
 * The 34px top bar (TRE-14 §2): who you are looking at, what is saved, and how
 * the machine is doing.
 *
 * Presentational on purpose. The host and its stats arrive from TRE-12's
 * endpoints once the sidebar owns selection (TRE-18); until then the shell
 * passes whatever it has, including nothing.
 */

export interface HostChip {
  label: string;
  /** The host's accent, straight from the Hosts row. */
  colour: string;
  /** Round-trip in ms, or null when it has not answered yet. */
  pingMs: number | null;
}

export interface MachineStats {
  uptime: string | null;
  cpu: string | null;
  ram: string | null;
  io: string | null;
  load: readonly number[];
}

export interface SavedView {
  id: string;
  name: string;
  /** "⌥1" and friends. */
  shortcut?: string;
}

/** How many view chips fit before the rest collapse into "+n". */
const VISIBLE_VIEWS = 4;

export function TopBar({
  host,
  stats,
  views = [],
  onOpenPalette,
}: {
  host: HostChip | null;
  stats: MachineStats | null;
  views?: readonly SavedView[];
  onOpenPalette?: () => void;
}) {
  const shown = views.slice(0, VISIBLE_VIEWS);
  const overflow = views.length - shown.length;

  return (
    <header className="bg-chrome border-line flex h-topbar shrink-0 items-center gap-3 border-b px-2">
      <span className="text-ink text-sm font-semibold tracking-caps select-none">TREKKER</span>

      {host && (
        <span className="border-line-strong bg-raised flex items-center gap-1.5 rounded-xs border px-1.5 py-0.5">
          <span
            aria-hidden
            className="size-1.5 rounded-full"
            style={{ backgroundColor: host.colour }}
          />
          <span className="text-ink-soft text-xs">{host.label}</span>
          <span className="text-ink-faint font-mono text-2xs">{host.pingMs === null ? "—" : `${host.pingMs}ms`}</span>
        </span>
      )}

      {views.length > 0 && (
        <nav
          aria-label="Saved views"
          className="flex min-w-0 items-center gap-1"
        >
          {shown.map((view) => (
            <button
              key={view.id}
              type="button"
              className="text-ink-muted hover:text-ink hover:bg-raised max-w-28 truncate rounded-xs px-1.5 py-0.5 text-2xs tracking-label"
            >
              {view.name}
              {view.shortcut && <span className="text-ink-faint ml-1 font-mono">{view.shortcut}</span>}
            </button>
          ))}
          {overflow > 0 && (
            <span
              className="text-ink-faint font-mono text-2xs"
              title={views
                .slice(VISIBLE_VIEWS)
                .map((view) => view.name)
                .join(", ")}
            >
              +{overflow}
            </span>
          )}
        </nav>
      )}

      <div className="flex-1" />

      {/* First thing to go when the viewport narrows — the ladder in §5. */}
      {stats && (
        <dl className="text-ink-faint hidden items-center gap-3 font-mono text-2xs stats:flex">
          <Stat
            term="up"
            value={stats.uptime}
          />
          <Stat
            term="cpu"
            value={stats.cpu}
          />
          <Stat
            term="ram"
            value={stats.ram}
          />
          <Stat
            term="io"
            value={stats.io}
          />
          {stats.load.length > 1 && (
            <div className="flex items-center gap-1">
              <dt>load</dt>
              <dd className="text-ink-dim">
                <Sparkline
                  values={stats.load}
                  label={`Load average over the last ${stats.load.length} samples`}
                />
              </dd>
            </div>
          )}
        </dl>
      )}

      <button
        type="button"
        onClick={onOpenPalette}
        className="border-line-strong text-ink-muted hover:text-ink hover:border-accent-soft flex items-center gap-1 rounded-xs border px-1.5 py-0.5 font-mono text-2xs"
      >
        ⌘K
      </button>
    </header>
  );
}

/** A stat renders its dash rather than vanishing: a missing value is a fact. */
function Stat({ term, value }: { term: string; value: string | null }) {
  return (
    <div className="flex items-center gap-1">
      <dt>{term}</dt>
      <dd className="text-ink-dim">{value ?? "—"}</dd>
    </div>
  );
}
