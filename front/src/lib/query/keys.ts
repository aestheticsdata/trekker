// Central registry of React Query cache keys. Every query key in the app starts
// with one of these, so cross-module invalidation (a transfer refreshing both
// panes, a chmod refreshing one directory) never relies on magic strings
// scattered across hooks.
export const QUERY_KEYS = {
  HEALTH: "health",
  HOSTS: "hosts",
  HOST_SUMMARY: "hostSummary",
  DIRECTORY: "directory",
  ENTRY: "entry",
} as const;
