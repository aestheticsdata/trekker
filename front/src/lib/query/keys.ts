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
  /**
   * How full a host's filesystems are (TRE-31). Its own key rather than part of
   * the summary's, because two very different things ask for it — the sidebar's
   * volumes panel, and each pane deciding whether its header carries a warning —
   * and one cached answer serves both.
   */
  HOST_DISKS: "hostDisks",
  /** The disk-usage panel's whole payload (TRE-33): last scan, running scan, one level. */
  SCAN: "scan",
  /**
   * One file's sha256 (TRE-27): what is cached, and what is being computed.
   *
   * Keyed by host and path, and asked for by the inspector alone. Its own key
   * rather than part of the entry's: answering it costs the server a `stat` on
   * the machine and a row read, and the panel refetches it whenever a job that
   * covers the file finishes — which has nothing to do with when a listing goes
   * stale.
   */
  HASH: "hash",
  /**
   * A comparison of the two panes (TRE-28). Keyed by both sides and the depth,
   * so re-opening the modal on the same pair redraws from cache while a
   * different pair is a fresh walk of two machines.
   *
   * Never refetched on focus: the list is something somebody is reading and
   * acting on row by row, and a list that reshuffled under the cursor would
   * scatter those actions across a different one — the same rule the transfer
   * plan and the delete plan follow.
   */
  COMPARE: "compare",
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
  /**
   * What one host would want in order to open a sudo window (TRE-29). Its own
   * key rather than part of the hosts list's: answering it costs a round trip
   * to the machine, and only the modal ever asks.
   */
  SUDO_REQUIREMENT: "sudoRequirement",
  ACTIVITY: "activity",
  /** The layout the account left, asked for only on a cold open (TRE-51). */
  LAYOUT: "layout",
  /**
   * The account's saved views (TRE-37). Its own key rather than part of the
   * layout's: that one is asked once per cold open and never refetched, and
   * this one is invalidated by every save, rename and delete.
   */
  VIEWS: "views",
} as const;
