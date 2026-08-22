"use client";

import { useAuth } from "@auth/context/AuthContext";
import { Overlay } from "@components/ui/overlay";
import { Tooltip } from "@components/ui/tooltip";
import { formatTotal } from "@helpers/listing";
import { PRESS, SELECTED } from "@helpers/press";
import { ApiError } from "@lib/api/client";
import { explain, runCompare } from "@lib/api/compare";
import { QUERY_KEYS } from "@lib/query/keys";
import { useHashJob } from "@lib/query/use-hash-job";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { CompareEntry, CompareResult, Verdict } from "@lib/api/compare";

/**
 * What differs between the two panes (TRE-28 §3).
 *
 * The dual-pane layout exists so the two sides can be compared, and this is the
 * screen that finally asks the question: did the deploy land, what drifted
 * between staging and prod, is the backup complete.
 *
 * **Its hardest job is not showing differences. It is being honest about what
 * it did not check.** A comparison that stopped at a depth limit, gave up at a
 * row ceiling, or found a directory it could not open still produces a tidy
 * list of rows — and a reader who takes that list as the whole truth deletes
 * the wrong copy. So the bounds are drawn above the list rather than in a
 * tooltip, and rows nothing settled say so in their own colour rather than
 * being rounded down to "no difference found".
 *
 * Nothing here decides a verdict. The server walked both trees, applied the
 * levels and counted; this file draws that, filters it, and turns a row into
 * either a selection in both panes or a transfer.
 */

/** Beyond this the list stops rendering rows and says how many it left out. */
const RENDER_LIMIT = 300;

/**
 * How long the modal will keep re-walking while it waits for checksums.
 *
 * Five minutes, which is a stop rather than an estimate: a hash pass big enough
 * to outlast it is one somebody should watch in the inspector, and a row whose
 * file cannot be read would otherwise keep this polling for as long as the
 * modal stayed open. Pressing the button again picks up where it left off,
 * because every digest that did land is cached.
 */
const RESOLVE_WINDOW_MS = 5 * 60_000;

export interface CompareTarget {
  a: { hostId: string; path: string; label: string };
  b: { hostId: string; path: string; label: string };
}

/** Where a row's `→` or `←` sends it. Absolute paths, resolved server-side. */
export interface CompareCopy {
  srcHostId: string;
  srcPath: string;
  dstHostId: string;
  /** The directory it lands in, which is the row's parent on the other side. */
  dstPath: string;
}

const VERDICT_INK: Record<Verdict, string> = {
  differs: "text-danger-soft",
  onlyA: "text-warning",
  onlyB: "text-warning",
  identical: "text-success",
  inconclusive: "text-ink-faint",
};

const VERDICT_LABEL: Record<Verdict, string> = {
  differs: "differs",
  onlyA: "only left",
  onlyB: "only right",
  identical: "identical",
  inconclusive: "unchecked",
};

type Filter = "all" | Verdict;

export function CompareModal({
  target,
  onClose,
  onReveal,
  onCopy,
}: {
  target: CompareTarget;
  onClose: () => void;
  /** Put the cursor on this entry in both panes. */
  onReveal: (entry: CompareEntry, result: CompareResult) => void;
  /** Hand a row to the transfer modal, preloaded. */
  onCopy: (copy: CompareCopy) => void;
}) {
  return (
    <Overlay
      label={`Compare ${target.a.path} with ${target.b.path}`}
      onClosed={onClose}
      panelClassName="bg-app border-line-strong flex w-full max-w-[62rem] flex-col overflow-hidden rounded-sm border shadow-2xl"
    >
      {(close) => (
        <ComparePanel
          target={target}
          close={close}
          onReveal={onReveal}
          onCopy={onCopy}
        />
      )}
    </Overlay>
  );
}

function ComparePanel({
  target,
  close,
  onReveal,
  onCopy,
}: {
  target: CompareTarget;
  close: () => void;
  onReveal: (entry: CompareEntry, result: CompareResult) => void;
  onCopy: (copy: CompareCopy) => void;
}) {
  const { csrfToken } = useAuth();
  const hashJob = useHashJob();
  const [filter, setFilter] = useState<Filter>("all");
  const [needle, setNeedle] = useState("");
  /**
   * When to stop waiting for a checksum pass this modal started, or null when
   * none is running. A deadline rather than a set of job ids — see below.
   */
  const [resolveUntil, setResolveUntil] = useState<number | null>(null);

  /**
   * Walked when the modal opens, and then held still.
   *
   * Two different rules, and both are needed. **Held still while it is open**
   * for the reason the transfer plan and the delete plan are: this is a list
   * somebody reads and then acts on row by row, and one that reshuffled under
   * the cursor would scatter those actions across a different list.
   *
   * **Walked again on every open**, because the answer is about two
   * filesystems and they move. `staleTime: Infinity` on its own would serve the
   * first comparison of a pair forever — including straight after a copy made
   * from this very modal, which is precisely when the old answer is wrong.
   * Observed, not theorised: without `refetchOnMount` the rows a checksum had
   * just settled still read "unchecked" on the next open.
   */
  const compare = useQuery({
    queryKey: [QUERY_KEYS.COMPARE, target.a.hostId, target.a.path, target.b.hostId, target.b.path],
    queryFn: () =>
      runCompare(
        { hostId: target.a.hostId, path: target.a.path },
        { hostId: target.b.hostId, path: target.b.path },
        csrfToken,
      ),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    /**
     * While a checksum pass this modal started is still running, and only
     * then. The digests land in the cache one file at a time, so each re-walk
     * picks up whatever has arrived and the rows resolve in front of the
     * reader; the effect below stops it the moment both jobs have ended.
     *
     * A poll rather than the hash feed, deliberately. The feed would tell us
     * the moment a job finished, which is one refetch instead of several — but
     * it also has to handle a job that ends before the stream connects (TRE-27
     * shipped that bug), and this modal is open for seconds. A 1.5-second
     * re-walk of an already-bounded comparison is cheaper than the machinery to
     * avoid it.
     */
    refetchInterval: () => (resolveUntil === null ? false : 1_500),
    retry: false,
    throwOnError: false,
  });

  const result = compare.data ?? null;
  const refusal = compare.error instanceof ApiError ? compare.error.message : null;
  const resolving = resolveUntil !== null;

  /**
   * Stop waiting when there is nothing left to settle, or when the window runs
   * out.
   *
   * Keyed on the *answer* rather than on the two jobs, and the deadline is why.
   * "Both jobs have finished" is the signal that looks right and is not
   * available cheaply — and worse, it is not sufficient: a file the host could
   * not read gets no digest, so its row is never going to resolve and a wait
   * keyed on it would spin for as long as the modal stayed open. Whereas
   * `hashable === 0` covers every case that does resolve, and the window covers
   * every case that does not. Pressing the button again is how somebody retries.
   */
  useEffect(() => {
    if (resolveUntil === null) return;
    if (result !== null && result.summary.hashable === 0) setResolveUntil(null);
    else if (Date.now() > resolveUntil) setResolveUntil(null);
  }, [resolveUntil, result]);

  /**
   * Queue the checksums that would settle the unchecked rows.
   *
   * Two jobs, one per side, through TRE-27's own route — so they are rate
   * limited, audited and cancellable exactly like a checksum asked for from the
   * inspector. There is no second code path for "compare, but with hashing":
   * the digests land in `FileHashes` and the next walk reads them.
   */
  const shown = (result?.entries ?? []).filter((entry) => {
    if (filter !== "all" && entry.verdict !== filter) return false;
    if (needle === "") return true;
    return entry.path.toLowerCase().includes(needle.toLowerCase());
  });

  const resolveByHash = () => {
    if (!result || result.hashable.a.length === 0) return;

    for (const side of [
      { hostId: result.a.hostId, paths: result.hashable.a },
      { hostId: result.b.hostId, paths: result.hashable.b },
    ]) {
      // A refusal — the rate limit, a path that has since gone — stops the
      // wait rather than leaving the button saying "resolving…" over nothing.
      // The shared hook has already raised the toast that says why.
      hashJob.mutate(side, { onError: () => setResolveUntil(null) });
    }
    setResolveUntil(Date.now() + RESOLVE_WINDOW_MS);
  };

  return (
    <>
      <header className="bg-strip border-line flex h-topbar flex-none items-center gap-2 border-b px-3">
        <span className="text-brand font-mono text-xs font-semibold tracking-label">compare</span>
        <span className="text-ink-muted min-w-0 flex-1 truncate font-mono text-cmd">
          {target.a.label}:{target.a.path} <span className="text-ink-faint">⇄</span> {target.b.label}:{target.b.path}
        </span>
      </header>

      {refusal !== null && (
        <div className="bg-danger-wash border-danger text-danger-soft mx-3.5 mt-2.5 border px-2.5 py-1.75 font-mono text-cmd/[1.5]">
          {refusal}
        </div>
      )}

      {result && (
        <>
          <Summary result={result} />
          <Bounds result={result} />
          <Filters
            result={result}
            filter={filter}
            onFilter={setFilter}
            needle={needle}
            onNeedle={setNeedle}
          />
        </>
      )}

      <div className="border-line max-h-96 min-h-24 flex-1 overflow-y-auto border-t border-b">
        {compare.isPending && <div className="text-ink-faint px-3.5 py-3 font-mono text-xs">walking both trees…</div>}

        {result && shown.length === 0 && (
          <div className="text-ink-faint px-3.5 py-3 font-mono text-xs">
            {result.entries.length === 0 ? "the two directories hold the same names" : "no rows match this filter"}
          </div>
        )}

        {shown.slice(0, RENDER_LIMIT).map((entry) => (
          <Row
            key={entry.path}
            entry={entry}
            result={result as CompareResult}
            onReveal={onReveal}
            onCopy={onCopy}
          />
        ))}

        {shown.length > RENDER_LIMIT && (
          <p className="text-ink-faint px-3.5 py-2 font-mono text-2xs">
            +{shown.length - RENDER_LIMIT} more rows, not drawn. Narrow the filter to see them.
          </p>
        )}
      </div>

      <div className="flex flex-none items-center justify-between gap-2 px-3.5 py-2.5">
        <div className="text-ink-faint min-w-0 font-mono text-2xs/[1.5]">
          {result && result.summary.hashable > 0 ? (
            <>
              {result.summary.hashable} row(s) agree about size and time. Only a checksum can say whether the bytes
              match.
            </>
          ) : (
            <>Clicking a row puts the cursor on it in both panes.</>
          )}
        </div>

        <div className="flex flex-none gap-1.5">
          {result && result.summary.hashable > 0 && (
            <button
              type="button"
              onClick={resolveByHash}
              disabled={resolving}
              className={`${PRESS} border-accent-fill border px-3 py-1.5 font-mono text-cmd font-medium`}
            >
              {/* The wait, not the request. The two POSTs are answered in
                  milliseconds and the reading takes as long as it takes, so a
                  label tied to `isPending` would flicker and then lie. */}
              {resolving ? "resolving…" : "resolve by hash"}
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="border-line-strong text-ink-muted hover:text-ink border px-3 py-1.5 font-mono text-cmd"
          >
            close
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The summary line the ticket asks for, in the order somebody reads it:
 * how much was looked at, then what is wrong with it.
 */
function Summary({ result }: { result: CompareResult }) {
  const { summary } = result;
  const parts: string[] = [`${summary.total} entr${summary.total === 1 ? "y" : "ies"}`];
  if (summary.differs > 0) parts.push(`${summary.differs} differ`);
  if (summary.onlyA > 0) parts.push(`${summary.onlyA} only left`);
  if (summary.onlyB > 0) parts.push(`${summary.onlyB} only right`);
  if (summary.identical > 0) parts.push(`${summary.identical} identical`);
  if (summary.inconclusive > 0) parts.push(`${summary.inconclusive} unchecked`);

  return (
    <p className="text-ink-soft px-3.5 pt-2.5 font-mono text-xs">
      {parts.join(" · ")}
      <span className="text-ink-faint"> · {result.depth} levels deep</span>
    </p>
  );
}

/**
 * Everything the comparison could not see, drawn above the list.
 *
 * Not a tooltip and not a footnote. A list of rows reads as the whole truth,
 * and the one thing that makes it not the whole truth has to be in the way.
 */
function Bounds({ result }: { result: CompareResult }) {
  if (!result.truncated && result.unreadableCount === 0) return null;

  return (
    <div className="bg-warning-wash border-warning text-warning mx-3.5 mt-2 border px-2.5 py-1.75 font-mono text-2xs/[1.6]">
      {result.truncated && (
        <p>
          This comparison stopped early — at {result.maxEntries} rows, or at the {result.depth}-level depth limit. What
          is below that was not looked at.
        </p>
      )}
      {result.unreadableCount > 0 && (
        <p>
          {result.unreadableCount} director{result.unreadableCount === 1 ? "y" : "ies"} could not be listed on one side:{" "}
          {result.unreadable.join(", ")}
          {result.unreadableCount > result.unreadable.length ? ", …" : ""}
        </p>
      )}
    </div>
  );
}

function Filters({
  result,
  filter,
  onFilter,
  needle,
  onNeedle,
}: {
  result: CompareResult;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  needle: string;
  onNeedle: (needle: string) => void;
}) {
  // Only the verdicts this comparison actually produced. A filter for a bucket
  // that is empty is a control that can only ever empty the list.
  const available: Filter[] = ["all", "differs", "onlyA", "onlyB", "inconclusive", "identical"].filter(
    (value) => value === "all" || result.summary[value as Verdict] > 0,
  ) as Filter[];

  return (
    <div className="flex items-center gap-2 px-3.5 py-2">
      <div className="flex gap-1">
        {available.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onFilter(value)}
            className={`border px-1.75 py-0.75 font-mono text-2xs/none ${
              filter === value
                ? `${SELECTED} border-accent-soft`
                : "border-line-strong text-ink-dim hover:text-ink-soft"
            }`}
          >
            {value === "all" ? "all" : VERDICT_LABEL[value]}
          </button>
        ))}
      </div>

      <input
        value={needle}
        onChange={(event) => onNeedle(event.target.value)}
        placeholder="filter by name"
        aria-label="Filter the comparison by name"
        className="bg-chrome border-line text-ink-soft placeholder:text-ink-faint min-w-0 flex-1 border px-2 py-1 font-mono text-2xs"
      />
    </div>
  );
}

/**
 * One row: what it is, what each side has, and the two ways to make them agree.
 *
 * The arrows are the whole point of the screen being in a file manager rather
 * than in a report. `→` sends the left side's copy to where the right side's
 * would live; both open the transfer modal rather than moving anything, because
 * a copy that overwrites is a decision somebody makes with the conflict in
 * front of them (TRE-24).
 */
function Row({
  entry,
  result,
  onReveal,
  onCopy,
}: {
  entry: CompareEntry;
  result: CompareResult;
  onReveal: (entry: CompareEntry, result: CompareResult) => void;
  onCopy: (copy: CompareCopy) => void;
}) {
  const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
  const joined = (root: string) => (parent === "" ? root : `${root}/${parent}`);

  return (
    <div className="border-raised grid grid-cols-[1fr_7rem_6.5rem_7rem_auto] items-center gap-2 border-t px-3.5 py-1.5">
      {/* The path is the button: clicking a row is how it becomes a selection
          in both panes, and a row-wide click target beats a hit area the width
          of the text. */}
      <button
        type="button"
        onClick={() => onReveal(entry, result)}
        className="min-w-0 text-left"
      >
        <span className="text-ink-muted block truncate font-mono text-xs/[1.3]">{entry.path}</span>
        <span className="text-ink-faint block truncate font-mono text-2xs/none">{explain(entry)}</span>
      </button>

      <Side facts={entry.a} />

      <span className={`text-center font-mono text-2xs/none ${VERDICT_INK[entry.verdict]}`}>
        {VERDICT_LABEL[entry.verdict]}
      </span>

      <Side facts={entry.b} />

      <div className="flex gap-1">
        <Arrow
          label="→"
          hint={entry.a ? `Copy this to ${joined(result.b.path)}` : "Nothing on the left to copy"}
          disabled={entry.a === null}
          onClick={() =>
            onCopy({
              srcHostId: result.a.hostId,
              srcPath: `${result.a.path}/${entry.path}`,
              dstHostId: result.b.hostId,
              dstPath: joined(result.b.path),
            })
          }
        />
        <Arrow
          label="←"
          hint={entry.b ? `Copy this to ${joined(result.a.path)}` : "Nothing on the right to copy"}
          disabled={entry.b === null}
          onClick={() =>
            onCopy({
              srcHostId: result.b.hostId,
              srcPath: `${result.b.path}/${entry.path}`,
              dstHostId: result.a.hostId,
              dstPath: joined(result.a.path),
            })
          }
        />
      </div>
    </div>
  );
}

/** One side's facts, or a visible absence. */
function Side({ facts }: { facts: CompareEntry["a"] }) {
  if (facts === null) return <span className="text-ink-faint text-right font-mono text-2xs/none">—</span>;

  return (
    <span className="text-ink-dim text-right font-mono text-2xs/[1.4]">
      {facts.kind === "directory" ? "dir" : formatTotal(facts.size)}
      <span className="text-ink-faint block">
        {new Date(facts.mtimeMs).toISOString().slice(0, 16).replace("T", " ")}
      </span>
    </span>
  );
}

function Arrow({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={hint}>
      <button
        type="button"
        // `aria-disabled`, not `disabled` (TRE-76): the hint is the whole value
        // of an inert control, and a control disabled by the attribute fires no
        // mouse event and takes no focus, so the explanation reaches nobody.
        aria-disabled={disabled}
        onClick={disabled ? undefined : onClick}
        className={`border px-1.5 py-0.5 font-mono text-2xs/none ${
          disabled
            ? "border-line text-ink-ghost cursor-not-allowed"
            : "border-line-strong text-ink-dim hover:text-ink hover:border-accent-soft"
        }`}
      >
        {label}
      </button>
    </Tooltip>
  );
}
