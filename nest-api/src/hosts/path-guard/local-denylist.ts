import { access, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * TRE-11 §3 — what the LOCAL host must never serve, even inside an allowed
 * root, even when the root is `/`. Computed once at boot from where the
 * process actually runs, so nothing environment-specific is committed:
 *
 *   - the install tree (dev: the repo; deployed: the workspace under
 *     TREKKER_REMOTE_ROOT), because it is Trekker itself;
 *   - the deploy root above it when it holds `ecosystem.config.js` — on the
 *     server that file carries the master key in clear;
 *   - `~/.pm2`, because `pm2 save` copies the resolved environment — master
 *     key included — into dump.pm2;
 *   - `~/.ssh`, the API user's own key material.
 *
 * Without these, one authenticated session reads the key that decrypts every
 * other host's credential, and TRE-8 is decoration.
 */

export interface DenylistInputs {
  /** Directory to walk up from — `__dirname` in production. */
  startDir: string;
  /** The API user's home — `os.homedir()` in production. */
  homeDir: string;
}

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
    // higher up (someone's ~/pnpm-workspace.yaml) must not deny their home.
    let installRoot = packageRoot;
    for (let dir = packageRoot; ; dir = dirname(dir)) {
      if (await exists(join(dir, "pnpm-workspace.yaml"))) {
        installRoot = dir;
        break;
      }
      if (dirname(dir) === dir) break;
    }
    entries.push(installRoot);

    // Deployed layout: the PM2 config with the secrets sits one level above
    // the workspace it launches. In dev the config lives inside the repo, so
    // this simply does not fire.
    const parent = dirname(installRoot);
    if (parent !== installRoot && (await exists(join(parent, "ecosystem.config.js")))) {
      entries.push(parent);
    }
  }

  entries.push(join(homeDir, ".pm2"), join(homeDir, ".ssh"));

  return Promise.all(entries.map(realpathOrSelf));
}
