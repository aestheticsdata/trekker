"use client";

import { useAuth } from "@auth/context/AuthContext";
import { Overlay } from "@components/ui/overlay";
import { useToast } from "@components/ui/toast";
import { Tooltip } from "@components/ui/tooltip";
import { joinPath } from "@helpers/listing";
import { ON_FILL, PRESS, SELECTED } from "@helpers/press";
import { ApiError } from "@lib/api/client";
import { applyRename, previewRename, renameEntry } from "@lib/api/rename";
import { QUERY_KEYS } from "@lib/query/keys";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { FileRow } from "@lib/api/fs";
import type { RenameMapping, RenamePlan } from "@lib/api/rename";

/**
 * The rename modal (TRE-22 §4), built from mockup 2a's own markup.
 *
 * 2a's idea, and the reason it is worth building as drawn: the pattern is not
 * something you apply and then inspect, it is something you watch. Every name
 * in the selection is on screen with its matched span lit and its result beside
 * it, and the summary counts how many of them actually change — so a pattern
 * that matches nothing, or matches everything, says so while you are still
 * typing it.
 *
 * Two things are here that 2a does not draw, both required by the ticket and
 * both about the same danger. Collisions are marked per row and refuse the CTA:
 * the mockup's `applyRename` maps names through `String.replace` and writes
 * them back, which for two entries landing on one name is a file that stops
 * existing. And there is a plain name field beside the pattern, because writing
 * a regex to rename one file is a ceremony nobody wants and the API has a route
 * that does not ask for one.
 *
 * **Which of the two opens is the caller's decision, not the selection's.** F2
 * on one entry means "rename this", so it opens on the name; the toolbar's
 * button is the only way to the pattern, so it opens there whatever is
 * selected. Deciding from the selection instead — as this first shipped —
 * leaves the pattern unreachable for a single file.
 *
 * Every preview on screen came from the server. Nothing in this file computes
 * a new name — see the note in `lib/api/rename.ts`.
 */

/** Which form the modal shows. `name` needs exactly one entry; `pattern` never does. */
export type RenameMode = "name" | "pattern";

/** Long enough that a pattern is not compiled on every keystroke of it. */
const PREVIEW_DEBOUNCE_MS = 180;

export interface RenameTarget {
  hostId: string;
  /** The directory the entries live in. */
  directory: string;
  /** What is selected, in listing order. Never empty. */
  entries: readonly FileRow[];
}

export function RenameModal({
  target,
  initialMode,
  onClose,
  onApplied,
}: {
  target: RenameTarget;
  /** What the caller asked for. A `name` request over several entries opens on
   * the pattern anyway — there is no single name to type. */
  initialMode: RenameMode;
  onClose: () => void;
  onApplied: () => void;
}) {
  const subject =
    target.entries.length === 1 ? target.entries[0].name : `${target.entries.length} entries in ${target.directory}`;

  return (
    <Overlay
      label={`Rename ${subject}`}
      onClosed={onClose}
      panelClassName="bg-app border-line-strong flex w-full max-w-[46.25rem] flex-col overflow-hidden rounded-sm border shadow-2xl"
    >
      {(close) => (
        <RenamePanel
          target={target}
          initialMode={initialMode}
          subject={subject}
          close={close}
          onApplied={onApplied}
        />
      )}
    </Overlay>
  );
}

function RenamePanel({
  target,
  initialMode,
  subject,
  close,
  onApplied,
}: {
  target: RenameTarget;
  initialMode: RenameMode;
  subject: string;
  close: () => void;
  onApplied: () => void;
}) {
  const { csrfToken } = useAuth();
  const { push } = useToast();
  const { hostId, directory, entries } = target;

  const only = entries.length === 1 ? entries[0] : null;
  const paths = entries.map((entry) => joinPath(directory, entry.name));

  // A `name` request with nothing single to name falls through to the pattern
  // rather than rendering a field with no subject.
  const [mode, setMode] = useState<RenameMode>(() => (initialMode === "name" && only ? "name" : "pattern"));
  const single = mode === "name" ? only : null;

  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [global, setGlobal] = useState(true);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [name, setName] = useState(() => only?.name ?? "");
  const [failure, setFailure] = useState<string | null>(null);

  const settledPattern = useDebounced(pattern, PREVIEW_DEBOUNCE_MS);
  const settledReplacement = useDebounced(replacement, PREVIEW_DEBOUNCE_MS);

  // Asked for only once there is a pattern to ask about. An empty field matches
  // every name at offset zero and replaces nothing, which is a real answer and
  // a pointless one — and it would put a thread on the API per open modal.
  //
  // The flags are not debounced: they are two buttons, and waiting a fifth of a
  // second after a click reads as the toggle not having worked.
  const preview = useQuery({
    queryKey: [
      QUERY_KEYS.RENAME_PREVIEW,
      hostId,
      directory,
      paths.length,
      settledPattern,
      settledReplacement,
      global,
      ignoreCase,
    ],
    queryFn: () =>
      previewRename(
        { hostId, paths, pattern: settledPattern, replacement: settledReplacement, global, ignoreCase },
        csrfToken,
      ),
    enabled: single === null && settledPattern !== "",
    retry: false,
    throwOnError: false,
    staleTime: 30_000,
  });

  const plan = preview.data ?? null;
  // While a request is in flight the previous plan stays on screen rather than
  // the rows emptying: a list that blinks out between keystrokes is unreadable,
  // and the summary below says the drawing is behind the field.
  const stale = preview.isFetching || settledPattern !== pattern || settledReplacement !== replacement;
  const refused = plan?.error ?? (preview.error instanceof ApiError ? preview.error.message : null);

  const renameable = single
    ? name.trim() !== "" && name !== single.name
    : plan !== null &&
      !stale &&
      plan.error === null &&
      plan.changed > 0 &&
      !plan.mappings.some((row) => row.problem !== null);

  const apply = useMutation({
    mutationFn: async () => {
      setFailure(null);
      if (single) return renameEntry({ hostId, path: joinPath(directory, single.name), newName: name }, csrfToken);
      return applyRename({ hostId, paths, pattern, replacement, global, ignoreCase }, csrfToken);
    },
    onSuccess: (result) => {
      onApplied();
      if (result.stranded.length > 0) {
        // The one outcome that must not be a toast that scrolls away: entries
        // are sitting in the directory under a name the app invented.
        setFailure(
          `The rename failed part-way and ${result.stranded.length} ${result.stranded.length === 1 ? "entry is" : "entries are"} under a temporary name: ${result.stranded.join(", ")}`,
        );
        return;
      }
      push({
        tone: "success",
        message: single
          ? `${single.name} → ${name}`
          : `Renamed ${result.renamed} ${result.renamed === 1 ? "entry" : "entries"}`,
        detail: single ? undefined : `s/${pattern}/${replacement}/`,
      });
      close();
    },
    onError: (error: unknown) => {
      setFailure(error instanceof ApiError ? error.message : "The rename could not be applied.");
    },
  });

  const rows: readonly RenameMapping[] = single
    ? [singleMapping(single.name, name)]
    : (plan?.mappings ?? entries.map((entry) => singleMapping(entry.name, entry.name)));

  /**
   * The field this modal exists for, focused once on open.
   *
   * One ref for both, because only one of the two is ever mounted. An effect
   * rather than `autoFocus`, which a11y lint rejects for good reason on a page
   * — inside a dialog the keyboard has nowhere else to be, and this is also the
   * only way to place the selection.
   *
   * For a single entry the extension is left out of the selection: renaming
   * `notes.txt` hardly ever means renaming the `.txt`.
   */
  const field = useRef<HTMLInputElement>(null);
  const openedOn = single?.name;
  useEffect(() => {
    field.current?.focus();
    if (openedOn !== undefined) field.current?.setSelectionRange(0, stemLength(openedOn));
  }, [openedOn]);

  return (
    <>
      <header className="bg-line border-line-strong flex h-topbar flex-none items-center gap-2.25 border-b px-3">
        <span className="text-ink font-mono text-xs font-semibold tracking-label">rename</span>
        <span className="text-ink-muted min-w-0 truncate font-mono text-cmd">{subject}</span>
        <div className="flex-1" />
        {/* Both forms, always visible, so neither entry point is a dead end:
            the toolbar's `rename` opens on the pattern and the name is one
            click away, and F2 on one entry does the reverse. */}
        <fieldset
          aria-label="Rename by"
          className="border-line-strong flex h-5 flex-none overflow-hidden rounded-sm border"
        >
          {(["name", "pattern"] as const).map((option) => {
            const active = mode === option;
            // A name field over a multiple selection has no subject to show, so
            // the cell says why it is inert rather than simply not responding.
            const disabled = option === "name" && only === null;
            return (
              <Tooltip
                key={option}
                content={disabled ? "One entry at a time — the pattern renames a selection" : undefined}
              >
                <button
                  type="button"
                  aria-pressed={active}
                  // `aria-disabled`, not `disabled` (TRE-76): that sentence *is*
                  // the explanation of the disabling, and a control disabled by
                  // the attribute is neither hoverable nor a tab stop, so it was
                  // the one cell nobody could ask.
                  aria-disabled={disabled}
                  onClick={() => !disabled && setMode(option)}
                  className={`border-line-strong flex items-center border-l px-2.25 font-mono text-2xs first:border-l-0 aria-disabled:opacity-40 ${
                    active ? `${SELECTED} font-medium` : "text-ink-muted"
                  }`}
                >
                  {option}
                </button>
              </Tooltip>
            );
          })}
        </fieldset>
        <Tooltip content="Close (⎋)">
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="text-ink-dim font-mono text-2xs"
          >
            esc ✕
          </button>
        </Tooltip>
      </header>

      {single ? (
        <div className="px-3.5 pt-3.25 pb-2.5">
          <Label>name</Label>
          <input
            ref={field}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && renameable && !apply.isPending) apply.mutate();
            }}
            aria-label="New name"
            className="bg-chrome border-accent text-ink w-full border px-2.25 py-1.75 font-mono text-name/none"
          />
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_1fr_6rem] gap-2 px-3.5 pt-3.25 pb-2.5">
          <div>
            <Label>match</Label>
            <input
              ref={field}
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              placeholder="^dump-(\d{4})-(\d{2})-(\d{2})"
              aria-label="Pattern"
              className={`bg-chrome text-ink w-full border px-2.25 py-1.75 font-mono text-name/none ${
                plan?.error ? "border-danger" : "border-accent"
              }`}
            />
          </div>
          <div>
            <Label>replace</Label>
            <input
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              placeholder="atlas_$1$2$3"
              aria-label="Replacement"
              className="bg-chrome border-line-strong text-ink w-full border px-2.25 py-1.75 font-mono text-name/none"
            />
          </div>
          <div>
            <Label>flags</Label>
            <div className="flex gap-1">
              <Flag
                label="g"
                on={global}
                onToggle={() => setGlobal((current) => !current)}
              />
              <Flag
                label="i"
                on={ignoreCase}
                onToggle={() => setIgnoreCase((current) => !current)}
              />
            </div>
          </div>
        </div>
      )}

      {(failure ?? refused) && (
        <div className="bg-danger-wash border-danger text-danger-soft mx-3.5 mb-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          {failure ?? refused}
        </div>
      )}

      <div className="border-line max-h-70 flex-1 overflow-y-auto border-t border-b">
        {rows.map((row) => (
          <Row
            key={row.name}
            row={row}
          />
        ))}
      </div>

      <footer className="bg-chrome flex h-11 flex-none items-center gap-2 px-3.5">
        <span className="text-ink-muted font-mono text-2xs/none">
          {summaryOf({ single: single !== null, plan, stale, rows, pattern })}
        </span>
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
          onClick={() => apply.mutate()}
          disabled={!renameable || apply.isPending}
          className={`${PRESS} disabled:bg-line disabled:text-ink-faint px-3.5 py-1.75 font-mono text-xs/none font-medium disabled:cursor-not-allowed`}
        >
          {apply.isPending ? "renaming…" : ctaOf(single !== null, plan)}
        </button>
      </footer>
    </>
  );
}

/* ---- the rows ----------------------------------------------------------- */

function Row({ row }: { row: RenameMapping }) {
  const before = row.match ? row.name.slice(0, row.match.index) : row.name;
  const hit = row.match ? row.name.slice(row.match.index, row.match.index + row.match.length) : "";
  const after = row.match ? row.name.slice(row.match.index + row.match.length) : "";

  return (
    <div className="border-raised grid grid-cols-[1fr_1rem_1fr] items-center gap-2.5 border-t px-3.5 py-1.5">
      <span className="text-ink-muted truncate font-mono text-xs/[1.3]">
        {before}
        {hit && <span className="bg-line-strong text-ink">{hit}</span>}
        {after}
      </span>
      <span
        aria-hidden
        className={`text-center font-mono text-2xs/none ${row.changed ? "text-ink-dim" : "text-ink-ghost"}`}
      >
        {row.changed ? "→" : "·"}
      </span>
      {row.problem ? (
        // Red, and saying what it collides with rather than only that it does:
        // "duplicate" on its own leaves the reader to find the other row by eye.
        // The row truncates, so the whole sentence is on the tooltip — the part
        // that gets cut is the end, which is where the other name is.
        <Tooltip content={`${row.next} — ${row.problem.message}`}>
          <span className="text-danger-soft truncate font-mono text-xs/[1.3]">
            {row.next} <span className="text-danger-mid">— {row.problem.message}</span>
          </span>
        </Tooltip>
      ) : (
        <Tooltip content={row.changed ? row.next : undefined}>
          <span className={`truncate font-mono text-xs/[1.3] ${row.changed ? "text-ink" : "text-ink-faint"}`}>
            {row.changed ? row.next : "unchanged"}
          </span>
        </Tooltip>
      )}
    </div>
  );
}

function Label({ children }: { children: string }) {
  return (
    <div className="text-ink-faint mb-1.25 font-sans text-3xs/none font-medium tracking-[0.12em] uppercase">
      {children}
    </div>
  );
}

function Flag({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label === "g" ? "Replace every occurrence" : "Ignore case"}
      onClick={onToggle}
      className={`flex-1 border py-1.75 text-center font-mono text-xs/none ${
        on ? `${ON_FILL} border-accent-fill` : "bg-chrome text-ink-muted border-line-strong"
      }`}
    >
      {label}
    </button>
  );
}

/* ---- the words ---------------------------------------------------------- */

/** The mockup's "n of m names change", and what to say before there is an n. */
function summaryOf({
  single,
  plan,
  stale,
  rows,
  pattern,
}: {
  single: boolean;
  plan: RenamePlan | null;
  stale: boolean;
  rows: readonly RenameMapping[];
  pattern: string;
}): string {
  if (single) return rows[0]?.changed ? "1 name changes" : "unchanged";
  if (pattern === "") return "type a pattern to preview";
  if (plan?.error) return "fix the pattern to preview";
  if (plan === null || stale) return "previewing…";

  const colliding = plan.mappings.filter((row) => row.problem !== null).length;
  const counted = `${plan.changed} of ${plan.mappings.length} names change`;
  return colliding === 0 ? counted : `${counted} · ${colliding} collide, nothing will be renamed`;
}

function ctaOf(single: boolean, plan: RenamePlan | null): string {
  if (single) return "rename";
  const count = plan?.changed ?? 0;
  return `rename ${count} ${count === 1 ? "file" : "files"}`;
}

/** A row for the single-entry case, shaped like the ones the server returns. */
function singleMapping(name: string, next: string): RenameMapping {
  return { name, next, changed: next !== name && next !== "", match: null, problem: null };
}

/** Where the extension starts, so the field opens with only the stem selected. */
function stemLength(name: string): number {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/**
 * The pattern, a beat after it stopped changing.
 *
 * Each preview compiles a regex in a thread on the API, so one per keystroke is
 * a thread per keystroke. React Query caches by the debounced value, which is
 * what makes backspacing through a pattern you already typed free.
 */
function useDebounced(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
