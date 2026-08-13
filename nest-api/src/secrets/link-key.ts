import { Injectable, Logger } from "@nestjs/common";
import { type MasterKey, parseMasterKey } from "@secrets/master-key";

/**
 * The key that signs download links (TRE-66), which is deliberately not the key
 * that decrypts credentials.
 *
 * **The separation is the whole ticket.** A signed link is a signing oracle by
 * design: anyone with an account can ask this server to sign a message of their
 * choosing and hand the result to a stranger. That is fine for a key that does
 * nothing else. It is not fine for `TREKKER_MASTER_KEY`, which seals every
 * stored SSH credential in the install — sharing one key between "sign this for
 * me" and "decrypt every machine we own" is how a feature becomes a
 * compromise. Single-purpose keys stay single-purpose.
 *
 * The *format* is shared, and shared by calling `parseMasterKey` rather than by
 * copying it: `<version>:<base64 of 32 bytes>`, the same placeholder refusals,
 * the same generation command in the same error. Two parsers for one format is
 * how the second one ends up accepting a key the first would reject.
 *
 * **Rotation is revocation.** There is no previous-key fallback here, and the
 * absence is the feature: changing this variable invalidates every outstanding
 * link at once, which is the only way to withdraw one that has already been
 * forwarded. `TREKKER_MASTER_KEY_PREVIOUS` exists for the opposite reason — a
 * credential must survive a rotation, and a link must not.
 */

export const LINK_KEY_VAR = "TREKKER_DOWNLOAD_LINK_KEY";

@Injectable()
export class LinkKeyService {
  private readonly logger = new Logger(LinkKeyService.name);
  private key: MasterKey | null = null;

  onModuleInit(): void {
    // Boot fails here rather than at the first link somebody tries to mint,
    // for the same reason the credential key does: discovering a missing key
    // while a person is waiting is a far worse moment than discovering it while
    // a deploy is watching.
    this.key = parseMasterKey(process.env[LINK_KEY_VAR], LINK_KEY_VAR);
    this.logger.log(`Download links signed with ${LINK_KEY_VAR} v${this.key.version}.`);
  }

  current(): MasterKey {
    if (this.key === null) throw new Error("LinkKeyService used before onModuleInit — check the module wiring.");
    return this.key;
  }
}
