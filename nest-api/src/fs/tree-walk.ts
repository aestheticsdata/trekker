import { isDriverError } from "@hosts/drivers/driver-error";

import type { FileEntry, FileKind, HostDriver } from "@hosts/drivers/host-driver";

/**
 * The bounded walk every recursive operation goes through (TRE-21 §1).
 *
 * Four properties, each of which is a bug when it is missing:
 *
 * **It stops.** `chmod -R` on `/` is a request that runs for an hour and then
 * reports success on a machine nobody wanted changed. The walk gives up as soon
 * as it passes the ceiling and the caller refuses with the count, so the answer
 * arrives in seconds and names why.
 *
 * **It never follows a symlink.** `node:fs.chmod` follows them, so descending
 * into — or applying to — a symlink would change whatever it points at, outside
 * the roots included. The guard validated the paths the client sent, not a link
 * discovered three levels down. This is also what `chmod -R` itself does, so
 * the behaviour is the familiar one.
 *
 * Whether a link is *recorded* is the caller's decision, and the two callers
 * genuinely differ (`includeLinks`). A recursive chmod must leave it out: it
 * would change the target. A recursive delete must put it in, because `unlink`
 * on a symlink removes the link and never the target — and because a link left
 * behind keeps its parent directory non-empty, so the `rmdir` above it fails
 * and a delete reports failure over a tree it very nearly removed.
 *
 * **It is post-order.** Children before the directory that holds them, because
 * removing `x` from a directory is precisely the operation that makes its
 * children unreachable: pre-order locks the walk out of the tree it is halfway
 * through changing.
 *
 * **It reports what it could not see.** A directory it cannot list is named
 * rather than silently contributing zero, so a count is never quietly short.
 */

/** Deep enough for any real tree; a defence against a filesystem that loops. */
const MAX_DEPTH = 64;

/**
 * What the walk saw about an entry, alongside the path it recorded.
 *
 * Added for TRE-25, which has to tell an operator how many bytes and how many
 * root-owned files a delete would take with it. `driver.list()` already returns
 * all of this and the walk was discarding it; statting the paths afterwards
 * would be one round trip per entry, which over SSH turns a preview into a
 * minute of waiting.
 */
export interface WalkedEntry {
  path: string;
  kind: FileKind;
  size: number;
  uid: number;
}

export interface Walked {
  /** Post-order: every child appears before the directory that holds it. */
  paths: string[];
  /**
   * One per entry in `paths`, in the same order. Callers that only need to
   * count — TRE-21's does — ignore it; it costs nothing to carry, because
   * nothing here was fetched for it.
   */
  details: WalkedEntry[];
  /** True when the tree is larger than the ceiling; `paths` is then partial. */
  exceeded: boolean;
  /**
   * Directories that could not be listed. They are still in `paths` — changing
   * a directory's own mode is exactly how an unreadable one gets fixed — but
   * nothing under them was seen, and the caller says so rather than reporting a
   * total it cannot stand behind.
   */
  unreadable: string[];
  /**
   * Symlinks passed over. Counted so the UI can say "3 links left unchanged"
   * instead of leaving the user to wonder why the total is short.
   */
  skippedLinks: number;
}

/**
 * Every path under `root`, with `root` itself last.
 *
 * `ceiling` counts entries, not depth: it is the number the user is shown
 * before they confirm, and the number the request is refused with.
 */
export interface WalkOptions {
  /**
   * Record symlinks as entries — never descend through them, which no option
   * enables. Off by default, so the recursive chmod that predates this keeps
   * the behaviour its own tests pin.
   */
  includeLinks?: boolean;
}

export async function walkTree(
  driver: HostDriver,
  root: string,
  ceiling: number,
  options: WalkOptions = {},
): Promise<Walked> {
  const includeLinks = options.includeLinks === true;
  const paths: string[] = [];
  const details: WalkedEntry[] = [];
  const unreadable: string[] = [];
  let skippedLinks = 0;
  let exceeded = false;

  const descend = async (directory: string, depth: number): Promise<void> => {
    if (exceeded) return;

    let entries: FileEntry[];
    try {
      entries = await driver.list(directory);
    } catch (error) {
      // A plain file is not a failure — a recursive change on one is just the
      // change. Anything else is a directory whose contents stayed hidden.
      if (!(isDriverError(error) && error.code === "ENOTDIR")) unreadable.push(directory);
      return;
    }

    for (const entry of entries) {
      if (exceeded) return;

      // Counted either way: the UI says "3 links left unchanged" for a chmod
      // and "3 links removed" for a delete, and both need the number.
      if (entry.kind === "symlink") {
        skippedLinks += 1;
        if (!includeLinks) continue;
      }

      const full = join(directory, entry.name);

      // Descend before recording, which is what makes the order post-order.
      if (entry.kind === "directory" && depth < MAX_DEPTH) {
        await descend(full, depth + 1);
        if (exceeded) return;
      }

      paths.push(full);
      details.push({ path: full, kind: entry.kind, size: entry.size, uid: entry.uid });
      if (paths.length > ceiling) {
        exceeded = true;
        return;
      }
    }
  };

  await descend(root, 1);

  if (!exceeded) {
    paths.push(root);
    // The root is the one entry no `list()` described — it came from the caller,
    // not from a directory listing — so it costs the one stat the rest did not.
    // A root that cannot be statted still belongs in `paths`: it is what the
    // caller asked about, and the operation on it reports its own failure.
    details.push(await describeRoot(driver, root));
  }

  return { paths, details, exceeded, unreadable, skippedLinks };
}

async function describeRoot(driver: HostDriver, root: string): Promise<WalkedEntry> {
  try {
    const stat = await driver.stat(root);
    return { path: root, kind: stat.kind, size: stat.size, uid: stat.uid };
  } catch {
    // Zeroes rather than a guess, and `unknown` so nothing downstream counts it
    // as a directory it is not. A total that is short by one entry is better
    // than a risk line that invents an owner.
    return { path: root, kind: "unknown", size: 0, uid: -1 };
  }
}

function join(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}
