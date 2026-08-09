import { randomInt } from "node:crypto";

/**
 * The recovery passphrase is generated, never chosen.
 *
 * It is the one secret that resets an account without any second factor, on an
 * app that holds SSH credentials — so it cannot be left to whatever the user
 * would have typed. Shown once at sign-up and only stored as a bcrypt hash.
 */

// No l, 1, 0 or O: this gets written down on paper more often than not.
const ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
const GROUPS = 4;
const GROUP_LENGTH = 6;

/** 24 characters from a 33-symbol alphabet — a little over 120 bits. */
export function generateRecoveryPassphrase(): string {
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group++) {
    let chars = "";
    for (let index = 0; index < GROUP_LENGTH; index++) {
      // randomInt rejects modulo bias, unlike `randomBytes()[i] % length`.
      chars += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(chars);
  }
  return groups.join("-");
}
