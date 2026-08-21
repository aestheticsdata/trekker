"use client";

import { Sparkline } from "@components/shell/sparkline";
import { hintFor } from "@helpers/keys";
import { PRESS } from "@helpers/press";

import type { ReactNode } from "react";

/**
 * The 34px top bar (TRE-14 §2, trued up against mockup 2a by TRE-42): who you
 * are looking at, what is saved, and how the machine is doing.
 *
 * Presentational on purpose. The host and its stats arrive from TRE-12's
 * endpoints once the sidebar owns selection (TRE-18); until then the shell
 * passes whatever it has, including nothing.
 */

export interface HostChip {
  label: string;
  /** The host's accent, straight from the Hosts row. */
  colour: string;
  /** "local" or "ssh" — shown beside the latency, as the mockup does. */
  transport?: string | null;
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

export function TopBar({
  host,
  stats,
  views,
  sudo,
  onOpenPalette,
}: {
  host: HostChip | null;
  stats: MachineStats | null;
  /**
   * The saved-views strip (TRE-37 §4), as a node rather than as data.
   *
   * The same call `sudo` below makes, and for a stronger reason: the strip
   * compares what is saved against what is on screen on every render, and it
   * owns a context menu and a modal. Passing rows here would mean this bar
   * taking the whole layout as a prop and re-rendering on every keystroke in
   * the glob field, which is precisely what it is not for.
   */
  views?: ReactNode;
  /**
   * The sudo badge for the host named in the chip (TRE-29).
   *
   * A slot rather than a pair of props, and for the reason stated at the top of
   * this file: the badge counts down once a second, and anything that ticks has
   * to own its own state or it repaints whatever passed it the number. Handing
   * it in as a node keeps that inside the badge and keeps this bar what it says
   * it is.
   */
  sudo?: ReactNode;
  onOpenPalette?: () => void;
}) {
  return (
    <header className="bg-chrome border-line flex h-topbar shrink-0 items-center gap-2.5 border-b px-2.5">
      <span className="flex items-center gap-2.25 pr-1.5 select-none">
        {/* The favicon's dual-pane mark, at chrome size. */}
        <svg
          viewBox="0 0 32 32"
          aria-hidden="true"
          className="size-3.75 shrink-0"
        >
          <rect
            width="32"
            height="32"
            rx="7"
            className="fill-line"
          />
          <rect
            x="6"
            y="7"
            width="8.4"
            height="18"
            rx="1.4"
            className="fill-brand"
          />
          <rect
            x="17.6"
            y="7"
            width="8.4"
            height="18"
            rx="1.4"
            className="fill-accent"
          />
        </svg>
        <span className="text-brand text-sm font-bold tracking-caps">TREKKER</span>
      </span>

      {host && (
        <span className="bg-line border-line-strong flex h-5.5 items-center gap-1.75 rounded-sm border px-2.5">
          <span
            aria-hidden
            className="size-1.5 rounded-full"
            style={{ backgroundColor: host.colour }}
          />
          <span className="text-ink-soft font-mono text-xs font-medium">{host.label}</span>
          {/* Transport is configuration, not a measurement: only the number degrades. */}
          <span className="text-ink-dim font-mono text-2xs">
            {host.transport ? `${host.transport} · ` : ""}
            {host.pingMs === null ? "—" : `${host.pingMs} ms`}
          </span>
        </span>
      )}

      {/* Beside the chip rather than inside it: the chip describes the host,
          this describes what this session may do to it, and a bordered control
          nested in a bordered chip reads as one thing with a seam. */}
      {host && sudo}

      {/* A rule between the host and the views, as 2a draws it: the chip says
          which machine, the strip says which arrangement, and they are two
          different questions. */}
      {views && (
        <span
          aria-hidden
          className="bg-line h-4 w-px flex-none"
        />
      )}
      {views}

      <div className="flex-1" />

      {/* First thing to go when the viewport narrows — the ladder in §5. */}
      {stats && (
        <dl className="text-ink-muted divide-line hidden items-center divide-x font-mono text-xs stats:flex">
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
          {stats.load.length > 0 && (
            <div className="flex items-center gap-1.5 px-2.5">
              <dt>load</dt>
              <dd className="text-ink font-medium">{stats.load[stats.load.length - 1]?.toFixed(2)}</dd>
              <dd>
                <Sparkline
                  values={stats.load}
                  label={`Load average over the last ${stats.load.length} samples`}
                />
              </dd>
            </div>
          )}
        </dl>
      )}

      {/* The chip reads its own name off the keymap (TRE-36 §2). It is the most
          visible shortcut in the app and it was the only one written as a
          literal — a chord moved in `helpers/keys.ts` while this said ⌘K would
          leave the app advertising the wrong key in its top right corner. */}
      <button
        type="button"
        onClick={onOpenPalette}
        className={`${PRESS} flex h-5 items-center rounded-sm px-2 font-mono text-xs font-medium`}
      >
        {hintFor("palette")}
      </button>
    </header>
  );
}

/** A stat renders its dash rather than vanishing: a missing value is a fact. */
function Stat({ term, value }: { term: string; value: string | null }) {
  return (
    <div className="flex items-center gap-1 px-2.5">
      <dt>{term}</dt>
      <dd className="text-ink font-medium">{value ?? "—"}</dd>
    </div>
  );
}
