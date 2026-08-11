"use client";

import { pathOf } from "@components/explorer/pane-state";
import { ageDays, ageIndex, breadcrumbs, formatAge, formatSize, formatTotal, typeTag } from "@helpers/listing";
import { ApiError } from "@lib/api/client";
import { useEffect, useRef } from "react";

import type { PaneState } from "@components/explorer/pane-state";
import type { Crumb, SortKey } from "@helpers/listing";
import type { FileRow, ListMeta } from "@lib/api/fs";
import type { HostView } from "@lib/api/hosts";

/**
 * One pane (TRE-16 §1): tabs, path row, sortable header, rows, footer.
 *
 * Presentational and controlled — every interaction is an action the explorer
 * dispatches, so the two panes share one reducer and the keyboard layer can
 * drive either of them without reaching inside.
 */

/**
 * The eight columns, shared by the header, the rows and the skeleton.
 *
 * In `rem` rather than the mockup's px so the whole listing follows
 * `--ui-base` (TRE-44); the px it was drawn at is in the comment. Tailwind's
 * numeric scale is 4px a unit, which is where `gap-1.25` (5px) comes from.
 */
const GRID =
  // 14  104   13  26  62  30  88  38
  "grid-cols-[0.875rem_minmax(6.5rem,1fr)_0.8125rem_1.625rem_3.875rem_1.875rem_5.5rem_2.375rem] gap-1.25 min-w-101 px-2.25";

/**
 * The age ramp as classes, one per bucket.
 *
 * Written out rather than composed as `bg-age-${bucket}`: Tailwind reads the
 * source for literal class names, and a token no utility mentions is pruned
 * from the stylesheet — a computed `var(--color-age-3)` then resolves to
 * nothing and the bar silently disappears.
 */
const HEAT_CLASS = ["bg-age-0", "bg-age-1", "bg-age-2", "bg-age-3", "bg-age-4", "bg-age-5", "bg-age-6"] as const;

export interface PaneCallbacks {
  onFocus: () => void;
  onCd: (path: string) => void;
  onUp: () => void;
  onBack: () => void;
  onForward: () => void;
  onOpen: (row: FileRow) => void;
  onNewTab: () => void;
  onSelectTab: (tab: number) => void;
  onSort: (key: SortKey) => void;
  onRowClick: (name: string, modifiers: { extend: boolean; toggle: boolean }) => void;
  onHostMenu: () => void;
  onClearGlob: () => void;
}

export function Pane({
  pane,
  active,
  host,
  rows,
  meta,
  loading,
  error,
  glob,
  hiddenByGlob,
  heat,
  now,
  callbacks,
}: {
  pane: PaneState;
  active: boolean;
  host: HostView | null;
  /** Already filtered and sorted by the explorer. */
  rows: readonly FileRow[];
  meta: ListMeta | null;
  loading: boolean;
  error: unknown;
  /** The active pane's glob, named by the empty state when it hides everything. */
  glob: string;
  /** How many rows the glob is hiding, so the empty state can say so. */
  hiddenByGlob: number;
  heat: boolean;
  /** Passed in so every row in a render ages against the same instant. */
  now: number;
  callbacks: PaneCallbacks;
}) {
  const path = pathOf(pane);
  const listRef = useRef<HTMLDivElement>(null);

  // The cursor must stay visible when the arrow keys push it past an edge.
  useEffect(() => {
    if (!pane.cur || !active) return;
    const row = listRef.current?.querySelector(`[data-row="${CSS.escape(pane.cur)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [pane.cur, active]);

  const selectedBytes = rows.filter((row) => pane.sel.includes(row.name)).reduce((sum, row) => sum + row.size, 0);
  const directories = rows.filter((row) => row.type === "dir").length;
  const largest = rows.reduce((max, row) => Math.max(max, row.size), 0);
  // Totalled over the rows on screen, not the whole directory: a count and a
  // size sitting on the same line must describe the same set of files.
  const shownBytes = rows.reduce((sum, row) => sum + row.size, 0);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: focusing a pane is a pointer affordance; ⇥ is the keyboard route and lives in the explorer
    <div
      onMouseDown={callbacks.onFocus}
      className={`border-line flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l-2 ${
        active ? "bg-pane-active" : "bg-pane"
      }`}
      // The active pane wears its host's colour. Without a host the class
      // above still supplies one, so the edge is never `currentColor`.
      style={active && host ? { borderLeftColor: host.colour } : undefined}
    >
      <TabStrip
        pane={pane}
        active={active}
        host={host}
        callbacks={callbacks}
      />

      <PathRow
        pane={pane}
        active={active}
        host={host}
        crumbs={breadcrumbs(path)}
        meta={meta}
        shownBytes={shownBytes}
        callbacks={callbacks}
      />

      <ColumnHeader
        sort={pane.sort}
        direction={pane.dir}
        onSort={callbacks.onSort}
      />

      <div
        ref={listRef}
        className="min-h-16.5 flex-auto overflow-x-hidden overflow-y-auto"
      >
        {loading ? (
          <Skeleton />
        ) : host === null ? (
          <Placeholder
            title="no host"
            detail="This pane has nothing to browse yet. Add the machine the API runs on, or an SSH host."
            action={{ label: "add a host", onSelect: callbacks.onHostMenu }}
            onUp={callbacks.onUp}
          />
        ) : error ? (
          <ErrorState
            error={error}
            onUp={callbacks.onUp}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            path={path}
            glob={glob}
            hiddenByGlob={hiddenByGlob}
            onClearGlob={callbacks.onClearGlob}
            onUp={callbacks.onUp}
          />
        ) : (
          <>
            {path !== "/" && (
              <button
                type="button"
                onClick={callbacks.onUp}
                className="text-on-pane-muted hover:bg-pane-hover grid h-row w-full grid-cols-[0.875rem_1fr] items-center gap-1.25 px-2.25 text-left font-mono text-xs"
              >
                <span className="text-center">↰</span>
                <span>..</span>
              </button>
            )}
            {rows.map((row) => (
              <Row
                key={row.name}
                row={row}
                selected={pane.sel.includes(row.name)}
                cursor={active && pane.cur === row.name}
                paneActive={active}
                largest={largest}
                heat={heat}
                now={now}
                onClick={callbacks.onRowClick}
                onOpen={callbacks.onOpen}
              />
            ))}
          </>
        )}
      </div>

      <footer className="bg-pane-bar border-pane-line text-on-pane-dim flex h-panefoot flex-none items-center gap-2.5 border-t px-2.25 font-mono text-2xs">
        {meta && !loading && !error && host && (
          <>
            <span className="whitespace-nowrap">
              {directories} folders · {rows.length - directories} files
            </span>
            <span className="whitespace-nowrap">{formatTotal(shownBytes)}</span>
          </>
        )}
        <div className="flex-1" />
        {/* The slot is never empty: with nothing selected it says how the
            listing is ordered, which is the other thing you ask of a pane. */}
        {pane.sel.length > 0 ? (
          <span className="text-on-pane truncate whitespace-nowrap">
            {pane.sel.length} selected · {formatTotal(selectedBytes)}
          </span>
        ) : (
          <span className="truncate whitespace-nowrap">
            sorted by {pane.sort} {pane.dir === 1 ? "▲" : "▼"}
          </span>
        )}
      </footer>
    </div>
  );
}

function TabStrip({
  pane,
  active,
  host,
  callbacks,
}: {
  pane: PaneState;
  active: boolean;
  host: HostView | null;
  callbacks: PaneCallbacks;
}) {
  return (
    <div className="bg-line flex h-tabstrip flex-none @container">
      {pane.tabs.map((tabPath, index) => {
        const current = index === pane.tab;
        const label = tabPath === "/" ? "/" : (tabPath.split("/").filter(Boolean).pop() ?? "/");
        return (
          <button
            // Tabs are positional and two may share a path, so the index is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: tab identity is its position
            key={index}
            type="button"
            onClick={() => callbacks.onSelectTab(index)}
            aria-current={current ? "page" : undefined}
            className={`flex flex-none items-center gap-1.5 px-2.5 font-mono text-2xs whitespace-nowrap ${
              current
                ? `${active ? "bg-pane-active" : "bg-pane"} text-on-pane font-medium`
                : "text-ink-muted hover:text-ink"
            }`}
          >
            <span
              aria-hidden
              className="size-1.25 rounded-full"
              style={{ backgroundColor: current && host ? host.colour : "var(--color-ink-faint)" }}
            />
            {label}
          </button>
        );
      })}

      <button
        type="button"
        onClick={callbacks.onNewTab}
        aria-label="New tab"
        className="text-ink-faint hover:text-ink-muted flex items-center px-2.25 font-mono text-sm"
      >
        +
      </button>

      <div className="flex-1" />

      {active && (
        <span className="text-brand hidden items-center px-2.5 font-mono text-2xs whitespace-nowrap @[32.5rem]:flex">
          ACTIVE PANE · ⇥ to switch
        </span>
      )}
    </div>
  );
}

function PathRow({
  pane,
  active,
  host,
  crumbs,
  meta,
  shownBytes,
  callbacks,
}: {
  pane: PaneState;
  active: boolean;
  host: HostView | null;
  crumbs: readonly Crumb[];
  meta: ListMeta | null;
  shownBytes: number;
  callbacks: PaneCallbacks;
}) {
  return (
    <div
      className={`border-pane-line text-on-pane-data flex h-pathrow flex-none items-center gap-1.5 overflow-hidden border-b px-1.75 font-mono text-xs @container ${
        active ? "bg-pane-bar-active" : "bg-pane-bar"
      }`}
    >
      <button
        type="button"
        onClick={callbacks.onHostMenu}
        className={`flex flex-none items-center gap-1.25 rounded-xs border px-1.5 py-0.5 font-mono text-2xs font-medium whitespace-nowrap ${
          active ? "bg-pane-chip text-on-pane" : "text-on-pane-muted border-pane-line"
        }`}
        style={active && host ? { borderColor: host.colour } : undefined}
      >
        <span
          aria-hidden
          className="size-1.25 rounded-full"
          style={{ backgroundColor: host?.colour ?? "var(--color-ink-faint)" }}
        />
        {host?.label ?? "no host"}
        <span className="text-on-pane-faint">▾</span>
      </button>

      <NavButton
        label="Back"
        glyph="←"
        enabled={pane.hist.length > 0}
        onClick={callbacks.onBack}
      />
      <NavButton
        label="Forward"
        glyph="→"
        enabled={pane.fwd.length > 0}
        onClick={callbacks.onForward}
      />
      <NavButton
        label="Up one level"
        glyph="↰"
        enabled
        onClick={callbacks.onUp}
      />

      <span
        aria-hidden
        className="bg-pane-line h-3 w-px flex-none"
      />

      {/* Right-aligned: when the path is too long it is the leading segments
          that should fall off the left, not the directory you are in. */}
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 flex-auto items-center justify-end overflow-hidden"
      >
        <span className="flex flex-none items-center">
          {crumbs.map((crumb) => (
            <button
              key={crumb.path}
              type="button"
              onClick={() => callbacks.onCd(crumb.path)}
              className={`flex-none whitespace-nowrap hover:underline ${
                crumb.last ? "text-on-pane font-semibold" : "text-on-pane-muted"
              }`}
            >
              {crumb.label}
            </button>
          ))}
        </span>
      </nav>

      {meta && (
        <span
          className={`hidden flex-none rounded-xs px-1.5 py-0.5 text-2xs whitespace-nowrap @[25rem]:inline ${
            meta.truncated ? "bg-on-pane-muted text-ink" : "bg-pane-chip text-on-pane"
          }`}
        >
          {meta.truncated ? `⚠ first ${meta.count} of ${meta.totalEntries}` : `${formatTotal(shownBytes)} total`}
        </span>
      )}
    </div>
  );
}

function NavButton({
  label,
  glyph,
  enabled,
  onClick,
}: {
  label: string;
  glyph: string;
  enabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      aria-label={label}
      title={label}
      className={`flex-none px-1 py-0.5 ${enabled ? "text-on-pane" : "text-pane-line cursor-not-allowed"}`}
    >
      {glyph}
    </button>
  );
}

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; align?: "right" }> = [
  { key: "size", label: "SIZE", align: "right" },
  { key: "mode", label: "MODE" },
  { key: "owner", label: "OWNER" },
  { key: "age", label: "AGE", align: "right" },
];

function ColumnHeader({
  sort,
  direction,
  onSort,
}: {
  sort: SortKey;
  direction: 1 | -1;
  onSort: (key: SortKey) => void;
}) {
  const arrow = (key: SortKey) => (sort === key ? (direction === 1 ? " ▲" : " ▼") : "");
  const tone = (key: SortKey) => (sort === key ? "text-on-pane" : "text-on-pane-label");

  return (
    <div
      className={`bg-pane-bar border-pane-line text-on-pane-label grid h-row-tight flex-none items-center border-b font-sans text-3xs font-medium tracking-[0.11em] ${GRID}`}
    >
      <span />
      <button
        type="button"
        onClick={() => onSort("name")}
        className={`text-left ${tone("name")}`}
      >
        NAME{arrow("name")}
      </button>
      <span />
      <span>SHARE</span>
      {COLUMNS.map((column) => (
        <button
          key={column.key}
          type="button"
          onClick={() => onSort(column.key)}
          className={`${column.align === "right" ? "text-right" : "text-left"} ${tone(column.key)}`}
        >
          {column.label}
          {arrow(column.key)}
        </button>
      ))}
    </div>
  );
}

function Row({
  row,
  selected,
  cursor,
  paneActive,
  largest,
  heat,
  now,
  onClick,
  onOpen,
}: {
  row: FileRow;
  selected: boolean;
  cursor: boolean;
  paneActive: boolean;
  largest: number;
  heat: boolean;
  now: number;
  onClick: PaneCallbacks["onRowClick"];
  onOpen: PaneCallbacks["onOpen"];
}) {
  const tag = typeTag(row);
  const days = ageDays(row.mtime, now);
  const bucket = ageIndex(days);
  const share = largest > 0 ? Math.max(2, Math.round((row.size / largest) * 100)) : 2;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: rows are driven by the pane's roving cursor and ⏎, not by per-row tab stops — a thousand-row listing must not add a thousand of them
    <div
      data-row={row.name}
      onMouseDown={(event) => {
        // preventDefault keeps a drag from selecting text — and, as a side
        // effect, keeps focus where it is. If that is the glob input, every
        // later keystroke is swallowed by it, so the focus move it suppressed
        // has to be done by hand.
        event.preventDefault();
        const focused = document.activeElement as HTMLElement | null;
        if (focused && focused !== document.body) focused.blur();
        onClick(row.name, { extend: event.shiftKey, toggle: event.metaKey || event.ctrlKey });
      }}
      onDoubleClick={() => onOpen(row)}
      className={`grid h-row cursor-pointer items-center font-mono text-xs ${GRID} -ml-0.5 border-l-2 ${
        selected
          ? `${paneActive ? "bg-pane-sel" : "bg-pane-sel-idle"} border-on-pane-strong`
          : "hover:bg-pane-hover border-transparent"
      } ${cursor ? "outline-on-pane-strong -outline-offset-1 outline-1 outline-dotted" : ""}`}
    >
      <span
        className={`text-on-pane-bright rounded-[1.5px] py-0.5 text-center font-mono text-tag font-bold tracking-normal ${tag.className}`}
      >
        {tag.label}
      </span>

      <span
        className={`truncate ${
          row.type === "dir" ? "text-on-pane-strong" : row.type === "link" ? "text-on-pane-muted" : "text-on-pane"
        }`}
      >
        {row.name}
        {row.linkTarget && (
          <span className={row.linkInsideRoot === false ? "text-danger" : "text-on-pane-faint"}>
            {" "}
            → {row.linkTarget}
          </span>
        )}
      </span>

      {/* Reserved for the git overlay (TRE-38); the column exists so the grid
          does not reflow when it arrives. */}
      <span />

      <span className="bg-pane-bar block h-1.5">
        <span
          className={`block h-1.5 ${heat ? HEAT_CLASS[bucket] : "bg-share-idle"}`}
          style={{ width: `${share}%` }}
        />
      </span>

      <span className="text-on-pane-data text-right">{formatSize(row.size, row.type)}</span>
      <span className="text-on-pane-dim">{row.mode}</span>
      <span className={`truncate ${row.ownerResolved ? "text-on-pane-dim" : "text-on-pane-faint"}`}>{row.owner}</span>

      {/* Only the fresh buckets get a filled chip: past a fortnight the exact
          age stops being the thing you are scanning for. */}
      <span
        className={`px-1 py-0.5 text-right text-2xs ${
          heat && bucket <= 3
            ? `${HEAT_CLASS[bucket]} ${bucket <= 2 ? "text-on-pane-bright" : "text-on-accent"}`
            : "text-on-pane-dim"
        }`}
        title={row.mtime}
      >
        {formatAge(days)}
      </span>
    </div>
  );
}

/** Eleven staggered rows, as the mockup does — a listing arriving, not a spinner. */
function Skeleton() {
  return (
    <div aria-busy="true">
      {Array.from({ length: 11 }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder, never reordered
          key={index}
          className={`grid h-row animate-shimmer items-center ${GRID}`}
          style={{ animationDelay: `${index * 70}ms` }}
        >
          <i className="bg-pane-bar-active block h-2" />
          <i
            className="bg-pane-bar-active block h-2"
            style={{ width: `${34 + ((index * 37) % 52)}%` }}
          />
          <i />
          <i className="bg-pane-bar-active block h-1.5" />
          <i className="bg-pane-bar-active block h-2" />
          <i className="bg-pane-bar-active block h-2" />
          <i className="bg-pane-bar-active block h-2" />
          <i className="bg-pane-bar-active block h-2" />
        </div>
      ))}
    </div>
  );
}

function Placeholder({
  title,
  detail,
  action,
  onUp,
}: {
  title: string;
  detail: string;
  action?: { label: string; onSelect: () => void };
  onUp: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.25 p-7">
      <div
        aria-hidden
        className="border-pane-dash relative h-10 w-13 border border-dashed"
      >
        <span className="border-pane-dash absolute -top-1.75 left-0 h-1.75 w-5 border border-b-0 border-dashed" />
      </div>
      <p className="text-on-pane-label font-mono text-sm font-medium">{title}</p>
      <p className="text-on-pane-faint max-w-70 text-center font-mono text-xs/relaxed">{detail}</p>
      <div className="mt-0.5 flex gap-1.5">
        {action && (
          <button
            type="button"
            onClick={action.onSelect}
            className="bg-accent text-on-accent px-2.5 py-1.25 font-mono text-xs font-medium"
          >
            {action.label}
          </button>
        )}
        <button
          type="button"
          onClick={onUp}
          className="border-pane-dash text-on-pane-label border px-2.5 py-1.25 font-mono text-xs"
        >
          go up ↰
        </button>
      </div>
    </div>
  );
}

/**
 * Empty is not one state (TRE-16 §7). A directory with nothing in it and a
 * glob that matched nothing are different facts, and saying "empty directory"
 * for the second one is a lie the user acts on.
 */
function EmptyState({
  path,
  glob,
  hiddenByGlob,
  onClearGlob,
  onUp,
}: {
  path: string;
  glob: string;
  hiddenByGlob: number;
  onClearGlob: () => void;
  onUp: () => void;
}) {
  if (hiddenByGlob > 0) {
    return (
      <Placeholder
        title={`no match for ${glob}`}
        detail={`${hiddenByGlob} ${hiddenByGlob === 1 ? "entry" : "entries"} hidden by the glob filter.`}
        action={{ label: "clear filter", onSelect: onClearGlob }}
        onUp={onUp}
      />
    );
  }

  return (
    <Placeholder
      title="empty directory"
      detail={`Nothing here. ${path} contains no files or folders.`}
      onUp={onUp}
    />
  );
}

/**
 * A refusal is never an empty directory. The API distinguishes "the host said
 * no" from "outside your roots" from "unreachable" (TRE-13 §5), and each one
 * needs a different next move from the person reading it.
 */
function ErrorState({ error, onUp }: { error: unknown; onUp: () => void }) {
  const status = error instanceof ApiError ? error.status : 0;
  const message = error instanceof Error ? error.message : "The listing could not be loaded.";

  const title =
    status === 403
      ? "permission denied"
      : status === 404
        ? "no such directory"
        : status === 502
          ? "host unreachable"
          : "listing failed";

  return (
    <Placeholder
      title={title}
      detail={message}
      onUp={onUp}
    />
  );
}
