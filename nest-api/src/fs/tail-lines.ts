import { StringDecoder } from "node:string_decoder";
import { TAIL_MAX_LINE_BYTES } from "@fs/tail-limits";

/**
 * Bytes arriving in arbitrary chunks, turned into whole lines (TRE-34 §2).
 *
 * A pure class with no I/O, which is the point: both sources hand it chunks,
 * and the spec drives it with hand-built ones — including the awkward
 * boundaries that are hard to provoke against a real host and are exactly where
 * this kind of code fails.
 *
 * **This is not log parsing.** Deciding what a line *means* is out of scope and
 * belongs to another app on the fleet. What happens here is making bytes safe
 * and legible to put in a DOM node: whole lines, valid UTF-8, no control
 * characters, and bounded length.
 */

/** One line, and whether the framer had to cut it short to produce it. */
export interface FramedLine {
  text: string;
  truncated: boolean;
}

/**
 * CSI escape sequences, as a colourised log emits them.
 *
 * Bounded quantifier, deliberately. This runs on every line of a live stream,
 * and an unbounded one here is a denial-of-service surface reachable by writing
 * a long line to a file — which is a thing log files do without being asked.
 */
// eslint-disable-next-line no-control-regex -- matching the escape character is the point
const ANSI = /\x1b\[[0-9;]{0,32}[A-Za-z]/g;

/** C0 controls and DEL, except tab — which is legitimate column alignment. */
// eslint-disable-next-line no-control-regex -- scrubbing control characters is the purpose
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

export class LineFramer {
  /**
   * One decoder for the life of the source, never one per chunk.
   *
   * A multi-byte character split across a chunk boundary is routine at 64 KiB
   * SFTP reads, and a fresh decoder per chunk turns each one into two
   * replacement characters — a corruption that appears only under load and only
   * on non-ASCII logs, which is the worst combination to debug.
   */
  private readonly decoder = new StringDecoder("utf8");

  /** Everything after the last newline, waiting for the rest of its line. */
  private partial = "";

  /**
   * Set once `partial` has outgrown the cap. Bytes are then discarded until the
   * next newline, rather than every subsequent line inheriting the overflow.
   */
  private discarding = false;

  /**
   * Whole lines from this chunk. The trailing fragment is carried, not emitted:
   * a poller reading a byte range mid-append splits a line routinely, so the
   * carry is the normal path rather than an edge case.
   */
  push(chunk: Buffer): FramedLine[] {
    const text = this.decoder.write(chunk);
    if (text.length === 0) return [];

    const lines: FramedLine[] = [];
    let start = 0;

    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) break;

      const segment = text.slice(start, newline);
      start = newline + 1;

      if (this.discarding) {
        // The rest of a line already emitted truncated. Drop it and resume.
        this.discarding = false;
        this.partial = "";
        continue;
      }

      // The cap applies to the assembled line, not merely to the carry. A
      // single chunk can hold a complete over-long line — which is the ordinary
      // case for a structured log, since the whole object is written with one
      // `write(2)` and arrives in one read.
      const line = this.partial + segment;
      this.partial = "";
      lines.push(
        line.length > TAIL_MAX_LINE_BYTES ? clean(line.slice(0, TAIL_MAX_LINE_BYTES), true) : clean(line, false),
      );
    }

    if (!this.discarding) {
      this.partial += text.slice(start);
      if (this.partial.length > TAIL_MAX_LINE_BYTES) {
        lines.push(clean(this.partial.slice(0, TAIL_MAX_LINE_BYTES), true));
        this.partial = "";
        this.discarding = true;
      }
    }

    return lines;
  }

  /**
   * The carry, if the source ended without a final newline.
   *
   * A log's last line usually has one; a file that was truncated mid-write does
   * not, and dropping it would lose the line that says why.
   */
  flush(): FramedLine[] {
    const tail = this.partial + this.decoder.end();
    this.partial = "";
    if (this.discarding || tail.length === 0) return [];
    return [clean(tail, false)];
  }

  /**
   * Forget the carry without emitting it.
   *
   * Called on rotation: the bytes held are the front of a line from a file that
   * is gone, and gluing them to the head of the new one would produce a line
   * that never existed on either.
   */
  reset(): void {
    this.partial = "";
    this.discarding = false;
  }
}

/**
 * A trailing `\r` goes first so a CRLF log does not render a stray glyph at
 * every end of line — before the control scrub, which would otherwise leave the
 * same problem having merely deleted the character.
 */
function clean(raw: string, truncated: boolean): FramedLine {
  const withoutCr = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const text = withoutCr.replace(ANSI, "").replace(CONTROLS, "");
  return { text: truncated ? `${text} …` : text, truncated };
}
