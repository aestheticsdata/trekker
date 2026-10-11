/**
 * The zod schemas' messages. Read at module scope, on purpose — see
 * `src/text/index.ts`.
 */
const validation = {
  auth: {
    email: "That does not look like an email address.",
    keySignIn: "The key is at least {min} characters.",
    keyRegister: "A new key must be at least {min} characters.",
    passphraseMin: "The recovery passphrase must be at least {min} characters.",
    passphraseRequired: "The recovery passphrase is required.",
    keysMismatch: "The two keys do not match.",
    passphrasesMismatch: "The two passphrases do not match.",
  },
  host: {
    pathRequired: "A path is required.",
    pathMax: "A path is at most {max} characters.",
    pathAbsolute: "A path must be absolute — start it with /.",
    nameRequired: "A name is required.",
    nameMax: "At most 64 characters.",
    colour: "A colour is six hex digits, e.g. #7fa8c9.",
    rootsRequired: "A host with no roots can serve nothing.",
    port: "A port is a whole number from 1 to 65535.",
    addressRequired: "An SSH host needs an address.",
    usernameRequired: "An SSH host needs a username.",
    credentialRequired: "An SSH host needs a {credential} to connect with.",
    homeOutsideRoots: "The home sits outside every root, so this host would open on a refusal.",
    /** What each credential kind actually asks you to paste. */
    credentialKinds: {
      PRIVATE_KEY: "private key",
      PASSWORD: "password",
      AGENT: "agent socket",
    },
  },
} as const;

export default validation;
