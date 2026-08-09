import type { CredentialKind } from "../../generated/prisma/client";
import type { EncryptedRecord } from "@secrets/secret-store.service";

/**
 * A credential as it travels inside the app: the envelope, never the material.
 *
 * `toJSON` throws on purpose. The realistic way a secret escapes is not someone
 * writing `console.log(privateKey)` — it is a credential ending up inside an
 * object that gets serialised: an error payload, a debug log, a response DTO
 * assembled with a spread. Making serialisation fail loudly turns that silent
 * leak into a stack trace during development.
 *
 * Anything the API returns about a credential should be built from
 * `describe()`: the kind and whether one exists, nothing else.
 */
export class SealedCredential {
  constructor(
    readonly hostId: string,
    readonly kind: CredentialKind,
    private readonly envelope: EncryptedRecord,
  ) {}

  /** The envelope, for the secret store alone. */
  unseal(): EncryptedRecord {
    return this.envelope;
  }

  /** The only shape safe to send anywhere. */
  describe(): { kind: CredentialKind; keyVersion: number } {
    return { kind: this.kind, keyVersion: this.envelope.keyVersion };
  }

  toJSON(): never {
    throw new Error(
      "Refusing to serialise a SealedCredential. Use describe() — a credential must never reach a log, a DTO or an error payload.",
    );
  }

  /** Node's console.log and util.inspect go through this, not toJSON. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SealedCredential { hostId: ${this.hostId}, kind: ${this.kind}, <sealed> }`;
  }
}
