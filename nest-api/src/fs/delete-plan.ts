/**
 * What the operator is asked to confirm, and the words they have to type
 * (TRE-25 §3).
 *
 * Pure on purpose: the token is the one part of this feature that has to agree
 * exactly between a browser and a server that never see each other's code, and
 * a function with no I/O is one that can be tested until that agreement is
 * certain.
 */

/** Longer than any single-segment filename a filesystem will hold. */
const MAX_TOKEN_LENGTH = 512;

/**
 * The words that arm the button.
 *
 * One entry is confirmed by its own name, which is what makes the gesture
 * meaningful — typing `production.sql` is a sentence about that file and no
 * other. Several are confirmed by their count, because there is no name to
 * type and a list would be worse than a number.
 *
 * **The server recomputes this from the paths it was actually sent**, which is
 * the whole point of it living here rather than in the modal. It is not a
 * secret and it stops no determined caller: anything that can name the paths
 * can derive the token. What it stops is a client deleting a *different set*
 * than the operator confirmed — three entries agreed to and three hundred sent
 * no longer match the words that were typed, and the request dies before the
 * walk.
 */
export function confirmationToken(paths: readonly string[]): string {
  if (paths.length === 1) return basename(paths[0]);
  return `delete ${paths.length} items`;
}

/**
 * Compared with the separators normalised away and nothing else forgiven.
 *
 * A trailing space is forgiven because a browser's autocomplete adds one and
 * the operator cannot see it. Case is not: `Production.sql` and
 * `production.sql` are two files on any filesystem this application talks to,
 * and treating them as one confirmation would be the wrong lesson to teach at
 * exactly the wrong moment.
 */
export function tokenMatches(typed: string, expected: string): boolean {
  return typed.trim() === expected.trim() && typed.length <= MAX_TOKEN_LENGTH;
}

export interface DeleteRisk {
  /** Directories in the tree. "Recursive" with a number behind it. */
  directories: number;
  /**
   * Entries owned by uid 0. The operator may still be allowed to remove them —
   * a directory they own can hold a root-owned file — and being told beforehand
   * is the difference between a partial failure and a decision.
   */
  rootOwned: number;
  /** Entries whose parent directory could not be listed, so the total is a floor. */
  unreadable: number;
  /** Symlinks that will be unlinked without touching what they point at. */
  links: number;
}

export interface RiskInput {
  kind: string;
  size: number;
  uid: number;
}

/**
 * Bytes a delete would free.
 *
 * Files only. A directory's own size is real — the space its entry table takes
 * — but it is not what anybody means by "space freed", and it varies with the
 * filesystem underneath, so including it makes the total unreproducible between
 * two machines holding the same tree. The apparent size of the files is the
 * figure the walk can stand behind without a second `du`.
 */
export function freedBytes(entries: readonly RiskInput[]): number {
  let bytes = 0;
  for (const entry of entries) {
    if (entry.kind !== "directory") bytes += entry.size;
  }
  return bytes;
}

/** The risk line, counted from the walk rather than estimated from the selection. */
export function assessRisk(entries: readonly RiskInput[], unreadable: number, links: number): DeleteRisk {
  let directories = 0;
  let rootOwned = 0;

  for (const entry of entries) {
    if (entry.kind === "directory") directories += 1;
    if (entry.uid === 0) rootOwned += 1;
  }

  return { directories, rootOwned, unreadable, links };
}

/**
 * The command that would do this in a shell, shown so the operator can read the
 * operation in a language they already trust.
 *
 * Display only — nothing in this application builds a shell string to run, and
 * `ALLOWED_PROGRAMS` contains no shell to run it with. The paths are quoted the
 * way a person would have to quote them, so that what is shown is something
 * they could actually paste.
 */
export function equivalentCommand(paths: readonly string[], recursive: boolean): string {
  const flags = recursive ? "-rf" : "-f";
  return `rm ${flags} ${paths.map(shellDisplay).join(" ")}`;
}

function shellDisplay(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The last segment, with any trailing slash ignored. `/var/log/` is `log`. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * How deep a path sits. `/` is 0, `/var` is 1, `/var/log` is 2.
 *
 * The floor this feeds is not about permissions — the roots decide those. It is
 * about the shape of the mistake: the shallower a path, the more of a machine
 * disappears with it, and the less likely anybody meant it.
 */
export function pathDepth(path: string): number {
  return path.split("/").filter((segment) => segment !== "").length;
}
