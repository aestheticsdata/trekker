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
 *
 * **And one of them limits nothing, ever.** `pathRefusal` counts and reports;
 * it refuses nobody. It keeps its place here because it is still a threshold
 * on a Redis counter and still spends through `RateLimitService`, and because
 * splitting it out would leave the one file that answers "what does this
 * install actually allow" no longer answering it in full. Its own comment says
 * what it does. See TRE-50.
 */

export interface LimitRule {
  /** Redis key prefix. Stable — renaming one silently resets every counter. */
  readonly key: string;
  /**
   * What the refusal tells the user it hit. Written for a person — except for
   * `pathRefusal`, which refuses nobody and whose label reaches only the
   * activity row it writes.
   */
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
   * **The one entry here that stops nobody.** It is a detector, not a limit:
   * `max` is the number of refusals within `windowSeconds` at which a single
   * `path.refused` activity row is written, and nothing else. Crossing it
   * changes no answer — a refused path returns 403 at the fiftieth attempt
   * exactly as at the first, for every account (TRE-50).
   *
   * It was a limit until TRE-50, and the reason it stopped being one is worth
   * keeping: `PathGuardService.refuse()` is only ever reached on a path the
   * guard has already decided against, so a full window never withheld
   * anything an account could otherwise have opened. It only turned that
   * path's permanent 403 into a temporary 429, which reads as the app being
   * broken rather than the directory being closed.
   *
   * Spent inside `PathGuardService`, not by a route: refusals are decided
   * below the routing layer, and by the time the interceptor sees the 403 the
   * decision has already been made. It is the one rule in this table that a
   * `@Audited` decorator does not name.
   *
   * The row is worth having because the GET routes carry no `@Audited` at all,
   * so a burst of refused listings would otherwise leave no trace. A burst is
   * either a broken client or someone walking the filesystem looking for a way
   * out of the roots; the server cannot tell which, and the row is what lets
   * somebody else decide later.
   */
  pathRefusal: rule("limit:path", "refused paths", 20, 60, "TREKKER_LIMIT_PATH_REFUSALS_PER_MIN"),

  /**
   * chmod and chown (TRE-21), sharing one budget the way the host mutations do
   * — they are one capability from an attacker's side, and a script that walks
   * a filesystem making everything world-writable alternates between them.
   *
   * Per request, not per entry: one recursive call may change ten thousand
   * files, which is what the entry ceiling is for. This counter bounds how many
   * times someone may aim that, and 20 a minute is far past deliberate use.
   */
  permissionChange: rule("limit:perm", "permission changes", 20, 60, "TREKKER_LIMIT_PERMISSION_CHANGES_PER_MIN"),

  /**
   * Renames (TRE-22), single and by pattern, on one budget.
   *
   * Per request, like the permission changes above and for the same reason:
   * one batch may rename a thousand entries, and what this bounds is how often
   * someone may aim one. Higher than 20 because a single rename is also an
   * ordinary editing gesture — F2, type, enter — and a person tidying a
   * directory does that a dozen times in a minute without meaning anything by it.
   *
   * It is here rather than in `TO_ATTACH` because the routes it governs land in
   * the same change. There is no window where this is a promise.
   */
  rename: rule("limit:mv", "renames", 60, 60, "TREKKER_LIMIT_RENAMES_PER_MIN"),
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
