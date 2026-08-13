import { createHmac, timingSafeEqual } from "node:crypto";

import type { MasterKey } from "@secrets/master-key";

/**
 * The token a signed link carries (TRE-66), signed and checked.
 *
 * Pure, and its own file, because this is the part where being wrong is
 * expensive and testable: everything below is a function of a string and a key,
 * so every way a token can be tampered with can be tried in a unit test rather
 * than reasoned about.
 *
 * **Stateless on purpose.** Nothing about an issued link is stored. The token
 * *is* the grant — it carries the host, the path, the expiry and who issued it,
 * and the signature is what makes those four unforgeable. A table of issued
 * links would buy per-link revocation and cost a row, an index and a cleanup
 * job for a feature whose whole point is that it expires by itself. Withdrawing
 * one early is done by rotating the key, which withdraws all of them; that is a
 * blunt instrument and it is the honest one for a URL that has already been
 * forwarded to somebody you cannot ask to forget it.
 */

/** What a link grants. Everything in it is covered by the signature. */
export interface LinkClaims {
  /** Key version, so a rotated key refuses with a sentence rather than a shrug. */
  v: number;
  /** Host id. */
  h: string;
  /** The path, exactly one. */
  p: string;
  /** Expiry, seconds since the epoch. */
  e: number;
  /** The account that issued it, which is the account the use is logged against. */
  u: string;
}

export type LinkVerdict =
  { ok: true; claims: LinkClaims } | { ok: false; reason: "malformed" | "signature" | "rotated" | "expired" };

/**
 * `<payload>.<signature>`, both base64url.
 *
 * base64url and not base64: this goes in a URL, and `+` and `/` do not survive
 * one intact. A dot separates them because it is not in the base64url alphabet,
 * so the split can never be ambiguous.
 */
export function signLink(claims: LinkClaims, key: MasterKey): string {
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${sign(payload, key)}`;
}

/**
 * Check a token, in an order chosen so nothing is learned from a refusal that
 * the signature has not already vouched for.
 *
 * The signature is verified **before** the payload is parsed and before the
 * expiry is read. Reading the claims first would mean answering questions about
 * a document nobody has authenticated — and "expired" on a forged token tells
 * the forger their structure was right, which is one bit more than they should
 * get.
 */
export function verifyLink(token: string, key: MasterKey, nowSeconds: number): LinkVerdict {
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) return { ok: false, reason: "malformed" };

  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  if (!constantTimeEqual(provided, sign(payload, key))) {
    // One answer for a wrong signature, whatever was wrong about it. A token
    // signed with the retired key is indistinguishable from a forged one at
    // this point, which is why the version is read below rather than here.
    const claims = parse(payload);
    if (claims !== null && claims.v !== key.version) return { ok: false, reason: "rotated" };
    return { ok: false, reason: "signature" };
  }

  const claims = parse(payload);
  if (claims === null) return { ok: false, reason: "malformed" };
  if (claims.v !== key.version) return { ok: false, reason: "rotated" };
  if (claims.e <= nowSeconds) return { ok: false, reason: "expired" };

  return { ok: true, claims };
}

/** What a refusal says out loud. Never more specific than it has to be. */
export function refusalMessage(reason: Exclude<LinkVerdict, { ok: true }>["reason"]): string {
  switch (reason) {
    case "expired":
      return "This link has expired. Ask whoever sent it for a new one.";
    case "rotated":
      return "This link was signed with a key that is no longer in use. Ask whoever sent it for a new one.";
    default:
      // `malformed` and `signature` answer identically. A tampered token and a
      // truncated one are the same event from here — somebody sent something
      // this server did not issue — and telling them which is which is telling
      // them how close they got.
      return "This link is not valid.";
  }
}

function sign(payload: string, key: MasterKey): string {
  return createHmac("sha256", key.key).update(payload).digest("base64url");
}

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function parse(payload: string): LinkClaims | null {
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<LinkClaims>;
    if (
      typeof decoded.v !== "number" ||
      typeof decoded.h !== "string" ||
      typeof decoded.p !== "string" ||
      typeof decoded.e !== "number" ||
      typeof decoded.u !== "string"
    ) {
      return null;
    }
    return { v: decoded.v, h: decoded.h, p: decoded.p, e: decoded.e, u: decoded.u };
  } catch {
    return null;
  }
}

/**
 * Compared in constant time, and length-checked first because `timingSafeEqual`
 * throws on a mismatch rather than returning false. The house pattern —
 * `secretsEqual` and `timingSafeTokenCompare` are the same three lines.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
