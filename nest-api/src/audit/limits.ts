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
 * **Every limit here is attached to something.** Some were not, once: a limit
 * and the operation it governs should land together, so one declared ahead of
 * its operation goes into `TO_ATTACH` below, which turns "remembered
 * afterwards" into a listed obligation instead of a hope. It works, and it has
 * now run to completion — TRE-23, TRE-25, TRE-29 and TRE-27 were all on that
 * list and all came off it, which is why it is currently empty.
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

  /**
   * New directories and new empty files (TRE-69), on one budget.
   *
   * Per request, and the same number as the renames above for the same reason:
   * making a folder is an ordinary editing gesture, and somebody laying out a
   * project does it several times in a minute without meaning anything by it.
   *
   * Neither route is destructive — `create` cannot truncate and `mkdir` cannot
   * replace — so the coverage spec does not demand a limit here. It is attached
   * anyway: these are the two routes that let a session write entries onto
   * another machine's filesystem without sending any bytes, and "not
   * destructive" is not the same as "worth leaving unbounded".
   */
  entryCreate: rule("limit:mk", "new entries", 60, 60, "TREKKER_LIMIT_CREATES_PER_MIN"),

  /**
   * Deletes (TRE-25), per request. Ten a minute: harsher than the renames above
   * because this is the operation with no undo, and nobody deletes deliberately
   * ten times in a minute.
   */
  fileDelete: rule("limit:rm", "deletions", 10, 60, "TREKKER_LIMIT_DELETES_PER_MIN"),

  /**
   * Deleted entries (TRE-25), per hour — the one rule in this table spent in
   * something other than requests.
   *
   * `fileDelete` above bounds how often someone may aim a delete; this bounds
   * how much it may take. They are different questions: ten requests a minute
   * is a reasonable ceiling on gestures and a catastrophic one on entries, and
   * a session that has removed fifty thousand files in an hour is either a
   * migration nobody told us about or a session that is not being driven by its
   * owner.
   *
   * Spent inside `DeleteService.remove`, in units, before anything is removed,
   * so a refusal costs nothing.
   */
  entriesDeleted: rule("limit:rment", "deleted entries", 50_000, 3600, "TREKKER_LIMIT_DELETED_ENTRIES_PER_HOUR"),

  /**
   * Downloads (TRE-26), per request. The one limit here on a route that changes
   * nothing.
   *
   * Per request rather than per byte, deliberately. A download can only take
   * what the account could already open — the roots decided that long before
   * this counter is asked — so there is no volume to ration that the roots have
   * not already granted. What is worth bounding is the *rate*, because a
   * session walking a fleet and pulling every directory it can reach is a
   * script, and a script is what the number is chosen against: 120 a minute is
   * far past a person clicking files and well short of one enumerating them.
   *
   * A byte budget belongs to TRE-66. Those URLs carry no session and can be
   * forwarded to anyone, so "how much may this link move" stops being a
   * question the roots have already answered.
   *
   * Spent inside `DownloadService.plan`, not by a route: the audit interceptor
   * looks at the mutating verbs only, so a GET has nowhere to declare one.
   */
  download: rule("limit:dl", "downloads", 120, 60, "TREKKER_LIMIT_DOWNLOADS_PER_MIN"),

  /**
   * Uploads (TRE-65), per request. Harsher than the downloads above because
   * this one writes: a download can only take what the roots already granted,
   * while an upload consumes somebody's disk, and the two are not symmetrical
   * however much the routes look it.
   */
  upload: rule("limit:up", "uploads", 30, 60, "TREKKER_LIMIT_UPLOADS_PER_MIN"),

  /**
   * Uploaded bytes (TRE-65), per hour, in 64 MiB units.
   *
   * The second limit this table needs and the reason is arithmetic: the
   * per-request limit above allows thirty uploads a minute and the per-file
   * ceiling allows ten gigabytes each, which multiplies to a number that fills
   * any disk in the fleet within the hour. One of those two bounds has to be on
   * volume or neither of them is.
   *
   * In units rather than bytes because a `max` counted in bytes would be a
   * fourteen-digit number in this table, and because sixty-four megabytes is
   * about a second of transfer — fine enough to be enforcement, coarse enough
   * that a long upload is a handful of Redis calls rather than one per chunk.
   *
   * Spent inside `UploadService.receive`, from the bytes actually received. The
   * declared `Content-Length` is never charged against it: a client that lies
   * about the header would otherwise be able to exhaust somebody else's budget
   * without sending anything.
   */
  uploadedBytes: rule("limit:upvol", "uploaded data", 800, 3600, "TREKKER_LIMIT_UPLOAD_UNITS_PER_HOUR"),

  /**
   * Signed-link fetches (TRE-66) — **the only rule here scoped to an IP.**
   *
   * Every other counter in this table is spent per user, and the comment on
   * `pathRefusal` explains why: a per-session limit is no limit at all when
   * signing in again mints a new one. A signed link has neither a session nor a
   * user, which is the point of it, so the IP is the only handle there is.
   *
   * That makes it a weaker control than the rest and it is worth saying so:
   * anyone with several addresses has several budgets. It is not an identity
   * check. What it bounds is one stranger hammering one URL, and what actually
   * makes the grant safe is its narrowness — one path, read only, expiring.
   *
   * Spent inside `LinkService.redeem`, before the token is even parsed, so
   * guessing at tokens costs the guesser the same as using a real one.
   */
  signedLink: rule("limit:link", "signed-link fetches", 60, 60, "TREKKER_LIMIT_LINK_FETCHES_PER_MIN"),

  /**
   * Transfers started (TRE-23), per minute — copies, moves and retries on one
   * budget, because they are one capability and a retry re-runs the same work.
   *
   * **This entry changed meaning when it moved out of `TO_ATTACH`, and that is
   * worth writing down.** It was declared there as an in-flight cap: `max: 5`,
   * `windowSeconds: 0`, "how many jobs may run at once". That is not something
   * this table can express. Every rule here is a fixed window on a Redis
   * counter, and a window of zero seconds is a key that expires instantly — the
   * counter would reset between the check and the next request and refuse
   * nobody, ever. Worse, it would refuse nobody while sitting in the live table
   * looking exactly like a rule that works, which is the failure the
   * "no unspent limit" test in `audit-coverage.spec.ts` exists to catch.
   *
   * So the two questions were separated. **How often may somebody start one**
   * is a rate and lives here. **How many may run at once** is a queue depth and
   * lives in `TransferQueueService` as `MAX_IN_FLIGHT`, enforced by not
   * dequeuing a seventh job rather than by refusing a request — a queued
   * transfer is the right answer to a busy server, and a 429 is not.
   *
   * Twenty a minute: far past deliberate use, and deliberately above the
   * in-flight cap so that a person queueing several directories in a row meets
   * the queue rather than this.
   */
  transferJobs: rule("limit:xfer", "transfers started", 20, 60, "TREKKER_LIMIT_TRANSFERS_PER_MIN"),

  /**
   * Disk scans started (TRE-32), per hour rather than per minute — the only
   * rule here whose window is not measured against a burst.
   *
   * A scan takes minutes, and almost everything about how often one can happen
   * is already decided by things this table cannot express: one per host at a
   * time, held by a unique index; two in flight across the process, held by the
   * queue; and two SSH slots per host that a scan may never take. What is left
   * for a rate limit is somebody pointing a script at a fleet and queueing a
   * hundred roots, and against that a minute-long window would be the wrong
   * shape — a scan an hour apart on twenty hosts is ordinary use, and twenty
   * inside a minute on one host is not something the counter would ever see,
   * because the unique index refuses the second one first.
   *
   * It is here rather than in `TO_ATTACH` because the route it governs lands in
   * the same change, so there is no window in which this is a promise.
   */
  diskScan: rule("limit:scan", "disk scans", 20, 3600, "TREKKER_LIMIT_SCANS_PER_HOUR"),

  /**
   * Attempts to open a sudo window (TRE-29), per five minutes.
   *
   * **This one guards a password field, which makes it different from every
   * other rule here.** The rest bound how often an authenticated session may
   * aim an operation it is already allowed to perform. This bounds guessing:
   * the route takes the host account's login password and hands it to `sudo`,
   * so without a ceiling a stolen session is an online brute-force oracle
   * against the machine's root, one request at a time, with the answer coming
   * back as a status code.
   *
   * Five in five minutes, matching `passwordChange` in spirit — a person who
   * mistypes twice and gets it right on the third try never sees this, and
   * anything doing better than one guess a minute is not a person.
   *
   * Counted per user rather than per host on purpose: the same password often
   * opens several hosts, so a per-host budget would multiply the guesses
   * available against one secret by the size of the fleet.
   *
   * It arrived here from `TO_ATTACH`, where it sat as `elevation` from TRE-30
   * until the operation existed. It was renamed on the way: the feature is
   * called sudo, in the UI and in the code, because that is the word the user
   * already knows from the terminal.
   */
  sudo: rule("limit:sudo", "sudo attempts", 5, 300, "TREKKER_LIMIT_SUDO_ATTEMPTS_PER_5MIN"),

  /**
   * Checksum jobs (TRE-27), per minute.
   *
   * Twenty. A job reads files on somebody's machine for minutes at a time, and
   * queueing one is a single gesture from a context menu — so this is well past
   * deliberate use and nowhere near what a script would want.
   *
   * **It arrived from `TO_ATTACH` with a different shape, and the change is
   * worth recording.** It was declared as `("limit:hash", "checksum jobs", 3, 0,
   * "TREKKER_LIMIT_HASHES_IN_FLIGHT")` — three, over a window of zero seconds —
   * which is a concurrency cap written in the vocabulary of a rate limit, and it
   * could never have worked as one: `consume` sets `EXPIRE key 0`, MySQL's Redis
   * equivalent of deleting it immediately, so the counter would reset on every
   * call and the limit would never fire. The intent behind it was real and is
   * kept: three jobs in flight is now `MAX_JOBS_IN_FLIGHT` in
   * `hashes/hash-limits.ts`, where the other costs of running one live, and this
   * counter bounds how often somebody may *start* one, which is the question
   * every other rule in this table answers.
   */
  hashJobs: rule("limit:hash", "checksum jobs", 20, 60, "TREKKER_LIMIT_HASH_JOBS_PER_MIN"),

  /**
   * Directory comparisons (TRE-28), per minute.
   *
   * Twenty, matching the checksum jobs above, and for the same reason rather
   * than by copying the number: a comparison spends two machines' IO listing up
   * to two thousand entries across eight levels, and pressing `compare ⇄` is
   * one gesture. Twenty a minute is past anybody doing it deliberately.
   *
   * It bounds a route that **changes nothing**, which is unusual in this table
   * and is the point: the coverage spec only demands a limit on a destructive
   * route, and this one is here because "harmless" and "free" are different
   * words. A script running this against `/` on two hosts in a loop is a
   * denial of service against both, and no byte is altered by it.
   */
  compare: rule("limit:cmp", "comparisons", 20, 60, "TREKKER_LIMIT_COMPARISONS_PER_MIN"),
} as const satisfies Record<string, LimitRule>;

/**
 * Declared, not yet attached — each waits on the operation it governs.
 *
 * This is not documentation. `audit-coverage.spec.ts` reads it, and the
 * ticket named beside each one is the ticket that must remove its entry. An
 * unattached limit is a promise, and a promise with no expiry is how "every
 * destructive operation is rate limited" becomes true on paper only.
 *
 * **It is empty, which is the state it was always meant to reach.** TRE-23,
 * TRE-25, TRE-29 and finally TRE-27 each took their entry off it when the
 * operation landed. An empty list here means every limit this install declares
 * is one it actually spends; the next unbuilt operation that wants one adds it
 * back, with its ticket.
 */
export const TO_ATTACH = {} as const satisfies Record<string, { rule: LimitRule; ticket: string }>;
