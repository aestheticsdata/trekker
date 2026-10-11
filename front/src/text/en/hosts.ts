/**
 * The host manager, its form, the roots editor and the sudo window (TRE-116).
 */
const hosts = {
  manager: {
    /** The dialog's accessible name. */
    dialog: "Hosts",
    listHeading: "HOSTS",
    empty: "No hosts yet. Add the machine the API runs on, or an SSH host.",
    newHost: "+ new host",
    newHostHeading: "NEW HOST",
    idleHeading: "SELECT A HOST",
    closeTooltip: "Close (⎋)",
    close: "Close",
    idle: "Pick a host on the left to open it in this pane, or its name to edit it.",
    saved: "{label} saved",
    deleted: "{label} deleted",
  },
  row: {
    alreadyOpen: "Already open in this pane",
    open: "Open in this pane",
    openNamed: "Open {label} in this pane",
    describeLocal: "local · {home}",
    describeSsh: "{username}@{address}{port}",
    /** Only shown when the port is not the default 22. */
    portSuffix: ":{port}",
    /** Stands in for a username or address the row does not carry. */
    unknown: "?",
  },
  menu: {
    edit: "Edit host…",
  },
  form: {
    labels: {
      name: "name",
      transport: "transport",
      colour: "colour",
      address: "address",
      port: "port",
      username: "username",
      credential: "credential",
      home: "home",
    },
    placeholders: {
      name: "web server",
      address: "host.example.com",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----", // gitleaks:allow — the PEM header as a form hint, never key material
      agentSocket: "/run/user/1000/keyring/ssh",
      home: "/srv",
    },
    transport: {
      label: "Transport",
      local: "local",
      ssh: "ssh",
      localTaken: "This account already has a local host",
      localHint: "The machine the API runs on",
    },
    colourSwatch: "Colour {swatch}",
    credential: {
      stored: "A {kind} is stored. Leave blank to keep it.",
      fresh: "Sent once, encrypted at rest, and never readable again.",
      kindLabel: "Credential kind",
      key: "key",
      password: "password",
      agent: "agent",
    },
    homeHint: {
      owner: "Where a pane opens.",
      member: "Where a pane opens. It must sit inside a root.",
    },
    deletion: {
      warning:
        "Deleting {label} also removes its roots, its stored credential, its pinned keys and its bookmarks. Type the name to confirm.",
      confirmLabel: "Type the host name to confirm deletion",
      delete: "delete",
      keep: "keep",
    },
    actions: {
      saving: "saving…",
      save: "save",
      add: "add host",
      cancel: "cancel",
      delete: "delete",
    },
    failures: {
      acceptKey: "Could not accept the host key.",
      unreachable: "The API could not be reached.",
      pasteSecret: "Paste the {kind} to test with — it is not stored yet.",
    },
  },
  probe: {
    testing: "connecting…",
    test: "test connection",
    authenticated: "authenticated",
    authRefused: "reachable, auth refused",
    unreachable: "unreachable",
    hostKey: "HOST KEY",
    hostKeyAlgorithm: "HOST KEY · {algorithm}",
    unverified: "Taken on first sight and never checked against the host.",
    /** Split around the `<code>` command. */
    compare: {
      before: "Compare it against",
      command: "ssh-keygen -lf {file}",
      after: "on the host itself. Pinning only means something if someone read it once.",
    },
    mismatch: {
      heading: "HOST KEY DOES NOT MATCH",
      pinned: "PINNED",
      neverPinned: "— (this algorithm was never pinned)",
      offered: "OFFERED NOW",
      explanation:
        "The connection was refused during key exchange, before any credential was offered, so nothing was sent to whatever answered. Either the host was rebuilt, or you are not talking to the machine you think you are. Check the fingerprint on the host itself before accepting — not over the connection that is failing.",
      accepting: "accepting…",
      accept: "accept the offered key",
    },
    useHome: "use {dir} as the home",
  },
  roots: {
    heading: "roots",
    /** Split around the `<code>/</code>`. */
    unenforced: {
      before: "You own this install, so these rows are saved without being enforced — your panes resolve against",
      after: ". They bind again the moment this host belongs to an account that is not the owner.",
    },
    pathPlaceholder: "/srv",
    pathLabel: "Root {index} path",
    holdsHome: "The home sits inside this root",
    home: "HOME",
    accessLabel: "Root {index} access",
    read: "read",
    write: "write",
    writeHint: "Write implies read",
    lastRoot: "A host needs at least one root",
    remove: "Remove this root",
    removeLabel: "Remove root {index}",
    empty: "No roots. Nothing about this host is written down as a boundary.",
    add: "+ add root",
  },
  sudo: {
    badge: {
      label: "sudo",
      closed: "sudo closed on {label}",
      closedDetail: "prompts show $",
      closeFailed: "Could not close the sudo window on {label}",
      dropTooltip: "Drop sudo on {label} — {left} left",
      dropLabel: "Drop sudo on {label}, {left} left",
      elevate: "Elevate with sudo on {label}",
    },
    modal: {
      dialog: "Elevate with sudo on {label}",
      heading: "sudo",
      opened: "sudo open on {label}",
      openedDetail: "{left} left · prompts show #",
      sendFailed: "The request could not be sent.",
      asking: "asking the host…",
      askFailed: "{label} could not be asked whether sudo would work.",
      passwordFor: "password for {username}",
      accountPassword: "account password",
      passwordForLabel: "Password for {username}",
      accountPasswordLabel: "Account password",
      window:
        "The window lasts {window} and covers this host only, in this browser session only. Close it early from the badge at any time.",
      cancel: "cancel",
      elevating: "asking sudo…",
      elevate: "elevate",
    },
    explanation: {
      password:
        "This host asks for the account's own login password before it will run sudo. It is sent once, held in the API's memory for the length of the window, and never written down — not beside the SSH credential, not to disk, not to the audit log.",
      none: "This account may run sudo here without a password, so there is nothing to type. Confirming is the whole check.",
      noneWarning:
        "Because sudo asks this account for nothing, the credential Trekker already holds for this host is enough to become root on it. This window records the intent; it cannot add a check the machine does not make.",
      notSudoer:
        "This account is not permitted to run sudo on this host. An administrator has to grant it there before Trekker can use it — nothing typed here will change that.",
      noSudo:
        "There is no sudo on this host, so there is nothing for Trekker to elevate with. Root-owned paths stay read-only.",
    },
  },
} as const;

export default hosts;
