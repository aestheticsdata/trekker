/**
 * The explorer's dialogs: permissions, upload, compare, rename, transfer,
 * create and delete (TRE-116).
 */
const dialogs = {
  /** What more than one dialog says, worded once so they cannot drift apart. */
  common: {
    closeTooltip: "Close (⎋)",
    close: "Close",
    escClose: "esc ✕",
    cancel: "cancel",
    /** A directory's kind, in a row's narrow column. */
    directoryShort: "dir",
    walkingBothTrees: "walking both trees…",
    /**
     * Worded the same in the upload and the transfer dialogs. Two modals writing
     * to one disk that disagreed about whether it has room would be worse than
     * either of them being wrong on its own.
     */
    noRoom: "Needs {needed} and {free} is free at the destination.",
    free: "{size} free",
    entryOne: "{count} entry",
    entryMany: "{count} entries",
    entriesIn: "{count} entries in {directory}",
    fileOne: "{count} file",
    fileMany: "{count} files",
    directoryOne: "{count} directory",
    directoryMany: "{count} directories",
    symlinkOne: "{count} symlink",
    symlinkMany: "{count} symlinks",
  },
  permissions: {
    /** The dialog's accessible name. */
    dialog: "Permissions for {subject}",
    title: "chmod",
    classes: {
      user: "user",
      group: "group",
      other: "other",
    },
    columns: {
      read: "read",
      write: "write",
      exec: "exec",
    },
    /** The fourth octal digit's three bits. */
    special: {
      setuid: "setuid",
      setgid: "setgid",
      sticky: "sticky",
    },
    bitLabel: "{column} for {who}",
    owner: "owner",
    ownerMixed: "mixed — user:group",
    ownerLabel: "Owner and group",
    recursive: "recursive",
    /** What "recursive" is about to mean, in entries. */
    recursiveNote: {
      selectionOnly: "· selection only",
      noDirectory: "· nothing selected is a directory",
      counting: "· counting…",
      unknown: "· the count could not be read",
      applies: "· applies to {count} nested entries",
      appliesMore: "· applies to more than {count} nested entries",
    },
    mixedModes: "{count} different modes are selected — applying {octal} unifies them.",
    specialSet: "{bits} will be set. This is how privilege is left behind on a filesystem.",
    specialJoin: " and ",
    refusedOne: "{count} entry holds Trekker's own key material and was left untouched:",
    refusedMany: "{count} entries hold Trekker's own key material and were left untouched:",
    failedSummary: "{changed} changed, {failed} refused:",
    pathsOne: "{count} path in {directory}",
    pathsMany: "{count} paths in {directory}",
    /** Stands in for the path list on the command line once there are more than two. */
    commandPaths: "{count} paths",
    applying: "applying…",
    apply: "apply {octal}",
    failure: "The change could not be applied.",
    toast: {
      changedOne: "{octal} · {count} entry",
      changedMany: "{octal} · {count} entries",
      owner: "owner {owner}",
      undo: "Undo",
      undoHint: "Restores only what this change touched — anything altered since is not affected.",
      reverted: "Reverted.",
      undoFailed: "Could not undo — it may have expired.",
    },
    /** The grid in a sentence, for anyone who is not looking at it. */
    describe: {
      rights: {
        read: "read",
        write: "write",
        execute: "execute",
      },
      nothing: "nothing",
      withoutExecute: "{name}, without execute",
      line: "{who} {list}",
      lineNoted: "{who} {list} ({notes})",
      unparsed: "Permissions {mode}",
      parsed: "Permissions {mode}: {parts}",
    },
  },
  upload: {
    dialog: "Upload into {directory}",
    title: "upload",
    /** The answers to "the destination already holds this name". */
    policies: {
      keepBoth: "keep both",
      overwrite: "overwrite",
      skip: "skip",
    },
    nothingChosen: "Nothing chosen yet.",
    allDotFiles: "Everything chosen is a dot-file.",
    chooseFiles: "choose files…",
    chooseFolder: "choose a folder…",
    dropHint: "or drop them onto a pane",
    notListed: "and {count} more, not listed",
    truncated: "That is more than {max} files. Only the first {max} were collected — send the rest in another pass.",
    tight: "This fits, but would leave only {size} free on the host.",
    ifExists: "if it exists",
    policyLabel: "What to do when the destination already holds the name",
    skipDotsOne: "skip {count} dot-file",
    skipDotsMany: "skip {count} dot-files",
    nothingToSend: "nothing to send",
    sendingOne: "{count} file, {size}",
    sendingMany: "{count} files, {size}",
    freeOf: "{free} free of {total}",
    addMore: "add more…",
    submit: "upload",
  },
  compare: {
    dialog: "Compare {a} with {b}",
    title: "compare",
    verdicts: {
      differs: "differs",
      onlyA: "only left",
      onlyB: "only right",
      identical: "identical",
      inconclusive: "unchecked",
    },
    sameNames: "the two directories hold the same names",
    noMatch: "no rows match this filter",
    notDrawn: "+{count} more rows, not drawn. Narrow the filter to see them.",
    hashable: "{count} row(s) agree about size and time. Only a checksum can say whether the bytes match.",
    revealHint: "Clicking a row puts the cursor on it in both panes.",
    resolving: "resolving…",
    resolve: "resolve by hash",
    close: "close",
    /** The summary line, in the order somebody reads it. */
    summary: {
      differ: "{count} differ",
      onlyLeft: "{count} only left",
      onlyRight: "{count} only right",
      identical: "{count} identical",
      unchecked: "{count} unchecked",
      depth: " · {depth} levels deep",
    },
    truncated:
      "This comparison stopped early — at {rows} rows, or at the {depth}-level depth limit. What is below that was not looked at.",
    unreadableOne: "{count} directory could not be listed on one side:",
    unreadableMany: "{count} directories could not be listed on one side:",
    /** Trails the unreadable list when the server named fewer than it counted. */
    unreadableMore: ", …",
    filterAll: "all",
    filterPlaceholder: "filter by name",
    filterLabel: "Filter the comparison by name",
    copyTo: "Copy this to {path}",
    nothingLeft: "Nothing on the left to copy",
    nothingRight: "Nothing on the right to copy",
  },
  rename: {
    dialog: "Rename {subject}",
    title: "rename",
    modeLabel: "Rename by",
    modes: {
      name: "name",
      pattern: "pattern",
    },
    nameNeedsOne: "One entry at a time — the pattern renames a selection",
    labels: {
      name: "name",
      match: "match",
      replace: "replace",
      flags: "flags",
    },
    newName: "New name",
    pattern: "Pattern",
    replacement: "Replacement",
    flagGlobal: "Replace every occurrence",
    flagIgnoreCase: "Ignore case",
    strandedOne: "The rename failed part-way and {count} entry is under a temporary name: {names}",
    strandedMany: "The rename failed part-way and {count} entries are under a temporary name: {names}",
    renamedSingle: "{from} → {to}",
    renamedOne: "Renamed {count} entry",
    renamedMany: "Renamed {count} entries",
    failure: "The rename could not be applied.",
    /** A collision, and what it collides with. */
    problem: "{next} — {message}",
    unchanged: "unchanged",
    renaming: "renaming…",
    /** The mockup's "n of m names change", and what to say before there is an n. */
    summary: {
      singleChanges: "1 name changes",
      typePattern: "type a pattern to preview",
      fixPattern: "fix the pattern to preview",
      previewing: "previewing…",
      counted: "{changed} of {total} names change",
      colliding: "{counted} · {count} collide, nothing will be renamed",
    },
    cta: {
      single: "rename",
      one: "rename {count} file",
      many: "rename {count} files",
    },
  },
  transfer: {
    dialog: "{verb} to {path}",
    /**
     * "transfer" when the hosts differ, because that is what it is: the bytes
     * leave one machine and arrive at another.
     */
    verbs: {
      copy: "copy",
      move: "move",
      transfer: "transfer",
    },
    strategies: {
      ask: "ask",
      overwrite: "overwrite all",
      skip: "skip all",
      keepBoth: "keep both",
    },
    /** The per-row answers. */
    answers: {
      overwrite: "overwrite",
      skip: "skip",
      keepBoth: "both",
    },
    truncated: "This selection holds more than {ceiling} entries. Narrow it before transferring.",
    conflictOne: "{count} conflict",
    conflictMany: "{count} conflicts",
    answer: "{conflicts} · answer",
    strategyLabel: "What to do with conflicts",
    notDrawn: "…and {count} more, all without conflicts. They transfer with the rest.",
    skippedLinks: "{links} under this selection will not be copied.",
    summary: "{files} · {size}",
    summaryWithDirectories: "{files} · {size} · {directories}",
    unanswered: "{conflicts} unanswered",
    starting: "starting…",
    submit: "{verb} {entries}",
    absent: "does not exist at the destination",
    noConflict: "no conflict",
    failure: "The transfer could not be started.",
  },
  create: {
    dialog: "New entry in {directory}",
    title: "new",
    modeLabel: "What to create",
    modes: {
      dir: "dir",
      file: "file",
    },
    in: "in",
    name: "name",
    placeholders: {
      dir: "reports",
      file: "notes.md",
    },
    nameLabels: {
      dir: "New directory name",
      file: "New file name",
    },
    descriptions: {
      dir: "an empty directory",
      file: "an empty file, 0 bytes",
    },
    creating: "creating…",
    submit: {
      dir: "mkdir",
      file: "create",
    },
    created: "{name} created",
    collides: "Already in this directory.",
    failure: "The entry could not be created.",
    /** The server's own messages, so a problem reads the same whichever side noticed it. */
    problems: {
      slash: "A name is one segment — it cannot contain “/”.",
      dots: "“{name}” names a directory, not a file.",
      spaces: "A name cannot start or end with a space.",
      trailingDot: "A name cannot end with a dot.",
    },
  },
  delete: {
    dialog: "Delete {subject}",
    title: "delete",
    partial: "Deleted {removed} of {total}",
    someFailed: "Some entries could not be removed.",
    deleted: "Deleted {entries}",
    freed: "{size} freed",
    failure: "The delete could not be sent.",
    elevation: "This would remove {entries} entries, above the {threshold} an unelevated session may delete.",
    walking: "walking the tree…",
    recursive: "recursive · {entries}",
    tokenPrompt: "type {token} to confirm",
    tokenLabel: "Type {token} to confirm",
    summary: "{entries} · {size}",
    deleting: "deleting…",
    confirm: "delete",
    /** What is about to go that the reader might not have noticed. */
    risk: {
      contains: "contains {notes}",
      rootOwned: "{entries} owned by root",
      links: "{links} (targets untouched)",
      unreadable: "{directories} unreadable",
    },
  },
} as const;

export default dialogs;
