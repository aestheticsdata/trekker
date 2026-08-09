import { Global, Module } from "@nestjs/common";
import { SecretStoreService } from "@secrets/secret-store.service";

@Global()
@Module({
  providers: [SecretStoreService],
  exports: [SecretStoreService],
})
export class SecretStoreModule {}
