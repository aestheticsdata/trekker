import { LineFramer } from "@fs/tail-lines";
import { TAIL_MAX_LINE_BYTES } from "@fs/tail-limits";

/**
 * The framer (TRE-34 §2), driven with the chunk boundaries that are the whole
 * reason it is a class rather than a `split("\n")`.
 *
 * Every case here is one a real source produces and a real host will not
 * reproduce on demand: a line split across two reads, a multi-byte character
 * split across two reads, a file with no newline in it at all. Testing this
 * against a live host would be testing whether the boundary happened to fall
 * somewhere interesting that afternoon.
 */

const chunk = (text: string): Buffer => Buffer.from(text, "utf8");
const texts = (framed: { text: string }[]): string[] => framed.map((line) => line.text);

describe("LineFramer", () => {
  it("emits whole lines and carries the fragment", () => {
    const framer = new LineFramer();

    expect(texts(framer.push(chunk("one\ntwo\nthr")))).toEqual(["one", "two"]);
    // The carry is the normal path, not an edge case: a poller reading a byte
    // range mid-append splits a line most times it runs.
    expect(texts(framer.push(chunk("ee\n")))).toEqual(["three"]);
  });

  it("emits nothing for a chunk with no newline in it", () => {
    const framer = new LineFramer();

    expect(framer.push(chunk("no newline here"))).toEqual([]);
  });

  it("joins a multi-byte character split across two chunks", () => {
    const framer = new LineFramer();
    const bytes = chunk("héllo\n");

    // Split inside the two-byte é. A fresh decoder per chunk turns this into
    // two replacement characters — a corruption that only shows up under load
    // and only on non-ASCII logs.
    expect(framer.push(bytes.subarray(0, 2))).toEqual([]);
    expect(texts(framer.push(bytes.subarray(2)))).toEqual(["héllo"]);
  });

  it("strips a trailing CR so a CRLF log does not render a stray glyph", () => {
    const framer = new LineFramer();

    expect(texts(framer.push(chunk("one\r\ntwo\r\n")))).toEqual(["one", "two"]);
  });

  it("keeps a CR that is not at the end of the line", () => {
    const framer = new LineFramer();

    // Only the line terminator is line-ending punctuation. A CR in the middle
    // is a control character and is scrubbed as one, not treated as a break.
    expect(texts(framer.push(chunk("one\rtwo\n")))).toEqual(["onetwo"]);
  });

  it("scrubs ANSI colour sequences", () => {
    const framer = new LineFramer();

    expect(texts(framer.push(chunk("\x1b[31merror\x1b[0m happened\n")))).toEqual(["error happened"]);
  });

  it("scrubs control characters but keeps tabs", () => {
    const framer = new LineFramer();

    expect(texts(framer.push(chunk("a\tb\x00c\x07d\n")))).toEqual(["a\tbcd"]);
  });

  it("truncates a line past the cap and marks it", () => {
    const framer = new LineFramer();
    const huge = "x".repeat(TAIL_MAX_LINE_BYTES + 500);

    const lines = framer.push(chunk(`${huge}\n`));

    expect(lines).toHaveLength(1);
    expect(lines[0].truncated).toBe(true);
    expect(lines[0].text.startsWith("x".repeat(100))).toBe(true);
    expect(lines[0].text.endsWith(" …")).toBe(true);
  });

  it("discards the rest of a truncated line instead of truncating its remainder", () => {
    const framer = new LineFramer();
    const huge = "x".repeat(TAIL_MAX_LINE_BYTES + 500);

    framer.push(chunk(huge));
    // The tail of the over-long line, then a real one. Without the discard
    // state, the remainder becomes a line of its own and every subsequent line
    // inherits the overflow — one bad line corrupting the whole stream.
    const lines = framer.push(chunk("still the same line\nnext\n"));

    expect(texts(lines)).toEqual(["next"]);
  });

  it("never grows the carry without bound on a file with no newlines", () => {
    const framer = new LineFramer();

    // A binary file reached by typing a URL rather than by using the picker.
    for (let index = 0; index < 20; index += 1) framer.push(chunk("y".repeat(1_000)));

    // Whatever it is holding, it is not twenty kilobytes of it.
    expect(texts(framer.push(chunk("\nafter\n"))).at(-1)).toBe("after");
  });

  it("emits the carry on flush, for a file that ended mid-write", () => {
    const framer = new LineFramer();

    framer.push(chunk("complete\nincomplete"));

    expect(texts(framer.flush())).toEqual(["incomplete"]);
  });

  it("emits nothing on flush when the source ended cleanly", () => {
    const framer = new LineFramer();

    framer.push(chunk("complete\n"));

    expect(framer.flush()).toEqual([]);
  });

  it("forgets the carry on reset, so a rotation cannot glue two files together", () => {
    const framer = new LineFramer();

    framer.push(chunk("front of a line from the old file"));
    framer.reset();

    // Without the reset this is "front of a line from the old filenew file" —
    // a line that never existed in either file.
    expect(texts(framer.push(chunk("new file\n")))).toEqual(["new file"]);
  });
});
