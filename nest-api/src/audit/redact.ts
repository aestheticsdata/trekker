/**
 * Keeps secrets out of the audit log.
 *
 * The log records what was attempted, never the contents of anything. But an
 * audit payload is assembled from request bodies, and request bodies on this
 * app carry SSH private keys, passphrases and passwords — so "do not log
 * secrets" cannot be a rule people remember at each call site. It has to be a
 * function every payload goes through (TRE-30, Security).
 *
 * Two independent filters, because either alone has a hole:
 *
 *   - by key name, which catches `{ password: "hunter2" }`
 *   - by value shape, which catches a PEM key block sitting in a field called
 *     `blob`, where the key name gives nothing away
 *
 * Redaction replaces rather than deletes. A missing field reads as "there was
 * nothing there"; `"[redacted]"` reads as "there was something and we chose
 * not to keep it", which is the true statement and the one an operator
 * reconstructing an incident needs.
 */

/**
 * Non-capturing `(?:...)` throughout, and it has to stay that way: this
 * pattern's `source` is spliced into `SECRET_ASSIGNMENT` below, which uses a
 * backreference to match a quoted value. A capturing group here silently
 * renumbers that backreference onto a fragment of the key name, and the
 * assignment pattern then matches nothing at all — quietly, with every test
 * that only checks the key-name path still green.
 */
const SECRET_KEY =
  /pass(?:word|phrase)?|secret|token|credential|privatekey|private_key|\bkey\b|auth|cookie|session|signature|otp/i;

/** PEM blocks, JWTs, and `Bearer`/`Basic` headers, whatever they are called. */
const SECRET_VALUE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /^(Bearer|Basic)\s+\S{8,}/i,
];

export const REDACTED = "[redacted]";

/** Depth cap: a payload deep enough to hit it is malformed, not legitimate. */
const MAX_DEPTH = 6;

function isSecretValue(value: string): boolean {
  return SECRET_VALUE.some((pattern) => pattern.test(value));
}

function scrub(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (typeof value === "string") {
    return isSecretValue(value) ? REDACTED : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry, depth + 1));
  }

  // Dates, buffers and class instances stringify to something unpredictable and
  // are never worth keeping — an audit payload is plain data by construction.
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : scrub(entry, depth + 1);
  }
  return out;
}

/**
 * Everything written to `ActivityLog.payload` goes through here. Applied to
 * the whole payload rather than to the fields that look risky, so nothing has
 * to be re-decided when a new field is added to a request body.
 */
export function redact(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  return scrub(payload, 0) as Record<string, unknown>;
}

/**
 * `password: hunter2`, `secret=abc`, `token => xyz` inside free text.
 *
 * The shape a driver's error message actually takes — MySQL's "Access denied
 * for user 'x' (using password: hunter2)" is the canonical one — and the shape
 * the whole-value check below cannot see, because the secret is a fragment of
 * a longer sentence rather than the sentence itself.
 */
const SECRET_ASSIGNMENT = new RegExp(
  `\\b(${SECRET_KEY.source})\\b\\s*(?:[:=]|=>)\\s*(['"\`]?)([^\\s'"\`,;)]+)\\2`,
  "gi",
);

/**
 * Failure detail shown to an operator. Truncated to the column, and never a
 * stack trace: a stack on this app names internal paths, and an error message
 * from `ssh2` or Prisma can carry a connection string.
 *
 * **This is best-effort and cannot be otherwise.** Free text has no schema, so
 * there is no way to recognise an arbitrary secret that happens to be quoted
 * inside a sentence — only the shapes that announce themselves. The guarantee
 * that actually holds is on `payload`, where the keys are known. Treat this as
 * a net under the caller, not as permission to pass one a secret.
 */
export function redactDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;

  const single = detail.replace(/\s+/g, " ").trim();
  if (isSecretValue(single)) return REDACTED;

  const scrubbed = single.replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`);
  return scrubbed.length > 255 ? `${scrubbed.slice(0, 252)}...` : scrubbed;
}
