import { createHmac } from "node:crypto";
import { type LinkClaims, refusalMessage, signLink, verifyLink } from "@fs/download-link";
import { LINK_KEY_VAR } from "@secrets/link-key";
import { MASTER_KEY_VAR, parseMasterKey } from "@secrets/master-key";

import type { MasterKey } from "@secrets/master-key";

/**
 * TRE-66 — the token, on its own.
 *
 * This is the file where being wrong is expensive: the signature is the entire
 * access control on a route that has no session, so every way a token can be
 * altered is worth trying rather than reasoning about. All of it is a pure
 * function of a string and a key, so all of it can be.
 */

const KEY: MasterKey = { version: 1, key: Buffer.alloc(32, 1) };
const OTHER_KEY: MasterKey = { version: 1, key: Buffer.alloc(32, 2) };
const ROTATED: MasterKey = { version: 2, key: Buffer.alloc(32, 3) };

const NOW = 1_700_000_000;
const CLAIMS: LinkClaims = { v: 1, h: "host-1", p: "/srv/data/report.pdf", e: NOW + 900, u: "user-1" };

/** A token with one claim changed, re-encoded but signed with nothing. */
function tampered(change: Partial<LinkClaims>): string {
  const forged = Buffer.from(JSON.stringify({ ...CLAIMS, ...change }), "utf8").toString("base64url");
  return `${forged}.${signLink(CLAIMS, KEY).split(".")[1]}`;
}

describe("signing", () => {
  it("round-trips every claim", () => {
    const verdict = verifyLink(signLink(CLAIMS, KEY), KEY, NOW);
    expect(verdict).toEqual({ ok: true, claims: CLAIMS });
  });

  it("produces something a URL can carry", () => {
    // base64url, not base64: `+` and `/` do not survive a URL path segment, and
    // a token that arrives re-encoded is a token that fails to verify for a
    // reason nobody will find.
    expect(signLink(CLAIMS, KEY)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("gives two different files two different tokens", () => {
    const other = signLink({ ...CLAIMS, p: "/srv/data/other.pdf" }, KEY);
    expect(other).not.toBe(signLink(CLAIMS, KEY));
  });
});

describe("tampering", () => {
  it("refuses a changed path — the grant is one file and this is that claim", () => {
    expect(verifyLink(tampered({ p: "/etc/shadow" }), KEY, NOW)).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a changed host", () => {
    expect(verifyLink(tampered({ h: "host-2" }), KEY, NOW)).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a changed issuing user — the roots are theirs", () => {
    // The most valuable forgery available: the path is checked against the
    // *issuer's* roots, so swapping the user id would be swapping whose
    // filesystem the link can reach.
    expect(verifyLink(tampered({ u: "owner-account" }), KEY, NOW)).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses an extended expiry", () => {
    expect(verifyLink(tampered({ e: NOW + 10_000_000 }), KEY, NOW)).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a token signed with a different key of the same version", () => {
    expect(verifyLink(signLink(CLAIMS, OTHER_KEY), KEY, NOW)).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a truncated signature", () => {
    const token = signLink(CLAIMS, KEY);
    expect(verifyLink(token.slice(0, -4), KEY, NOW).ok).toBe(false);
  });

  it("refuses a token with no signature at all", () => {
    const payload = signLink(CLAIMS, KEY).split(".")[0];
    expect(verifyLink(payload, KEY, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyLink(`${payload}.`, KEY, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses rubbish without throwing", () => {
    for (const rubbish of ["", ".", "..", "a.b", "%%%.%%%", "null.null"]) {
      expect(verifyLink(rubbish, KEY, NOW).ok).toBe(false);
    }
  });

  it("refuses a correctly-signed payload that is not a claims object", () => {
    // The signature genuinely passes here — the HMAC is computed with the real
    // key over the real payload — so the only thing left to refuse it is the
    // shape check after the parse. Without that, a `p` of `undefined` would
    // reach the guard as a path.
    for (const junk of [{ hello: "world" }, { ...CLAIMS, p: 42 }, { ...CLAIMS, e: "soon" }, null, "a string"]) {
      const payload = Buffer.from(JSON.stringify(junk), "utf8").toString("base64url");
      const signature = createHmac("sha256", KEY.key).update(payload).digest("base64url");
      expect(verifyLink(`${payload}.${signature}`, KEY, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
  });
});

describe("expiry", () => {
  it("refuses a token whose moment has passed", () => {
    expect(verifyLink(signLink(CLAIMS, KEY), KEY, CLAIMS.e + 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses one at exactly its expiry, rather than one second past it", () => {
    expect(verifyLink(signLink(CLAIMS, KEY), KEY, CLAIMS.e)).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts one a second before", () => {
    expect(verifyLink(signLink(CLAIMS, KEY), KEY, CLAIMS.e - 1).ok).toBe(true);
  });
});

describe("rotation", () => {
  it("invalidates every outstanding link, which is how one is withdrawn", () => {
    const issued = signLink(CLAIMS, KEY);
    expect(verifyLink(issued, ROTATED, NOW)).toEqual({ ok: false, reason: "rotated" });
  });

  it("says so, because a link that stopped working needs an explanation", () => {
    expect(refusalMessage("rotated")).toContain("no longer in use");
  });

  it("tells a forger nothing — malformed and forged read alike", () => {
    expect(refusalMessage("malformed")).toBe(refusalMessage("signature"));
  });
});

describe("the key itself", () => {
  it("is parsed by the credential key's own parser, so one format cannot drift from two", () => {
    const raw = `1:${Buffer.alloc(32, 4).toString("base64")}`;
    expect(parseMasterKey(raw, LINK_KEY_VAR)).toEqual({ version: 1, key: Buffer.alloc(32, 4) });
  });

  it("refuses a short key, naming the link variable rather than the credential one", () => {
    expect(() => parseMasterKey(`1:${Buffer.alloc(16).toString("base64")}`, LINK_KEY_VAR)).toThrow(LINK_KEY_VAR);
  });

  it("refuses the placeholder, and refuses being absent", () => {
    expect(() => parseMasterKey("REPLACE_ME", LINK_KEY_VAR)).toThrow(LINK_KEY_VAR);
    expect(() => parseMasterKey(undefined, LINK_KEY_VAR)).toThrow(LINK_KEY_VAR);
  });

  it("is a different variable from the one that seals credentials", () => {
    // The whole ticket in one assertion. If these two names ever converge, a
    // feature that signs attacker-chosen messages is doing it with the key that
    // decrypts every SSH credential in the install.
    expect(LINK_KEY_VAR).not.toBe(MASTER_KEY_VAR);
  });
});
