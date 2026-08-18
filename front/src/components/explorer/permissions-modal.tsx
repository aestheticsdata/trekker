"use client";

import { useAuth } from "@auth/context/AuthContext";
import { CommandLine } from "@components/ui/command-line";
import { Overlay } from "@components/ui/overlay";
import { useToast } from "@components/ui/toast";
import { Tooltip } from "@components/ui/tooltip";
import { joinPath } from "@helpers/listing";
import { parseMode } from "@helpers/permissions";
import { ApiError } from "@lib/api/client";
import { changeMode, changeOwner, fetchEntryCount } from "@lib/api/permissions";
import { QUERY_KEYS } from "@lib/query/keys";
import { useMutation, useQueries } from "@tanstack/react-query";
import { Fragment, useState } from "react";

import type { FileRow } from "@lib/api/fs";
import type { ChangeResult } from "@lib/api/permissions";
import type { ReactNode } from "react";

/**
 * The permissions modal (TRE-21 §2), built from mockup 2a's markup.
 *
 * The mockup's own idea, and the reason it is worth building as drawn: the
 * grid, the octal, the symbolic string and the command line at the bottom are
 * four renderings of one number, all live. Whichever one you already think in,
 * you can watch the other three follow — which is what makes a mode something
 * you can check before applying rather than after.
 *
 * Two things are here that 2a does not draw. The special bits get a row of
 * their own, because the ticket requires them to be settable and flagged and
 * the mockup's nine cells cannot express them. And a mixed selection says so:
 * applying one mode to entries that differ is a flattening, and the moment to
 * learn that is before the click, not from the listing afterwards.
 */

const CLASSES = ["user", "group", "other"] as const;
const COLUMNS = ["read", "write", "exec"] as const;
const PRESETS = ["0644", "0640", "0755", "0600"] as const;

/** The fourth octal digit, which the nine-cell grid has no room for. */
const SPECIAL = [
  { bit: 0o4000, label: "setuid", warn: true },
  { bit: 0o2000, label: "setgid", warn: true },
  { bit: 0o1000, label: "sticky", warn: false },
] as const;

export interface PermissionsTarget {
  hostId: string;
  /** The directory the entries live in. */
  directory: string;
  /** What is selected, in listing order. Never empty. */
  entries: readonly FileRow[];
}

export function PermissionsModal({
  target,
  onClose,
  onApplied,
}: {
  target: PermissionsTarget;
  onClose: () => void;
  onApplied: () => void;
}) {
  const subject = subjectOf(target);

  return (
    <Overlay
      label={`Permissions for ${subject}`}
      onClosed={onClose}
      panelClassName="bg-app border-line-strong w-full max-w-[30rem] overflow-hidden rounded-sm border shadow-2xl"
    >
      {(close) => (
        <PermissionsPanel
          target={target}
          subject={subject}
          close={close}
          onApplied={onApplied}
        />
      )}
    </Overlay>
  );
}

/**
 * Everything inside the panel. Split from the shell above so that `close` — the
 * animated one, which lets the exit play before React takes the tree down — can
 * reach the cancel button and the successful save alike.
 */
function PermissionsPanel({
  target,
  subject,
  close,
  onApplied,
}: {
  target: PermissionsTarget;
  subject: string;
  close: () => void;
  onApplied: () => void;
}) {
  const { csrfToken } = useAuth();
  const { push } = useToast();
  const { hostId, directory, entries } = target;

  const first = entries[0];
  const paths = entries.map((entry) => joinPath(directory, entry.name));
  const distinctModes = new Set(entries.map((entry) => entry.mode)).size;
  const startingOwner = `${first.owner}:${first.group}`;
  const mixedOwners = entries.some((entry) => `${entry.owner}:${entry.group}` !== startingOwner);

  // The mode the panel opens on is the first entry's, as the ticket asks. When
  // they differ that is a starting point rather than a description, which is
  // what the notice below the grid is for.
  const [bits, setBits] = useState(() => parseMode(first.mode) ?? 0o644);
  const [owner, setOwner] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [outcome, setOutcome] = useState<ChangeResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const octal = octalOf(bits);
  const directories = entries.filter((entry) => entry.type === "dir");

  // Asked for only once the box is ticked: walking a tree to answer a question
  // nobody asked is work on someone else's machine.
  const counts = useQueries({
    queries: directories.map((entry) => {
      const path = joinPath(directory, entry.name);
      return {
        queryKey: [QUERY_KEYS.ENTRY_COUNT, hostId, path],
        queryFn: () => fetchEntryCount(hostId, path),
        enabled: recursive,
        retry: false,
        throwOnError: false,
        staleTime: 5_000,
      };
    }),
  });

  const apply = useMutation({
    mutationFn: async () => {
      setFailure(null);
      setOutcome(null);

      const mode = await changeMode({ hostId, paths, mode: octal, recursive }, csrfToken);

      // Ownership is a separate call and a separate privilege, so it only runs
      // when the field was actually typed in. Sending the unchanged owner back
      // would turn every chmod into a chown that fails with EPERM for anyone
      // who is not root — a refusal for something nobody asked for.
      const wanted = owner.trim();
      if (wanted === "" || wanted === startingOwner) return mode;

      const [nextOwner, nextGroup] = wanted.split(":");
      const ownership = await changeOwner(
        {
          hostId,
          paths,
          owner: nextOwner || undefined,
          group: nextGroup || undefined,
          recursive,
        },
        csrfToken,
      );
      return merge(mode, ownership);
    },
    onSuccess: (result) => {
      setOutcome(result);
      onApplied();
      // A clean run has nothing left to say, and leaving the panel open over
      // the listing it just changed hides the evidence. A run with refusals in
      // it stays open — the list of what would not change is the whole answer.
      if (result.failed > 0) return;

      const changedOwner = owner.trim();
      push({
        tone: "success",
        message: `${octal} · ${result.changed} ${result.changed === 1 ? "entry" : "entries"}`,
        detail: changedOwner && changedOwner !== startingOwner ? `owner ${changedOwner}` : undefined,
      });
      close();
    },
    onError: (error: unknown) => {
      setFailure(error instanceof ApiError ? error.message : "The change could not be applied.");
    },
  });

  const command = `chmod ${recursive ? "-R " : ""}${octal} ${entries.length > 2 ? `${entries.length} paths` : paths.join(" ")}`;
  const marked = SPECIAL.filter((special) => (bits & special.bit) !== 0);

  return (
    <>
      <header className="bg-line border-line-strong flex h-topbar flex-none items-center gap-2.25 border-b px-3">
        <span className="text-ink font-mono text-xs font-semibold tracking-label">chmod</span>
        <span className="text-ink-muted min-w-0 truncate font-mono text-cmd">{subject}</span>
        <div className="flex-1" />
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

      <div className="flex gap-4.5 px-3.5 pt-3.5 pb-2.5">
        <div className="w-37.5 flex-none">
          <div className="text-ink font-mono text-[2.125rem]/none font-bold tracking-[0.06em]">{octal}</div>
          <div className="text-ink-dim font-mono text-sm/[1.6]">{symbolicOf(bits, first.type === "dir")}</div>

          <div className="mt-2.75 flex flex-wrap gap-1">
            {PRESETS.map((preset) => {
              const active = octal === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  // The preset replaces the nine cells and leaves the fourth
                  // digit alone: a preset is a permission set, and silently
                  // clearing a setuid bit would be a security change nobody
                  // asked this button for.
                  onClick={() => setBits((current) => (current & 0o7000) | (Number.parseInt(preset, 8) & 0o777))}
                  className={`border px-1.75 py-1 font-mono text-2xs/none ${
                    active ? "bg-accent text-on-accent border-accent" : "text-ink-muted border-line-strong"
                  }`}
                >
                  {preset}
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-ink-muted grid grid-cols-[3.375rem_1fr_1fr_1fr] items-center gap-1 font-mono text-cmd">
            <span />
            {COLUMNS.map((column) => (
              <span
                key={column}
                className="text-ink-faint text-center"
              >
                {column}
              </span>
            ))}

            {CLASSES.map((who, group) => (
              <Fragment key={who}>
                <span>{who}</span>
                {[0, 1, 2].map((column) => {
                  const bit = 1 << (8 - (group * 3 + column));
                  const on = (bits & bit) !== 0;
                  return (
                    <button
                      key={column}
                      type="button"
                      aria-pressed={on}
                      aria-label={`${COLUMNS[column]} for ${who}`}
                      onClick={() => setBits((current) => current ^ bit)}
                      className={`border py-1.75 text-center font-medium ${
                        on ? "bg-accent text-on-accent border-accent" : "bg-chrome text-ink-faint border-line-strong"
                      }`}
                    >
                      {on ? "rwx"[column] : "·"}
                    </button>
                  );
                })}
              </Fragment>
            ))}
          </div>

          {/* Not in 2a: the fourth digit, which the nine cells above cannot
                say anything about. Kept visually quieter than the grid — these
                are rarely what someone came here to change, and loudly the
                ones they must be able to see when they are set. */}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {SPECIAL.map((special) => {
              const on = (bits & special.bit) !== 0;
              return (
                <button
                  key={special.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setBits((current) => current ^ special.bit)}
                  className={`border px-1.75 py-1 font-mono text-2xs/none ${
                    on
                      ? special.warn
                        ? "bg-warning text-on-accent border-warning"
                        : "bg-accent text-on-accent border-accent"
                      : "text-ink-faint border-line-strong"
                  }`}
                >
                  {special.label}
                </button>
              );
            })}
          </div>

          <div className="text-ink-muted mt-2.5 grid grid-cols-[3.375rem_1fr] items-center gap-1 font-mono text-cmd">
            <span>owner</span>
            <input
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              placeholder={mixedOwners ? "mixed — user:group" : startingOwner}
              aria-label="Owner and group"
              className="bg-chrome border-line-strong text-ink w-full border px-2 py-1.5 font-mono text-cmd"
            />
          </div>
        </div>
      </div>

      <div className="px-3.5 pb-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={recursive}
            onChange={(event) => setRecursive(event.target.checked)}
            className="sr-only"
          />
          <span
            aria-hidden
            className={`flex size-3.25 items-center justify-center border font-mono text-caps/none ${
              recursive ? "bg-accent border-accent text-on-accent" : "bg-chrome border-line-strong"
            }`}
          >
            {recursive ? "✓" : ""}
          </span>
          <span className="text-ink-soft font-mono text-cmd">recursive</span>
          <span className="text-ink-faint font-mono text-2xs/none">{recursiveNote(recursive, counts)}</span>
        </label>

        {distinctModes > 1 && (
          <Notice tone="warn">
            {distinctModes} different modes are selected — applying {octal} unifies them.
          </Notice>
        )}

        {marked.length > 0 && (
          <Notice tone="warn">
            {marked.map((special) => special.label).join(" and ")} will be set. This is how privilege is left behind on
            a filesystem.
          </Notice>
        )}

        <div className="mt-2.5">
          <CommandLine
            hostId={hostId}
            command={command}
            className="truncate"
          />
        </div>

        {failure && <Notice tone="bad">{failure}</Notice>}

        {/*
          Shown on a successful run too, unlike the failure panel below (TRE-52).
          A recursive change that reports a clean sweep while quietly stepping
          over the directories holding this server's keys is a worse answer than
          one that says which entries it left alone.
        */}
        {outcome && outcome.refused.length > 0 && (
          <div className="mt-2.5">
            <Notice tone="warn">
              {outcome.refused.length} {outcome.refused.length === 1 ? "entry holds" : "entries hold"} Trekker's own key
              material and {outcome.refused.length === 1 ? "was" : "were"} left untouched:
            </Notice>
            {outcome.refused.map((path) => (
              <p
                key={path}
                className="text-ink-faint mt-1 font-mono text-2xs"
              >
                {path}
              </p>
            ))}
          </div>
        )}

        {outcome && outcome.failed > 0 && (
          <div className="mt-2.5">
            <Notice tone="bad">
              {outcome.changed} changed, {outcome.failed} refused:
            </Notice>
            {outcome.results
              .filter((row) => !row.ok)
              .map((row) => (
                <p
                  key={row.path}
                  className="text-ink-muted mt-1 font-mono text-2xs"
                >
                  <span className="text-ink-faint">{row.path}</span> — {row.message ?? row.code}
                </p>
              ))}
          </div>
        )}
      </div>

      <footer className="bg-chrome border-line flex h-11 flex-none items-center gap-2 border-t px-3.5">
        <span className="text-ink-faint font-mono text-2xs/none">
          {entries.length} {entries.length === 1 ? "path" : "paths"} in {directory}
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
          disabled={apply.isPending}
          className="bg-accent text-on-accent px-3.5 py-1.75 font-mono text-xs/none font-medium disabled:opacity-60"
        >
          {apply.isPending ? "applying…" : `apply ${octal}`}
        </button>
      </footer>
    </>
  );
}

/**
 * `/` stats with an empty name — it is the one path that is all separator — so
 * the header falls back to the path rather than rendering a blank.
 */
function subjectOf({ entries, directory }: PermissionsTarget): string {
  if (entries.length !== 1) return `${entries.length} entries`;
  return entries[0].name || joinPath(directory, "");
}

function Notice({ tone, children }: { tone: "warn" | "bad"; children: ReactNode }) {
  return (
    <p className={`mt-2.5 font-mono text-2xs ${tone === "bad" ? "text-danger-soft" : "text-warning"}`}>{children}</p>
  );
}

/** Four digits always, so a setuid bit is visible rather than implied. */
function octalOf(bits: number): string {
  return (bits & 0o7777).toString(8).padStart(4, "0");
}

/** The `ls` string, including what the fourth digit does to the exec columns. */
function symbolicOf(bits: number, isDirectory: boolean): string {
  const triples = [0, 1, 2].map((group) => {
    const shift = 6 - group * 3;
    const read = (bits >> (shift + 2)) & 1;
    const write = (bits >> (shift + 1)) & 1;
    const exec = (bits >> shift) & 1;
    const special = (bits & SPECIAL[group].bit) !== 0;
    const mark = group === 2 ? "t" : "s";
    return `${read ? "r" : "-"}${write ? "w" : "-"}${special ? (exec ? mark : mark.toUpperCase()) : exec ? "x" : "-"}`;
  });
  return `${isDirectory ? "d" : "-"}${triples.join("")}`;
}

/**
 * What "recursive" is about to mean, in entries.
 *
 * A checkbox that says only "recursive" asks someone to agree to a number they
 * have not been shown. While the walk is still running it says so rather than
 * showing a zero that is about to change.
 */
function recursiveNote(
  recursive: boolean,
  counts: readonly { data?: { entries: number; exceeded: boolean }; isPending: boolean }[],
): string {
  if (!recursive) return "· selection only";
  if (counts.length === 0) return "· nothing selected is a directory";
  if (counts.some((count) => count.isPending)) return "· counting…";

  const known = counts.filter((count) => count.data);
  if (known.length === 0) return "· the count could not be read";

  const total = known.reduce((sum, count) => sum + (count.data?.entries ?? 0), 0);
  const capped = known.some((count) => count.data?.exceeded);
  return `· applies to ${capped ? "more than " : ""}${total.toLocaleString("en-GB")} nested entries`;
}

/** chmod and chown answered separately; the panel reports them as one run. */
function merge(mode: ChangeResult, ownership: ChangeResult): ChangeResult {
  return {
    results: [...mode.results, ...ownership.results],
    changed: mode.changed + ownership.changed,
    failed: mode.failed + ownership.failed,
    skippedLinks: mode.skippedLinks + ownership.skippedLinks,
    unreadable: [...mode.unreadable, ...ownership.unreadable],
    // Deduplicated, unlike the two lists above: chmod and chown walk the same
    // tree and step over the same entries, so concatenating would report every
    // protected path twice for a run that changed both mode and owner.
    refused: [...new Set([...mode.refused, ...ownership.refused])],
  };
}
