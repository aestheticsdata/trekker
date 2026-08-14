// Central registry of React Query cache keys. Every query key in the app starts
// with one of these, so cross-module invalidation (a transfer refreshing both
// panes, a chmod refreshing one directory) never relies on magic strings
// scattered across hooks.
export const QUERY_KEYS = {
  HOSTS: "hosts",
  HOST_SUMMARY: "hostSummary",
  /**
   * The active host's live numbers (TRE-73). Its own key rather than part of the
   * summary's: the summary is asked for every host in the sidebar and this is
   * asked for one, on a shorter interval, and each answer costs the server a
   * second of sampling.
   */
  HOST_METRICS: "hostMetrics",
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
  /**
   * The transfer queue (TRE-24). Server state, not component state — which is
   * what makes the widget survive a page reload, and what the SSE feed
   * reconciles against every time it reconnects.
   */
  TRANSFERS: "transfers",
  /**
   * What a transfer would do (TRE-24). Asked when the modal opens and never
   * refetched: the operator is answering a list of conflicts, and a list that
   * changed under the cursor would scatter those answers across a different one.
   */
  TRANSFER_PLAN: "transferPlan",
  ACTIVITY: "activity",
  /** The layout the account left, asked for only on a cold open (TRE-51). */
  LAYOUT: "layout",
} as const;
