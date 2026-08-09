/**
 * Master key handling for the credential store (TRE-8).
 *
 * The key decrypts every stored SSH credential, so it must live outside every
 * path Trekker is allowed to browse — otherwise an authenticated user browsing
 * the local host reads the key that unlocks every other machine, and the
 * encryption is theatre. TRE-11's denylist enforces that; this file only
 * refuses to run with a key that is obviously wrong.
 */

export const MASTER_KEY_VAR = "TREKKER_MASTER_KEY";
export const PREVIOUS_MASTER_KEY_VAR = "TREKKER_MASTER_KEY_PREVIOUS";

export const MASTER_KEY_BYTES = 32;

/** Values shipped in the example config. Refusing them is the point. */
const PLACEHOLDERS = new Set(["REPLACE_ME", "replace-me", "changeme", "change-me"]);

export interface MasterKey {
  version: number;
  key: Buffer;
}

/**
 * Parses `<version>:<base64>`, e.g. `1:Ux9…`. The version travels with the key
 * rather than being a separate variable, so the pair cannot be set
 * inconsistently — the commonest way a rotation goes wrong.
 */
export function parseMasterKey(raw: string | undefined, variableName: string): MasterKey {
  if (!raw || raw.trim() === "") {
    throw new Error(
      `${variableName} is required. Generate one with: node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  if (PLACEHOLDERS.has(raw.trim())) {
    throw new Error(`${variableName} is still the placeholder from ecosystem.config.example.js. Generate a real one.`);
  }

  const separator = raw.indexOf(":");
  if (separator < 1) {
    throw new Error(
      `${variableName} must be "<version>:<base64 key>", e.g. "1:Ux9...". Got a value with no version prefix.`,
    );
  }

  const version = Number(raw.slice(0, separator));
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`${variableName} version must be a positive integer, got "${raw.slice(0, separator)}".`);
  }

  const key = Buffer.from(raw.slice(separator + 1), "base64");
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `${variableName} must decode to ${MASTER_KEY_BYTES} bytes, got ${key.length}. Generate one with: node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  return { version, key };
}

/** The previous key is optional and only present during a rotation. */
export function parsePreviousMasterKey(raw: string | undefined): MasterKey | null {
  if (!raw || raw.trim() === "") return null;
  return parseMasterKey(raw, PREVIOUS_MASTER_KEY_VAR);
}
