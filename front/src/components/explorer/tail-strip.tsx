"use client";

import { useTail } from "@components/explorer/use-tail";
import { ScrollThumbRail, useScrollThumbs } from "@components/ui/scroll-thumbs";
import { Tooltip, TooltipBlock } from "@components/ui/tooltip";
import { joinPath } from "@helpers/listing";
import {
  looksLikeLog,
  splitLine,
  TAIL_BODY_INK,
  TAIL_BUTTON_FILL,
  TAIL_BUTTON_INK,
  TAIL_HEADER_INK,
  TAIL_NOTE_INK,
  TAIL_SURFACE,
} from "@helpers/tail";
import { useEffect, useRef, useState } from "react";

import type { TailEntry } from "@components/explorer/use-tail";
import type { FileRow } from "@lib/api/fs";

/**
 * The live tail, docked at the bottom of a pane (TRE-34 §3).
 *
 * A strip rather than a panel, the way the disk-usage bar is: it takes its
 * space from the listing above it and gives it back when it closes. The mockup
 * draws it inside the pane on a ground one step below the rows, with the accent
 * edge on its left — the same edge an active pane wears, which is what says
 * this belongs to *this* pane and not to the window.
 *
 * **It never opens a stream by itself.** Three mechanisms decide, in order of
 * authority: the tailed file is a per-pane URL parameter, so it survives a
 * reload and a shared link; a path heuristic decides whether the strip *offers*
 * itself, by rendering an idle picker; and nothing auto-streams, because
 * opening a connection to somebody's server on the strength of a directory name
 * is the kind of helpfulness people uninstall software over.
 *
 * **Auto-scroll is a state, not a behaviour.** Following the end of a file is
 * the default, scrolling up leaves it, and what arrives while away is counted
 * rather than yanked into view. That is the ticket's rule and the reason the
 * count is a button: a reader who scrolled up is reading, and the app's job is
 * to say what it is holding rather than to interrupt.
 */

/**
 * How close to the end still counts as "at the end", in CSS pixels.
 *
 * Not a design length and deliberately not scaled: it absorbs the sub-pixel
 * rounding a fractional line height leaves behind, where an element scrolled
 * fully to the bottom reports a `scrollTop` a fraction short of the arithmetic.
 * Without it a tail at rest reads as scrolled away and stops following itself.
 */
const AT_END_SLACK = 4;

export function TailStrip({
  hostId,
  directory,
  file,
  rows,
  onTail,
}: {
  /** The pane's host. A tail is a file on one machine, and this is the machine. */
  hostId: string | null;
  /** Where the pane is standing — what the picker joins a chosen name onto. */
  directory: string;
  /** The file being followed, or null for the idle picker. */
  file: string | null;
  /** The pane's listing, which is where the picker's candidates come from. */
  rows: readonly FileRow[];
  onTail: (path: string | null) => void;
}) {
  if (file === null)
    return (
      <TailPicker
        directory={directory}
        rows={rows}
        onTail={onTail}
      />
    );

  return (
    <TailFeedView
      // Keyed on the file so switching between two logs starts a clean buffer
      // rather than appending one to the other.
      key={`${hostId}:${file}`}
      hostId={hostId}
      path={file}
      onTail={onTail}
    />
  );
}

function TailFeedView({
  hostId,
  path,
  onTail,
}: {
  hostId: string | null;
  path: string;
  onTail: (path: string | null) => void;
}) {
  /**
   * Bumped to open the stream again after it ended.
   *
   * Both ways a tail ends are worth offering this for, and for different
   * reasons. A refusal will usually be refused again — but a cap is somebody
   * else's tab closing, and a rate limit is a minute passing. Ten consecutive
   * failures on the host is the other, and that is precisely the kind of thing
   * that is over by the time anybody reads the message.
   */
  const [attempt, setAttempt] = useState(0);
  const feed = useTail(hostId, path, attempt);
  const bodyRef = useRef<HTMLDivElement>(null);

  // The composited scrollbar's measured half (TRE-117). `received` rather
  // than the ring or its length: the ring's identity churns on frames that
  // changed nothing, and its length parks at the cap while wrapped lines
  // keep rotating through — which changes the height with the count frozen.
  // The total received is the one number that moves on every append.
  useScrollThumbs(bodyRef, feed.received);

  /**
   * The line count at the moment the reader scrolled away, or null while the
   * strip is following the end.
   *
   * One piece of state for two questions — whether to follow, and how much has
   * arrived since — because they are one question. Two would let them disagree,
   * which presents as a button offering to show nothing.
   */
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const pending = pausedAt === null ? 0 : Math.max(0, feed.received - pausedAt);

  useEffect(() => {
    if (pausedAt !== null) return;
    const body = bodyRef.current;
    if (body !== null) body.scrollTop = body.scrollHeight;
    // The count rather than the array: the effect wants to run when something
    // was appended, and the ring's identity changes on every frame including
    // the ones that changed nothing on screen.
  }, [pausedAt, feed.entries.length]);

  const follow = (): void => {
    setPausedAt(null);
    const body = bodyRef.current;
    if (body !== null) body.scrollTop = body.scrollHeight;
  };

  const onScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    const body = event.currentTarget;
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight <= AT_END_SLACK;
    if (atEnd) {
      if (pausedAt !== null) setPausedAt(null);
    } else if (pausedAt === null) {
      setPausedAt(feed.received);
    }
  };

  const name = path.split("/").filter(Boolean).pop() ?? path;

  return (
    <Frame
      title={
        <Tooltip
          content={
            <TooltipBlock
              subject={feed.ready?.path ?? path}
              rows={[
                { label: "source", value: feed.ready?.source === "tail" ? "tail -F" : "polling" },
                { label: "lines", value: String(feed.received) },
              ]}
              note={
                feed.ready?.shared === true
                  ? "Another tab is following this file. Both share one reader on the host."
                  : undefined
              }
            />
          }
        >
          <span className="min-w-0 truncate font-mono">{name}</span>
        </Tooltip>
      }
      controls={
        <>
          <StatusWord feed={feed} />

          {feed.status === "ended" && (
            <button
              type="button"
              onClick={() => setAttempt((previous) => previous + 1)}
              className={`${TAIL_BUTTON_FILL} ${TAIL_BUTTON_INK} px-1.5 py-0.5 font-medium whitespace-nowrap`}
            >
              retry
            </button>
          )}

          {pausedAt !== null && (
            <button
              type="button"
              onClick={follow}
              className={`${TAIL_BUTTON_FILL} ${TAIL_BUTTON_INK} px-1.5 py-0.5 font-medium whitespace-nowrap`}
            >
              ↓ {pending > 0 ? `${pending} new` : "follow"}
            </button>
          )}

          <button
            type="button"
            onClick={() => onTail(null)}
            aria-label="Stop following this file"
            className={`${TAIL_HEADER_INK} px-1 font-mono hover:opacity-70`}
          >
            ×
          </button>
        </>
      }
    >
      <div
        ref={bodyRef}
        onScroll={onScroll}
        role="log"
        // `log` is the role, and `off` is the whole point of saying so
        // explicitly: the role implies `polite`, and a busy access log left
        // polite would read every request aloud for as long as the pane is
        // open. Off and labelled means a screen reader can be taken to it and
        // read it, rather than being read at by it.
        aria-live="off"
        aria-label={`Live tail of ${path}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box with no other keyboard route has to be focusable, or its content is reachable by pointer alone
        tabIndex={0}
        className={`${TAIL_BODY_INK} scroll-composited h-tailbody overflow-x-hidden overflow-y-auto font-mono text-caption leading-log`}
      >
        <ScrollThumbRail />
        {feed.entries.length === 0 ? (
          <p className={TAIL_NOTE_INK}>
            {feed.status === "ended" ? (feed.ended ?? "The tail ended.") : "waiting for the first line…"}
          </p>
        ) : (
          feed.entries.map((entry) => (
            <Line
              key={entry.key}
              entry={entry}
            />
          ))
        )}
      </div>
    </Frame>
  );
}

/**
 * The strip with nothing being followed: a log-looking directory, and the files
 * in it worth offering.
 *
 * It renders and it does not stream, which is the whole distinction the design
 * turns on. The candidates come from the pane's own rows, so they are already
 * fetched, filtered and sorted — asking the host a second question to build a
 * picker would be a request per navigation for a strip nobody may click.
 */
function TailPicker({
  directory,
  rows,
  onTail,
}: {
  directory: string;
  rows: readonly FileRow[];
  onTail: (path: string | null) => void;
}) {
  const candidates = rows.filter((row) => row.type === "file" && looksLikeLog(row.name));

  return (
    <Frame title={<span className="min-w-0 truncate">pick a file to follow</span>}>
      <div className={`${TAIL_NOTE_INK} flex flex-wrap gap-1 py-0.5 font-mono text-caption`}>
        {candidates.length === 0 ? (
          <p>nothing here looks like a log — right-click a file and choose “tail this file”</p>
        ) : (
          candidates.map((row) => (
            <button
              key={row.name}
              type="button"
              onClick={() => onTail(joinPath(directory, row.name))}
              className="border-pane-line text-on-pane-data hover:bg-pane-hover border px-1.5 py-0.5"
            >
              {row.name}
            </button>
          ))
        )}
      </div>
    </Frame>
  );
}

/**
 * The box itself: the mockup's ground, its accent edge, its padding and its
 * small-caps header, with whatever the two states put inside.
 *
 * Shared rather than repeated so the idle strip and the streaming one are the
 * same object growing a feed, not two boxes that have to be kept looking alike.
 */
function Frame({
  title,
  controls,
  children,
}: {
  title: React.ReactNode;
  controls?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={`${TAIL_SURFACE} border-accent mx-2.25 mb-2.25 flex-none border-l-2 px-2 py-1.75`}>
      {/* The small caps are the label's, not the header's. `tracking-caps` and
          `uppercase` on the row would take the file name with them, and
          `ACCESS.LOG` at 0.14em is not the name of anything on the host. */}
      <header className={`${TAIL_HEADER_INK} flex h-3.5 items-center gap-1.5 text-3xs leading-none`}>
        <span className="tracking-caps flex-none font-medium uppercase">live tail</span>
        <span
          aria-hidden
          className="border-pane-line h-2 flex-none border-l"
        />
        {title}
        <span className="flex-1" />
        {controls}
      </header>

      {children}
    </section>
  );
}

/** What the stream is doing, in one word, and only when it is not simply live. */
function StatusWord({ feed }: { feed: ReturnType<typeof useTail> }) {
  if (feed.status === "ended") {
    return (
      <Tooltip content={feed.ended}>
        <span className="text-log-server whitespace-nowrap">ended</span>
      </Tooltip>
    );
  }

  if (feed.status === "reconnecting") return <span className="text-log-client whitespace-nowrap">reconnecting…</span>;
  if (feed.status === "connecting") return <span className="whitespace-nowrap opacity-70">connecting…</span>;

  if (feed.warning !== null) {
    return (
      <Tooltip content={feed.warning}>
        <span className="text-log-server whitespace-nowrap">host not answering</span>
      </Tooltip>
    );
  }

  // Live and healthy says nothing at all. A row that is always occupied by the
  // word "live" teaches a reader to stop looking at it, which is the one thing
  // this slot must not do — it is where "ended" has to be noticed.
  return null;
}

/**
 * One row of the body: a line of the file, or a marker the app wrote.
 *
 * The two are visibly different on purpose. A line the app invented must never
 * be mistakable for a line the file contained, which is what the rules on
 * either side of a marker are for.
 */
function Line({ entry }: { entry: TailEntry }) {
  if (entry.kind !== "line") {
    return (
      <div
        className={`${TAIL_NOTE_INK} flex items-center gap-1.5`}
        // Markers are the app talking, and this is the one thing in the strip
        // worth announcing: a gap changes what the lines around it mean.
        role="status"
      >
        <span
          aria-hidden
          className="border-pane-line flex-1 border-t"
        />
        <span className="flex-none">{entry.text}</span>
        <span
          aria-hidden
          className="border-pane-line flex-1 border-t"
        />
      </div>
    );
  }

  const parts = splitLine(entry.text);

  return (
    // `pre-wrap` so a log's own leading indentation survives, `break-all`
    // because a line of one is a URL with nowhere to break — and without it the
    // longest line in the file sets the width of the strip and the rest of the
    // pane scrolls sideways with it.
    <div className="break-all whitespace-pre-wrap">
      {parts.head}
      {parts.status !== null && <span className={`${parts.ink} font-medium`}>{parts.status}</span>}
      {parts.tail}
    </div>
  );
}
