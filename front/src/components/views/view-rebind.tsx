"use client";

import { Overlay } from "@components/ui/overlay";
import { Tooltip } from "@components/ui/tooltip";
import { PRESS } from "@helpers/press";
import { FORM_LABEL_INK, FORM_QUIET_INK, rebind } from "@helpers/views";
import { useState } from "react";

import type { BrokenPane, PaneKey } from "@helpers/views";
import type { HostView } from "@lib/api/hosts";
import type { SavedView, ViewLayout } from "@schemas/layout";

/**
 * A view that names a host the account no longer has (TRE-37 §1).
 *
 * Reported rather than degraded, which is the whole difference between this and
 * the session restore one ticket over. A cold open nobody asked for should
 * quietly fall back to the defaults — the reader did not request it and should
 * not have to acknowledge its failure. Pressing `⌥3` is a request for a
 * specific arrangement, and answering it by silently landing on `/` would be
 * the app doing something else and not saying so. Landing on whatever host
 * happens to be bound would be worse: the same paths, on the wrong machine.
 *
 * The offer is per pane, because only one of the two is usually gone. The other
 * restores exactly as saved either way.
 *
 * Whatever is chosen is applied and **not** written back. The view still says
 * what it said; the layout on screen no longer matches it, so the dirty dot
 * appears — which is true, and which puts "Update from current" one right-click
 * away for anybody who wants to make the rebinding permanent.
 */
export function ViewRebind({
  view,
  broken,
  hosts,
  onClose,
  onRestore,
}: {
  view: SavedView;
  broken: readonly BrokenPane[];
  hosts: readonly HostView[];
  onClose: () => void;
  onRestore: (layout: ViewLayout) => void;
}) {
  return (
    <Overlay
      label={`${view.name} cannot be restored as saved`}
      onClosed={onClose}
      panelClassName="bg-app border-line-strong flex w-full max-w-[28rem] flex-col overflow-hidden rounded-sm border shadow-2xl"
    >
      {(close) => (
        <RebindPanel
          view={view}
          broken={broken}
          hosts={hosts}
          close={close}
          onRestore={onRestore}
        />
      )}
    </Overlay>
  );
}

function RebindPanel({
  view,
  broken,
  hosts,
  close,
  onRestore,
}: {
  view: SavedView;
  broken: readonly BrokenPane[];
  hosts: readonly HostView[];
  close: () => void;
  onRestore: (layout: ViewLayout) => void;
}) {
  // Null means "open that pane on nothing", which is a real answer: a view of
  // two machines is still worth half-restoring when one of them is gone.
  const [choice, setChoice] = useState<Partial<Record<PaneKey, string | null>>>({});

  return (
    <>
      <header className="bg-line border-line-strong flex h-topbar flex-none items-center gap-2.25 border-b px-3">
        <span className="text-ink font-mono text-xs font-semibold tracking-label">host missing</span>
        <span className="text-ink-muted min-w-0 truncate font-mono text-2xs">{view.name}</span>
        <div className="flex-1" />
        <Tooltip content="Close (⎋)">
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="text-ink-dim flex-none font-mono text-2xs"
          >
            esc ✕
          </button>
        </Tooltip>
      </header>

      <div className="px-3.5 pt-3.25 pb-2.5">
        <p className="text-ink-soft mb-3 font-mono text-xs/[1.5]">
          {broken.length === 1
            ? `This view opens one pane on ${nameFor(broken[0])}, which this account no longer has.`
            : `This view opens both panes on hosts this account no longer has: ${broken.map(nameFor).join(" and ")}.`}
        </p>

        {broken.map((pane) => (
          <div
            key={pane.pane}
            className="mb-2.5 last:mb-0"
          >
            <div
              className={`${FORM_LABEL_INK} mb-1.25 font-sans text-3xs/none font-medium tracking-[0.12em] uppercase`}
            >
              pane {pane.pane.toUpperCase()} — was {nameFor(pane)}
            </div>
            <select
              value={choice[pane.pane] ?? ""}
              onChange={(event) => setChoice({ ...choice, [pane.pane]: event.target.value || null })}
              aria-label={`Host for pane ${pane.pane.toUpperCase()}`}
              className="bg-chrome border-line-strong text-ink w-full border px-2.5 py-1.75 font-mono text-xs"
            >
              <option value="">leave it on nothing</option>
              {hosts.map((host) => (
                <option
                  key={host.id}
                  value={host.id}
                >
                  {host.label}
                </option>
              ))}
            </select>
            {/* The path is not carried across. A path only means something
                against the machine it was read from, and `/var/log/nginx` on a
                different box is how a rebound view lands in an empty directory
                and reads as broken rather than as moved. */}
            <p className={`${FORM_QUIET_INK} mt-1 font-mono text-caption`}>
              {choice[pane.pane] ? "opens at its home directory" : "opens unbound, at /"}
            </p>
          </div>
        ))}
      </div>

      <footer className="bg-chrome border-line flex h-11 flex-none items-center gap-2 border-t px-3.5">
        <span className="text-ink-muted font-mono text-2xs/none">the view itself is not changed</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={close}
          className="border-line-strong text-ink-soft border px-3.5 py-1.75 font-mono text-xs/none"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={() => {
            onRestore(rebind(view.layout, choice));
            close();
          }}
          className={`${PRESS} px-3.5 py-1.75 font-mono text-xs/none font-medium`}
        >
          restore
        </button>
      </footer>
    </>
  );
}

/** What the missing host was called, or an honest shrug when nothing was kept. */
function nameFor(pane: BrokenPane): string {
  return pane.was ?? "a host that has been removed";
}
