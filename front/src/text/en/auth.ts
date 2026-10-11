/** The four public screens and their shared frame (TRE-15). */
const auth = {
  title: "TREKKER",
  /** Any failure that is not the API's own answer. */
  unreachable: "The API could not be reached.",
  links: {
    signIn: "sign in",
    register: "register",
    recover: "recover",
    about: "about",
  },
  fields: {
    identity: "Identity",
    key: "Key",
    confirmKey: "Confirm key",
    newKey: "New key",
    confirmNewKey: "Confirm new key",
    recoveryPassphrase: "Recovery passphrase",
    confirmPassphrase: "Confirm passphrase",
    // `show` becomes `hide` on the click, so the text is no handle.
    reveal: "show",
    conceal: "hide",
  },
  /** The strength meter's word, indexed by score; nothing typed reads as nothing. */
  strength: ["", "weak", "fair", "good", "strong"],
  login: {
    subtitle: "Sign in",
    // `CONNECT` reads `CONNECTING…` for the length of the request.
    submit: "CONNECT",
    submitting: "CONNECTING…",
  },
  signup: {
    subtitle: "Register",
    closed:
      "Registration is closed on this instance. An open sign-up on an app that stores SSH keys is not a feature — whoever runs it opens registration deliberately.",
    noRecoveryEmail:
      "There is no recovery email. The passphrase below is the only way back into this account — write it down before you continue.",
    passphraseHint: "At least {count} characters. A sentence works better than a word.",
    submit: "CREATE ACCOUNT",
    submitting: "CREATING…",
    submitClosed: "REGISTRATION CLOSED",
  },
  recover: {
    subtitle: "Recover",
    submit: "REPLACE KEY",
    submitting: "REPLACING…",
    done: {
      subtitle: "Key replaced",
      body: "The key is replaced and every existing session has been signed out — including any this account had open elsewhere. Sign in with the new one.",
      signIn: "SIGN IN",
    },
  },
  about: {
    subtitle: "About",
    /** The legal notice, same rows as a sibling app's about page (TRE-15 §1). */
    notice: [
      "Website hosted by OVH SAS",
      "Registered office: 2 rue Kellermann — 59100 Roubaix — France",
      "APE code 2620Z",
      "VAT no.: FR 22 424 761 419",
    ],
    // The domain is deliberate and stays: it is the operator's published
    // identity, which is a legal requirement, not an infrastructure leak.
    // Recorded here so TRE-5's sweeps stop re-raising it.
    operator: "trekker · 1991computer.com",
  },
} as const;

export default auth;
