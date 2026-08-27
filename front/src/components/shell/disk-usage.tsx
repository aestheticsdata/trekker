"use client";

import { useAuth } from "@auth/context/AuthContext";
import { useToast } from "@components/ui/toast";
import { Tooltip, TooltipBlock } from "@components/ui/tooltip";
import {
  STRIP_ACTION_INK,
  STRIP_ALARM_INK,
  STRIP_LABEL_INK,
  STRIP_QUIET_INK,
  STRIP_SURFACE,
  STRIP_VALUE_INK,
  volumeFor,
  WARN_CHIP_FILL,
  WARN_CHIP_INK,
} from "@helpers/disks";
import { formatTotal, parentPath } from "@helpers/listing";
import { PRESS } from "@helpers/press";
import { BAND_CLASS, BAND_LABEL_INK, BAND_REST_CLASS, BAND_SIZE_INK, treemapBands } from "@helpers/treemap";
import { ApiError } from "@lib/api/client";
import { fetchDisks } from "@lib/api/disks";
import { cancelScan, fetchScanState, scanStreamUrl, startScan } from "@lib/api/scans";
import { QUERY_KEYS } from "@lib/query/keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { TreemapBand } from "@helpers/treemap";
import type { DiskMount } from "@lib/api/disks";
import type { HostView } from "@lib/api/hosts";
import type { ScanProgress, ScanState, ScanView } from "@lib/api/scans";
import type { ReactNode } from "react";

/**
 * The docked disk-usage strip (TRE-33 §2), built from the App mockup's markup.
 *
 * A bar rather than a panel: fixed height, full width, below the panes and
 * above the status bar, and the panes give up the space.
 *
 * The mockup splits it with an `OPERATION LOG` at 280px on the right, and this
 * app does not: that column is the activity feed, and TRE-30 put it in the
 * sidebar where it is visible whatever the strip is doing (`ActivityStrip`).
 * So the usage half takes the whole width, deliberately and permanently.
 *
 * It is worth naming what that column is **not**, because it read as an open
 * slot for a while and it is not one. The live tail (TRE-34) is drawn inside
 * the pane, docked between the rows and the pane's footer — a tail belongs to
 * the directory somebody is standing in, and there are two of those.
 *
 * **Which root it shows.** `root` is the pinned one when there is one and the
 * active pane's path otherwise, and that distinction is what makes clicking a
 * band usable: the click navigates the pane, and a strip that followed the pane
 * would go blank in the same instant and offer to scan the directory you had
 * just arrived in. Starting a scan pins it, and the pin is in the URL, so the
 * link is still the view.
 *
 * **What it never does** is present a stale reading as a current one. A `du` of
 * a large tree takes minutes and is kept for days, so the ordinary state of
 * this panel on any given afternoon is "showing you this morning" — which is
 * fine, and is only fine because the age is on the line every time and turns
 * amber past the threshold. That threshold is the server's and travels in the
 * payload; nothing here decides when a scan has gone off.
 *
 * **A running scan does not blank it.** The API keeps the previous result alive
 * until the new one reaches DONE for exactly this reason, so a scan in flight
 * takes over the summary line and leaves the treemap and the facts saying what
 * they said before, with the line naming which reading that is.
 */

export function DiskUsage({
  host,
  root,
  panePath,
  onPin,
  onNavigate,
  onHide,
}: {
  /** The active pane's host, or null when that pane is bound to nothing. */
  host: HostView | null;
  /** The root whose scan is on screen. */
  root: string;
  /** Where the active pane is — what `scan` would walk. */
  panePath: string;
  /** Pin the strip to a root, or null to let it follow the active pane again. */
  onPin: (root: string | null) => void;
  /** Point the active pane at a path. */
  onNavigate: (path: string) => void;
  onHide: () => void;
}) {
  const { csrfToken } = useAuth();
  const queryClient = useQueryClient();
  const { push } = useToast();

  /** The newest frame off the progress feed, terminal ones included. */
  const [progress, setProgress] = useState<ScanProgress | null>(null);

  const {
    data: state,
    isPending,
    isError,
  } = useQuery({
    queryKey: [QUERY_KEYS.SCAN, host?.id, root],
    queryFn: () => fetchScanState(host?.id as string, root),
    enabled: Boolean(host),
    staleTime: 30_000,
    // A poll is the floor under the feed, not a replacement for it — the same
    // arrangement the transfer queue uses. The stream carries the counters; this
    // is what guarantees the panel eventually agrees with the database even if
    // every frame of a scan is lost, which is what a restart mid-walk does.
    refetchInterval: (query) => (query.state.data?.running ? 5_000 : false),
    retry: false,
    throwOnError: false,
  });

  // Shared with the sidebar's volumes panel by key, so the capacity on the
  // summary line costs no second `df`.
  const { data: disks } = useQuery({
    queryKey: [QUERY_KEYS.HOST_DISKS, host?.id],
    queryFn: () => fetchDisks(host?.id as string),
    enabled: Boolean(host),
    staleTime: 30_000,
    retry: false,
    throwOnError: false,
  });

  /**
   * The progress feed.
   *
   * Opened per host and torn down when the host changes, because the server
   * filters the stream by the id in the URL. Reconnection is `EventSource`'s
   * own business; what this adds is a refetch on every terminal frame, which is
   * how a finished scan becomes a treemap without waiting for a poll.
   */
  // The id, not the host: the effect below must reopen when the *machine*
  // changes and at no other time, and depending on the object would tie a live
  // connection to a reference the React Compiler happens to keep stable.
  const hostId = host?.id ?? null;

  useEffect(() => {
    if (hostId === null) return;

    const source = new EventSource(scanStreamUrl(hostId), { withCredentials: true });

    source.onmessage = (event: MessageEvent<string>) => {
      const frame = parseProgress(event.data);
      if (frame === null) return;
      setProgress(frame);
      if (frame.status === "RUNNING") return;

      // A walk that dies is not the same as a POST that was refused, and only
      // the second one raises a toast on its own. Without this a scan started
      // ten minutes ago fails silently — the panel keeps the previous result,
      // which is honest but says nothing about the attempt.
      if (frame.status === "FAILED") {
        push({
          tone: "danger",
          message: `The scan of ${frame.root} failed`,
          detail: frame.error ?? undefined,
        });
      }

      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.SCAN] });
      // A scan that has just ended is also the best moment to re-read `df`: the
      // walk is over, and whatever it was reading has settled.
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.HOST_DISKS] });
    };

    // Deliberately nothing on error. A network drop is EventSource's own
    // problem and it retries; a 401 closes it for good, and the next query is
    // what routes that to the login screen.
    return () => {
      source.close();
      setProgress(null);
    };
  }, [hostId, queryClient, push]);

  const begin = useMutation({
    mutationFn: (target: string) => startScan(host?.id as string, target, csrfToken),
    onSuccess: (scan: ScanView) => {
      // Pinned to what the server actually walked, never to what was asked for:
      // the guard resolves the path, and a symlinked root is stored — and later
      // matched — under its real name.
      onPin(scan.root);
      // Written into the cache as well as invalidated, because `running` is now
      // read off the payload alone: between the 202 and the refetch landing, an
      // invalidate-only path would show the empty state and an enabled `scan ⟳`
      // for the scan that had just been accepted. The invalidate still follows
      // and reconciles whatever else changed.
      queryClient.setQueryData([QUERY_KEYS.SCAN, scan.hostId, scan.root], (previous?: ScanState) => ({
        scan: previous?.scan ?? null,
        level: previous?.level ?? null,
        running: scan,
      }));
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.SCAN] });
    },
    onError: (error) =>
      push({
        tone: "danger",
        message:
          error instanceof ApiError && error.status === 409
            ? "A scan is already running on this host"
            : "Could not start the scan",
        detail: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const stop = useMutation({
    mutationFn: () => cancelScan(host?.id as string, csrfToken),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.SCAN] }),
    onError: (error) =>
      push({
        tone: "danger",
        message: "Could not stop the scan",
        detail: error instanceof ApiError ? error.message : undefined,
      }),
  });

  /**
   * Whether a scan is running — and the payload decides, never the feed.
   *
   * The obvious arrangement is the wrong one. A frame is 700ms old and the
   * payload up to five seconds old, so believing the frame looks like the
   * fresher answer; but a frame is also the *last* thing said rather than the
   * current state, and there is no replay. The stream carries no `id:` and
   * ignores `Last-Event-ID`, so any frame emitted while the connection was down
   * is gone — the terminal one included. An API restart mid-walk emits nothing
   * at all: the row is swept to FAILED by a database write. Anything deriving
   * "running" from the last frame therefore has a state it can enter and never
   * leave, with the shimmer going forever and `cancel` answering 404.
   *
   * So the payload is the state, the poll above keeps it moving, and the feed
   * only fills in the counters — and only for the scan the payload names, so a
   * frame left over from the previous one cannot label this one.
   */
  const pending = state?.running ?? null;
  // The one thing the feed may override: a terminal frame for the very scan the
  // payload still calls running is newer than the payload, and is believed
  // until the refetch it triggered lands. This direction is safe because it can
  // only ever end the running state, never begin one that has no row behind it.
  const settled = pending !== null && progress?.id === pending.id && progress.status !== "RUNNING";
  const running = pending !== null && !settled;
  const live = running && progress?.id === pending?.id && progress?.status === "RUNNING" ? progress : null;
  // Only the feed carries a failure: `ScanStateView` returns the newest DONE
  // scan and whatever is RUNNING, and a FAILED one is in neither.
  const failure = progress?.status === "FAILED" && progress.root === root ? progress.error : null;

  const scan = state?.scan ?? null;
  const level = state?.level ?? null;
  const volume = disks ? volumeFor(root, disks) : null;

  /**
   * A pin that points at nothing lets go.
   *
   * `duRoot` carries a path and no host, so a pin made on one machine survives
   * the pane being rebound to another, where that path is at best a different
   * directory and at worst absent — and nothing else in the app writes the
   * parameter, so it would be a strip stuck on a root with no way back short of
   * editing the URL. Rather than teach the pin about hosts, it is dropped the
   * moment the server says there is neither a kept scan nor a running one under
   * it: that is exactly when it has stopped meaning anything, whether the cause
   * was a host change, a swept result, or a directory that is gone.
   */
  useEffect(() => {
    // `root !== panePath` is what "pinned" means here: the page passes
    // `duRoot ?? panePath`, so the two can only differ when something is pinned.
    if (root === panePath || state === undefined) return;
    if (state.scan !== null || state.running !== null) return;
    onPin(null);
  }, [root, panePath, state, onPin]);

  return (
    <section
      aria-label="Disk usage"
      className={`${STRIP_SURFACE} border-line h-strip flex-none border-t px-2.5 py-2`}
    >
      <div className="flex items-baseline gap-2.25">
        {/* Two truncating halves, and only the second one gives way. The label
            is four fixed words; the root is a path with no bound on it, and left
            whole it would push `scan` and `hide` off the right edge of the bar
            on any deep directory. */}
        <h2
          className={`${STRIP_LABEL_INK} flex min-w-0 items-baseline gap-1 font-sans text-caps leading-none font-semibold tracking-[0.16em]`}
        >
          <span className="flex-none whitespace-nowrap">DISK USAGE</span>
          {host && (
            <Tooltip content={`${host.label}:${root}`}>
              <span className="min-w-0 truncate font-mono tracking-normal">
                · {host.label}:{root}
              </span>
            </Tooltip>
          )}
        </h2>

        {/* No spacer beside it: two `flex-1` children would split the free space
            between them, and half of it would go to an empty box while the line
            that has something to say truncated at half the width it could have had. */}
        <Summary
          host={host}
          scan={scan}
          volume={volume}
          live={live}
          running={running}
          pending={isPending && host !== null}
          failed={isError}
        />

        {host &&
          (running ? (
            <Action
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
              hint="Stop the scan running on this host"
            >
              cancel ✕
            </Action>
          ) : (
            <Action
              onClick={() => begin.mutate(panePath)}
              disabled={begin.isPending}
              hint={`Walk ${panePath} with du and keep the result`}
            >
              scan ⟳
            </Action>
          ))}

        <Action
          onClick={onHide}
          hint="Collapse the strip and give the space back to the panes"
        >
          hide ▾
        </Action>
      </div>

      <div className="mt-1.5">
        {scan && level ? (
          <Treemap
            bands={treemapBands(level)}
            onNavigate={onNavigate}
          />
        ) : running ? (
          <Working live={live} />
        ) : (
          <Blank
            host={host}
            root={root}
            failure={failure}
            // The root this state is *about*, not the pane's: the sentence
            // beside the button names one directory and the button has to walk
            // that one. `scan ⟳` in the header is the control that follows the
            // pane, and it says so on hover.
            onScan={host ? () => begin.mutate(root) : null}
            pending={begin.isPending}
          />
        )}
      </div>

      {/* The last finished scan's, even while a new one runs — the summary line
          above is what says which reading these belong to. */}
      <Facts scan={scan} />
    </section>
  );
}

/**
 * The line beside the title: what was found, of what the volume holds, how old
 * the reading is, and how many inodes it took.
 *
 * A running scan takes it over, because a progress readout and a result are
 * never both the newest thing this panel knows — and because it is the one line
 * that can say "walking, and what you are looking at is from this morning".
 */
function Summary({
  host,
  scan,
  volume,
  live,
  running,
  pending,
  failed,
}: {
  host: HostView | null;
  scan: ScanView | null;
  volume: DiskMount | null;
  live: ScanProgress | null;
  running: boolean;
  pending: boolean;
  /** The scan-state request itself failed — which is not "never scanned". */
  failed: boolean;
}) {
  const line = "min-w-0 flex-1 truncate font-mono text-caption leading-none";

  if (!host) return <p className={`${line} ${STRIP_QUIET_INK}`}>No host in the active pane.</p>;

  if (running) {
    const counted = live
      ? `${formatCount(live.inodes)} entries · ${formatTotal(Number(live.bytes))} · ${live.elapsedSeconds}s`
      : null;

    return (
      <p className={`${line} ${STRIP_QUIET_INK} flex items-center gap-1.5`}>
        <span
          aria-hidden
          className="bg-accent-soft h-1.25 w-5 flex-none animate-shimmer"
        />
        <span className={`${STRIP_VALUE_INK} flex-none`}>{live ? PHASE_LABEL[live.phase] : "starting a scan"}</span>
        <span className="min-w-0 truncate">
          {[counted, scan ? `showing the scan from ${formatAgo(scan.ageSeconds)}` : null]
            .filter((part): part is string => part !== null)
            .join(" · ")}
        </span>
      </p>
    );
  }

  if (pending) return <p className={`${line} ${STRIP_QUIET_INK}`}>Looking for a kept scan…</p>;
  // Before the "never scanned" arm, because they are different claims and only
  // one of them is about the disk: a request that failed knows nothing about
  // whether this root has ever been walked, and saying so would be an assertion
  // built out of a network error.
  if (failed) return <p className={`${line} ${STRIP_ALARM_INK}`}>Could not read this host's scans.</p>;
  if (!scan) return <p className={`${line} ${STRIP_QUIET_INK}`}>Never scanned.</p>;

  const parts = [
    volume
      ? `${formatTotal(Number(scan.totalBytes ?? 0))} of ${formatTotal(volume.totalBytes)}`
      : formatTotal(Number(scan.totalBytes ?? 0)),
    `scan finished ${formatAgo(scan.ageSeconds)}`,
    scan.inodes ? `${formatCount(scan.inodes)} inodes` : null,
    // Both of these change what the numbers beside them mean, so they ride on
    // the same line rather than waiting to be discovered in a tooltip.
    scan.truncated ? "partial: the tree outgrew what one scan keeps" : null,
    scan.unreadableCount > 0 ? `${formatCount(scan.unreadableCount)} unreadable` : null,
  ].filter((part): part is string => part !== null);

  return (
    <p className={`${line} ${STRIP_QUIET_INK} flex items-baseline gap-1.5`}>
      {scan.stale && (
        <Tooltip content={`This install calls a scan current for ${formatDuration(scan.staleAfterSeconds)}.`}>
          <span className={`${WARN_CHIP_FILL} ${WARN_CHIP_INK} flex-none rounded-xs px-1 py-0.5 leading-none`}>
            ⚠ stale
          </span>
        </Tooltip>
      )}
      <span className="min-w-0 truncate">{parts.join(" · ")}</span>
    </p>
  );
}

/**
 * Why the one band that never opens never opens (TRE-105).
 *
 * The front's words rather than the API's, following `linkInsideRoot`: the 403
 * body is written for a request that has already been made, this is written for
 * a pointer resting on a rectangle. One fact, two registers — and the server
 * sends a boolean, so there is only ever one fact to keep straight.
 */
const BAND_DENIED_NOTE =
  "Trekker's own install. It holds the master key that decrypts every stored credential, " +
  "so it stays closed to the browser — reach it over SSH.";

/**
 * The bands.
 *
 * Widths are flex shares of the level's own total, which is what makes them sum
 * to the strip exactly however many gaps sit between them — percentages plus
 * gaps do not, and the error lands in whichever band is drawn last.
 */
function Treemap({ bands, onNavigate }: { bands: readonly TreemapBand[]; onNavigate: (path: string) => void }) {
  if (bands.length === 0) return <Note>This directory holds nothing to divide up.</Note>;

  return (
    <div className="flex h-7.5 gap-0.5">
      {bands.map((band, index) => {
        const percent = Math.round(band.share * 100);
        // A pane cannot be pointed at a file, so a band standing for one takes
        // you to the directory holding it — which is the place you can act on it.
        //
        // A denied band resolves to nothing at all (TRE-105). It has a path and
        // a size and still goes nowhere, so it joins the tail in the one state
        // this component already knows how to draw: no target. Everything below
        // — the guarded click, `aria-disabled`, the cursor — then needs no case
        // of its own, and only the tooltip has to tell the two apart.
        const target = band.path === null || band.denied ? null : band.isDirectory ? band.path : parentPath(band.path);

        return (
          // ⚠️ The tooltip wraps the button and adds no element of its own,
          // which here is structural rather than tidy: `flexGrow`/`flexBasis` is
          // the entire geometry of this strip, and a box between the button and
          // the flex row would divide the bar by the wrong numbers.
          <Tooltip
            key={band.path ?? "rest"}
            content={
              <TooltipBlock
                note={
                  band.denied ? BAND_DENIED_NOTE : target === null ? undefined : "Click to open it in the active pane."
                }
                rows={[
                  { label: "size", value: formatTotal(band.bytes) },
                  { label: "share", value: `${percent}%` },
                ]}
                subject={band.path ?? "everything below the five largest"}
              />
            }
          >
            <button
              type="button"
              // `aria-disabled`, not `disabled`. A disabled control fires no
              // mouse event at all, and the band that cannot be opened is the
              // fold — the one band whose full size is written down nowhere
              // else on screen. Still not activatable, the click below is
              // guarded, and now reachable by keyboard, which it never was.
              aria-disabled={target === null}
              onClick={() => target && onNavigate(target)}
              // `flexBasis: 0` with a grow of the band's share is the whole
              // geometry: the row's width, minus its gaps, divided in proportion.
              // `min-w-0` is what lets a sliver actually be a sliver rather than
              // be held open by its own padding.
              style={{ flexGrow: band.share, flexBasis: 0 }}
              // By identity, never by position: the fold lands at whatever index
              // is left over, which is the fifth only when the level had five
              // children to name.
              className={`flex min-w-0 flex-col justify-end overflow-hidden px-1.25 py-0.75 text-left ${
                band.path === null ? BAND_REST_CLASS : BAND_CLASS[Math.min(index, BAND_CLASS.length - 1)]
              } ${target === null ? "cursor-default" : ""}`}
            >
              <span className={`${BAND_LABEL_INK} truncate font-mono text-caption leading-tight font-medium`}>
                {band.label}
              </span>
              <span className={`${BAND_SIZE_INK} truncate font-mono text-caps leading-tight`}>
                {formatTotal(band.bytes)} · {percent}%
              </span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * The first scan of a root, with nothing behind it to keep showing.
 *
 * No bar and no percentage, because there is no denominator: `du` does not know
 * how much tree is left until it has walked it, and a bar drawn against a guess
 * is a lie with a shape. What it can report is real — the phase, what has been
 * counted so far, and how long it has been going.
 */
function Working({ live }: { live: ScanProgress | null }) {
  return (
    <div
      className={`border-line-strong ${STRIP_QUIET_INK} flex h-7.5 items-center gap-2.25 border px-2 font-mono text-caption leading-none`}
    >
      <span
        aria-hidden
        className="bg-accent-soft h-1.25 w-6 flex-none animate-shimmer"
      />
      <span className={`${STRIP_VALUE_INK} flex-none`}>{live ? PHASE_LABEL[live.phase] : "starting…"}</span>
      {live && (
        <span className="min-w-0 truncate">
          {formatCount(live.inodes)} entries · {formatTotal(Number(live.bytes))} · {live.elapsedSeconds}s
        </span>
      )}
    </div>
  );
}

const PHASE_LABEL: Record<ScanProgress["phase"], string> = {
  probing: "probing the host's du",
  walking: "walking the tree",
  hashing: "hashing duplicate candidates",
  saving: "writing the result",
};

/**
 * No scan, or one that failed.
 *
 * Two different facts, and they want different next moves: "nobody has scanned
 * this" is an invitation, "the last one failed and here is why" is an
 * explanation. Saying the first for the second is how somebody presses the same
 * button four times.
 */
function Blank({
  host,
  root,
  failure,
  onScan,
  pending,
}: {
  host: HostView | null;
  root: string;
  failure: string | null;
  onScan: (() => void) | null;
  pending: boolean;
}) {
  if (!host) return <Note>Bind the active pane to a host and its disk usage appears here.</Note>;

  return (
    <div className="border-pane-dash flex h-7.5 items-center gap-2.5 border border-dashed px-2">
      <Tooltip content={failure ?? undefined}>
        <p
          className={`min-w-0 flex-1 truncate font-mono text-caption leading-none ${
            failure ? STRIP_ALARM_INK : STRIP_QUIET_INK
          }`}
        >
          {failure ?? `${root} has not been scanned yet — du walks it once and the result is kept.`}
        </p>
      </Tooltip>
      {onScan && (
        <button
          type="button"
          onClick={onScan}
          disabled={pending}
          className={`${PRESS} flex-none px-2.5 py-1 font-mono text-2xs leading-none font-medium disabled:opacity-60`}
        >
          {pending ? "starting…" : failure ? "try again" : "scan now"}
        </button>
      )}
    </div>
  );
}

/**
 * The three facts under the strip.
 *
 * Always three, always in this order, and an uncomputed one is an em dash
 * rather than a gap: after the first read the row is read by position, and a
 * fact that shifts because its neighbour was missing has to be read again.
 */
function Facts({ scan }: { scan: ScanView | null }) {
  const largest = scan?.facts.largest;
  const duplicates = scan?.facts.duplicates;
  const old = scan?.facts.oldFiles;

  return (
    <div
      className={`${STRIP_QUIET_INK} mt-1.5 flex gap-4 overflow-hidden font-mono text-caption leading-none whitespace-nowrap`}
    >
      <Fact
        label="largest"
        hint={largest?.path}
      >
        {largest ? `${lastSegment(largest.path)} ${formatTotal(Number(largest.bytes))}` : null}
      </Fact>

      <Fact
        label="duplicates"
        hint={
          duplicates ? (
            <TooltipBlock
              // The pair matters: `confirmed` are groups two files of which were
              // read and hashed, `candidates` only share a size. Reporting the
              // second as the first would promise reclaimable space that may not
              // exist — which is why they are three rows here rather than the
              // one flat line a `title` could hold.
              note="Only the confirmed groups are reclaimable."
              rows={[
                { label: "candidates", value: formatCount(duplicates.candidates) },
                { label: "confirmed", value: formatCount(duplicates.confirmed) },
                { label: "too large to hash", value: formatCount(duplicates.skipped) },
              ]}
              subject="duplicates, by size then by hash"
            />
          ) : undefined
        }
      >
        {duplicates
          ? `${formatCount(duplicates.confirmed)} · ${formatTotal(Number(duplicates.reclaimableBytes))} reclaimable`
          : null}
      </Fact>

      <Fact
        label="files > 1 year"
        hint={
          old ? (
            <TooltipBlock
              rows={[
                { label: "size", value: formatTotal(Number(old.bytes)) },
                { label: "untouched since", value: old.before.slice(0, 10) },
              ]}
              subject="files older than a year"
            />
          ) : undefined
        }
      >
        {old ? formatCount(old.count) : null}
      </Fact>
    </div>
  );
}

/** `hint`, not `title`: a prop called `title` that is not a title is how the
 *  attribute finds its way back in (TRE-76). */
function Fact({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <Tooltip content={hint}>
      <span className="min-w-0 truncate">
        {label}: <span className={STRIP_VALUE_INK}>{children ?? "—"}</span>
      </span>
    </Tooltip>
  );
}

/**
 * The mockup's own control text: mono, lowercase, no border.
 *
 * The one place in this file that keeps the `disabled` attribute rather than
 * moving to `aria-disabled`. Both are true of it: the state lasts as long as one
 * request is in flight, and the hint says what the button does rather than why
 * it cannot be pressed. Nothing is stranded by the hint pausing for as long as
 * the control does.
 */
function Action({
  onClick,
  disabled = false,
  hint,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  hint: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={hint}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`${STRIP_ACTION_INK} hover:text-ink flex-none font-mono text-caption leading-none whitespace-nowrap disabled:opacity-60`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className={`${STRIP_QUIET_INK} flex h-7.5 items-center font-mono text-caption leading-none`}>{children}</p>;
}

/** How long ago, in one unit — the age column's own habit. */
function formatAgo(seconds: number | null): string {
  return seconds === null ? "just now" : `${formatDuration(seconds)} ago`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

/**
 * A count, grouped. The locale is pinned rather than the browser's: this
 * renders on the server first, and a separator chosen from two different
 * locales is a hydration mismatch on every number over a thousand.
 */
function formatCount(value: string | number): string {
  return Number(value).toLocaleString("en-US");
}

function lastSegment(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** A truncated frame is dropped rather than thrown — the next one is 700ms away. */
function parseProgress(data: string): ScanProgress | null {
  try {
    return JSON.parse(data) as ScanProgress;
  } catch {
    return null;
  }
}
