/**
 * Creates a real account from the command line, on the machine the API runs on.
 *
 * Registration is closed on a deployed instance and should stay that way — an
 * open sign-up on an app that holds SSH credentials is not a feature (TRE-7).
 * This is the way in that does not require opening that door even briefly:
 *
 *   ACCOUNT_EMAIL=you@example.com pnpm --filter ./nest-api account:create
 *
 * The password is generated unless ACCOUNT_PASSWORD is set. The recovery
 * passphrase is *always* generated — the API treats it as the one secret that
 * resets an account with no second factor, so it is never left to whatever
 * someone would have typed.
 *
 * Both are printed once and never again. There is no endpoint that returns
 * them and no way to read them back out of the database, which is the whole
 * point of storing only bcrypt hashes.
 *
 * The first account created on an install becomes its owner (TRE-48) and
 * browses every path on every host it configures, without the roots allowlist
 * binding it. The role is printed below for that reason: this is the one
 * moment a person is looking at the account, so it is where they should learn
 * what it is.
 */
import { randomInt } from "node:crypto";
import { hash } from "bcryptjs";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../generated/prisma/client";
import { parseDatabaseUrl } from "../src/config/database-url";
import { loadEnv } from "../src/config/load-env";
import { MIN_PASSWORD_LENGTH } from "../src/users/dto/add-user.dto";
import { roleFields, roleForNewAccount } from "../src/users/owner";
import { generateRecoveryPassphrase } from "../src/users/recovery-passphrase.util";

// The same cost the API hashes with, so an account made here is
// indistinguishable from one made through the form.
const BCRYPT_ROUNDS = 10;

/** Readable on paper: no l, 1, 0 or O, same reasoning as the passphrase. */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_";

function generatePassword(length = 24): string {
  let password = "";
  for (let index = 0; index < length; index++) password += ALPHABET[randomInt(ALPHABET.length)];
  return password;
}

async function main(): Promise<void> {
  loadEnv();

  const email = process.env.ACCOUNT_EMAIL;
  if (!email) {
    console.error("Set ACCOUNT_EMAIL. See the header of this file.");
    process.exit(1);
  }

  const supplied = process.env.ACCOUNT_PASSWORD;
  if (supplied !== undefined && supplied.length < MIN_PASSWORD_LENGTH) {
    console.error(`ACCOUNT_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters — the API enforces the same.`);
    process.exit(1);
  }

  const password = supplied ?? generatePassword();
  const passphrase = generateRecoveryPassphrase();

  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb(parseDatabaseUrl(process.env.DATABASE_URL)),
  });

  try {
    const existing = await prisma.users.findUnique({ where: { email } });
    if (existing) {
      // Not overwritten silently: replacing a password from a script is a
      // different, more dangerous act than creating an account.
      console.error(`${email} already exists. Delete it first, or use the recovery screen to change its key.`);
      process.exit(1);
    }

    const role = await roleForNewAccount(prisma.users);

    await prisma.users.create({
      data: {
        email,
        passwordHash: await hash(password, BCRYPT_ROUNDS),
        recoveryPassphraseHash: await hash(passphrase, BCRYPT_ROUNDS),
        ...roleFields(role),
      },
    });

    console.log("\nAccount created. These are shown once and cannot be recovered:\n");
    console.log(`  email       ${email}`);
    console.log(`  password    ${password}${supplied ? "  (as supplied)" : "  (generated)"}`);
    console.log(`  passphrase  ${passphrase}`);
    console.log(`  role        ${role}${role === "OWNER" ? "  (browses without the roots allowlist)" : ""}`);
    console.log("\nWrite the passphrase down — it is the only way back into this account.\n");
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: Error) => {
  console.error(`\naccount:create failed: ${error.message}\n`);
  process.exit(1);
});
