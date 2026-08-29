"use client";

import { Overlay } from "@components/ui/overlay";
import { ScrollThumbRail, useScrollThumbs } from "@components/ui/scroll-thumbs";
import { KEYS, matches } from "@helpers/keys";
import {
  commonPrefix,
  completions,
  FALLBACK_INK,
  GLYPH,
  ICON_INK,
  ICON_ON_INK,
  joinInto,
  KEY_EDGE,
  KEY_INK,
  PALETTE_EDGE,
  PALETTE_INPUT_INK,
  PALETTE_LABEL_INK,
  PALETTE_QUIET_INK,
  PALETTE_RULE,
  PALETTE_SURFACE,
  pathQuery,
  ROW_DANGER_INK,
  ROW_DETAIL_INK,
  ROW_DETAIL_ON_INK,
  ROW_EDGE,
  ROW_FILL,
  ROW_LABEL_INK,
  ROW_LABEL_ON_INK,
  ROW_OFF_INK,
  rank,
  withHeads,
} from "@helpers/palette";
import { fetchListing } from "@lib/api/fs";
import { QUERY_KEYS } from "@lib/query/keys";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { PaletteGroup } from "@helpers/palette";

/**
 * ⌘K (TRE-36).
 *
 * The palette is how a keyboard app stays learnable. Every operation is
 * reachable by typing part of its name, every entry shows the key that reaches
 * it directly, and so using this is how somebody stops needing it. That last
 * part is the whole design, and it is why the keys come from `helpers/keys.ts`
 * and never from a literal near a label: an entry teaching a key that no longer
 * fires does not read as a stale label, it reads as a broken app.
 *
 * This file draws and decides nothing about what exists. The entries arrive
 * built — the explorer knows the panes, the selection, the hosts and what each
 * of them can do right now — and the only rows it makes for itself are the ones
 * that depend on what has been typed: an absolute path and the directories
 * under it.
 *
 * **Unavailable entries are shown, not hidden.** An action that cannot run for
 * this selection is drawn quiet, with the sentence why in place of its
 * description, and the keyboard still walks onto it. A palette that hides what
 * it cannot do right now is a palette nobody can learn the application from,
 * which is the one thing this is for.
 */

/** One row. Everything except the path rows arrives from the caller like this. */
export interface PaletteEntry {
  /** Stable across re-renders and unique in the list — the React key, and the cursor's anchor. */
  id: string;
  /** One of the mockup's six. A union rather than a string, so a group invented
   *  by a typo is a compile error and not a header nobody notices. */
  group: PaletteGroup;
  label: string;
  /** The small second line. Ranked against, and replaced by a reason when disabled. */
  detail: string;
  icon: string;
  /** From the keymap, or absent when no chord reaches it. */
  hint?: string;
  /** Present means it cannot run now, and this is the sentence saying why. */
  unavailableReason?: string;
  danger?: boolean;
  run: () => void;
}

/**
 * How many directories a typed path offers.
 *
 * The list scrolls, so this is not about height: it is about a `/` typed at the
 * root of a machine with four hundred entries in it, where the answer is to
 * type another character rather than to scroll through them.
 */
const COMPLETION_LIMIT = 8;

/** The same window the terminal's `ls` uses — a directory just walked is warm. */
const STALE_MS = 10_000;

export function Palette({
  entries,
  cwd,
  hostId,
  hostLabel,
  initialQuery = "",
  onGo,
  onShell,
  onClosed,
}: {
  entries: readonly PaletteEntry[];
  /**
   * What the field opens with (TRE-37 §4).
   *
   * One caller sets it: the top bar's `+n`, which is the overflow of the saved
   * views strip and opens this on the word `view` rather than growing a second
   * menu of its own. Everything else opens empty, which is the point of ⌘K.
   */
  initialQuery?: string;
  /** The active pane's directory: the footer states it, and the shell runs there. */
  cwd: string;
  /** The active pane's host, for path completions. Null when nothing is bound. */
  hostId: string | null;
  hostLabel: string | null;
  onGo: (path: string) => void;
  /**
   * What ↩ does when nothing matches: hand the line to the terminal (TRE-35).
   *
   * 2a's own fallback, and it stays honest against a restricted command set —
   * the parser either runs it or prints the refusal that lists what it does
   * take, and either answer is more use than a dead keypress on an empty list.
   */
  onShell: (line: string) => void;
  onClosed: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [at, setAt] = useState(0);
  /**
   * What ↩ picked, held until the panel has finished leaving.
   *
   * Running it immediately would open the next modal over the top of a palette
   * still animating out, which is the one thing `Overlay`'s two-step close
   * exists to prevent. 2a solves it with a 10ms timeout; this waits for the
   * animation that is actually running.
   */
  const [chosen, setChosen] = useState<{ run: () => void } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** The in-flow wrapper the rows sit in, whose height *is* the content height. */
  const rowsRef = useRef<HTMLDivElement>(null);

  // Opened by a keypress, so the caret goes where the keypress meant to.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const path = pathQuery(query);

  /**
   * The directory a typed path is inside.
   *
   * Keyed like every other listing in the app, so a directory either pane has
   * walked through is already here and completions appear on the keystroke.
   * `dir` changes once per `/` typed, not once per character — the leaf is
   * filtered locally — so this is at most one request per path segment.
   */
  const { data: listing } = useQuery({
    queryKey: [QUERY_KEYS.DIRECTORY, hostId, path?.dir ?? null],
    queryFn: () => fetchListing(hostId as string, path?.dir as string),
    enabled: hostId !== null && path !== null,
    staleTime: STALE_MS,
    retry: false,
    throwOnError: false,
  });

  /** Directories only. A path row that landed on a file would not be a path row. */
  const reachable = (listing?.entries ?? [])
    .filter((entry) => entry.type === "dir" || entry.type === "link")
    .map((entry) => entry.name);
  const candidates = path === null ? [] : completions(path.leaf, reachable, COMPLETION_LIMIT);

  const pathRows: readonly PaletteEntry[] =
    path === null
      ? []
      : [
          {
            id: `path:${path.target}`,
            group: "GO TO",
            label: path.target,
            detail:
              hostId === null ? "this pane has no host to go anywhere on" : `go here on ${hostLabel ?? "this host"}`,
            icon: GLYPH.goTo,
            unavailableReason: hostId === null ? "Bind a host to this pane first" : undefined,
            run: () => onGo(path.target),
          },
          ...candidates
            // The one already offered above, when what was typed is a whole name.
            .filter((name) => joinInto(path.dir, name) !== path.target)
            .map(
              (name): PaletteEntry => ({
                id: `path:${joinInto(path.dir, name)}`,
                group: "GO TO",
                label: joinInto(path.dir, name),
                detail: "directory",
                icon: GLYPH.goTo,
                run: () => onGo(joinInto(path.dir, name)),
              }),
            ),
        ];

  /**
   * The list, path rows first.
   *
   * The ordinary entries are still ranked against the same string rather than
   * suppressed, and that is deliberate: `/srv` is a perfectly good query for a
   * favourite called `/srv/backups`, and hiding it because the input starts
   * with a slash would make path mode a trap rather than a shortcut.
   */
  const rows = [...pathRows, ...rank(entries, query)];
  const shown = withHeads(rows);

  /**
   * Where the cursor lands when the list changes.
   *
   * The first row that can actually run, rather than simply the first row: with
   * nothing selected in the pane, half of ACTIONS is unavailable, and a palette
   * whose ↩ does nothing the moment it opens reads as broken rather than as
   * careful. Arrowing still reaches the quiet rows — they are there to be read.
   */
  // The separator is written as an escape, not as the character. TRE-36
  // shipped a literal NUL in this line, which git reads as a binary file and
  // grep refuses to search — so the file could not be diffed or found in.
  const signature = rows.map((row) => row.id).join("\u0000");
  useEffect(() => {
    const first = rows.findIndex((row) => row.unavailableReason === undefined);
    setAt(first === -1 ? 0 : first);
    // `signature` is what actually changed about `rows`, which is rebuilt on
    // every render — the same guard the explorer's action context uses.
  }, [signature]);

  const cursor = Math.min(at, Math.max(0, rows.length - 1));
  const current = rows[cursor] ?? null;

  /**
   * Keeps the cursor row on screen when the keyboard walks past the fold, and
   * when a new query rebuilds the list under a list that had been scrolled.
   */
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-current]")?.scrollIntoView({ block: "nearest" });
  }, [cursor, signature]);

  /**
   * The composited thumb (TRE-120).
   *
   * This list was the last scroller in the app still on the main-thread-painted
   * bar, and the only one somebody complained about — 33 entries is close to
   * four screens, not the three rows the exclusion assumed. `signature` is what
   * changes when the rows do, which is the same string the cursor effect above
   * already watches.
   */
  useScrollThumbs(listRef, signature, rowsRef);

  const move = (delta: 1 | -1) => {
    if (rows.length === 0) return;
    setAt(Math.min(rows.length - 1, Math.max(0, cursor + delta)));
  };

  /**
   * `⇥` fills in as far as every candidate agrees, the way a shell does.
   *
   * Not "jump to the first match": with `log` and `logrotate` under `/var`, the
   * first match is a guess and the common head is a fact. A single candidate is
   * completed with its `/` attached, because the only reason to complete a
   * directory is to carry on into it.
   */
  const complete = () => {
    if (path === null || candidates.length === 0) return;
    if (candidates.length === 1) {
      setQuery(`${joinInto(path.dir, candidates[0])}/`);
      return;
    }
    const shared = commonPrefix(candidates);
    if (shared.length > path.leaf.length) setQuery(joinInto(path.dir, shared));
  };

  return (
    <Overlay
      label="Command palette"
      align="top"
      onClosed={() => {
        chosen?.run();
        onClosed();
      }}
      panelClassName={`${PALETTE_SURFACE} ${PALETTE_EDGE} max-w-palette flex w-full flex-col overflow-hidden rounded-sm border shadow-2xl`}
    >
      {(close) => {
        const pick = (row: PaletteEntry) => {
          // Nothing at all on an entry that cannot run. The reason is already on
          // the row being looked at; closing the palette would take it away.
          if (row.unavailableReason !== undefined) return;
          setChosen({ run: row.run });
          close();
        };

        return (
          <>
            <div className={`${PALETTE_RULE} flex h-10.5 flex-none items-center gap-2.25 border-b px-3`}>
              <span
                aria-hidden
                className={`${PALETTE_LABEL_INK} font-mono text-md/none font-medium`}
              >
                ›
              </span>
              <input
                ref={inputRef}
                type="text"
                value={query}
                aria-label="Command palette"
                placeholder="go to a path, run an action, search…"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (matches(event, KEYS.palette)) {
                    // The key that opens it closes it, which is the rule ⌥↩
                    // already follows for the terminal. Taken from the browser
                    // rather than left to it — Chrome's own ⌘K puts the caret
                    // in the address bar, and a palette that threw somebody out
                    // of the app for pressing its own shortcut twice would be a
                    // worse answer than doing nothing.
                    event.preventDefault();
                    close();
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    move(1);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    move(-1);
                    return;
                  }
                  if (event.key === "Tab") {
                    // Taken from the browser deliberately: there is nothing else
                    // in this panel to move focus to, and ⇥ is what completes a
                    // path everywhere else somebody types one.
                    event.preventDefault();
                    complete();
                    return;
                  }
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (current !== null) {
                    pick(current);
                    return;
                  }
                  // Nothing matched. The line goes to the terminal, which is the
                  // fallback the footer and the empty state both promise.
                  if (query.trim().length === 0) return;
                  setChosen({ run: () => onShell(query) });
                  close();
                }}
                className={`${PALETTE_INPUT_INK} placeholder:text-ink-faint caret-brand min-w-0 flex-1 bg-transparent font-mono text-base/none outline-none`}
              />
              <span className={`${PALETTE_QUIET_INK} flex-none font-mono text-caption/none`}>
                {rows.length}/{entries.length}
              </span>
            </div>

            <div
              ref={listRef}
              className="scroll-composited max-h-palette-body min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
            >
              <ScrollThumbRail />
              {/* The padding rides the wrapper rather than the scroller, the
                  sidebar's rule: the thumb's travel is spanned in the scrollport's
                  content box and its length is measured from `clientHeight`, and
                  padding on the scroller is what makes those two disagree. */}
              <div
                ref={rowsRef}
                className="py-1"
              >
                {shown.map(({ item, head }, index) => (
                  <div key={item.id}>
                    {head !== null && (
                      <div
                        className={`${PALETTE_LABEL_INK} px-3 pt-2 pb-1 font-sans text-3xs/none font-semibold tracking-[0.16em]`}
                      >
                        {head}
                      </div>
                    )}
                    <Row
                      entry={item}
                      selected={index === cursor}
                      onHover={() => setAt(index)}
                      onPick={() => pick(item)}
                    />
                  </div>
                ))}

                {rows.length === 0 && (
                  <p className={`${PALETTE_QUIET_INK} px-3 py-6.5 text-center font-mono text-xs/[1.6]`}>
                    no command matches “{query}”
                    <br />
                    <span className={FALLBACK_INK}>↩ runs it in the terminal instead</span>
                  </p>
                )}
              </div>
            </div>

            <div
              className={`${PALETTE_RULE} ${PALETTE_QUIET_INK} flex h-6.5 flex-none items-center gap-3.5 border-t px-3 font-mono text-caption/none`}
            >
              <span className="whitespace-nowrap">↑↓ navigate</span>
              <span className="whitespace-nowrap">↩ run</span>
              <span className="whitespace-nowrap">⇥ autocomplete</span>
              <span className="whitespace-nowrap">⎋ close</span>
              <span className="min-w-0 flex-1 truncate text-right">{cwd}</span>
            </div>
          </>
        );
      }}
    </Overlay>
  );
}

/**
 * One row: icon, label over description, and the key that reaches it.
 *
 * `onMouseDown` rather than `onClick`, with the default prevented — a click
 * that took focus off the input would leave the palette with no keyboard, and
 * pressing something and then pressing ↩ is an ordinary thing to do.
 */
function Row({
  entry,
  selected,
  onHover,
  onPick,
}: {
  entry: PaletteEntry;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const off = entry.unavailableReason !== undefined;
  const badge = entry.hint ?? (selected && !off ? "↩" : null);

  return (
    <button
      type="button"
      data-current={selected ? "" : undefined}
      aria-disabled={off}
      onMouseEnter={onHover}
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
      className={`flex h-8.5 w-full items-center gap-2.5 border-l-2 px-3 text-left ${
        selected ? `${ROW_FILL} ${ROW_EDGE}` : "border-transparent"
      } ${off ? "cursor-not-allowed" : ""}`}
    >
      <span
        aria-hidden
        className={`w-4 flex-none text-center font-mono text-xs/none ${selected ? ICON_ON_INK : ICON_INK}`}
      >
        {entry.icon}
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={`block truncate font-mono text-name/[1.3] ${
            entry.danger ? ROW_DANGER_INK : off ? ROW_OFF_INK : selected ? ROW_LABEL_ON_INK : ROW_LABEL_INK
          }`}
        >
          {entry.label}
        </span>
        <span
          className={`block truncate font-mono text-caption/[1.3] ${selected ? ROW_DETAIL_ON_INK : ROW_DETAIL_INK}`}
        >
          {entry.unavailableReason ?? entry.detail}
        </span>
      </span>

      {/* The key, or `↩` on the row about to be run — 2a's rule, and the reason
          the badge is not simply absent when no chord reaches an entry: the
          selected row always says how to run it. Nothing on a row that cannot
          run, which would be advertising a key that does nothing. */}
      {badge !== null && (
        <span
          className={`${KEY_INK} flex-none border px-1.5 py-0.75 font-mono text-caption/none ${
            selected ? KEY_EDGE : "border-transparent"
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
