/**
 * Re-encrypts every stored credential under a new master key (TRE-8).
 *
 *   TREKKER_MASTER_KEY_PREVIOUS=<old>  TREKKER_MASTER_KEY=<new>  pnpm rotate-key
 *
 * Both keys must be readable: rows are decrypted with whichever version sealed
 * them and written back under the new one. Safe to run with the API up — each
 * row is its own transaction, and a row already at the new version is skipped,
 * so an interrupted run is resumed by running it again.
 *
 * Full procedure in DEPLOY.md.
 */
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { parseDatabaseUrl } from "../src/config/database-url";
import { loadEnv } from "../src/config/load-env";
import { SecretStoreService } from "../src/secrets/secret-store.service";
import { PrismaClient } from "../generated/prisma/client";

loadEnv();

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const store = new SecretStoreService();
  store.onModuleInit();

  if (!process.env.TREKKER_MASTER_KEY_PREVIOUS) {
    console.error(
      "TREKKER_MASTER_KEY_PREVIOUS is not set. Rotation needs both keys: the old one to read\n" +
        "existing rows and the new one to write them back.",
    );
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb({
      ...parseDatabaseUrl(process.env.DATABASE_URL),
      connectionLimit: 5,
      allowPublicKeyRetrieval: true,
    }),
  });

  const rows = await prisma.hostCredentials.findMany({
    select: { id: true, hostId: true, ciphertext: true, iv: true, authTag: true, keyVersion: true },
  });

  console.log(
    `${rows.length} credential${rows.length === 1 ? "" : "s"}, target version v${store.currentVersion}${dryRun ? " (dry run)" : ""}`,
  );

  let rotated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (store.isCurrentVersion(row)) {
      skipped++;
      continue;
    }

    let plaintext: Buffer | undefined;
    try {
      plaintext = store.decrypt(row, row.hostId);
      const sealed = store.encrypt(plaintext, row.hostId);

      if (!dryRun) {
        // One transaction per row: an interrupted rotation leaves every row
        // either fully old or fully new, never half-written.
        await prisma.$transaction([
          prisma.hostCredentials.update({
            where: { id: row.id },
            data: {
              // Prisma's Bytes wants Uint8Array<ArrayBuffer>; a Node Buffer is
              // Uint8Array<ArrayBufferLike>, which TS will not narrow.
              ciphertext: new Uint8Array(sealed.ciphertext),
              iv: new Uint8Array(sealed.iv),
              authTag: new Uint8Array(sealed.authTag),
              keyVersion: sealed.keyVersion,
            },
          }),
        ]);
      }
      rotated++;
    } catch (error) {
      // Never print the row's contents — only which host is affected.
      failed++;
      console.error(`  host ${row.hostId}: ${(error as Error).message}`);
    } finally {
      plaintext?.fill(0);
    }
  }

  console.log(`rotated ${rotated}, already current ${skipped}, failed ${failed}`);
  if (failed === 0 && !dryRun) {
    console.log(
      `\nDone. Remove TREKKER_MASTER_KEY_PREVIOUS from the config and reload:  pm2 reload trekker-api --update-env`,
    );
  }

  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
