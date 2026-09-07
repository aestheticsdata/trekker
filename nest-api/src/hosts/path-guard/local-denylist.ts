import { access, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * TRE-11 §3 — what the LOCAL host must never serve, even inside an allowed
 * root, even when the root is `/`. Computed once at boot from where the
 * process actually runs, so nothing environment-specific is committed:
 *
 *   - the PM2 config, `ecosystem.config.js`, at each level the deploy can put
 *     it: beside the API package (development), at the install root, and one
 *     above the install root — the deployed layout, where the file sits outside
 *     the tree it launches so that it survives the release swap. On the server
 *     it carries the master key in clear;
 *   - `~/.pm2`, because `pm2 save` copies the resolved environment — master
 *     key included — into dump.pm2;
 *   - `~/.ssh`, the API user's own key material.
 *
 * Without these, one authenticated session reads the key that decrypts every
 * other host's credential, and TRE-8 is decoration.
 *
 * Until TRE-150 the first entry was the install tree whole, and the deploy root
 * above it. That closed everything under `$TREKKER_REMOTE_ROOT` — releases,
 * backups, deploy logs — to the one account that has to manage them, for the
 * sake of a single file. The file is named now and the tree is served like any
 * other directory. Every operation that could carry the file out of a served
 * tree — a zip download, a transfer — asks `PathGuardService.localDenial` about
 * what it walked, the way delete and chmod already did (TRE-52).
 */

export interface DenylistInputs {
  /** Directory to walk up from — `__dirname` in production. */
  startDir: string;
  /** The API user's home — `os.homedir()` in production. */
  homeDir: string;
}

/**
 * The PM2 config's name. `front/ecosystem.config.cjs` and the committed
 * `ecosystem.config.example.js` hold no secrets and are not named.
 */
const PM2_CONFIG = "ecosystem.config.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Entries that exist are resolved; the rest stay literal and still deny. */
async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function computeLocalDenylist({ startDir, homeDir }: DenylistInputs): Promise<string[]> {
  const entries: string[] = [];

  // Nearest ancestor holding a package.json — the API package itself.
  let packageRoot: string | null = null;
  for (let dir = startDir; ; dir = dirname(dir)) {
    if (await exists(join(dir, "package.json"))) {
      packageRoot = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }

  if (packageRoot !== null) {
    // Nearest ancestor holding pnpm-workspace.yaml — the whole install, not
    // just the API package. Nearest, not highest: a stray workspace file
    // higher up (someone's ~/pnpm-workspace.yaml) must not name their home.
    let installRoot = packageRoot;
    for (let dir = packageRoot; ; dir = dirname(dir)) {
      if (await exists(join(dir, "pnpm-workspace.yaml"))) {
        installRoot = dir;
        break;
      }
      if (dirname(dir) === dir) break;
    }

    // Named at all three levels whether or not a file is there today: an entry
    // for a config that does not exist yet still refuses one created there
    // later, and the deploy writes the real one at exactly these paths. A Set,
    // because a package that is its own install root would name the same file
    // twice. The directory is resolved before the name goes on, so an install
    // reached through a symlink still names the file the guard will compare
    // against; the file is resolved again below in case it is itself a link.
    const levels = new Set([packageRoot, installRoot, dirname(installRoot)]);
    for (const level of levels) {
      entries.push(join(await realpathOrSelf(level), PM2_CONFIG));
    }
  }

  entries.push(join(homeDir, ".pm2"), join(homeDir, ".ssh"));

  return Promise.all(entries.map(realpathOrSelf));
}
