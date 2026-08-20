"use client";

import { useAuth } from "@auth/context/AuthContext";
import { useToast } from "@components/ui/toast";
import { Tooltip } from "@components/ui/tooltip";
import {
  ageDays,
  formatAge,
  formatExactBytes,
  formatInstant,
  formatSize,
  formatTotal,
  joinPath,
  onDiskBytes,
  typeTag,
} from "@helpers/listing";
import { describeMode, permissionRows } from "@helpers/permissions";
import { startDownload } from "@lib/api/download";
import { fetchListing, fetchStat } from "@lib/api/fs";
import { cancelHash, fetchHashState, hashStreamUrl, shortDigest } from "@lib/api/hashes";
import { QUERY_KEYS } from "@lib/query/keys";
import { useHashJob } from "@lib/query/use-hash-job";
import { useSignedLink } from "@lib/query/use-signed-link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";

import type { SortDirection, SortKey } from "@helpers/listing";
import type { FileRow, FileRowDetail, RowType } from "@lib/api/fs";
import type { HashProgress } from "@lib/api/hashes";
import type { HostView } from "@lib/api/hosts";
import type { ReactNode } from "react";

/**
 * The 218px right sidebar (TRE-17), built from mockup 2a's markup.
 *
 * Three panels, chosen by how much is selected: nothing, one entry, several.
 * 2a draws only the middle one — a selected gzip archive — so the geometry,
 * the type scale and the two grids are ported from it exactly and the other
 * two panels are assembled from the same parts rather than invented alongside
 * them. That is why every panel keeps the same rhythm: title, preview, name,
 * four stats, rows, permissions. Only the contents change.
 *
 * It follows the *active* pane, which is the whole reason it lives here rather
 * than in the shell: the selection, the rows and the sort it describes are all
 * the explorer's, and lifting them into the page to hand back down would be
 * three more props that can disagree with what the pane is drawing.
 *
 * What is deliberately not here: a real preview (the hatched box is a stub, as
 * the mockup draws it) and a checksum (TRE-27). The INTEGRITY block still ships
 * and says "not computed", because a panel that hides the line reads as a file
 * with nothing to verify.
 */

/** Fresh enough that a chmod shows up, slow enough not to refetch on a glance. */
const STALE_MS = 10_000;

/** How many names a multi-selection lists before it starts counting instead. */
const NAMES_SHOWN = 8;

const TYPE_LABEL: Record<RowType, string> = {
  dir: "directory",
  file: "file",
  link: "symlink",
  other: "special file",
};

export function Inspector({
  host,
  path,
  rows,
  selected,
  sort,
  dir,
  glob,
  loading,
  error,
  now,
  onClose,
  onEditPermissions,
}: {
  host: HostView | null;
  /** The active pane's directory. */
  path: string;
  /** The rows the active pane is showing — already filtered and sorted. */
  rows: readonly FileRow[];
  /** Those of them that are selected, in listing order. */
  selected: readonly FileRow[];
  sort: SortKey;
  dir: SortDirection;
  /** The active glob, named by the directory panel's filter row. */
  glob: string;
  loading: boolean;
  error: unknown;
  /** Passed in so the panel ages against the same instant as the rows. */
  now: number;
  onClose: () => void;
  /** Opens the permissions modal on whatever is selected (TRE-21). */
  onEditPermissions: () => void;
}) {
  const one = selected.length === 1 ? selected[0] : null;

  /**
   * The panel's own download (TRE-26), which needs no callback out of here.
   *
   * The toolbar's button has to ask the explorer because the selection lives
   * there. This one is already looking at exactly one entry and knows its host
   * and its path, so it starts the download itself — routing it up and back
   * would add a prop to say something this component can already see.
   */
  const downloadOne = host && one ? () => startDownload(host.id, joinPath(path, one.name)) : null;

  /**
   * Minting a signed link (TRE-66), which ends in the clipboard.
   *
   * The hook is shared with the context menu's own entry (TRE-70): the rule
   * that the URL is never rendered into the page is one that survives in a
   * single place and rots in two.
   */
  const link = useSignedLink();

  const signedLink =
    host && one && one.type === "file" ? () => link.mutate({ hostId: host.id, path: joinPath(path, one.name) }) : null;

  // One stat call serves two panels: the selected entry, or — with nothing
  // selected — the directory itself, whose mode and owner the listing does not
  // carry. Several selected entries need no stat: the rows already have every
  // value that panel prints.
  const target = one ? joinPath(path, one.name) : selected.length === 0 ? path : null;
  const detail = useQuery({
    queryKey: [QUERY_KEYS.ENTRY, host?.id ?? null, target],
    queryFn: () => fetchStat(host?.id as string, target as string),
    enabled: host !== null && target !== null,
    staleTime: STALE_MS,
    retry: false,
    throwOnError: false,
  });

  // A selected directory's item count, for the preview stub. This shares its
  // cache entry with the explorer's hover and cursor prefetch, so by the time
  // the panel asks, the answer is usually already sitting there.
  const folderPath = one?.type === "dir" ? joinPath(path, one.name) : null;
  const folder = useQuery({
    queryKey: [QUERY_KEYS.DIRECTORY, host?.id ?? null, folderPath],
    queryFn: () => fetchListing(host?.id as string, folderPath as string),
    enabled: host !== null && folderPath !== null,
    staleTime: STALE_MS,
    retry: false,
    throwOnError: false,
  });

  return (
    <aside
      aria-label="Inspector"
      // 218px. Below the inspector breakpoint there is none at all — at that
      // width the two panes are already the narrowest thing worth showing, and
      // the toolbar's toggle goes with it rather than leaving a control with
      // nothing to open. That gate now sits on the box that opens this one
      // (TRE-62), which is where the width it would animate lives.
      className="bg-chrome border-line flex w-inspector flex-none flex-col border-l"
    >
      <header className="bg-line text-brand flex h-6 flex-none items-center justify-between px-2.5 font-sans text-caps font-semibold tracking-[0.16em]">
        <span>INSPECTOR</span>
        <Tooltip content="Hide the inspector (⌘I)">
          <button
            type="button"
            onClick={onClose}
            className="text-ink-faint hover:text-ink-muted font-normal"
          >
            ⌘I
          </button>
        </Tooltip>
      </header>

      {/* The mockup pins INTEGRITY and the actions to the bottom with a flex
          spacer. The scroller does the same job and survives a long path or a
          selection of forty names, which the spacer would push off the edge. */}
      {loading ? (
        <Notice>reading the directory…</Notice>
      ) : error ? (
        <Notice>this directory could not be read</Notice>
      ) : host === null ? (
        <Notice>no host bound to this pane</Notice>
      ) : selected.length === 0 ? (
        <DirectoryPanel
          path={path}
          rows={rows}
          sort={sort}
          dir={dir}
          glob={glob}
          detail={detail.data ?? null}
          now={now}
        />
      ) : one ? (
        <EntryPanel
          host={host}
          entry={one}
          entryPath={joinPath(path, one.name)}
          detail={detail.data ?? null}
          // `totalEntries`, not `count`: the listing is capped server-side, and
          // a folder of 40 000 files would otherwise report the cap as a fact.
          items={folder.data?.meta.totalEntries ?? null}
          now={now}
          onEditPermissions={onEditPermissions}
          onDownload={downloadOne}
          onSignedLink={signedLink}
          minting={link.isPending}
        />
      ) : (
        <SelectionPanel
          selected={selected}
          onEditPermissions={onEditPermissions}
        />
      )}
    </aside>
  );
}

/* ---- the three panels --------------------------------------------------- */

/**
 * Nothing selected: the directory itself (TRE-17 §1).
 *
 * Counted over the rows on screen rather than the whole directory, so the
 * numbers here and the ones in the pane footer describe the same set — which
 * is the point of naming the active filter two rows below them.
 */
function DirectoryPanel({
  path,
  rows,
  sort,
  dir,
  glob,
  detail,
  now,
}: {
  path: string;
  rows: readonly FileRow[];
  sort: SortKey;
  dir: SortDirection;
  glob: string;
  detail: FileRowDetail | null;
  now: number;
}) {
  const folders = rows.filter((row) => row.type === "dir").length;
  const bytes = rows.reduce((sum, row) => sum + row.size, 0);
  const newest = rows.reduce<FileRow | null>(
    (best, row) => (best === null || Date.parse(row.mtime) > Date.parse(best.mtime) ? row : best),
    null,
  );

  return (
    <Scroller>
      <Preview>folder · {rows.length === 1 ? "1 item" : `${rows.length} items`}</Preview>
      <Name>{path === "/" ? "/" : (path.split("/").filter(Boolean).pop() ?? "/")}</Name>

      <Stats
        cells={[
          { label: "ITEMS", value: String(rows.length) },
          { label: "SIZE", value: formatTotal(bytes) },
          { label: "FOLDERS", value: String(folders) },
          {
            label: "NEWEST",
            value: newest ? formatAge(ageDays(newest.mtime, now)) : "—",
            hint: newest?.name,
            quiet: true,
          },
        ]}
      />

      <Meta>
        <MetaRow label="path">{path}</MetaRow>
        <MetaRow label="sort">
          {sort} {dir === 1 ? "▲" : "▼"}
        </MetaRow>
        <MetaRow label="filter">{glob || "none"}</MetaRow>
      </Meta>

      <Permissions
        mode={detail?.mode ?? null}
        line={detail ? `${detail.mode} · directory` : null}
      />
    </Scroller>
  );
}

/** One entry (TRE-17 §2) — the state the mockup draws. */
function EntryPanel({
  host,
  entry,
  entryPath,
  detail,
  items,
  now,
  onEditPermissions,
  onDownload,
  onSignedLink,
  minting,
}: {
  host: HostView;
  entry: FileRow;
  entryPath: string;
  detail: FileRowDetail | null;
  /** A selected directory's child count, once it is known. */
  items: number | null;
  now: number;
  onEditPermissions: () => void;
  /** Starts the download (TRE-26). Null while there is no host to ask. */
  onDownload: (() => void) | null;
  /** Mints a signed link (TRE-66). Null for a directory — a link grants one file. */
  onSignedLink: (() => void) | null;
  minting: boolean;
}) {
  const isLink = entry.type === "link";

  return (
    <>
      <Scroller>
        <Preview>{previewCaption(entry, items)}</Preview>
        <Name>{entry.name}</Name>

        <Stats
          cells={[
            { label: "SIZE", value: formatSize(entry.size, entry.type) },
            {
              label: "ON DISK",
              value: isLink ? "—" : formatTotal(onDiskBytes(entry.size)),
              hint: isLink ? undefined : "Rounded up to a 4 KiB block — an estimate, not a measurement",
            },
            { label: "MODE", value: entry.mode },
            { label: "AGE", value: formatAge(ageDays(entry.mtime, now)), hint: entry.mtime, quiet: true },
          ]}
        />

        <Meta>
          <MetaRow label="host">{host.label}</MetaRow>
          <MetaRow label="path">{entryPath}</MetaRow>
          <MetaRow label="type">
            {TYPE_LABEL[entry.type]}
            {entry.linkTarget ? ` → ${entry.linkTarget}` : ""}
          </MetaRow>
          <MetaRow label="bytes">{formatExactBytes(entry.size)}</MetaRow>
          <MetaRow label="modified">{formatInstant(entry.mtime)}</MetaRow>
          <MetaRow label="accessed">{detail?.atime ? formatInstant(detail.atime) : "—"}</MetaRow>
          <MetaRow label="owner">
            {entry.owner}:{entry.group}
          </MetaRow>
          <MetaRow label="inode">{detail?.inode != null ? String(detail.inode) : "—"}</MetaRow>
          <MetaRow label="links">{detail?.nlink != null ? String(detail.nlink) : "—"}</MetaRow>
        </Meta>

        <Permissions
          mode={entry.mode}
          line={`${entry.mode} · ${entry.owner}:${entry.group}`}
          onEdit={onEditPermissions}
        />
      </Scroller>

      <Integrity
        hostId={host.id}
        entryPath={entryPath}
        isFile={entry.type === "file"}
      />

      <Actions
        onDownload={onDownload}
        onSignedLink={onSignedLink}
        minting={minting}
      />
    </>
  );
}

/**
 * Several entries (TRE-17 §3).
 *
 * The distinct-mode count is the one number here that is not arithmetic: it is
 * what tells you, before a bulk chmod, whether you are about to flatten three
 * different permission sets into one.
 */
function SelectionPanel({
  selected,
  onEditPermissions,
}: {
  selected: readonly FileRow[];
  onEditPermissions: () => void;
}) {
  const folders = selected.filter((row) => row.type === "dir").length;
  const bytes = selected.reduce((sum, row) => sum + row.size, 0);
  const modes = [...new Set(selected.map((row) => row.mode))].sort();
  const listed = selected.slice(0, NAMES_SHOWN);

  return (
    <Scroller>
      <Preview>{selected.length} entries</Preview>
      <Name>{selected.length} selected</Name>

      <Stats
        cells={[
          { label: "TOTAL SIZE", value: formatTotal(bytes) },
          { label: "MODES", value: String(modes.length), quiet: modes.length === 1 },
          { label: "FILES", value: String(selected.length - folders) },
          { label: "FOLDERS", value: String(folders) },
        ]}
      />

      {/* The name takes the room here, and the size is the fixed column — the
          reverse of a metadata row, whose key is the short half. */}
      <div className="px-2.5 pt-2.25">
        {listed.map((row) => (
          <div
            key={row.name}
            className="border-raised flex h-4.5 items-center gap-2 border-b font-mono text-2xs"
          >
            <Tooltip content={row.name}>
              <span className="text-ink-soft min-w-0 flex-1 truncate">{row.name}</span>
            </Tooltip>
            <span className="text-ink-faint flex-none">{formatSize(row.size, row.type)}</span>
          </div>
        ))}
        {selected.length > listed.length && (
          <p className="text-ink-faint pt-1.5 font-mono text-2xs">+{selected.length - listed.length} more</p>
        )}
      </div>

      <Permissions
        mode={selected[0].mode}
        line={modes.join(" · ")}
        onEdit={onEditPermissions}
      />
    </Scroller>
  );
}

/* ---- the checksum ------------------------------------------------------- */

/**
 * The INTEGRITY block (TRE-27 §3).
 *
 * Four states and no fifth: nothing computed, a job reading it right now, a
 * digest, and a digest that the file has moved on from. The last one is the
 * reason this is not a boolean — a checksum taken before somebody rewrote the
 * file is not a checksum of the file, and the server refuses to serve it, so
 * what is left to do here is say *why* the line went blank rather than letting
 * it read as though nothing was ever asked.
 *
 * **The digest is truncated on screen and whole in the clipboard.** Sixteen
 * characters is what fits at this width and is far more than anybody compares
 * by eye; the tooltip carries all sixty-four for the reader who wants to see
 * it, and the copy action carries all sixty-four for the one who wants to use
 * it. Truncating the copied value would be the worst of both.
 *
 * A directory keeps the block and says a checksum is per file. Hiding it would
 * make the panel change height on every selection, and the sentence is what
 * tells somebody that hashing the folder — which the context menu does offer —
 * means hashing what is inside it.
 */
function Integrity({ hostId, entryPath, isFile }: { hostId: string; entryPath: string; isFile: boolean }) {
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { csrfToken } = useAuth();
  const hashJob = useHashJob();

  const state = useQuery({
    queryKey: [QUERY_KEYS.HASH, hostId, entryPath],
    queryFn: () => fetchHashState(hostId, entryPath),
    enabled: isFile,
    staleTime: STALE_MS,
    /**
     * A slow poll while a job is running, which the feed below should make
     * redundant and does not always.
     *
     * The feed is the fast path and the reason the line moves at all. What it
     * cannot cover is a job that **ends before the stream connects** — a small
     * file, or one the cache already held, finishes in single-digit
     * milliseconds while `EventSource` is still opening its socket. There is
     * then no terminal frame to receive, nothing invalidates, and the panel
     * sits on "computing…" over a digest that has been in the database for a
     * quarter of an hour. Observed, not theorised: it is what this component
     * did before this line existed.
     *
     * Two seconds rather than the scan panel's five, because a checksum job can
     * genuinely be over in one — and the cost is a query that ends the moment
     * `running` goes null.
     */
    refetchInterval: (query) => (query.state.data?.running ? 2_000 : false),
    retry: false,
    throwOnError: false,
  });

  /** The live frame for the job covering this file, or null between jobs. */
  const [frame, setFrame] = useState<HashProgress | null>(null);

  const running = state.data?.running ?? null;
  // The id, not the object: the effect below must open a stream when a job
  // starts and close it when that job ends, and depending on the object would
  // tie a live connection to a reference the React Compiler happens to keep
  // stable.
  const jobId = running?.id ?? null;

  useEffect(() => {
    if (jobId === null) return;

    const source = new EventSource(hashStreamUrl(), { withCredentials: true });

    source.onmessage = (event: MessageEvent<string>) => {
      const next = parseProgress(event.data);
      // The feed is per account and carries every job this session started, so
      // the filter is here — a job hashing the other pane's selection must not
      // redraw this file's line.
      if (next === null || next.id !== jobId) return;
      setFrame(next);
      if (next.status === "RUNNING") return;

      if (next.status === "FAILED") {
        push({ tone: "danger", message: "The checksum job failed", detail: next.error ?? undefined });
      }
      // The digest is in the database by now, so this is what turns a finished
      // job into a line of hex without waiting for anything to go stale.
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.HASH] });
    };

    // Deliberately nothing on error. A network drop is EventSource's own
    // problem and it retries; a 401 closes it for good, and the next query is
    // what routes that to the login screen.
    return () => {
      source.close();
      setFrame(null);
    };
  }, [jobId, queryClient, push]);

  const hash = state.data?.hash ?? null;
  const busy = jobId !== null;

  const copy = async () => {
    if (!hash) return;
    try {
      // The whole digest, never the sixteen characters on screen.
      await navigator.clipboard.writeText(hash.digest);
      push({ tone: "success", message: "sha256 copied", detail: hash.digest });
    } catch {
      push({ tone: "warning", message: "Could not copy", detail: "This browser refused clipboard access." });
    }
  };

  const stop = () => {
    if (jobId === null) return;
    void cancelHash(jobId, csrfToken).then(
      () => queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.HASH] }),
      () => {
        // A job that ended a moment ago answers 404, which is the outcome the
        // press was asking for. Nothing to report either way.
        void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.HASH] });
      },
    );
  };

  return (
    <section className="border-line flex-none border-t px-2.5 py-2.25">
      <div className="flex items-baseline justify-between">
        <Heading>INTEGRITY</Heading>
        {isFile &&
          (busy ? (
            <button
              type="button"
              onClick={stop}
              className="text-ink-dim hover:text-ink-soft mb-1.75 font-mono text-caption/none"
            >
              stop
            </button>
          ) : hash ? (
            <button
              type="button"
              onClick={() => void copy()}
              className="text-ink-dim hover:text-ink-soft mb-1.75 font-mono text-caption/none"
            >
              copy
            </button>
          ) : (
            <button
              type="button"
              onClick={() => hashJob.mutate({ hostId, paths: [entryPath] })}
              className="text-ink-dim hover:text-ink-soft mb-1.75 font-mono text-caption/none"
            >
              compute
            </button>
          ))}
      </div>

      {!isFile ? (
        <p className="text-ink-soft font-mono text-caption">
          sha256 <span className="text-ink-faint">per file</span>
        </p>
      ) : busy ? (
        <>
          <p className="text-ink-soft font-mono text-caption">
            sha256 <span className="text-ink-dim">computing…</span>
          </p>
          <p className="text-ink-faint font-mono text-caption">{describeJob(frame, running)}</p>
        </>
      ) : hash ? (
        <>
          <Tooltip content={hash.digest}>
            <p className="text-ink-soft font-mono text-caption break-all">
              sha256 <span className="text-ink">{shortDigest(hash.digest)}…</span>
            </p>
          </Tooltip>
          <p className="text-ink-faint font-mono text-caption">
            {formatInstant(hash.computedAt)} · {hash.method === "REMOTE" ? "on the host" : "streamed"}
          </p>
        </>
      ) : (
        <>
          <p className="text-ink-soft font-mono text-caption">
            sha256 <span className="text-ink-faint">not computed</span>
          </p>
          {state.data?.superseded && (
            <p className="text-ink-faint font-mono text-caption">the file changed since it was last hashed</p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The second line while a job runs.
 *
 * Files rather than bytes, because files are what the number actually tracks:
 * `sha256sum` reports nothing until a file is finished, so a byte figure would
 * advance in jumps the size of whatever it is reading. Before the first frame
 * arrives there is still something true to say — how many files the job was
 * accepted with — and saying it beats an empty line that reads as a stall.
 */
function describeJob(frame: HashProgress | null, running: { files: number; queued: boolean } | null): string {
  if (frame === null) {
    if (running === null) return "";
    return running.queued ? `${running.files} file(s) · waiting for a slot` : `${running.files} file(s)`;
  }
  const failed = frame.filesFailed > 0 ? ` · ${frame.filesFailed} unreadable` : "";
  return `${frame.filesDone}/${frame.files} file(s)${failed}`;
}

/**
 * A frame off the wire, or null.
 *
 * Parsed defensively for the reason the scan panel gives: this is the one input
 * that does not arrive through `apiRequest`, so nothing above it has already
 * decided the body is JSON.
 */
function parseProgress(data: string): HashProgress | null {
  try {
    const parsed = JSON.parse(data) as HashProgress;
    return typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/* ---- the parts every panel is built from -------------------------------- */

function Scroller({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</div>;
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="text-ink-faint px-2.5 py-2.25 font-mono text-2xs">{children}</p>;
}

/**
 * The hatched box. It is a stub and looks like one on purpose — real previews
 * are a later idea, and a blank rectangle would read as one that failed.
 */
function Preview({ children }: { children: ReactNode }) {
  return (
    <div
      className="border-line-strong text-ink-dim mx-2.5 my-2.25 flex h-19.5 items-center justify-center border font-mono text-caption"
      style={{
        // 7px stripes, in rem so the hatch scales with everything else.
        backgroundImage:
          "repeating-linear-gradient(45deg, var(--color-raised) 0 0.4375rem, var(--color-line) 0.4375rem 0.875rem)",
      }}
    >
      {children}
    </div>
  );
}

/** Breaks mid-token, as the mockup does: a long name must not widen the panel. */
function Name({ children }: { children: ReactNode }) {
  return <div className="text-ink px-2.5 font-mono text-name font-medium break-all">{children}</div>;
}

interface StatCell {
  label: string;
  value: string;
  hint?: string;
  /** The dimmer value tone the mockup gives AGE — a reading, not a total. */
  quiet?: boolean;
}

/**
 * Four cells, two by two.
 *
 * There are no cell borders: the grid is painted in the line colour and the
 * 1px gap and 1px border let it show through as a hairline cross, which is how
 * the mockup draws it and why the cells repaint their own background.
 */
function Stats({ cells }: { cells: readonly StatCell[] }) {
  return (
    <div className="px-2.5 pt-2">
      <div className="bg-line border-line grid grid-cols-2 gap-px border">
        {cells.map((cell) => (
          <Tooltip
            key={cell.label}
            content={cell.hint}
          >
            <div className="bg-chrome px-1.75 py-1.25">
              {/* `leading-none` because the mockup sets these two at /1 and /1.4,
                  while `text-3xs` and `text-xs` both default to a 1rem line box —
                  unset, the label floats 7px above the value it belongs to. */}
              <div className="text-ink-faint font-mono text-3xs leading-none">{cell.label}</div>
              <div
                className={`font-mono text-xs leading-[1.4] font-medium ${cell.quiet ? "text-ink-dim" : "text-ink"}`}
              >
                {cell.value}
              </div>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <dl className="px-2.5 pt-2.25">{children}</dl>;
}

/**
 * One key and one value. The key column is fixed so nine rows read as a table;
 * the value ellipsizes rather than wrapping, and carries the whole string in
 * its tooltip — a path is exactly the thing that will not fit.
 *
 * The key column is 56px where the mockup draws 70. That is the one geometry
 * here deliberately not ported: 2a's rows hold `{{ m.k }}`, a placeholder that
 * names nothing, so its 70px was sized for content the mockup never decided
 * on. The real keys are eight characters at most — 48px — and the 14px handed
 * back is what lets a full `2026-08-07 04:20:11` survive once the panel starts
 * scrolling and the 9px scrollbar takes its cut. At 70px it lost the seconds.
 */
function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  const full = typeof children === "string" ? children : undefined;

  return (
    <div className="border-raised flex h-4.5 items-center gap-2 border-b font-mono text-2xs">
      <dt className="text-ink-faint w-14 flex-none">{label}</dt>
      <Tooltip content={full}>
        <dd className="text-ink-soft min-w-0 flex-1 truncate">{children}</dd>
      </Tooltip>
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="text-ink-link mb-1.75 font-sans text-caps font-semibold tracking-[0.16em]">{children}</h2>;
}

/**
 * The mode as a grid (TRE-17 §2), with the octal underneath it.
 *
 * Sixteen cells that mean nothing read one at a time, so the grid is one image
 * with the mode spelled out as its label. The line below is not a caption for
 * it — it carries the owner too, and it is the only place the exact mode is
 * printed as text.
 */
function Permissions({
  mode,
  line,
  onEdit,
}: {
  mode: string | null;
  line: string | null;
  /** Present only where there is a selection to change (TRE-21). */
  onEdit?: () => void;
}) {
  const rows = mode === null ? null : permissionRows(mode);

  return (
    <section className="px-2.5 pt-2.25 pb-2.5">
      {/* Baseline-aligned, as 2a draws it: the link is the same row as the
          heading, not a control floating beside it. */}
      <div className="flex items-baseline justify-between">
        <Heading>PERMISSIONS</Heading>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="text-ink-dim hover:text-ink-soft mb-1.75 font-mono text-caption/none"
          >
            edit
          </button>
        )}
      </div>

      {rows === null || mode === null ? (
        <p className="text-ink-faint font-mono text-2xs">unknown</p>
      ) : (
        <>
          <div
            role="img"
            aria-label={describeMode(mode)}
            // `leading-none` is what makes a cell 14px: 10px of glyph and the
            // 2px padding either side. `text-2xs` otherwise carries a 1rem line
            // box, which would inflate the panel's signature element by 40%.
            className="text-ink-muted grid grid-cols-[2.625rem_1fr_1fr_1fr] items-center gap-0.75 font-mono text-2xs leading-none"
          >
            <span />
            {["r", "w", "x"].map((column) => (
              <span
                key={column}
                className="text-ink-faint text-center"
              >
                {column}
              </span>
            ))}

            {rows.map((row) => (
              <Fragment key={row.who}>
                <span>{row.who}</span>
                {row.cells.map((cell, index) => (
                  <Tooltip
                    // Position is the identity: three fixed columns, r/w/x.
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed r/w/x columns
                    key={index}
                    content={cell.note}
                  >
                    <span className={`py-0.5 text-center ${cell.granted ? "bg-accent text-on-accent" : "bg-raised"}`}>
                      {cell.glyph}
                    </span>
                  </Tooltip>
                ))}
              </Fragment>
            ))}
          </div>

          {line && <p className="text-ink-dim mt-1.75 font-mono text-2xs leading-none break-all">{line}</p>}
        </>
      )}
    </section>
  );
}

/**
 * The four actions the mockup draws. `download` is live as of TRE-26 and
 * `signed link` as of TRE-66; the other two are still the bargain the toolbar
 * strikes — visible and inert, because a bottom row that grows buttons over two
 * milestones never looks finished.
 *
 * The fill comes back when the action does. A bright button that does nothing is
 * a worse lie than a dim one, and the inverse is true too.
 */
const ENTRY_ACTIONS: ReadonlyArray<{ id: string; label: string; reason?: string; primary?: boolean }> = [
  { id: "download", label: "download", primary: true },
  { id: "open", label: "open in →", reason: "Read-only previews are not part of M1" },
  { id: "extract", label: "extract", reason: "Archive extraction is not scheduled yet" },
  { id: "link", label: "signed link" },
];

function Actions({
  onDownload,
  onSignedLink,
  minting,
}: {
  onDownload: (() => void) | null;
  onSignedLink: (() => void) | null;
  minting: boolean;
}) {
  const handlers: Record<string, (() => void) | null> = { download: onDownload, link: onSignedLink };

  return (
    <div className="grid flex-none grid-cols-2 gap-1.5 px-2.5 pb-2.5">
      {ENTRY_ACTIONS.map((action) => {
        const press = handlers[action.id] ?? null;
        const busy = action.id === "link" && minting;
        const off = press === null || busy;
        return (
          <Tooltip
            key={action.id}
            content={action.reason}
          >
            <button
              type="button"
              // `aria-disabled`, not `disabled` (TRE-76). The whole value of the
              // hint here is that it explains why the button is inert, and a
              // control disabled by the attribute fires no mouse event and takes
              // no focus — so that explanation reached nobody using a keyboard
              // and nobody hovering it either.
              aria-disabled={off}
              onClick={off ? undefined : (press ?? undefined)}
              className={
                off
                  ? `bg-line text-ink-dim cursor-not-allowed border py-1.5 text-center font-mono text-cmd ${
                      action.primary ? "border-accent-soft" : "border-line-strong"
                    }`
                  : "bg-accent-soft text-on-accent border-accent-soft hover:bg-accent border py-1.5 text-center font-mono text-cmd font-medium"
              }
            >
              {busy ? "signing…" : action.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/* ---- helpers ------------------------------------------------------------ */

/**
 * What the stub says it would be showing. The mockup's own captions, widened
 * to the types a real listing contains.
 */
function previewCaption(row: FileRow, items: number | null): string {
  if (row.type === "dir") {
    if (items === null) return "folder";
    return `folder · ${items === 1 ? "1 item" : `${items} items`}`;
  }
  if (row.type === "link") return "symlink";
  if (row.type === "other") return "special file";

  const tag = typeTag(row).label;
  if (tag === "IMG") return "image preview";
  if (tag === "MP4") return "preview · video";
  if (tag === "GZ") return `preview · ${ARCHIVE_NAMES[row.extension] ?? row.extension} archive`;
  return row.extension ? `preview · ${row.extension}` : "preview";
}

/**
 * The format an archive extension stands for, where the two differ.
 *
 * `.gz` is the whole reason this exists: the mockup's own file is a
 * `.sql.gz` and its caption reads "gzip archive", not "gz archive". Anything
 * not named here already reads correctly as itself — "zip archive", "xz
 * archive" — so the map stays as short as the difference is.
 */
const ARCHIVE_NAMES: Record<string, string> = {
  gz: "gzip",
  tgz: "gzip",
  bz2: "bzip2",
  zst: "zstd",
};
