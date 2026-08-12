import { isDriverError } from "@hosts/drivers/driver-error";

import type { FileEntry, HostDriver } from "@hosts/drivers/host-driver";

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
 * **It never follows a symlink, and never changes one.** `node:fs.chmod`
 * follows them, so descending into — or applying to — a symlink would change
 * whatever it points at, outside the roots included. The guard validated the
 * paths the client sent, not a link discovered three levels down. This is also
 * what `chmod -R` itself does, so the behaviour is the familiar one.
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

export interface Walked {
  /** Post-order: every child appears before the directory that holds it. */
  paths: string[];
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
export async function walkTree(driver: HostDriver, root: string, ceiling: number): Promise<Walked> {
  const paths: string[] = [];
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

      if (entry.kind === "symlink") {
        skippedLinks += 1;
        continue;
      }

      const full = join(directory, entry.name);

      // Descend before recording, which is what makes the order post-order.
      if (entry.kind === "directory" && depth < MAX_DEPTH) {
        await descend(full, depth + 1);
        if (exceeded) return;
      }

      paths.push(full);
      if (paths.length > ceiling) {
        exceeded = true;
        return;
      }
    }
  };

  await descend(root, 1);
  if (!exceeded) paths.push(root);
  return { paths, exceeded, unreadable, skippedLinks };
}

function join(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}
