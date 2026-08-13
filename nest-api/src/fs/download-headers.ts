/**
 * The headers a download is served with (TRE-26 §3), and the parsing of the one
 * header it accepts.
 *
 * Its own file, and pure, for two reasons. It is the security surface of the
 * download — a filename reaches the client through a header, which is the one
 * place in this application where a string the operator does not control gets
 * to influence how the browser behaves — and it is shared by the session route
 * here and the tokened one in TRE-66, which must not be allowed to drift into
 * two different ideas of what is safe.
 *
 * Nothing here touches a driver, a request or a response. Every rule below is a
 * function of a string, which is what makes them testable without a filesystem.
 */

/**
 * Always `attachment`, and never a type a browser will render.
 *
 * The ticket asks for "the right Content-Type", and this deliberately does not
 * give one. `attachment` alone is enough in every browser shipping today, and
 * `nosniff` is enough again — but the property being defended is that a file
 * this application serves *cannot* execute on this application's origin, and a
 * property that rests on a header being honoured is a property with a date on
 * it. An HTML file downloaded as `text/html` is one disposition-parsing bug
 * away from stored XSS against every session; downloaded as an opaque byte
 * stream it is a file on a disk.
 *
 * What it costs is inline preview, which this route never wanted: the toolbar
 * downloads, and the inspector's "open in →" is a different feature. What it
 * buys is that TRE-66 can hand a URL to somebody outside the app without that
 * URL being a way to run script here.
 */
export const DOWNLOAD_CONTENT_TYPE = "application/octet-stream";

/**
 * Belt to the disposition's braces. `default-src 'none'` leaves a page served
 * from this route unable to load anything at all, and `sandbox` with no
 * allowances denies it scripts, forms, popups and its own origin.
 *
 * A CSP on a downloaded file is mostly inert — the browser applies it to a
 * document, and an attachment never becomes one. It is here for the case where
 * that is not true: a browser that ignores the disposition, an extension that
 * re-serves the body, a future `inline` route added by someone reading this
 * file for the parts they wanted.
 */
export const DOWNLOAD_CSP = "default-src 'none'; sandbox";

/** What a name reduces to when nothing survives sanitising. */
const FALLBACK_NAME = "download";

/**
 * Characters allowed in the quoted ASCII filename.
 *
 * An allowlist, not a denylist. The header is `attachment; filename="…"`, so
 * the characters that break it are the quote and the backslash — but a
 * semicolon, a comma, a newline or a control byte each end or extend the header
 * in some parser somewhere, and the set of parsers is not enumerable. Letters,
 * digits and a handful of punctuation is every filename anyone will notice
 * losing, and the `filename*` beside it carries the real one anyway.
 */
const SAFE_ASCII = /[^A-Za-z0-9._ -]/g;

/**
 * The name as `filename=` can carry it: ASCII, quoted, and unable to end the
 * header early.
 *
 * Leading dots are stripped rather than kept. `.bashrc` arriving as `bashrc` is
 * a small lie about the name; a downloaded file called `..` or `.` is a bigger
 * one about what it is, and this is the fallback — `filename*` below has the
 * truth for every client written after 2011.
 */
export function asciiFilename(name: string): string {
  const cleaned = basename(name).replace(SAFE_ASCII, "_").replace(/^\.+/, "").trim();
  return cleaned.length === 0 ? FALLBACK_NAME : cleaned.slice(0, 200);
}

/**
 * RFC 5987 `ext-value`: percent-encoded UTF-8, with the attribute characters
 * left alone.
 *
 * `encodeURIComponent` is the right primitive and not quite the right rule — it
 * leaves `!`, `'`, `(`, `)` and `*` unescaped, and RFC 5987's `attr-char` does
 * not include `'`, `(`, `)` or `*`. The quote matters most: it is the delimiter
 * of the `charset'lang'value` form, so a filename containing one would split
 * the value into pieces the client reassembles wrongly.
 */
export function extendedFilename(name: string): string {
  return encodeURIComponent(basename(name)).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `Content-Disposition`, both spellings of the name (RFC 6266 §4.3).
 *
 * Both, always, in that order: a client that understands `filename*` uses it
 * and ignores the quoted one, and a client that does not gets something
 * readable rather than nothing. Sending only the extended form loses the name
 * on old clients; sending only the quoted form loses every non-Latin name.
 */
export function contentDisposition(name: string): string {
  return `attachment; filename="${asciiFilename(name)}"; filename*=UTF-8''${extendedFilename(name)}`;
}

/** The last segment. Never used to build a path — only to name a download. */
export function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** A byte window, inclusive at both ends, exactly as HTTP means it. */
export interface ByteRange {
  start: number;
  end: number;
}

export type RangeVerdict =
  /** No range asked for, or one this server does not implement. Serve it all. */
  | { kind: "full" }
  | { kind: "partial"; range: ByteRange }
  /** Asked for, understood, and entirely past the end of the file. */
  | { kind: "unsatisfiable" };

/**
 * `Range: bytes=…` (RFC 9110 §14).
 *
 * Three forms are understood and a fourth is deliberately not:
 *
 * - `bytes=0-499` — a window.
 * - `bytes=500-` — from there to the end.
 * - `bytes=-500` — the last 500 bytes.
 * - `bytes=0-9,20-29` — several windows, which would need a
 *   `multipart/byteranges` body. Answered as `full`, which is what the spec
 *   says to do with a range you do not support and is also the behaviour a
 *   resuming client can cope with. Refusing would strand it.
 *
 * A zero-length file has no satisfiable range at all, so any range against one
 * is `unsatisfiable` — including `bytes=0-`, which reads as satisfiable right
 * up until you try to name the last byte.
 */
export function parseRange(header: string | undefined, size: number): RangeVerdict {
  if (header === undefined) return { kind: "full" };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return { kind: "full" };

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { kind: "full" };
  if (size === 0) return { kind: "unsatisfiable" };

  if (rawStart === "") {
    // Suffix form. A suffix longer than the file is not an error — it means
    // "all of it", which is what clamping to 0 gives.
    const wanted = Number.parseInt(rawEnd, 10);
    if (wanted === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", range: { start: Math.max(size - wanted, 0), end: size - 1 } };
  }

  const start = Number.parseInt(rawStart, 10);
  if (start >= size) return { kind: "unsatisfiable" };

  // An end past the last byte is clamped rather than refused: a client that
  // asks for more than exists is asking for the rest, and every server on the
  // web reads it that way.
  const end = rawEnd === "" ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1);
  if (end < start) return { kind: "unsatisfiable" };

  return { kind: "partial", range: { start, end } };
}

/** Bytes in a window, both ends inclusive. */
export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}
