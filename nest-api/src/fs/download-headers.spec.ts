import { asciiFilename, contentDisposition, extendedFilename, parseRange, rangeLength } from "@fs/download-headers";

/**
 * TRE-26 §3 — the header rules, on their own.
 *
 * These are the tests that matter most in this ticket and the cheapest to run:
 * a filename is the one string in a download that the operator did not choose,
 * and it reaches the client inside a header. Everything here is a pure function
 * of a string, so every hostile name anyone has thought of can be checked
 * without a filesystem, a driver or a server.
 */

describe("the ASCII filename", () => {
  it("keeps an ordinary name intact", () => {
    expect(asciiFilename("/var/log/production.sql")).toBe("production.sql");
  });

  it("takes the last segment, never the path", () => {
    // A path in the header would leak the host's layout to anyone the file is
    // forwarded to, and a `/` inside a quoted filename is how a saved file
    // lands somewhere the browser did not mean.
    expect(asciiFilename("/etc/nginx/sites-enabled/default")).toBe("default");
  });

  it("removes the quote that would end the header early", () => {
    expect(asciiFilename('re"port.txt')).toBe("re_port.txt");
    expect(contentDisposition('re"port.txt')).not.toContain('"re"');
  });

  it("removes a semicolon, which would start a parameter of its own", () => {
    // `attachment; filename="a"; x=1.txt"` — the injected parameter is the
    // attack, and a browser that honoured it would be told something this
    // server never said.
    expect(asciiFilename('a"; x=1.txt')).toBe("a__ x_1.txt");
  });

  it("removes a newline, which would inject a whole header", () => {
    expect(asciiFilename("a\r\nSet-Cookie: x=1")).toBe("a__Set-Cookie_ x_1");
  });

  it("removes a backslash, which quoted-string escaping would swallow", () => {
    expect(asciiFilename("a\\b.txt")).toBe("a_b.txt");
  });

  it("replaces non-ASCII rather than emitting bytes a header cannot carry", () => {
    expect(asciiFilename("rapport-financier-écrit.pdf")).toBe("rapport-financier-_crit.pdf");
    expect(asciiFilename("報告書.pdf")).toBe("___.pdf");
  });

  it("never produces a dotfile, or a name that is only dots", () => {
    expect(asciiFilename(".bashrc")).toBe("bashrc");
    expect(asciiFilename("...")).toBe("download");
  });

  it("falls back rather than emitting an empty quoted string", () => {
    expect(asciiFilename("→")).toBe("_");
    expect(asciiFilename("")).toBe("download");
  });

  it("bounds the length, because a header is not a place for a 4 KB name", () => {
    expect(asciiFilename(`${"a".repeat(500)}.txt`)).toHaveLength(200);
  });
});

describe("the extended filename", () => {
  it("carries the real name, percent-encoded", () => {
    expect(extendedFilename("rapport-écrit.pdf")).toBe("rapport-%C3%A9crit.pdf");
    expect(extendedFilename("報告書.pdf")).toBe("%E5%A0%B1%E5%91%8A%E6%9B%B8.pdf");
  });

  it("escapes the apostrophe, which delimits the ext-value's three fields", () => {
    // `UTF-8''it's.txt` would parse as charset `UTF-8`, language ``, value
    // `it`, and the rest would be somebody else's problem.
    expect(extendedFilename("it's.txt")).toBe("it%27s.txt");
  });

  it("escapes the parentheses and asterisk that attr-char excludes", () => {
    expect(extendedFilename("a(1)*.txt")).toBe("a%281%29%2A.txt");
  });

  it("escapes the space, the quote and the semicolon", () => {
    expect(extendedFilename('a b";c.txt')).toBe("a%20b%22%3Bc.txt");
  });
});

describe("Content-Disposition", () => {
  it("is always an attachment — there is no inline path through this code", () => {
    expect(contentDisposition("index.html")).toMatch(/^attachment;/);
  });

  it("sends both spellings, so old clients get a name and new ones get the name", () => {
    expect(contentDisposition("rapport-écrit.pdf")).toBe(
      `attachment; filename="rapport-_crit.pdf"; filename*=UTF-8''rapport-%C3%A9crit.pdf`,
    );
  });

  it("survives a name built entirely out of header punctuation", () => {
    const header = contentDisposition('"; filename="owned.html');
    // One quoted section, one extended value, and nothing in between that a
    // parser could read as a third parameter.
    expect(header.match(/"/g)).toHaveLength(2);
    expect(header).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''[^;]*$/);
  });
});

describe("Range", () => {
  it("serves the whole file when nothing was asked for", () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: "full" });
  });

  it("reads a window, both ends inclusive", () => {
    expect(parseRange("bytes=0-499", 1000)).toEqual({ kind: "partial", range: { start: 0, end: 499 } });
    expect(rangeLength({ start: 0, end: 499 })).toBe(500);
  });

  it("reads an open end as the rest of the file", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ kind: "partial", range: { start: 500, end: 999 } });
  });

  it("reads a suffix as the last n bytes", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ kind: "partial", range: { start: 900, end: 999 } });
  });

  it("clamps a suffix longer than the file rather than refusing it", () => {
    expect(parseRange("bytes=-5000", 1000)).toEqual({ kind: "partial", range: { start: 0, end: 999 } });
  });

  it("clamps an end past the last byte, which is what every server does", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ kind: "partial", range: { start: 900, end: 999 } });
  });

  it("refuses a start past the end, and says so as 416", () => {
    expect(parseRange("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=2000-3000", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("refuses a backwards window", () => {
    // Only reachable via an explicit end below the start; the clamp above
    // cannot produce it.
    expect(parseRange("bytes=500-400", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("refuses a zero-length suffix, which names no byte at all", () => {
    expect(parseRange("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("has nothing to satisfy in an empty file", () => {
    expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("serves the whole file for a multi-range, rather than stranding the client", () => {
    // Several windows need a multipart/byteranges body, which this does not
    // produce. RFC 9110 says to ignore a Range you do not support, and a
    // resuming client copes with 200 where it would not cope with 416.
    expect(parseRange("bytes=0-9,20-29", 1000)).toEqual({ kind: "full" });
  });

  it("ignores a unit it does not understand", () => {
    expect(parseRange("items=0-9", 1000)).toEqual({ kind: "full" });
    expect(parseRange("bytes=abc-def", 1000)).toEqual({ kind: "full" });
    expect(parseRange("", 1000)).toEqual({ kind: "full" });
  });
});
