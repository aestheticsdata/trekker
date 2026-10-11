/**
 * The frame around the panes: the top bar, the status bar, the size stepper,
 * the account menu, the disk-usage strip, and the words the heat map and the
 * treemap lend to the listing.
 */
const shell = {
  /** Set in caps on purpose: the top bar's wordmark and the too-narrow notice. */
  wordmark: "TREKKER",

  /** Below tablet the app says so rather than degrading (TRE-14 §5). */
  tooNarrow: {
    lead: "This app needs a wider screen.",
    body: "Two directories side by side is the whole point, and it does not survive a phone.",
  },

  account: {
    signOut: "Sign out",
    /** Replaces the address on the chip while the request is in flight. */
    signingOut: "signing out…",
    signOutFailed: {
      message: "Could not sign out",
      noAnswer: "The API did not answer.",
      leaveAnyway: "Leave anyway",
      leaveAnywayHint: "Return to the sign-in screen. The session stays open until it expires.",
    },
  },

  topBar: {
    editHost: "Edit {host}",
    pingMs: "{ms} ms",
    stats: {
      up: "up",
      cpu: "cpu",
      ram: "ram",
      throughput: "io",
      load: "load",
    },
    loadHint: "Load average over the last {count} samples",
  },

  statusBar: {
    facts: {
      size: "size",
      mode: "mode",
      owner: "owner",
      modified: "modified",
    },
    noSelection: "No selection",
    showDiskUsage: "show disk usage ▴",
  },

  uiScale: {
    label: "ui",
    value: "{base}px",
    smaller: "Smaller interface",
    larger: "Larger interface",
  },

  diskUsage: {
    region: "Disk usage",
    title: "DISK USAGE",

    actions: {
      cancel: "cancel ✕",
      cancelHint: "Stop the scan running on this host",
      scan: "scan ⟳",
      scanHint: "Walk {path} with du and keep the result",
      hide: "hide ▾",
      hideHint: "Collapse the strip and give the space back to the panes",
    },

    toasts: {
      scanFailed: "The scan of {root} failed",
      alreadyRunning: "A scan is already running on this host",
      startFailed: "Could not start the scan",
      stopFailed: "Could not stop the scan",
    },

    summary: {
      noHost: "No host in the active pane.",
      startingScan: "starting a scan",
      showingScanFrom: "showing the scan from {ago}",
      looking: "Looking for a kept scan…",
      readFailed: "Could not read this host's scans.",
      neverScanned: "Never scanned.",
      usedOfTotal: "{used} of {total}",
      finished: "scan finished {ago}",
      inodes: "{count} inodes",
      truncated: "partial: the tree outgrew what one scan keeps",
      unreadable: "{count} unreadable",
      staleHint: "This install calls a scan current for {duration}.",
      stale: "⚠ stale",
    },

    /** What a running scan has counted so far, on the summary line and in the working box. */
    progress: "{count} entries · {bytes} · {seconds}s",
    starting: "starting…",

    phases: {
      probing: "probing the host's du",
      walking: "walking the tree",
      hashing: "hashing duplicate candidates",
      saving: "writing the result",
    },

    treemap: {
      empty: "This directory holds nothing to divide up.",
      openHint: "Click to open it in the active pane.",
      size: "size",
      share: "share",
      /** The fold's subject: the band without a path. */
      restSubject: "everything below the five largest",
      /**
       * Why the one band that never opens never opens (TRE-105). The front's
       * words rather than the API's: the 403 body is written for a request that
       * has already been made, this for a pointer resting on a rectangle.
       */
      denied:
        "Trekker's own key material — the master key that decrypts every stored credential, or the API user's SSH keys. It stays closed to the browser; reach it over SSH.",
    },

    blank: {
      noHost: "Bind the active pane to a host and its disk usage appears here.",
      notScanned: "{root} has not been scanned yet — du walks it once and the result is kept.",
      tryAgain: "try again",
      scanNow: "scan now",
    },

    facts: {
      largest: "largest",
      duplicates: "duplicates",
      duplicatesValue: "{count} · {bytes} reclaimable",
      /**
       * The pair matters: `confirmed` are groups two files of which were read
       * and hashed, `candidates` only share a size — so only one is reclaimable.
       */
      duplicatesNote: "Only the confirmed groups are reclaimable.",
      candidates: "candidates",
      confirmed: "confirmed",
      tooLarge: "too large to hash",
      duplicatesSubject: "duplicates, by size then by hash",
      oldFiles: "files > 1 year",
      size: "size",
      untouchedSince: "untouched since",
      oldFilesSubject: "files older than a year",
    },

    /** How long, in one unit — the age column's own habit. */
    duration: {
      seconds: "{n}s",
      minutes: "{n} min",
      hours: "{n} h",
      days: "{n} d",
    },
    ago: "{duration} ago",
    justNow: "just now",
  },

  /**
   * The age heat map's buckets (TRE-33 §3). Months are thirty days, as
   * `formatAge` counts them, so "2 months" here and `2mo` in the column mean
   * the same span.
   */
  heat: {
    underAnHour: "under an hour",
    under12Hours: "under 12 hours",
    under3Days: "under 3 days",
    under2Weeks: "under 2 weeks",
    under2Months: "under 2 months",
    under7Months: "under 7 months",
    older: "older",
  },

  treemap: {
    /** The fold's label on the strip: whatever the named bands leave over. */
    rest: "rest",
  },
} as const;

export default shell;
