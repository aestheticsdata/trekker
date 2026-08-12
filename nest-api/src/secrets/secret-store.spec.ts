import { inspect } from "node:util";
import {
  MASTER_KEY_BYTES,
  MASTER_KEY_VAR,
  PREVIOUS_MASTER_KEY_VAR,
  parseMasterKey,
  parsePreviousMasterKey,
} from "@secrets/master-key";
import { SealedCredential } from "@secrets/sealed-credential";
import {
  DecryptError,
  type EncryptedRecord,
  SECRET_ENVELOPE_SIZES,
  SecretStoreService,
  secretsEqual,
} from "@secrets/secret-store.service";

/**
 * The credential vault (TRE-8, TRE-55).
 *
 * This is the code that decrypts every SSH credential on the fleet, and the
 * only test it had was `pnpm verify:secrets` — a script run by hand, which is
 * to say never. Pure and offline: no database, no Redis, so it runs in
 * `pnpm test` and therefore inside the pre-deploy gate.
 *
 * The assertions are on *reasons*, not just on failure. A vault that refuses
 * everything passes a suite that only checks that bad input throws, and the
 * whole design of this file — a host id inside the authenticated plaintext
 * rather than in the AAD — exists to make two of those reasons tell apart.
 */

const { IV_BYTES, AUTH_TAG_BYTES } = SECRET_ENVELOPE_SIZES;

const HOST_A = "host-a";
const HOST_B = "host-b";

/** Deterministic, so a failure reproduces. Real ones come from randomBytes. */
function masterKey(version: number, fill = version): string {
  return `${version}:${Buffer.alloc(MASTER_KEY_BYTES, fill).toString("base64")}`;
}

/**
 * A booted store. The service reads the environment in `onModuleInit` rather
 * than in its constructor, so a test that skips that call is testing a service
 * with no key at all — and would pass on a `decrypt` that never ran.
 */
function bootStore(current: string, previous?: string): SecretStoreService {
  process.env[MASTER_KEY_VAR] = current;
  if (previous === undefined) {
    delete process.env[PREVIOUS_MASTER_KEY_VAR];
  } else {
    process.env[PREVIOUS_MASTER_KEY_VAR] = previous;
  }

  const store = new SecretStoreService();
  store.onModuleInit();
  return store;
}

/** Flips one bit in a copy, leaving the original alone. */
function corrupt(bytes: Uint8Array, index = 0): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[index] ^= 0x01;
  return copy;
}

function expectDecryptError(run: () => unknown, reason: DecryptError["reason"]): DecryptError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(DecryptError);
  const error = caught as DecryptError;
  expect(error.reason).toBe(reason);
  return error;
}

const savedEnv = {
  current: process.env[MASTER_KEY_VAR],
  previous: process.env[PREVIOUS_MASTER_KEY_VAR],
};

afterEach(() => {
  for (const [name, value] of [
    [MASTER_KEY_VAR, savedEnv.current],
    [PREVIOUS_MASTER_KEY_VAR, savedEnv.previous],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("parseMasterKey", () => {
  it("refuses a missing or empty value, and says how to make one", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(() => parseMasterKey(raw, MASTER_KEY_VAR)).toThrow(/TREKKER_MASTER_KEY is required/);
    }
    // The remedy travels with the refusal: an operator who reads this message
    // does not then have to find the command in DEPLOY.md.
    expect(() => parseMasterKey("", MASTER_KEY_VAR)).toThrow(/randomBytes\(32\)/);
  });

  it("refuses the placeholder shipped in the example config", () => {
    // The failure this exists for: an install that deployed the example file
    // unedited and encrypted a fleet's credentials under a key in a public repo.
    for (const placeholder of ["REPLACE_ME", "replace-me", "changeme", "change-me"]) {
      expect(() => parseMasterKey(placeholder, MASTER_KEY_VAR)).toThrow(/still the placeholder/);
    }
  });

  it("refuses a value carrying no version", () => {
    const bare = Buffer.alloc(MASTER_KEY_BYTES, 7).toString("base64");
    expect(() => parseMasterKey(bare, MASTER_KEY_VAR)).toThrow(/no version prefix/);
    // A leading separator is the same mistake with the colon typed anyway.
    expect(() => parseMasterKey(`:${bare}`, MASTER_KEY_VAR)).toThrow(/no version prefix/);
  });

  it("refuses a version that is not a positive integer", () => {
    const body = Buffer.alloc(MASTER_KEY_BYTES, 7).toString("base64");
    for (const version of ["0", "-1", "1.5", "v1", "abc"]) {
      expect(() => parseMasterKey(`${version}:${body}`, MASTER_KEY_VAR)).toThrow(/version must be a positive integer/);
    }
  });

  it("refuses a key that is not 32 bytes once decoded", () => {
    for (const size of [16, 31, 33, 64]) {
      const wrong = `1:${Buffer.alloc(size, 3).toString("base64")}`;
      expect(() => parseMasterKey(wrong, MASTER_KEY_VAR)).toThrow(
        new RegExp(`must decode to ${MASTER_KEY_BYTES} bytes, got ${size}`),
      );
    }
  });

  it("reads the version and the key out of a well-formed value", () => {
    const parsed = parseMasterKey(masterKey(4), MASTER_KEY_VAR);
    expect(parsed.version).toBe(4);
    expect(parsed.key).toEqual(Buffer.alloc(MASTER_KEY_BYTES, 4));
  });

  it("names the variable it was given, so a rotation failure points at the right line", () => {
    expect(() => parseMasterKey("", PREVIOUS_MASTER_KEY_VAR)).toThrow(/TREKKER_MASTER_KEY_PREVIOUS is required/);
  });
});

describe("parsePreviousMasterKey", () => {
  it("treats absent and empty as no rotation in progress", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(parsePreviousMasterKey(raw)).toBeNull();
    }
  });

  it("holds a present one to the same contract as the current key", () => {
    expect(() => parsePreviousMasterKey("nonsense")).toThrow(/no version prefix/);
    expect(parsePreviousMasterKey(masterKey(1))?.version).toBe(1);
  });
});

describe("boot", () => {
  it("refuses a previous key sharing the current version", () => {
    // The rotation that silently does nothing: both variables set, same
    // version, so `keyForVersion` can never tell them apart and every old
    // record decrypts or fails by luck of which key was written last.
    expect(() => bootStore(masterKey(2, 2), masterKey(2, 9))).toThrow(/same version/);
  });

  it("accepts a previous key at a different version", () => {
    const store = bootStore(masterKey(2), masterKey(1));
    expect(store.currentVersion).toBe(2);
  });

  it("fails at boot rather than at the first credential read", () => {
    // Discovering a missing key when someone tries to reach a host is a far
    // worse moment than discovering it at startup.
    expect(() => bootStore("")).toThrow(/is required/);
  });
});

describe("sealing", () => {
  it("round-trips a secret for the host it was sealed for", () => {
    const store = bootStore(masterKey(1));
    // Multi-line, because that is the shape of what actually goes in here, but
    // deliberately not a real PEM header: the pre-commit guard cannot tell a
    // fixture from a leak, and it is right not to try (TRE-5).
    const secret = Buffer.from("the first line of a key\nthe second\nthe third\n");

    const record = store.encrypt(secret, HOST_A);
    expect(store.decrypt(record, HOST_A)).toEqual(secret);
  });

  it("writes an envelope of the shape the columns expect", () => {
    const store = bootStore(masterKey(3));
    const record = store.encrypt(Buffer.from("hunter2"), HOST_A);

    expect(record.iv).toHaveLength(IV_BYTES);
    expect(record.authTag).toHaveLength(AUTH_TAG_BYTES);
    expect(record.keyVersion).toBe(3);
  });

  it("never repeats an IV, so the same secret seals differently every time", () => {
    // GCM's one unforgivable misuse. A fixed IV across two messages under one
    // key leaks their XOR and, worse, the authentication subkey.
    const store = bootStore(masterKey(1));
    const secret = Buffer.from("the same password twice");

    const first = store.encrypt(secret, HOST_A);
    const second = store.encrypt(secret, HOST_A);

    expect(Buffer.compare(Buffer.from(first.iv), Buffer.from(second.iv))).not.toBe(0);
    expect(Buffer.compare(Buffer.from(first.ciphertext), Buffer.from(second.ciphertext))).not.toBe(0);
  });

  it("keeps the plaintext out of the stored bytes", () => {
    const store = bootStore(masterKey(1));
    const secret = Buffer.from("correct-horse-battery-staple");
    const record = store.encrypt(secret, HOST_A);

    expect(Buffer.from(record.ciphertext).includes(secret)).toBe(false);
    // The host id is inside the ciphertext, not beside it — that is the whole
    // point of framing rather than passing it as AAD.
    expect(Buffer.from(record.ciphertext).includes(Buffer.from(HOST_A))).toBe(false);
  });

  it("leaves the caller's plaintext buffer intact", () => {
    // `encrypt` zeroes the frame it built, not the buffer it was handed. A
    // future "optimisation" that framed in place would blank the caller's copy
    // mid-transaction, and the symptom would be a credential that stores fine
    // and fails to connect.
    const store = bootStore(masterKey(1));
    const secret = Buffer.from("still here afterwards");
    store.encrypt(secret, HOST_A);

    expect(secret.toString()).toBe("still here afterwards");
  });

  it("returns a copy, so zeroing the frame does not blank the secret", () => {
    const store = bootStore(masterKey(1));
    const record = store.encrypt(Buffer.from("survives the finally"), HOST_A);

    const out = store.decrypt(record, HOST_A);
    expect(out.toString()).toBe("survives the finally");
    expect(out.every((byte) => byte === 0)).toBe(false);
  });

  it("carries an empty secret and a binary one without special-casing either", () => {
    const store = bootStore(masterKey(1));
    const binary = Buffer.from([0x00, 0xff, 0x00, 0x7f, 0x80]);

    expect(store.decrypt(store.encrypt(Buffer.alloc(0), HOST_A), HOST_A)).toHaveLength(0);
    expect(store.decrypt(store.encrypt(binary, HOST_A), HOST_A)).toEqual(binary);
  });
});

describe("tampering", () => {
  it("refuses an altered ciphertext, IV or tag", () => {
    const store = bootStore(masterKey(1));
    const record = store.encrypt(Buffer.from("a stolen dump is ciphertext"), HOST_A);

    expectDecryptError(() => store.decrypt({ ...record, ciphertext: corrupt(record.ciphertext) }, HOST_A), "tampered");
    expectDecryptError(() => store.decrypt({ ...record, iv: corrupt(record.iv) }, HOST_A), "tampered");
    expectDecryptError(() => store.decrypt({ ...record, authTag: corrupt(record.authTag) }, HOST_A), "tampered");
  });

  it("refuses a record decrypted under the wrong key of the right version", () => {
    // Two installs, both on v1, one database restored into the other.
    const sealed = bootStore(masterKey(1, 1)).encrypt(Buffer.from("not yours"), HOST_A);
    const other = bootStore(masterKey(1, 200));

    expectDecryptError(() => other.decrypt(sealed, HOST_A), "tampered");
  });

  it("says nothing about the record it refused", () => {
    const store = bootStore(masterKey(1));
    const record = store.encrypt(Buffer.from("hunter2"), HOST_A);

    const error = expectDecryptError(
      () => store.decrypt({ ...record, ciphertext: corrupt(record.ciphertext) }, HOST_A),
      "tampered",
    );
    // Not "wrong key", not a byte count, not the host — a decrypt failure is
    // an oracle if it explains itself.
    expect(error.message).toBe("Credential failed its integrity check.");
  });
});

describe("host binding", () => {
  it("refuses a record sealed for another host", () => {
    const store = bootStore(masterKey(1));
    const record = store.encrypt(Buffer.from("root's key for host A"), HOST_A);

    // Handing this back would authenticate against a machine the operator
    // never granted access to — a row copied between host rows in the database.
    expectDecryptError(() => store.decrypt(record, HOST_B), "wrong-host");
  });

  it("tells a moved record apart from a corrupted one", () => {
    // The reason the host id is encrypted alongside the secret instead of being
    // passed as AAD. Under AAD both of these are one failed tag check and the
    // operator cannot tell a restore mistake from an attack.
    const store = bootStore(masterKey(1));
    const record = store.encrypt(Buffer.from("secret"), HOST_A);

    expect(expectDecryptError(() => store.decrypt(record, HOST_B), "wrong-host").reason).toBe("wrong-host");
    expect(
      expectDecryptError(() => store.decrypt({ ...record, ciphertext: corrupt(record.ciphertext) }, HOST_A), "tampered")
        .reason,
    ).toBe("tampered");
  });

  it("does not let one host id pass as another that starts the same way", () => {
    // The length prefix is what makes the split exact. Without it "host" and
    // "host-2" differ only in where the reader decides the id ended.
    const store = bootStore(masterKey(1));
    const record = store.encrypt(Buffer.from("secret"), "host");

    expectDecryptError(() => store.decrypt(record, "host-2"), "wrong-host");
    expect(store.decrypt(record, "host").toString()).toBe("secret");
  });

  it("frames the longest id it can hold, and refuses one it cannot", () => {
    const store = bootStore(masterKey(1));
    const longest = "h".repeat(255);

    expect(store.decrypt(store.encrypt(Buffer.from("ok"), longest), longest).toString()).toBe("ok");
    // Silently truncating here would seal a credential to a host prefix and
    // hand it to every id sharing those 255 bytes.
    expect(() => store.encrypt(Buffer.from("ok"), "h".repeat(256))).toThrow(/too long to frame/);
  });
});

describe("malformed envelopes", () => {
  it("refuses an IV or tag of the wrong length", () => {
    const store = bootStore(masterKey(1));
    const record = store.encrypt(Buffer.from("secret"), HOST_A);

    expectDecryptError(() => store.decrypt({ ...record, iv: new Uint8Array(8) }, HOST_A), "malformed");
    expectDecryptError(() => store.decrypt({ ...record, authTag: new Uint8Array(8) }, HOST_A), "malformed");
  });

  it("checks the shape before choosing a key", () => {
    // Order matters for the diagnosis: a record that is both misshapen and of
    // an unknown version should name the shape, which is the thing an operator
    // can act on without hunting for a key they may not have.
    const store = bootStore(masterKey(1));
    const record = store.encrypt(Buffer.from("secret"), HOST_A);

    expectDecryptError(() => store.decrypt({ ...record, iv: new Uint8Array(8), keyVersion: 99 }, HOST_A), "malformed");
  });

  it("reports the lengths it got, since that is what identifies the bad column", () => {
    const store = bootStore(masterKey(1));
    const record = store.encrypt(Buffer.from("secret"), HOST_A);

    const error = expectDecryptError(() => store.decrypt({ ...record, iv: new Uint8Array(8) }, HOST_A), "malformed");
    expect(error.message).toContain("8-byte IV");
    expect(error.message).toContain(`expected ${IV_BYTES} and ${AUTH_TAG_BYTES}`);
  });
});

describe("unknown key versions", () => {
  it("refuses a record sealed with a key that is not loaded", () => {
    const store = bootStore(masterKey(2));
    const record: EncryptedRecord = { ...store.encrypt(Buffer.from("secret"), HOST_A), keyVersion: 1 };

    const error = expectDecryptError(() => store.decrypt(record, HOST_A), "unknown-key-version");
    // Names the variable to set, because the fix is always the same one.
    expect(error.message).toContain(PREVIOUS_MASTER_KEY_VAR);
    expect(error.message).toContain("v1");
  });

  it("lists both loaded versions while a rotation is in progress", () => {
    const store = bootStore(masterKey(3), masterKey(2));
    const record: EncryptedRecord = { ...store.encrypt(Buffer.from("secret"), HOST_A), keyVersion: 1 };

    const error = expectDecryptError(() => store.decrypt(record, HOST_A), "unknown-key-version");
    expect(error.message).toContain("v3");
    expect(error.message).toContain("v2");
  });
});

describe("rotation", () => {
  it("reads a record sealed with the previous key", () => {
    const old = bootStore(masterKey(1));
    const record = old.encrypt(Buffer.from("sealed before the rotation"), HOST_A);

    const rotating = bootStore(masterKey(2), masterKey(1));
    expect(rotating.decrypt(record, HOST_A).toString()).toBe("sealed before the rotation");
  });

  it("writes with the new key while still reading the old", () => {
    const rotating = bootStore(masterKey(2), masterKey(1));
    expect(rotating.encrypt(Buffer.from("fresh"), HOST_A).keyVersion).toBe(2);
  });

  it("marks the old record stale and the new one current", () => {
    // What `rotate-master-key` walks the table on: a record that answers false
    // here is one that still has to be re-sealed before the old key can be
    // dropped from the environment.
    const old = bootStore(masterKey(1));
    const stale = old.encrypt(Buffer.from("secret"), HOST_A);

    const rotating = bootStore(masterKey(2), masterKey(1));
    expect(rotating.isCurrentVersion(stale)).toBe(false);
    expect(rotating.isCurrentVersion(rotating.encrypt(Buffer.from("secret"), HOST_A))).toBe(true);
  });

  it("re-seals into a record the next boot can read without the old key", () => {
    // The whole rotation, end to end: seal under v1, read it while both are
    // loaded, write it back, then boot with v2 alone and read it again.
    const record = bootStore(masterKey(1)).encrypt(Buffer.from("carried across"), HOST_A);

    const rotating = bootStore(masterKey(2), masterKey(1));
    const resealed = rotating.encrypt(rotating.decrypt(record, HOST_A), HOST_A);

    const after = bootStore(masterKey(2));
    expect(after.decrypt(resealed, HOST_A).toString()).toBe("carried across");
    // And the un-resealed one is now unreadable, which is why the walk has to
    // finish before the variable is removed.
    expectDecryptError(() => after.decrypt(record, HOST_A), "unknown-key-version");
  });
});

describe("secretsEqual", () => {
  it("matches identical bytes and rejects everything else", () => {
    expect(secretsEqual(Buffer.from("SHA256:abc"), Buffer.from("SHA256:abc"))).toBe(true);
    expect(secretsEqual(Buffer.from("SHA256:abc"), Buffer.from("SHA256:abd"))).toBe(false);
  });

  it("returns false on a length mismatch rather than throwing", () => {
    // `timingSafeEqual` throws on unequal lengths, and the SSH driver compares
    // host key fingerprints with this — an exception there would surface as a
    // connection error instead of a refused key.
    expect(secretsEqual(Buffer.from("short"), Buffer.from("much longer"))).toBe(false);
    expect(secretsEqual(Buffer.alloc(0), Buffer.from("x"))).toBe(false);
  });
});

describe("SealedCredential", () => {
  const envelope: EncryptedRecord = {
    ciphertext: Buffer.from("ciphertext"),
    iv: Buffer.alloc(IV_BYTES),
    authTag: Buffer.alloc(AUTH_TAG_BYTES),
    keyVersion: 1,
  };
  const credential = new SealedCredential(HOST_A, "PRIVATE_KEY", envelope);

  it("describes itself with the kind and key version, and nothing else", () => {
    expect(credential.describe()).toEqual({ kind: "PRIVATE_KEY", keyVersion: 1 });
  });

  it("refuses to serialise, however it is reached", () => {
    // The realistic leak is not `console.log(privateKey)` — it is a credential
    // caught up in an object that gets serialised: an error payload, a response
    // DTO assembled with a spread.
    expect(() => credential.toJSON()).toThrow(/Refusing to serialise/);
    expect(() => JSON.stringify(credential)).toThrow(/Refusing to serialise/);
    expect(() => JSON.stringify({ host: { id: HOST_A, credential } })).toThrow(/Refusing to serialise/);
    expect(() => JSON.stringify([credential])).toThrow(/Refusing to serialise/);
  });

  it("redacts under inspect, which is the path console.log takes", () => {
    // Distinct from toJSON: util.inspect never calls it, so a throwing toJSON
    // alone would still let `console.log(credential)` print the envelope.
    const shown = inspect(credential);
    expect(shown).toContain("<sealed>");
    expect(shown).not.toContain("ciphertext");
    expect(inspect({ credential })).toContain("<sealed>");
  });

  it("hands the envelope out only to whoever asks for it by name", () => {
    expect(credential.unseal()).toBe(envelope);
  });
});
