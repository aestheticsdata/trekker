/**
 * The terminal: its parser's refusals, `help`, the docked panel, and the
 * command line the modals print (TRE-116).
 */
const terminal = {
  parser: {
    restricted: "Trekker's terminal is a restricted set, not a shell. `help` lists what it takes.",
    notFound: "{name}: command not found",
    operator: "{character} is not something this terminal does",
    operatorHint:
      "No pipes, redirection, substitution or chaining. One command, and it runs through the same guards the buttons do. Quote it — 'a;b' — to mean it as part of a name.",
    unbalancedQuote: "unbalanced {quote} quote",
    chmodNeedsArgs: "chmod needs a mode and something to apply it to",
    chmodExample: "chmod 644 notes.txt",
    notOctal: "{mode} is not an octal mode",
    octalHint: "Three or four octal digits — 644, 0755, 2775.",
    rmNeedsTarget: "rm needs something to remove",
    sshTakesOneHost: "ssh takes one host",
    sshExample: "ssh web-01",
    badFlag: "{name}: {flag} is not one of the flags this takes",
    helpTopic: "help {name}",
    /** `takes` is one of the three below. */
    takes: "{name} takes {takes}",
    takesOneDirectory: "one directory",
    takesOneCommand: "one command",
    takesNothing: "nothing",
  },

  /** Typed paths, grouped for a modal that takes one directory. */
  targets: {
    nothing: "nothing to act on",
    root: "/ is not something this can act on",
    sameDirectory: "every path has to be in the same directory",
    sameDirectoryHint: "The dialogue this opens takes one directory and a list of names. Run it once per directory.",
  },

  /**
   * One line of `help` per command, and the source of the per-command topic
   * too. `help` splits each on ` — `, so that separator is load-bearing.
   */
  usage: {
    ls: "ls [dir] — list a directory in the active pane's listing",
    cd: "cd [dir] — move the active pane. `cd -` goes back, bare `cd` goes home",
    pwd: "pwd — print the active pane's directory",
    du: "du [dir] — scan disk usage, the same walk the strip runs",
    df: "df — filesystems on this host, as the sidebar shows them",
    chmod: "chmod <mode> <path…> — opens the permissions modal, pre-filled",
    rm: "rm [-r] <path…> — opens the delete modal, which asks you to type the name",
    hostname: "hostname — the host this pane is bound to",
    whoami: "whoami — the account the connection uses on that host",
    ssh: "ssh <host> — rebind the active pane to another host, by slug or address",
    clear: "clear — empty the output",
    help: "help [command] — this, or one line about one command",
  },
  /** What `help` prints above the table when asked for no topic. */
  helpIntro: [
    "A restricted set, not a shell. Each line is parsed into one intent and run",
    "through the same guards the buttons use — there is no passthrough.",
  ],

  panel: {
    /** The section's accessible name. */
    label: "Terminal",
    title: "TERMINAL",
    noHost: "no host",
    clear: "clear",
    collapse: "Collapse the terminal",
    output: "Terminal output",
    input: "Terminal input",
    stripHint: "⌥↩ expand to terminal · ↑ history",
    /**
     * What the panel says with nothing in its scrollback — and, since TRE-85,
     * what the collapsed strip offers as its placeholder before anything has
     * been run. One string so the two forms cannot drift.
     */
    emptyScrollback: "a restricted set, not a shell — `help` lists what it takes",
    unbound: "{command}: this pane is not bound to a host",
    hostsPending: "Still reading the host list.",
    pickHost: "Pick one in the sidebar, or `ssh <host>`.",
  },

  /** The note under a modal's command line while a sudo window is open (TRE-29). */
  commandLine: {
    sudoNote:
      "sudo is open on {host}. Entries {user} is refused on are retried as root; everything else runs unelevated, as it would with the window closed.",
    thisHost: "this host",
    thisAccount: "this account",
  },
} as const;

export default terminal;
