import { Worker } from "node:worker_threads";

/**
 * The one function the preview and the apply both call (TRE-22 §1).
 *
 * Nothing here touches a driver, a host or a request. That is the point: the
 * modal's preview and the batch that runs afterwards must be the same
 * computation, and the reliable way to make two callers agree is to give them
 * nothing to disagree about. A preview computed in the browser and an apply
 * computed here would drift on the first difference between two regex engines,
 * and the drift shows up as a destroyed file rather than as a wrong label.
 *
 * The plan is pure and total: it never throws for a bad pattern or a colliding
 * name. Those are results — the modal has to *draw* them — so they come back as
 * problems attached to the rows that have them.
 */

/** POSIX `NAME_MAX` on every filesystem this app will meet. Bytes, not characters. */
export const MAX_NAME_BYTES = 255;

/**
 * How long the pattern gets to run over the whole batch before the thread
 * running it is killed.
 *
 * Generous on purpose: a thousand names against a sane pattern is under a
 * millisecond, so anything approaching this is not a slow pattern, it is a
 * non-terminating one.
 */
export const REGEX_DEADLINE_MS = 2_000;

export type ProblemCode =
  /** Two entries in the batch map onto the same new name. */
  | "duplicate"
  /** The new name is already taken by something the batch is not renaming. */
  | "exists"
  | "empty"
  | "separator"
  | "relative"
  | "nul"
  | "toolong";

export interface RenameProblem {
  code: ProblemCode;
  message: string;
  /** The other entry, for `duplicate` — the modal names both sides. */
  collidesWith?: string;
}

export interface RenameMapping {
  /** The current name, a single path segment. */
  name: string;
  /** What the pattern makes of it. Equal to `name` when nothing matched. */
  next: string;
  changed: boolean;
  /**
   * Where the pattern first matched, for the highlighted span in the preview.
   * Null when it did not match at all. Character offsets into `name`.
   */
  match: { index: number; length: number } | null;
  problem: RenameProblem | null;
}

export interface RenamePlan {
  mappings: RenameMapping[];
  /** How many names the pattern actually changes. The modal's "n of m". */
  changed: number;
  /**
   * The engine's own message when the pattern would not compile, and null
   * otherwise. Not an exception: an unfinished pattern is the normal state of
   * the field while someone is typing into it.
   */
  error: string | null;
}

export interface RenameInput {
  /** The entries to rename, as single path segments in listing order. */
  names: readonly string[];
  /**
   * Every name currently in the directory, including the ones being renamed.
   * What makes "this target is already taken" answerable.
   */
  existing: readonly string[];
  pattern: string;
  replacement: string;
  global: boolean;
  ignoreCase: boolean;
}

/** Every mapping that would actually move, in the order it was given. */
export function movesOf(plan: RenamePlan): RenameMapping[] {
  return plan.mappings.filter((mapping) => mapping.changed);
}

/** True when the plan may not be applied — the CTA reads this, and so does the API. */
export function isRefused(plan: RenamePlan): boolean {
  return plan.error !== null || plan.mappings.some((mapping) => mapping.problem !== null);
}

/** Every problem the plan found, for the refusal message. */
export function problemsOf(plan: RenamePlan): { name: string; problem: RenameProblem }[] {
  return plan.mappings.flatMap((mapping) =>
    mapping.problem ? [{ name: mapping.name, problem: mapping.problem }] : [],
  );
}

/**
 * Applies the pattern and then judges the result.
 *
 * The two halves are deliberately separate: matching is the part that runs
 * somebody else's regex and therefore runs where it can be killed, and judging
 * is arithmetic over strings that has to be readable and directly testable.
 */
export async function planRename(input: RenameInput, deadlineMs = REGEX_DEADLINE_MS): Promise<RenamePlan> {
  const applied = await applyPattern(input, deadlineMs);
  if (!applied.ok) {
    return {
      mappings: input.names.map((name) => ({ name, next: name, changed: false, match: null, problem: null })),
      changed: 0,
      error: applied.message,
    };
  }
  return judge(input, applied.results);
}

/* ---- the judgment ------------------------------------------------------- */

interface Applied {
  next: string;
  /** -1 when the pattern did not match this name. */
  index: number;
  length: number;
}

/**
 * Turns computed names into a plan, with every problem the ticket names.
 *
 * Exported for the property test, which needs to drive this half without
 * spinning up a thread for every generated case.
 */
export function judge(input: RenameInput, results: readonly Applied[]): RenamePlan {
  const mappings: RenameMapping[] = input.names.map((name, index) => {
    const result = results[index];
    return {
      name,
      next: result.next,
      changed: result.next !== name,
      match: result.index >= 0 ? { index: result.index, length: result.length } : null,
      problem: null,
    };
  });

  const moving = mappings.filter((mapping) => mapping.changed);

  // A name that is being renamed away is about to be free, so it does not
  // block anything. A name in the batch that the pattern leaves alone is not:
  // it stays exactly where it is, and something else landing on it would
  // overwrite it — which is the case the `exists` rule below is really for.
  const vacated = new Set(moving.map((mapping) => mapping.name));
  const occupied = new Set(input.existing.filter((name) => !vacated.has(name)));

  // Counted over the moving entries only. A collision with a *stationary*
  // entry is already an `exists` — it is still sitting in the directory — and
  // reporting it twice would say two different things about one problem.
  const targets = new Map<string, string[]>();
  for (const mapping of moving) {
    targets.set(mapping.next, [...(targets.get(mapping.next) ?? []), mapping.name]);
  }

  for (const mapping of moving) {
    const invalid = nameProblem(mapping.next);
    if (invalid) {
      mapping.problem = invalid;
      continue;
    }

    const sharing = targets.get(mapping.next) ?? [];
    if (sharing.length > 1) {
      mapping.problem = {
        code: "duplicate",
        message: `Also the new name of ${sharing.filter((other) => other !== mapping.name).join(", ")}.`,
        collidesWith: sharing.find((other) => other !== mapping.name),
      };
      continue;
    }

    if (occupied.has(mapping.next)) {
      mapping.problem = { code: "exists", message: "Already in this directory, and not being renamed." };
    }
  }

  return { mappings, changed: moving.length, error: null };
}

/**
 * Whether a computed name is a name at all.
 *
 * A rename is never a move (TRE-22 security note), so a replacement that
 * produces `../evil` is refused here rather than resolved later — by the time
 * a path is being resolved, the question "was this supposed to be one segment"
 * can no longer be asked.
 */
export function nameProblem(next: string): RenameProblem | null {
  if (next.length === 0) return { code: "empty", message: "The pattern leaves an empty name." };
  if (next.includes("\0")) return { code: "nul", message: "The new name contains a null byte." };
  if (next.includes("/")) return { code: "separator", message: "A new name is one segment — it cannot contain “/”." };
  if (next === "." || next === "..") return { code: "relative", message: `“${next}” names a directory, not a file.` };
  if (Buffer.byteLength(next, "utf8") > MAX_NAME_BYTES) {
    return { code: "toolong", message: `Longer than the ${MAX_NAME_BYTES} bytes a filename may hold.` };
  }
  return null;
}

/* ---- running somebody else's regex --------------------------------------- */

type PatternResult = { ok: true; results: Applied[] } | { ok: false; message: string };

/**
 * The worker's whole program, as source rather than as a file.
 *
 * `eval: true` because a path would have to resolve identically under
 * `nest start`, under `dist/`, and under ts-jest — three different layouts for
 * one twelve-line script. As a string it has no layout to get wrong.
 *
 * Two compilations of the same pattern: the `g` one does the replacing, and a
 * non-global one finds the first match, because a global regex carries
 * `lastIndex` between calls and would report the highlight of the previous name.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { names, pattern, replacement, global: g, ignoreCase } = workerData;

try {
  const all = new RegExp(pattern, (g ? "g" : "") + (ignoreCase ? "i" : ""));
  const first = new RegExp(pattern, ignoreCase ? "i" : "");
  const results = names.map((name) => {
    const match = first.exec(name);
    all.lastIndex = 0;
    return {
      next: name.replace(all, replacement),
      index: match ? match.index : -1,
      length: match ? match[0].length : 0,
    };
  });
  parentPort.postMessage({ ok: true, results });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message });
}
`;

/**
 * How many patterns may be running at once, process-wide.
 *
 * The deadline below bounds how long one evaluation lasts; this bounds how many
 * there are. Without it, a preview issued per keystroke by ten tabs is ten
 * threads, and a client that stopped debouncing is as many as it can send — each
 * of them entitled to two seconds of a core. Four is well above what one person
 * typing into a pattern field can occupy, and far below what would matter.
 */
const MAX_CONCURRENT = 4;

let running = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return;
  }
  return new Promise<void>((resolve) => {
    waiting.push(() => {
      running += 1;
      resolve();
    });
  });
}

function release(): void {
  running -= 1;
  waiting.shift()?.();
}

/**
 * Runs the pattern over the batch in a thread that can be killed (TRE-22 §3).
 *
 * A user-supplied regex is a plausible way to stop this API without meaning to:
 * catastrophic backtracking does not need malice, and `(a+)+$` against a
 * thirty-character filename is already more steps than a request will ever
 * survive. Nothing in JavaScript interrupts a running `RegExp` — no flag, no
 * signal, no `AbortController` — so the only real timeout is a thread that can
 * be terminated, and that is what this is.
 *
 * One thread per call, which costs a few tens of milliseconds. Pooling one
 * across requests would save that, at the price of a queue where a hung job
 * delays everyone behind it until the deadline expires; a rename preview is
 * debounced keystrokes, not a hot path, so the simple version wins.
 *
 * The heap cap is the second half of the same defence: a pattern cannot hang
 * this thread, and a replacement cannot exhaust the API's memory from it either.
 */
async function applyPattern(input: RenameInput, deadlineMs: number): Promise<PatternResult> {
  await acquire();
  try {
    return await evaluate(input, deadlineMs);
  } finally {
    release();
  }
}

function evaluate(input: RenameInput, deadlineMs: number): Promise<PatternResult> {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      names: [...input.names],
      pattern: input.pattern,
      replacement: input.replacement,
      global: input.global,
      ignoreCase: input.ignoreCase,
    },
    resourceLimits: { maxOldGenerationSizeMb: 64 },
  });

  return new Promise<PatternResult>((resolve) => {
    let settled = false;
    const finish = (result: PatternResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        message: `The pattern is still running after ${deadlineMs / 1000}s over ${input.names.length} names. It is almost certainly backtracking — anchor it, or replace a nested quantifier such as (a+)+ with a single one.`,
      });
    }, deadlineMs);

    worker.on("message", (message: PatternResult) => finish(message));
    // A worker that dies rather than answering: out of memory, or terminated
    // from under us. Reported as a pattern problem because that is what it is
    // — nothing else runs in there.
    worker.on("error", (error: Error) => finish({ ok: false, message: error.message }));
    worker.on("exit", () => finish({ ok: false, message: "The pattern could not be evaluated." }));
  });
}
