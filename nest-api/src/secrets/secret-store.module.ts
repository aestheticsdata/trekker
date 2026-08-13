import { Global, Module } from "@nestjs/common";
import { LinkKeyService } from "@secrets/link-key";
import { SecretStoreService } from "@secrets/secret-store.service";

/**
 * Both keys, side by side, and deliberately not one key used twice — see
 * `link-key.ts` for why a signing oracle must not share a key with the store
 * that seals every SSH credential in the install (TRE-66).
 */
@Global()
@Module({
  providers: [SecretStoreService, LinkKeyService],
  exports: [SecretStoreService, LinkKeyService],
})
export class SecretStoreModule {}
