import { createParser, debounce, parseAsNumberLiteral, parseAsStringLiteral } from "nuqs";

import type { UrlKeys } from "nuqs";

/**
 * The layout, in the query string (TRE-18 §1).
 *
 * The point is that a link is a saved view: paste the URL into another tab and
 * both panes, their hosts, paths and sorts, the split, the heat map and the
 * glob all come back. That is also why this lands now rather than later —
 * every component that owns one of these would otherwise have to be rewritten
 * around it.
 *
 * What is deliberately NOT here: the selection, the cursor, the open tabs and
 * the back/forward stacks. `pane-state.ts` claims the whole reducer could be
 * lifted "without reshaping it", and that turned out to be wrong for `hist`
 * and `fwd` — they are unbounded arrays appended on every navigation, so a
 * long session would push a multi-kilobyte URL into a browser that stops
 * accepting one somewhere around 2000 characters. The selection and cursor
 * change on every arrow key and are worth nothing to a reader. They stay in
 * React state.
 *
 * Every parser below is written to survive a hostile query string, because a
 * URL is user input. nuqs's stock parsers are not: `parseAsString` returns
 * whatever it is given, including `""` and `../../etc/passwd`; `parseAsInteger`
 * is an unbounded `parseInt`, so `?pane=47` would index `state.panes[47]` and
 * hand the app `undefined`. The rule here is that anything unparseable becomes
 * the default rather than a value nothing downstream expects.
 */

export const SPLIT_MODES = ["split", "left", "right"] as const;
export const VIEW_MODES = ["list", "detail"] as const;
export const SORT_KEYS = ["name", "size", "mode", "owner", "age"] as const;

/** Long enough for any real path, short enough that a URL stays a URL. */
const MAX_PATH = 700;

/**
 * An absolute POSIX path, or the default.
 *
 * `?p=` reaches a parser as `""`, not as absent — nuqs treats only `null` as
 * missing — so an empty value has to be rejected here or a pane opens on a
 * path that is not a path. Traversal is refused too: the server's guard is the
 * real boundary (TRE-11), but there is no reason to send it something we can
 * already see is malformed.
 */
export const parseAsAbsolutePath = createParser({
  parse(query: string): string | null {
    if (query.length === 0 || query.length > MAX_PATH) return null;
    if (!query.startsWith("/")) return null;
    if (query.includes("\0") || query.includes("//")) return null;
    // `.` and `..` are the host's to resolve, never a string operation — but a
    // path that *only* traverses is never something the app produced.
    if (query.split("/").some((segment) => segment === "..")) return null;
    return query;
  },
  serialize: (value: string) => value,
});

/**
 * A host id. Null is meaningful — it is "this pane is not bound to anything" —
 * so there is no default and no `withDefault`.
 *
 * Shape only: nuqs cannot know which hosts exist, so a well-formed id for a
 * host that was deleted still parses. The explorer reconciles against the
 * fetched list and rebinds, which is the same path a deleted host already
 * takes (TRE-43).
 */
export const parseAsHostId = createParser({
  parse: (query: string) => (/^[0-9a-f-]{36}$/i.test(query) ? query : null),
  serialize: (value: string) => value,
});

/** One pane's share of the URL. Both panes use this map under different keys. */
export const paneParams = {
  host: parseAsHostId,
  // The only key that pushes a history entry: the back button should undo the
  // last navigation, which is what the ticket asks for, and nothing else in
  // this map is a navigation.
  path: parseAsAbsolutePath.withDefault("/").withOptions({ history: "push" }),
  sort: parseAsStringLiteral(SORT_KEYS).withDefault("name"),
  dir: parseAsNumberLiteral([1, -1] as const).withDefault(1),
};

export const LEFT_KEYS: UrlKeys<typeof paneParams> = { host: "aHost", path: "aPath", sort: "aSort", dir: "aDir" };
export const RIGHT_KEYS: UrlKeys<typeof paneParams> = { host: "bHost", path: "bPath", sort: "bSort", dir: "bDir" };

/**
 * Everything shared by the two panes.
 *
 * `heat` is a hand-written parser rather than `parseAsBoolean`, which is
 * `value.toLowerCase() === "true"` and therefore never returns null — it would
 * read `?heat=banana` as false rather than as absent, which is the same
 * rendering but not the same URL, and `clearOnDefault` could then never strip
 * it. Explicit null is what makes a malformed value disappear.
 */
export const parseAsFlag = createParser({
  parse: (query: string) =>
    query === "1" || query === "true" ? true : query === "0" || query === "false" ? false : null,
  serialize: (value: boolean) => (value ? "1" : "0"),
});

export const explorerParams = {
  active: parseAsNumberLiteral([0, 1] as const).withDefault(0),
  split: parseAsStringLiteral(SPLIT_MODES).withDefault("split"),
  view: parseAsStringLiteral(VIEW_MODES).withDefault("detail"),
  heat: parseAsFlag.withDefault(false),
  // Visible by default, as 2a draws it (`inspector: this.props.showInspector ??
  // true`). It shipped hidden in TRE-17, which made the panel — and the only
  // way into the permissions modal — reachable solely by a shortcut nobody had
  // been told about.
  insp: parseAsFlag.withDefault(true),
  // Typed a character at a time. Without this each keystroke is a URL write,
  // and on the App Router each write is three history calls (nuqs sets
  // rateLimitFactor 3 for exactly that reason). Debounced, the URL catches up
  // once the typing stops.
  glob: createParser({
    parse: (query: string) => (query.length <= 200 ? query : null),
    serialize: (value: string) => value,
  })
    .withDefault("")
    .withOptions({ limitUrlUpdates: debounce(400) }),
};
