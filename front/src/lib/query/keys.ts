// Central registry of React Query cache keys. Every query key in the app starts
// with one of these, so cross-module invalidation (a transfer refreshing both
// panes, a chmod refreshing one directory) never relies on magic strings
// scattered across hooks.
export const QUERY_KEYS = {
  HEALTH: "health",
  HOSTS: "hosts",
  HOST_SUMMARY: "hostSummary",
  BOOKMARKS: "bookmarks",
  DIRECTORY: "directory",
  ENTRY: "entry",
  /** What a recursive change would touch — asked only when the box is ticked. */
  ENTRY_COUNT: "entryCount",
  ACTIVITY: "activity",
  /** The layout the account left, asked for only on a cold open (TRE-51). */
  LAYOUT: "layout",
} as const;
