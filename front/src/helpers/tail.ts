/**
 * The live tail's surface, its inks, and the two questions about a path that
 * decide whether the strip offers itself at all (TRE-34).
 *
 * Here rather than in the component for the same reason `tooltip.ts` is:
 * `scripts/verify-contrast.ts` measures these, and Node runs that script
 * directly — it can strip types, but not JSX. Importing them from the `.tsx`
 * would end the check, and a check with its own copy of the palette is a check
 * of the copy.
 */

/**
 * The strip's ground: one depth below the listing it takes its space from.
 *
 * Every ink below is measured against this and nothing else. The strip does not
 * change colour with the pane — an active pane and an idle one draw the same
 * tail — so there is one surface here and one set of numbers, unlike the five a
 * row can be.
 */
export const TAIL_SURFACE = "bg-pane-sunk";

/** The small caps header: which file, and what the stream is doing. */
export const TAIL_HEADER_INK = "text-on-pane-label";
/** The log itself. Mono, because a log is data and its columns should line up. */
export const TAIL_BODY_INK = "text-on-pane-data";
/**
 * The strip's own asides — a gap marker, a rotation marker, the idle picker's
 * explanation. Deliberately not the body ink: these are the app talking, and a
 * line the app wrote must not be mistakable for a line the file contained.
 *
 * The same token as the header, and that is the point rather than an accident:
 * the app has one voice in this box, and everything it says itself is that
 * colour while everything the file said is the body's.
 *
 * It was `--color-on-pane-muted` first, which is this app's ordinary ink for a
 * quiet line. It cleared AA on the pane at 4.74:1 and, one step down onto the
 * sunk ground, measured 4.35:1 and did not — the exact failure the surface was
 * documented as causing, walked into within an hour of documenting it, and
 * caught by `pnpm verify:contrast` rather than by looking.
 *
 * TRE-82 then darkened `muted` until it cleared the pane's furniture bars, and
 * it clears the sunk ground on the way past, at 5.03:1. So the number no longer
 * decides this and the paragraph above does: one box, one voice.
 */
export const TAIL_NOTE_INK = "text-on-pane-label";

/**
 * The strip's two header buttons — `retry`, and the one offering to follow the
 * end again.
 *
 * **Not `bg-accent` with `text-on-accent`,** which is what this app reached for
 * when something was the thing to press, and which measures 3.62:1. That pair
 * was under AA wherever it was used and would have been under AA here at 8.5px,
 * which is the smallest type in the application. `--color-accent` is an awkward
 * mid-blue with nothing clearing 4.5:1 against it in either direction — the
 * lightest ink in the palette reaches 4.08 — so the fix was a different fill
 * rather than a different ink.
 *
 * TRE-78 has since made that fix everywhere else: `PRESS` in `helpers/press.ts`
 * is `--color-accent-fill` at 7.09:1, and it is what a filled control in the
 * chrome wears now. This strip keeps its own pair regardless, because it is not
 * in the chrome — it sits on a pane that has inverted to light, where a fill
 * bright enough to carry dark ink would be the brightest thing on the strip.
 *
 * A chip in the app's own dark surface, on a pane that has inverted to light,
 * is this design's plainest way of saying "control" anyway. And the accent is
 * still in the strip: it is the edge down its left side.
 */
export const TAIL_BUTTON_FILL = "bg-app";
export const TAIL_BUTTON_INK = "text-ink";

/**
 * A status code's class, and the ink it is drawn in.
 *
 * Three classes rather than five: 1xx never appears in an access log worth
 * reading, and 3xx is a request that was served, so it shares the ink with 2xx
 * exactly as the mockup draws it.
 */
export type StatusClass = "ok" | "client" | "server";

export const STATUS_INK: Readonly<Record<StatusClass, string>> = {
  ok: "text-log-ok",
  client: "text-log-client",
  server: "text-log-server",
};

/**
 * What the mockup shipped, kept so `verify:contrast` can print it.
 *
 * All three fail AA on `TAIL_SURFACE`, which is why the tokens above are not
 * them. Printing the numbers is what keeps that a measurement rather than a
 * preference — the same treatment the treemap's ramp already gets.
 */
export const MOCKUP_STATUS_HEX: Readonly<Record<StatusClass, string>> = {
  ok: "#2f7a4a",
  client: "#1c4a68",
  server: "#aa3333",
};

/** One line of a tail, already framed by the server, split for rendering. */
export interface TailLine {
  /** Everything before the status code, or the whole line when there is none. */
  head: string;
  /** The three digits, or null when this line is not an access-log request. */
  status: string | null;
  tail: string;
  ink: string | null;
}

/**
 * The status code in a common- or combined-format access log line.
 *
 * **This is not log parsing**, and the bound is deliberate: the line is not
 * split into fields, nothing is interpreted, and a line that does not match
 * this one shape is rendered exactly as it arrived. What it does is find the
 * three digits that follow the quoted request — the one token in an access log
 * whose position is fixed by both formats — so that a 502 can be seen without
 * being read.
 *
 *   127.0.0.1 - - [21/Aug/2026:10:00:00 +0000] "GET /x HTTP/1.1" 502 1234
 *                                              ^^^^^^^^^^^^^^^^  ^^^
 *
 * The quoted request is what anchors it. Matching a bare three-digit run would
 * colour the port in `127.0.0.1:443`, the year in a date, and the size of a
 * 404-byte response — three false positives on the commonest line there is.
 *
 * Lazy rather than greedy, which matters on the combined format: that line
 * carries three quoted fields, and a greedy `.*` starts from the user agent and
 * backtracks its way left. It arrives at the same answer and it does so by
 * walking the line — on a 8 KiB one, per line, on a live stream. Lazy finds the
 * first quoted field with three digits after it, which is the request, first.
 */
const ACCESS_LOG = /^(.*?"[^"]*"\s+)(\d{3})(\s|$)/;

export function splitLine(line: string): TailLine {
  const match = ACCESS_LOG.exec(line);
  if (match === null) return { head: line, status: null, tail: "", ink: null };

  const status = match[2];
  return {
    head: match[1],
    status,
    tail: line.slice(match[1].length + status.length),
    ink: STATUS_INK[statusClass(status)],
  };
}

export function statusClass(status: string): StatusClass {
  if (status.startsWith("5")) return "server";
  if (status.startsWith("4")) return "client";
  return "ok";
}

/**
 * Whether this directory is one the strip should offer itself in.
 *
 * `/var/log` and anything under it, or any path with a segment called `log` or
 * `logs` — which covers `/srv/app/logs`, `~/logs` and a container's
 * `/opt/thing/log` without needing to know about any of them.
 *
 * It decides whether the strip *renders*, never whether it *streams*. Opening a
 * connection to somebody's server because they navigated into a directory is
 * the kind of helpfulness people uninstall software over, and guessing which of
 * eleven files in `/var/log` was meant would be wrong most of the time. So a
 * match offers a picker and nothing else; the stream starts when a file is
 * picked, and the pick is what goes in the URL.
 */
export function isLogDirectory(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments[0] === "var" && segments[1] === "log") return true;
  return segments.some((segment) => segment === "log" || segment === "logs");
}

/**
 * The log files whose names say nothing about being logs.
 *
 * A pattern cannot reach these — `syslog` has no separator before its `log`,
 * and `messages` has no `log` in it at all — and they are the two files most
 * likely to be the reason somebody opened `/var/log` in the first place. A
 * short list of the ones that actually exist beats a looser pattern that would
 * also offer `blog.txt` and `logrotate.conf`.
 */
const KNOWN_LOGS = new Set(["syslog", "messages", "dmesg", "lastlog", "faillog"]);

/**
 * Whether the picker should offer this name.
 *
 * Rotated files are offered too — `access.log.1` is the one somebody reaches
 * for when the question is "what happened last night" — except that a
 * compressed one is named and not offered, because tailing gzip shows the
 * reader a screenful of binary that the framer has already scrubbed into
 * nothing.
 *
 * Deliberately not exhaustive. It decides what the strip *offers*, and the
 * context menu follows any file at all — so a name this misses costs a
 * right-click, while a name it wrongly matches puts a config file in a picker
 * of logs. Wrong in the second direction is the more expensive one.
 */
export function looksLikeLog(name: string): boolean {
  if (/\.(gz|bz2|xz|zst|zip)$/i.test(name)) return false;
  if (KNOWN_LOGS.has(name.toLowerCase().replace(/\.\d+$/, ""))) return true;
  return /(^|[._-])log($|[._-])/i.test(name) || /\.(log|out|err)(\.\d+)?$/i.test(name);
}
