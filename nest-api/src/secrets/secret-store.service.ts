import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  MASTER_KEY_VAR,
  PREVIOUS_MASTER_KEY_VAR,
  type MasterKey,
  parseMasterKey,
  parsePreviousMasterKey,
} from "@secrets/master-key";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM's native nonce size; longer costs an extra GHASH pass.
const AUTH_TAG_BYTES = 16;

/**
 * The stored envelope, mirroring the HostCredentials columns.
 *
 * Uint8Array rather than Buffer because that is what Prisma returns for a
 * `Bytes` column. Declaring Buffer here would mean a cast at every read, and a
 * cast is where a mismatch stops being a compile error.
 */
export interface EncryptedRecord {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
}

/**
 * Why a decrypt failed. These are genuinely different situations:
 *   wrong-host          — intact record, sealed for a different host row
 *   tampered            — the bytes have been altered, or the key is wrong
 *   unknown-key-version — encrypted with a master key we do not have loaded
 *   malformed           — the envelope itself is the wrong shape
 */
export type DecryptFailure = "wrong-host" | "tampered" | "unknown-key-version" | "malformed";

export class DecryptError extends Error {
  constructor(
    readonly reason: DecryptFailure,
    message: string,
  ) {
    super(message);
    this.name = "DecryptError";
  }
}

/**
 * The only code in the app allowed to see a plaintext credential.
 *
 * Threat model: database disclosure, not host compromise. Someone who owns the
 * API host reads the master key out of the process environment and it is over —
 * the README says so rather than pretending otherwise. What this buys is that a
 * leaked dump, a stolen backup or a SQL injection yields ciphertext.
 *
 * **Host binding lives inside the authenticated plaintext, not in the AAD.**
 * The ticket specified AAD, and AAD is the more idiomatic construction, but it
 * cannot satisfy the requirement that a record moved between host rows be
 * *distinguishable* from a corrupted one: both are a failed GCM tag check and
 * nothing more. Encrypting the host id alongside the secret gives the same
 * integrity guarantee — the id is covered by the same tag — while letting a
 * successful decrypt with a mismatched id be reported as exactly that. The
 * security property is identical; only the diagnosis improves.
 */
@Injectable()
export class SecretStoreService implements OnModuleInit {
  private readonly logger = new Logger(SecretStoreService.name);
  private current!: MasterKey;
  private previous: MasterKey | null = null;

  onModuleInit(): void {
    // Boot fails here rather than at the first credential read. Discovering a
    // missing key when someone tries to reach a host is a far worse moment.
    this.current = parseMasterKey(process.env[MASTER_KEY_VAR], MASTER_KEY_VAR);
    this.previous = parsePreviousMasterKey(process.env[PREVIOUS_MASTER_KEY_VAR]);

    if (this.previous) {
      if (this.previous.version === this.current.version) {
        throw new Error(
          `${PREVIOUS_MASTER_KEY_VAR} has the same version as ${MASTER_KEY_VAR}. Bump the version when rotating.`,
        );
      }
      this.logger.warn(
        `Rotation in progress: reading v${this.previous.version} and v${this.current.version}, writing v${this.current.version}.`,
      );
    }

    this.logger.log(`Secret store ready (master key v${this.current.version})`);
  }

  encrypt(plaintext: Buffer, hostId: string): EncryptedRecord {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.current.key, iv);
    const framed = frame(hostId, plaintext);

    try {
      const ciphertext = Buffer.concat([cipher.update(framed), cipher.final()]);
      return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: this.current.version };
    } finally {
      framed.fill(0);
    }
  }

  /**
   * Returns a Buffer the caller should zero once used. Nothing here takes or
   * returns a string: a string cannot be wiped in V8, so a credential that
   * becomes one stays in memory until the GC feels like it.
   */
  decrypt(record: EncryptedRecord, hostId: string): Buffer {
    if (record.iv.length !== IV_BYTES || record.authTag.length !== AUTH_TAG_BYTES) {
      throw new DecryptError(
        "malformed",
        `Envelope has a ${record.iv.length}-byte IV and a ${record.authTag.length}-byte tag; expected ${IV_BYTES} and ${AUTH_TAG_BYTES}.`,
      );
    }

    const key = this.keyForVersion(record.keyVersion);
    if (!key) {
      throw new DecryptError(
        "unknown-key-version",
        `Record was encrypted with master key v${record.keyVersion}; only v${this.current.version}` +
          `${this.previous ? ` and v${this.previous.version}` : ""} are loaded. Set ${PREVIOUS_MASTER_KEY_VAR} to the old key.`,
      );
    }

    const decipher = createDecipheriv(ALGORITHM, key, record.iv);
    decipher.setAuthTag(record.authTag);

    let framed: Buffer;
    try {
      framed = Buffer.concat([decipher.update(record.ciphertext), decipher.final()]);
    } catch {
      // The message deliberately carries no detail about the record.
      throw new DecryptError("tampered", "Credential failed its integrity check.");
    }

    try {
      const { hostId: sealedFor, secret } = unframe(framed);
      if (!constantTimeEqualStrings(sealedFor, hostId)) {
        // Intact, correctly keyed, wrong owner: a row copied between hosts.
        // Handing this back would authenticate against a machine the operator
        // never granted access to.
        throw new DecryptError("wrong-host", "Credential is sealed for a different host.");
      }
      return secret;
    } finally {
      framed.fill(0);
    }
  }

  private keyForVersion(version: number): Buffer | null {
    if (version === this.current.version) return this.current.key;
    if (this.previous && version === this.previous.version) return this.previous.key;
    return null;
  }

  /** True when the record is already sealed with the newest key. */
  isCurrentVersion(record: Pick<EncryptedRecord, "keyVersion">): boolean {
    return record.keyVersion === this.current.version;
  }

  get currentVersion(): number {
    return this.current.version;
  }
}

/** `<1 byte id length><id><secret>` — length-prefixed so the split is exact. */
function frame(hostId: string, secret: Buffer): Buffer {
  const id = Buffer.from(hostId, "utf8");
  if (id.length > 255) throw new Error("Host id too long to frame.");
  return Buffer.concat([Buffer.of(id.length), id, secret]);
}

function unframe(framed: Buffer): { hostId: string; secret: Buffer } {
  const idLength = framed.readUInt8(0);
  if (framed.length < 1 + idLength) {
    throw new DecryptError("malformed", "Decrypted envelope is shorter than its own header.");
  }
  return {
    hostId: framed.subarray(1, 1 + idLength).toString("utf8"),
    // Copied, not a view: the caller keeps this after `framed` is zeroed.
    secret: Buffer.from(framed.subarray(1 + idLength)),
  };
}

function constantTimeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Constant-time equality for secret material. Exported because the SSH driver
 * compares host key fingerprints and must not do it with `===`.
 */
export function secretsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const SECRET_ENVELOPE_SIZES = { IV_BYTES, AUTH_TAG_BYTES } as const;
