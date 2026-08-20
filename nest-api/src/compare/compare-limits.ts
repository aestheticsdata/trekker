/**
 * Every bound a comparison runs under, in one table (TRE-28).
 *
 * The same habit as `scan-limits.ts` and `hash-limits.ts`: "what will this
 * actually do to two machines" should be one file to read rather than a grep
 * across four. And the same rule about silence — every bound here reaches the
 * response, because a comparison that stopped early and did not say so is a
 * "these directories match" about a tree nobody finished looking at.
 *
 * The ticket puts it more sharply than any comment could: *a comparison of two
 * `/` is not a feature, it is an outage.*
 */

/** Levels below the two roots that are descended into. */
export const DEFAULT_DEPTH = 3;

/**
 * The deepest a comparison will go.
 *
 * Eight, which is deeper than `MAX_DEPTH` for a scan because the two are
 * bounded by different things. A scan's depth limits what is *stored* and its
 * walk is full-depth regardless; this one limits the walk itself, and every
 * extra level is two more listings per directory over two links.
 *
 * A shared directory below this is not silently assumed to match. It is
 * reported as a row nobody compared, with the depth named as the reason.
 */
export const MAX_DEPTH = 8;

/**
 * Rows one comparison will produce.
 *
 * Two thousand is far past what anybody reads in a modal — the list stops
 * rendering long before this — so what it really bounds is the number of
 * `list()` calls the walk makes on two machines. Past it the walk stops and
 * `truncated` is set, which the summary line says out loud.
 */
export const MAX_ENTRIES = 2_000;

/**
 * Directories the walk will report as unreadable before it stops naming them.
 *
 * The count keeps climbing after this; only the list of names is capped. A
 * comparison of a tree where four hundred directories are closed to this
 * account has one useful fact in it — the number — and four hundred paths is
 * not a second one.
 */
export const MAX_UNREADABLE_NAMED = 20;
