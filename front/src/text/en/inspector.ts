/** The right sidebar: its three panels, the checksum block and the actions (TRE-17). */
const inspector = {
  label: "Inspector",
  title: "INSPECTOR",
  hide: "Hide the inspector (⌘I)",

  /** What stands in for a panel while there is nothing to describe. */
  notices: {
    loading: "reading the directory…",
    unreadable: "this directory could not be read",
    noHost: "no host bound to this pane",
  },

  types: {
    dir: "directory",
    file: "file",
    link: "symlink",
    other: "special file",
  },

  /**
   * What the stub says it would be showing. The mockup's own captions, widened
   * to the types a real listing contains.
   */
  preview: {
    folder: "folder",
    folderOne: "folder · 1 item",
    folderMany: "folder · {count} items",
    symlink: "symlink",
    specialFile: "special file",
    image: "image preview",
    video: "preview · video",
    archive: "preview · {format} archive",
    extension: "preview · {extension}",
    generic: "preview",
  },

  /**
   * The format an archive extension stands for, where the two differ.
   *
   * `.gz` is the whole reason this exists: the mockup's own file is a
   * `.sql.gz` and its caption reads "gzip archive", not "gz archive". Anything
   * not named here already reads correctly as itself — "zip archive", "xz
   * archive" — so the map stays as short as the difference is.
   */
  archiveNames: {
    gz: "gzip",
    tgz: "gzip",
    bz2: "bzip2",
    zst: "zstd",
  },

  /** Nothing selected: the directory itself. */
  directory: {
    stats: {
      items: "ITEMS",
      size: "SIZE",
      folders: "FOLDERS",
      newest: "NEWEST",
    },
    meta: {
      path: "path",
      sort: "sort",
      filter: "filter",
    },
    noFilter: "none",
    modeLine: "{mode} · directory",
  },

  /** One entry — the state the mockup draws. */
  entry: {
    stats: {
      size: "SIZE",
      onDisk: "ON DISK",
      mode: "MODE",
      age: "AGE",
    },
    onDiskHint: "Rounded up to a 4 KiB block — an estimate, not a measurement",
    meta: {
      host: "host",
      path: "path",
      type: "type",
      bytes: "bytes",
      modified: "modified",
      accessed: "accessed",
      owner: "owner",
      inode: "inode",
      links: "links",
    },
  },

  /** Several entries. */
  selection: {
    entries: "{count} entries",
    selected: "{count} selected",
    stats: {
      totalSize: "TOTAL SIZE",
      modes: "MODES",
      files: "FILES",
      folders: "FOLDERS",
    },
    more: "+{count} more",
  },

  integrity: {
    heading: "INTEGRITY",
    stop: "stop",
    copy: "copy",
    compute: "compute",
    algorithm: "sha256",
    perFile: "per file",
    computing: "computing…",
    notComputed: "not computed",
    superseded: "the file changed since it was last hashed",
    onHost: "on the host",
    streamed: "streamed",
    failed: "The checksum job failed",
    copied: "sha256 copied",
    copyFailed: "Could not copy",
    clipboardRefused: "This browser refused clipboard access.",
    /** The second line while a job runs: files, not bytes. */
    job: {
      files: "{count} file(s)",
      waiting: "{count} file(s) · waiting for a slot",
      progress: "{done}/{total} file(s)",
      unreadable: " · {count} unreadable",
    },
  },

  permissions: {
    heading: "PERMISSIONS",
    edit: "edit",
    unknown: "unknown",
  },

  /** The four actions the mockup draws; two are still inert, with a reason. */
  actions: {
    download: "download",
    open: "open in →",
    openReason: "Read-only previews are not part of M1",
    extract: "extract",
    extractReason: "Archive extraction is not scheduled yet",
    link: "signed link",
    signing: "signing…",
  },
} as const;

export default inspector;
