const explorer = {
  /** The split, as three palette entries rather than a toggle — the toolbar has three. */
  splits: {
    split: { label: "show both panes", detail: "the two directories side by side" },
    left: { label: "left pane only", detail: "the right one collapses" },
    right: { label: "right pane only", detail: "the left one collapses" },
  },
  columnMenu: {
    /** Named for the pane it will change, not "columns". */
    label: "columns · {path}",
    showAll: "show every column",
  },
  tabMenu: {
    newTab: "new tab",
    closeTab: "close tab",
    closeOthers: "close other tabs",
    /** The only place the rule "a pane keeps a tab" is ever stated to anybody. */
    lone: "A pane always keeps one tab.",
  },
  /** The context menu's header when it is about several entries. */
  menuEntries: "{count} entries",
  /** The comparison's side labels when a pane's host is not in the list yet. */
  compare: {
    left: "left",
    right: "right",
  },
  toasts: {
    pickSomething: "Select an entry, or put the cursor on one",
    bindFirst: "Bind one from the sidebar first",
    noHostHere: "No host on this pane",
    noHostThere: "No host on that pane",
    noHostOther: "No host on the other pane",
    nothingToRename: "Nothing to rename",
    nothingToDelete: "Nothing to delete",
    nothingToCompare: "Nothing to compare",
    bothPanesNeedHost: "Both panes need a host",
    nothingToTransfer: "Nothing to transfer",
    transferNeedsDestination: "A transfer needs somewhere to go",
    nothingToCut: "Nothing to cut",
    nothingToCopy: "Nothing to copy",
    paste: {
      alreadyHere: "Already here",
      cutFromHere: "These were cut from this directory",
      sourceUnreadable: "Could not read where these came from",
      nothingLeft: "Nothing left to paste",
      noLongerThere: "{names} no longer there",
      someGone: "Some of these are gone",
      restStill: "{names} — the rest still {operation}",
    },
    clipboard: {
      pathCopied: "Path copied",
      nameCopied: "Name copied",
      failed: "Could not copy",
      refused: "This browser refused clipboard access.",
    },
    favourite: {
      added: "Added to favourites",
      failed: "Could not add that favourite",
    },
    download: {
      nothing: "Nothing to download",
      oneAtATime: "One at a time",
      oneEntry: "A download takes one entry. Download the directory to get several as a zip.",
    },
    duplicate: {
      nothing: "Nothing to duplicate",
      failedOne: "Could not duplicate {name}",
      failed: "Could not duplicate",
      hostRefused: "The host refused.",
    },
    upload: {
      nothing: "Nothing to upload",
      dropEmpty: "That drop carried no files",
    },
    linkLeavesRoots: "That link leaves the allowed roots",
    previewPending: "Read-only preview arrives with the inspector (TRE-17)",
    columns: {
      notRemembered: "Could not remember these columns",
      notRememberedDetail: "This pane is showing what you asked for; the machine will not remember it.",
    },
  },
  palette: {
    goTo: {
      home: "home directory on {host}",
      favourite: "favourite · {label}",
      favouriteWithHint: "favourite · {label} · {hint}",
      recent: "recently in this pane",
    },
    view: {
      showInspector: "show the inspector",
      hideInspector: "hide the inspector",
      inspectorDetail: "the panel beside the panes",
      alreadySplit: "The panes are already like this",
      showHeat: "show the age heat map",
      hideHeat: "hide the age heat map",
      heatDetail: "colour every row by how long ago it changed",
      showColumn: "show the {column} column",
      hideColumn: "hide the {column} column",
      showAllColumns: "show every column",
    },
    shell: {
      openTerminal: "open the terminal here",
      closeTerminal: "close the terminal",
    },
    views: {
      restore: "restore the view {name}",
      save: "save this layout as a view",
      saveDetail: "both panes, their sorts, the split and the glob",
      unavailable: "Saved views are not available here",
    },
    servers: {
      connect: "connect this pane to {host}",
      detail: "{where} · {ping}",
      local: "local",
      remote: "{user}@{address}",
      unknownPart: "?",
      pingMs: "{ms} ms",
      noPing: "—",
      alreadyOn: "This pane is already on it",
    },
  },
  pane: {
    unbound: {
      title: "no host",
      detail: "This pane has nothing to browse yet. Add the machine the API runs on, or an SSH host.",
      action: "add a host",
    },
    footer: {
      counts: "{directories} folders · {files} files",
      selected: "{count} selected · {total}",
      sorted: "sorted by {sort} {arrow}",
    },
    tabs: {
      close: "Close tab",
      closeNamed: "Close tab {path}",
      new: "New tab",
      activeBadge: "ACTIVE PANE · ⇥ to switch",
    },
    path: {
      noHost: "no host",
      back: "Back",
      forward: "Forward",
      up: "Up one level",
      breadcrumb: "Breadcrumb",
    },
    /** The one chip at the end of the path row, and which of three things it says. */
    badge: {
      truncated: "⚠ first {count} of {total}",
      truncatedHint: "This directory has more entries than one listing carries.",
      volume: "⚠ volume at {percent}%",
      volumeHint: "{mount} is {percent}% full — {free} free.",
      total: "{total} total",
    },
    columns: {
      name: "NAME",
      share: "SHARE",
      size: "SIZE",
      mode: "MODE",
      owner: "OWNER",
      age: "AGE",
    },
    size: {
      partial: "Part of this directory could not be read, so the real total is larger.",
      unmeasured: "This directory could not be measured.",
      measuring: "Measuring…",
      /** The feed ended without reaching this row: simply unknown. */
      unknown: "—",
      /** Why a directory could not be measured, by the errno the walk reported. */
      refusals: {
        EACCES: "This directory cannot be read with the account this host connects as.",
        ENOENT: "This directory was gone by the time it was measured.",
        ENOTDIR: "This is no longer a directory.",
        ENOSYS: "This host cannot run a command, so its directories cannot be measured.",
        EIO: "This directory could not be measured.",
      },
    },
    placeholder: {
      up: "go up ↰",
    },
    filtered: {
      title: "no match for {glob}",
      detailOne: "{count} entry hidden by the glob filter.",
      detailMany: "{count} entries hidden by the glob filter.",
      action: "clear filter",
    },
    empty: {
      title: "empty directory",
      detail: "Nothing here. {path} contains no files or folders.",
    },
    error: {
      fallback: "The listing could not be loaded.",
      forbidden: "permission denied",
      notFound: "no such directory",
      unreachable: "host unreachable",
      failed: "listing failed",
    },
  },
  /** The accessible names of the two drawn marks; a file's letters name themselves. */
  fileMark: {
    directory: "directory",
    symlink: "symlink",
  },
  tail: {
    header: "live tail",
    picker: {
      title: "pick a file to follow",
      none: "nothing here looks like a log — right-click a file and choose “tail this file”",
    },
    tooltip: {
      source: "source",
      lines: "lines",
      tail: "tail -F",
      polling: "polling",
      shared: "Another tab is following this file. Both share one reader on the host.",
    },
    retry: "retry",
    follow: "↓ follow",
    pending: "↓ {count} new",
    stop: "Stop following this file",
    body: "Live tail of {path}",
    ended: "The tail ended.",
    waiting: "waiting for the first line…",
    status: {
      ended: "ended",
      reconnecting: "reconnecting…",
      connecting: "connecting…",
      unanswered: "host not answering",
    },
  },
} as const;

export default explorer;
