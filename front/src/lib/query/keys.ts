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
  /**
   * What a rename pattern would produce (TRE-22). Keyed by the pattern itself,
   * so backspacing to something already typed redraws from cache instead of
   * asking the server to compile it again.
   */
  RENAME_PREVIEW: "renamePreview",
  /**
   * What a delete would take (TRE-25). Asked once when the modal opens and
   * never refetched: the number being confirmed must not change under the
   * cursor while it is being typed.
   */
  DELETE_PLAN: "deletePlan",
  ACTIVITY: "activity",
  /** The layout the account left, asked for only on a cold open (TRE-51). */
  LAYOUT: "layout",
} as const;
