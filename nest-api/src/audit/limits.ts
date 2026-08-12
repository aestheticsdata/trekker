/**
 * The rate limits (TRE-30 §3), in one table.
 *
 * Every limit lives here rather than at its call site, so "what does this
 * install actually allow" is one file to read instead of a grep. Each is
 * overridable by an environment variable, and every one of those is optional
 * with the default below — an install that sets none of them gets these
 * numbers, which are chosen to be invisible to a person and obstructive to a
 * script.
 *
 * **Some of these have nothing to limit yet, and that is deliberate.** The
 * operations they name arrive in TRE-23, TRE-25, TRE-27 and TRE-29. They are
 * declared now because the limit and the operation should land together rather
 * than the limit being remembered afterwards, and because `TO_ATTACH` below
 * turns "remembered afterwards" into a listed obligation instead of a hope.
 */

export interface LimitRule {
  /** Redis key prefix. Stable — renaming one silently resets every counter. */
  readonly key: string;
  /** What the refusal tells the user it hit. Written for a person. */
  readonly label: string;
  readonly max: number;
  readonly windowSeconds: number;
}

function rule(key: string, label: string, max: number, windowSeconds: number, envVar: string): LimitRule {
  const override = Number.parseInt(process.env[envVar] ?? "", 10);
  return {
    key,
    label,
    max: Number.isNaN(override) || override < 1 ? max : override,
    windowSeconds,
  };
}

export const LIMITS = {
  /**
   * Adding, editing, re-pinning and deleting hosts. One shared budget: they
   * are the same capability from an attacker's side, and a per-route counter
   * would let a stolen session cycle between them and stay under all four.
   */
  hostMutation: rule("limit:host", "host changes", 30, 60, "TREKKER_LIMIT_HOST_MUTATIONS_PER_MIN"),

  /**
   * Deliberately harsh. A password change needs the current password, so a
   * burst is either an online guessing attempt against that field or a script,
   * and no human changes their password five times in an hour.
   */
  passwordChange: rule("limit:pwd", "password changes", 5, 3600, "TREKKER_LIMIT_PASSWORD_CHANGES_PER_HOUR"),

  /**
   * Paths refused by the roots allowlist (TRE-11).
   *
   * Spent inside `PathGuardService`, not by a route: refusals are decided
   * below the routing layer, and by the time the interceptor sees the 403 the
   * decision has already been made. It is the one limit in this table that a
   * `@Audited` decorator does not name.
   *
   * Counts refusals, never requests — so a person who mistypes a path twenty
   * times is stopped from mistyping a twenty-first, and every path they are
   * actually allowed to open keeps working. A burst of these is either a
   * broken client or someone walking the filesystem looking for a way out of
   * the roots; the server cannot tell which, and does not need to.
   */
  pathRefusal: rule("limit:path", "refused paths", 20, 60, "TREKKER_LIMIT_PATH_REFUSALS_PER_MIN"),
} as const satisfies Record<string, LimitRule>;

/**
 * Declared, not yet attached — each waits on the operation it governs.
 *
 * This is not documentation. `audit-coverage.spec.ts` reads it, and the
 * ticket named beside each one is the ticket that must remove its entry. An
 * unattached limit is a promise, and a promise with no expiry is how "every
 * destructive operation is rate limited" becomes true on paper only.
 */
export const TO_ATTACH = {
  fileDelete: { rule: rule("limit:rm", "deletions", 10, 60, "TREKKER_LIMIT_DELETES_PER_MIN"), ticket: "TRE-25" },
  entriesDeleted: {
    rule: rule("limit:rment", "deleted entries", 50_000, 3600, "TREKKER_LIMIT_DELETED_ENTRIES_PER_HOUR"),
    ticket: "TRE-25",
  },
  transferJobs: { rule: rule("limit:xfer", "transfers", 5, 0, "TREKKER_LIMIT_TRANSFERS_IN_FLIGHT"), ticket: "TRE-23" },
  hashJobs: { rule: rule("limit:hash", "checksum jobs", 3, 0, "TREKKER_LIMIT_HASHES_IN_FLIGHT"), ticket: "TRE-27" },
  elevation: {
    rule: rule("limit:sudo", "elevation attempts", 5, 300, "TREKKER_LIMIT_ELEVATIONS_PER_5MIN"),
    ticket: "TRE-29",
  },
} as const;
