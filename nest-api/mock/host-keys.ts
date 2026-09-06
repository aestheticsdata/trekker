import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { utils } from "ssh2";
import type { RemoteSlug } from "./manifest";
import { remoteHome } from "./tree";

/**
 * Each remote machine's host key (TRE-148): an ed25519 pair under
 * `<mock home>/hosts/<slug>/keys/`, made once by whoever asks first — the
 * loader, to pin its fingerprint on the host row, or `sshd.ts`, to present it —
 * and kept across `pnpm mock` runs, because a pin that no longer matches the
 * key a server presents is a refused connection until somebody accepts it
 * again. `ssh2` makes the pair itself: no `ssh-keygen`, nothing outside node.
 */

const ALGORITHM = "ssh-ed25519";

export function hostKeyPath(slug: RemoteSlug): string {
  return join(remoteHome(slug), "keys", "ssh_host_ed25519_key");
}

/** The private key in OpenSSH form, as `ssh2.Server` takes it. Made if it is not there. */
export function hostPrivateKey(slug: RemoteSlug): string {
  const path = hostKeyPath(slug);
  if (!existsSync(path)) {
    const pair = utils.generateKeyPairSync("ed25519", { comment: slug });
    mkdirSync(join(remoteHome(slug), "keys"), { recursive: true });
    writeFileSync(path, pair.private, { encoding: "utf8", mode: 0o600 });
    writeFileSync(`${path}.pub`, `${pair.public}\n`, { encoding: "utf8", mode: 0o644 });
  }
  return readFileSync(path, "utf8");
}

/**
 * What the API pins: the algorithm as it comes off the wire, and
 * `SHA256:<unpadded base64>` of the public key blob — byte for byte what
 * `fingerprintOf` in `ssh-connection.pool.ts` computes, and what `ssh-keygen
 * -lf` prints.
 */
export function hostKeyPin(slug: RemoteSlug): { algorithm: string; fingerprint: string } {
  hostPrivateKey(slug);
  const line = readFileSync(`${hostKeyPath(slug)}.pub`, "utf8").trim();
  const [type, blob] = line.split(/\s+/);
  if (type !== ALGORITHM || !blob) throw new Error(`${hostKeyPath(slug)}.pub is not an ${ALGORITHM} key`);
  const digest = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "");
  return { algorithm: ALGORITHM, fingerprint: `SHA256:${digest}` };
}
