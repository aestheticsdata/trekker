/** The left rail (TRE-18): its section headings, hosts, volumes, favourites and activity strip. */
const sidebar = {
  sections: {
    views: "VIEWS",
    servers: "SERVERS",
    volumes: "VOLUMES",
    favourites: "FAVOURITES",
    transfers: "TRANSFERS",
    activity: "ACTIVITY",
  },
  servers: {
    hostOne: "{count} host",
    hostMany: "{count} hosts",
    empty: "No hosts yet.",
    add: "＋ new host…",
    openActive: "Open {host} in the active pane",
    openInPane: "Open {host} in pane {pane}",
    pingMs: "{ms}ms",
  },
  volumes: {
    noHost: "No host in the active pane.",
    reading: "Reading df…",
    readFailed: "Could not read df on this host.",
    none: "This host reports no filesystems.",
    open: "Click to open it in the active pane.",
    openWarn: "Above the warning threshold. Click to open it in the active pane.",
    used: "used",
    of: "of",
    free: "{size} free",
  },
  favourites: {
    empty: "None yet. Bookmark a directory from a pane.",
    removeFailed: "Could not remove that favourite",
    remove: "Remove",
    removeLabel: "Remove {label} from favourites",
  },
  activity: {
    empty: "Nothing yet.",
    when: "when",
    from: "from",
    reverted: "Reverted.",
    undoFailed: "Could not undo — it may have expired.",
    undo: "Undo",
    undoHint: "Undo — restores only what this change touched, not anything altered since.",
    /** The compact relative-time column: 4 characters wide in the mockup. */
    since: {
      seconds: "{n}s",
      minutes: "{n}m",
      hours: "{n}h",
      days: "{n}d",
    },
  },
} as const;

export default sidebar;
