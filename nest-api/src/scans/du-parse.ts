import { StringDecoder } from "node:string_decoder";
import type { DuRung } from "@scans/du-flavour";

/**
 * `du`'s output, turned into records as the bytes arrive (TRE-32).
 *
 * Three things here are not obvious and all three are bugs when they are
 * missing.
 *
 * **A `StringDecoder`, not `chunk.toString("utf8")`.** A chunk boundary falls
 * wherever the network put it, which is regularly in the middle of a multi-byte
 * character. `toString` on each chunk independently turns that character into
 * two replacement characters, and the path it was part of is quietly wrong —
 * for a scan, that is a rectangle labelled with a name nobody can find.
 *
 * **NUL framing where the host offers it.** A filename may contain a newline.
 * Anyone who can write into the scanned tree can `touch $'a\nb'` and, under a
 * line parser, invent a record: a size they choose against a path they choose.
 * That is not a display bug, it is somebody else deciding what the disk panel
 * says about the machine. `-0` removes the possibility outright, which is why
 * it is the first rung.
 *
 * The newline rungs below it cannot be made safe, and it is worth being plain
 * about that rather than implying otherwise. A fabricated line with a relative
 * path is refused here, and one pointing outside the scan root is refused by
 * the aggregator — but a fabricated line naming an absolute path *inside* the
 * root is indistinguishable from a real record, because the framing itself is
 * ambiguous and no shape-checking recovers it. Those rungs exist for a `du`
 * older than coreutils 8.6 (2010); on anything current, `-0` answers first and
 * they are never reached. `du-parse.spec.ts` asserts all three behaviours,
 * including the one that gets through.
 *
 * **A partial trailing record is dropped, never parsed.** The last chunk before
 * a cancel ends mid-record, and half a number is a plausible-looking number.
 */

export interface DuRecord {
  /** Already in bytes: the rung's unit has been applied. */
  bytes: bigint;
  /** Epoch milliseconds, or null on a rung whose `du` reports no time. */
  mtimeMs: number | null;
  /** Absolute path, exactly as `du` printed it. */
  path: string;
}

/**
 * `du` counts what it could not read as zero and says so on stderr, one line
 * per directory. The count is what tells somebody a total is short; the text is
 * somebody else's machine talking and is never stored.
 */
const UNREADABLE_LINE = /^du:\s+(cannot read|cannot access|cannot open|fts_read)/i;

export function countsAsUnreadable(line: string): boolean {
  return UNREADABLE_LINE.test(line);
}

/** How many of a `du` stderr's lines are "could not read this directory". */
export function countUnreadable(stderr: string): number {
  let count = 0;
  for (const line of stderr.split("\n")) {
    if (countsAsUnreadable(line.trim())) count += 1;
  }
  return count;
}

/**
 * A streaming splitter over one `du` invocation.
 *
 * Deliberately not an async iterator over the stream: the runner drives this
 * from a `for await` of its own so that it holds the backpressure, and a parser
 * that owned the loop would take that away.
 */
export class DuParser {
  private readonly decoder = new StringDecoder("utf8");
  private readonly terminator: string;
  private buffered = "";

  /** Records `du` printed that this parser could not make sense of. */
  private malformed = 0;

  constructor(private readonly rung: DuRung) {
    this.terminator = rung.nullTerminated ? "\0" : "\n";
  }

  /** Feed a chunk; get whatever complete records it completed. */
  push(chunk: Buffer): DuRecord[] {
    this.buffered += this.decoder.write(chunk);
    return this.drain();
  }

  /**
   * Flush the decoder at end of stream.
   *
   * The final record has a terminator after it on every `du` there is, so what
   * remains in the buffer here is either empty or a truncated record from a
   * cancelled walk. It is counted and dropped.
   */
  end(): DuRecord[] {
    this.buffered += this.decoder.end();
    const records = this.drain();
    if (this.buffered.trim().length > 0) this.malformed += 1;
    this.buffered = "";
    return records;
  }

  get malformedCount(): number {
    return this.malformed;
  }

  private drain(): DuRecord[] {
    const records: DuRecord[] = [];
    let start = 0;

    for (;;) {
      const end = this.buffered.indexOf(this.terminator, start);
      if (end === -1) break;

      const raw = this.buffered.slice(start, end);
      start = end + 1;

      const record = this.decode(raw);
      if (record) {
        records.push(record);
      } else if (raw.trim().length > 0) {
        this.malformed += 1;
      }
    }

    this.buffered = this.buffered.slice(start);
    return records;
  }

  /**
   * One record: `size<TAB>path`, or `size<TAB>epoch<TAB>path` where the rung
   * asked for a time.
   *
   * Split on the first tab (and the second, with a time) rather than on
   * whitespace, because a path may contain tabs as well as spaces. Everything
   * after the last structural tab is the path, whatever is in it.
   */
  private decode(raw: string): DuRecord | null {
    // A newline rung can hand us a leading fragment of a filename that itself
    // contained a newline. Such a "record" has no leading integer and is
    // dropped by the test below, which is the defence that rung has.
    const firstTab = raw.indexOf("\t");
    if (firstTab <= 0) return null;

    const size = raw.slice(0, firstTab);
    if (!/^\d+$/.test(size)) return null;

    let mtimeMs: number | null = null;
    let path: string;

    if (this.rung.hasTime) {
      const secondTab = raw.indexOf("\t", firstTab + 1);
      if (secondTab === -1) return null;
      const epoch = raw.slice(firstTab + 1, secondTab);
      if (!/^\d+$/.test(epoch)) return null;
      mtimeMs = Number(epoch) * 1000;
      path = raw.slice(secondTab + 1);
    } else {
      path = raw.slice(firstTab + 1);
    }

    // `du` prints the path it was given, and it was given an absolute one.
    // Anything else is a fragment of a filename that contained a newline.
    if (!path.startsWith("/")) return null;

    return {
      bytes: BigInt(size) * BigInt(this.rung.unitBytes),
      mtimeMs,
      path: path.replace(/\/+$/, "") || "/",
    };
  }
}
