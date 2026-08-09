/**
 * Exercises the secret store's security properties (TRE-8) without needing a
 * database or a server. Run with: pnpm --filter ./nest-api verify:secrets
 *
 * Every key here is generated at run time — no fixture contains real material.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { SecretStoreService, type EncryptedRecord } from "../src/secrets/secret-store.service";
import { parseMasterKey } from "../src/secrets/master-key";
import { SealedCredential } from "../src/secrets/sealed-credential";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${label}`);
    pass++;
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

function keyEnv(version: number): string {
  return `${version}:${randomBytes(32).toString("base64")}`;
}

function storeWith(current: string, previous?: string): SecretStoreService {
  process.env.TREKKER_MASTER_KEY = current;
  if (previous) process.env.TREKKER_MASTER_KEY_PREVIOUS = previous;
  else delete process.env.TREKKER_MASTER_KEY_PREVIOUS;
  const store = new SecretStoreService();
  store.onModuleInit();
  return store;
}

function reasonOf(run: () => unknown): string {
  try {
    run();
    return "no-error";
  } catch (error) {
    return (error as { reason?: string }).reason ?? "not-a-DecryptError";
  }
}

const KEY_V1 = keyEnv(1);
const KEY_V2 = keyEnv(2);

console.log("== master key validation ==");
for (const [label, value] of [
  ["missing", undefined],
  ["empty", ""],
  ["placeholder", "REPLACE_ME"],
  ["no version prefix", randomBytes(32).toString("base64")],
  ["version zero", `0:${randomBytes(32).toString("base64")}`],
  ["too short", `1:${randomBytes(16).toString("base64")}`],
  ["too long", `1:${randomBytes(48).toString("base64")}`],
] as const) {
  let message = "";
  try {
    parseMasterKey(value, "TREKKER_MASTER_KEY");
  } catch (error) {
    message = (error as Error).message;
  }
  check(`rejects ${label}`, message.includes("TREKKER_MASTER_KEY"), message || "no error thrown");
}
check("accepts a well-formed key", parseMasterKey(KEY_V1, "TREKKER_MASTER_KEY").version === 1);

console.log("\n== round trip ==");
const store = storeWith(KEY_V1);
const hostA = randomUUID();
const hostB = randomUUID();
const secret = randomBytes(1704); // roughly an ed25519 private key in PEM
const record = store.encrypt(secret, hostA);
check("decrypt returns the exact input bytes", store.decrypt(record, hostA).equals(secret));
check("ciphertext is not the plaintext", !Buffer.from(record.ciphertext).includes(secret));
check("iv is 12 bytes", record.iv.length === 12);
check("auth tag is 16 bytes", record.authTag.length === 16);
check("keyVersion recorded", record.keyVersion === 1);

const twice = store.encrypt(secret, hostA);
check("same plaintext encrypts differently each time", !Buffer.from(twice.ciphertext).equals(record.ciphertext));
check("iv differs per record", !Buffer.from(twice.iv).equals(record.iv));

console.log("\n== host binding ==");
check("a record moved to another host row is refused", reasonOf(() => store.decrypt(record, hostB)) === "wrong-host");
check(
  "and that is distinguishable from tampering",
  reasonOf(() => store.decrypt({ ...record, authTag: flip(record.authTag) }, hostA)) === "tampered",
);

console.log("\n== tampering ==");
check(
  "flipped auth tag",
  reasonOf(() => store.decrypt({ ...record, authTag: flip(record.authTag) }, hostA)) === "tampered",
);
check(
  "flipped ciphertext",
  reasonOf(() => store.decrypt({ ...record, ciphertext: flip(record.ciphertext) }, hostA)) === "tampered",
);
check("flipped iv", reasonOf(() => store.decrypt({ ...record, iv: flip(record.iv) }, hostA)) === "tampered");
check(
  "truncated iv is malformed, not tampered",
  reasonOf(() => store.decrypt({ ...record, iv: record.iv.subarray(0, 8) }, hostA)) === "malformed",
);

console.log("\n== key versions ==");
check(
  "a v1 record is unreadable by a v2-only store",
  reasonOf(() => storeWith(KEY_V2).decrypt(record, hostA)) === "unknown-key-version",
);
const rotating = storeWith(KEY_V2, KEY_V1);
check("during rotation a v1 record still decrypts", rotating.decrypt(record, hostA).equals(secret));
check("during rotation new records are written at v2", rotating.encrypt(secret, hostA).keyVersion === 2);
check("isCurrentVersion spots a stale record", !rotating.isCurrentVersion(record));

let sameVersionError = "";
try {
  storeWith(KEY_V1, `1:${randomBytes(32).toString("base64")}`);
} catch (error) {
  sameVersionError = (error as Error).message;
}
check("refuses a previous key with the same version", sameVersionError.includes("same version"), sameVersionError);

console.log("\n== rotation over a full table ==");
const rotateStore = storeWith(KEY_V1);
const rows: Array<{ hostId: string; secret: Buffer; record: EncryptedRecord }> = [];
for (let i = 0; i < 500; i++) {
  const hostId = randomUUID();
  const material = randomBytes(64 + (i % 200));
  rows.push({ hostId, secret: material, record: rotateStore.encrypt(material, hostId) });
}
const rotator = storeWith(KEY_V2, KEY_V1);
let rotated = 0;
for (const row of rows) {
  const plain = rotator.decrypt(row.record, row.hostId);
  row.record = rotator.encrypt(plain, row.hostId);
  plain.fill(0);
  rotated++;
}
check(`re-encrypted ${rotated} rows`, rotated === 500);
check(
  "every row is now v2",
  rows.every((r) => r.record.keyVersion === 2),
);
const afterRotation = storeWith(KEY_V2);
check(
  "every row still decrypts with only the new key",
  rows.every((r) => afterRotation.decrypt(r.record, r.hostId).equals(r.secret)),
);
check(
  "and each is still bound to its own host",
  reasonOf(() => afterRotation.decrypt(rows[0].record, rows[1].hostId)) === "wrong-host",
);

console.log("\n== leak discipline ==");
const thrown = (() => {
  try {
    store.decrypt({ ...record, ciphertext: flip(record.ciphertext) }, hostA);
  } catch (error) {
    return error as Error;
  }
  return new Error("none");
})();
const hex = secret.toString("hex");
check("error message carries no key or ciphertext", !thrown.message.includes(hex) && thrown.message.length < 120);
check("error message is generic", thrown.message === "Credential failed its integrity check.");

function flip(bytes: Uint8Array): Buffer {
  const copy = Buffer.from(bytes);
  copy[0] ^= 0xff;
  return copy;
}

console.log("\n== serialisation guard ==");
const sealed = new SealedCredential(hostA, "PRIVATE_KEY", record);
check(
  "JSON.stringify on a credential throws",
  (() => {
    try {
      JSON.stringify(sealed);
      return false;
    } catch {
      return true;
    }
  })(),
);
check(
  "so does stringifying an object that contains one",
  (() => {
    try {
      JSON.stringify({ host: "x", credential: sealed });
      return false;
    } catch {
      return true;
    }
  })(),
);
check("inspect shows no material", !inspect(sealed).includes(secret.toString("hex").slice(0, 16)));
check("describe() carries only kind and version", JSON.stringify(sealed.describe()) === '{"kind":"PRIVATE_KEY","keyVersion":1}');

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
