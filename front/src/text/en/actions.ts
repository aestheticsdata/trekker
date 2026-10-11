/**
 * The action registry's words, the toolbar and the ⌘K palette (TRE-116).
 *
 * `registry` is keyed by `ActionId` and read by `components/shell/actions.ts`,
 * which keeps the rules, the order and the shapes; only what each operation is
 * called lives here.
 */
const actions = {
  /** Why an action is unavailable. Absent means enabled; this is the sentence. */
  reasons: {
    noHost: "Bind a host to this pane first",
    nothing: "Select an entry, or put the cursor on one",
    oneAtATime: "This takes one entry at a time",
    noOtherHostToSend: "The other pane has no host to send these to",
    /**
     * Not `noOtherHostToSend`: "to send these to" is the wrong sentence for a
     * comparison, which reads both panes rather than sending anything one way.
     */
    noOtherHostToCompare: "The other pane has no host to compare against",
    openOtherDirectoryOnly: "Only a directory can be opened in the other pane",
    clipboardEmpty: "Nothing on the clipboard",
    tailFileOnly: "A tail follows a file",
    linkFileOnly: "A signed link points at a file",
    favouriteDirectoryOnly: "Only a directory can be a favourite",
  },

  /**
   * What each operation is called: `label` everywhere, `short` where the
   * toolbar's width forced a shorter word, `note` as the palette's second line.
   *
   * The two labels are not decoration. `copy` in the toolbar and `copy to other
   * pane` in the menu are the same action, and the menu has to say where the
   * bytes are going because the clipboard's `copy` is sitting four rows above it.
   */
  registry: {
    newDir: { label: "new directory", short: "new", note: "a directory, here" },
    newFile: { label: "new file", note: "an empty file, here" },
    open: { label: "open" },
    openOther: { label: "open in other pane" },
    cut: { label: "cut", note: "hold the selection, to move it" },
    copy: { label: "copy", note: "hold the selection, to duplicate it" },
    paste: { label: "paste", note: "put down what the clipboard is holding" },
    duplicate: { label: "duplicate", note: "a copy beside the original, under a free name" },
    copyTo: { label: "copy to other pane", short: "copy", note: "with each conflict decided per entry" },
    moveTo: { label: "move to other pane", short: "move", note: "with each conflict decided per entry" },
    refresh: { label: "refresh", note: "re-read this directory from the host" },
    // `rename`, not `regex rename`: the long label pushed `rm` off the right edge
    // of the toolbar at a 12px `--ui-base` (TRE-72), and the modal's own
    // name/pattern switch says the regex is there better than a label can.
    rename: { label: "rename", note: "one name, or a pattern over the selection" },
    chmod: { label: "permissions", note: "mode, owner and group" },
    download: { label: "download", note: "a file as itself, a directory as a zip" },
    tail: { label: "tail this file", note: "follow it live in the strip under the panes" },
    upload: { label: "upload here", short: "upload", note: "pick files to put in this directory" },
    link: { label: "mint signed link", note: "a signed URL, good for a while" },
    copyPath: { label: "copy path", note: "the absolute path, to the clipboard" },
    copyName: { label: "copy name", note: "just the name, to the clipboard" },
    favourite: { label: "add to favourites", note: "keep this directory in the sidebar" },
    compare: { label: "compare with other pane", short: "compare", note: "name, size and hash, both directories" },
    hash: { label: "compute sha256", note: "runs in the background" },
    rm: { label: "rm", note: "permanent — this app has no trash" },
  },

  palette: {
    /**
     * The group headers, in the order the mockup stacks them. Also the values
     * `PaletteGroup` is made of, and matched against by the ranking.
     */
    groups: {
      goTo: "GO TO",
      actions: "ACTIONS",
      view: "VIEW",
      shell: "SHELL",
      views: "VIEWS",
      servers: "SERVERS",
    },
    /** The dialog's and the field's accessible name. */
    label: "Command palette",
    placeholder: "go to a path, run an action, search…",
    path: {
      noHost: "this pane has no host to go anywhere on",
      goHere: "go here on {host}",
      /** Stands in for a host with no label. */
      thisHost: "this host",
      directory: "directory",
    },
    empty: {
      noMatch: "no command matches “{query}”",
      fallback: "↩ runs it in the terminal instead",
    },
    footer: {
      navigate: "↑↓ navigate",
      run: "↩ run",
      complete: "⇥ autocomplete",
      close: "⎋ close",
    },
  },

  toolbar: {
    viewMode: {
      label: "View mode",
      list: "list",
      detail: "detail",
    },
    glob: {
      label: "glob",
      placeholder: "*.log",
      field: "Filter by glob",
      hitOne: "{count} hit",
      hitMany: "{count} hits",
    },
    heat: "heat",
    inspector: {
      label: "inspector",
      hint: "Show the inspector (⌘I)",
    },
    split: {
      label: "Split",
      left: "Left pane only",
      both: "Both panes",
      right: "Right pane only",
    },
  },
} as const;

export default actions;
