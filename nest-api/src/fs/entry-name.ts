import { MAX_NAME_BYTES, nameProblem } from "@fs/rename-plan";

/**
 * Whether a string is a name a new entry may be created under (TRE-69 §1).
 *
 * **A name is not a path**, and that is the whole reason this is a function
 * rather than a line in a service. `POST /fs/mkdir` takes a containing
 * directory and a single segment, joins them, and hands the result to a driver;
 * a `name` of `../../etc/cron.d` would make that join produce a path the guard
 * was never asked about. The guard's job is which directories may be written
 * to. It should not also have to defend against an argument that is trying to
 * be a path, and this refuses one before the guard is reached.
 *
 * The separator, `.`/`..`, NUL, the empty string and the byte ceiling are not
 * restated here: they are `nameProblem` in `rename-plan.ts`, which already
 * answers "is this one path segment" for every rename in the app. One rule set,
 * one message per problem. What is added below is the two a *new* name has that
 * an existing one does not have to survive.
 */

export interface EntryNameProblem {
  /** `space` and `dot` are this module's; the rest come from `nameProblem`. */
  code: string;
  message: string;
}

/** Re-exported so a caller needs one import to state the ceiling in a message. */
export { MAX_NAME_BYTES };

export function entryNameProblem(name: string): EntryNameProblem | null {
  const segment = nameProblem(name);
  if (segment) return { code: segment.code, message: segment.message };

  // Refused rather than trimmed. Trimming would create an entry under a name
  // the operator did not type, and `report ` and `report` are two files in a
  // listing that draws them identically — which is the whole problem.
  if (name !== name.trim()) {
    return { code: "space", message: "A name cannot start or end with a space." };
  }

  // Legal on POSIX and a trap everywhere it is then shared from: Samba and
  // Windows drop a trailing dot silently, so `report.` and `report` become one
  // file on the other side of a share and one of them stops existing.
  if (name.endsWith(".")) {
    return { code: "dot", message: "A name cannot end with a dot." };
  }

  return null;
}
