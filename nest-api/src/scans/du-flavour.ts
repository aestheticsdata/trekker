import type { HostDriver } from "@hosts/drivers/host-driver";

/**
 * Which `du` a host has, and therefore which command to run (TRE-32).
 *
 * This is not an optimisation, it is a correctness requirement, and the reason
 * is one flag behaving differently rather than one flag being absent. BSD `du`
 * **accepts** `-B 1` and silently reports 512-byte blocks:
 *
 *   $ du -a -x -B 1 t      $ du -a -x -k t
 *   16   t/a/f1            8    t/a/f1        # the same 5000-byte file
 *
 * A wrong unit is worse than a refused flag by a wide margin. A refusal is
 * visible immediately; a factor of 512 is a disk panel that is confidently
 * wrong, and the ticket's own acceptance test — "the total matches `du -sh` run
 * manually" — is exactly the thing it breaks. So the flavour is probed rather
 * than assumed, and the portable rung uses `-k` and multiplies.
 *
 * Cached per host for the lifetime of the process, not stored on the row: a
 * host's coreutils can change under us, and a stale column would be a wrong
 * unit again with nothing to notice it. A probe costs one round trip on the
 * first scan of a host and nothing after that.
 */

export type ScanFlavour = "GNU" | "PORTABLE" | "SUBTOTALS";

export interface DuRung {
  flavour: ScanFlavour;
  /** Argv after the program, with the root appended by the caller. */
  args: readonly string[];
  /** Records are NUL-terminated rather than newline-terminated. */
  nullTerminated: boolean;
  /** Multiply the reported figure by this to get bytes. */
  unitBytes: number;
  /** Records carry an mtime, so the age fact can be gathered. */
  hasTime: boolean;
  /** Records exist for files, not only directories. */
  hasFiles: boolean;
}

/**
 * The ladder, richest first. Each rung is tried in order and demoted only on
 * evidence that the host refused it — see `shouldDemote`.
 *
 * `--` closes the option list so a root beginning with `-` is a path.
 * `quoteArgument` stops shell injection; it does nothing about a path that
 * looks like a flag.
 */
export const DU_RUNGS: readonly DuRung[] = Object.freeze([
  {
    // GNU coreutils, everything.
    flavour: "GNU",
    args: ["-x", "-a", "-0", "-B1", "--time", "--time-style=+%s", "--"],
    nullTerminated: true,
    unitBytes: 1,
    hasTime: true,
    hasFiles: true,
  },
  {
    // GNU before 8.6, which has --time but not -0. Newline-terminated, so a
    // filename containing a newline corrupts one record; the parser drops those
    // rather than trusting them.
    flavour: "GNU",
    args: ["-x", "-a", "-B1", "--time", "--time-style=+%s", "--"],
    nullTerminated: false,
    unitBytes: 1,
    hasTime: true,
    hasFiles: true,
  },
  {
    // BSD and busybox: per-file records, KiB, no mtime. `-k` and never `-B 1`.
    flavour: "PORTABLE",
    args: ["-x", "-a", "-k", "--"],
    nullTerminated: false,
    unitBytes: 1024,
    hasTime: false,
    hasFiles: true,
  },
  {
    // The floor: subtotals only. A treemap and no facts at all.
    flavour: "SUBTOTALS",
    args: ["-x", "-k", "--"],
    nullTerminated: false,
    unitBytes: 1024,
    hasTime: false,
    hasFiles: false,
  },
]);

/**
 * The same question for one directory's total (TRE-107).
 *
 * Two rungs where the walk has four, and the two that vanish say something
 * about what `-s` is. `--time` and `-a` exist so a scan can gather facts about
 * individual files; a size column wants one number. `-0` exists so a filename
 * containing a newline cannot corrupt the record it sits in; here the record is
 * `<bytes>\t<path>` for a single directory named on the command line, so the
 * number is already complete before any part of the name is read, and nothing a
 * name can contain reaches it.
 *
 * **`-x` is deliberately absent**, and this is the one place these rungs
 * disagree with the walk's. A scan asks what is on *this disk* and stops at a
 * mount point, which is why `DU_RUNGS` carries it. This column answers "what is
 * inside this directory", and a subtree that happens to live on another
 * filesystem is still inside it — stopping there would report a folder as
 * nearly empty for a reason invisible to the person reading the number.
 */
export interface DuSizeRung {
  flavour: ScanFlavour;
  /** Argv after the program, with the one directory appended by the caller. */
  args: readonly string[];
  /** Multiply the reported figure by this to get bytes. */
  unitBytes: number;
}

export const DU_SIZE_RUNGS: readonly DuSizeRung[] = Object.freeze([
  // GNU coreutils: bytes, exactly.
  { flavour: "GNU", args: ["-s", "-B1", "--"], unitBytes: 1 },
  // BSD and busybox, which accept `-B 1` and answer in 512-byte blocks anyway.
  // `-k` and a multiplication, for the reason the file opens with.
  { flavour: "PORTABLE", args: ["-s", "-k", "--"], unitBytes: 1024 },
]);

/** The `-s` rung index to start from, given a probe. */
export function firstSizeRung(probe: Probe): number {
  return probe.gnu ? 0 : 1;
}

/**
 * Whether a rung's failure means "this host does not understand that flag".
 *
 * **Never on exit 1.** GNU `du` exits 1 when it could not read some subtree and
 * still prints everything it could, which is the commonest successful scan of a
 * system directory there is. Demoting on it would drop every such host to the
 * portable rung and lose the facts for no reason.
 *
 * The signal is a usage complaint with nothing on stdout: a `du` that rejected
 * a flag never started walking.
 */
const REFUSAL = /unrecognized option|illegal option|invalid option|unknown option|usage:/i;

export function shouldDemote(result: { code: number | null; stdout: string; stderr: string }): boolean {
  if (result.stdout.trim().length > 0) return false;
  if (result.code !== null && result.code >= 2) return true;
  return REFUSAL.test(result.stderr);
}

/**
 * Whether the host has a usable `nice`.
 *
 * A login shell that cannot find it answers 127, and `nice` refusing on its own
 * behalf answers 125 or 126. All three are unambiguous here because the only
 * program ever run under this prefix is `du`, which exits 0 or 1.
 */
export function isNiceFailure(code: number | null): boolean {
  return code !== null && code >= 125 && code <= 127;
}

interface Probe {
  flavour: ScanFlavour;
  gnu: boolean;
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * The probe's cache, keyed by host. A `Map` on a module rather than on an
 * injectable, because it holds no state worth injecting and every consumer
 * wants the same answer.
 */
const probed = new Map<string, Probe>();

/**
 * Ask the host which `du` it has.
 *
 * `du --version` is the question, and its *failure* is as informative as its
 * success: GNU answers with "GNU coreutils", and everything else refuses the
 * flag. Only the top of the ladder is chosen here — the rungs below it are
 * reached by demotion when a flag is actually refused, because there is no
 * version string that reliably predicts which of them a busybox build wants.
 */
export async function probeFlavour(driver: HostDriver): Promise<Probe> {
  const cached = probed.get(driver.hostId);
  if (cached) return cached;

  let gnu = false;
  try {
    const result = await driver.exec("du", ["--version"], { timeoutMs: PROBE_TIMEOUT_MS });
    gnu = result.code === 0 && /GNU coreutils/i.test(result.stdout);
  } catch {
    // A host that cannot answer the probe still gets a scan — from the portable
    // rung, which asks for nothing unusual. The error, if it is a real one, will
    // arrive again on the walk with a better message.
  }

  const probe: Probe = { flavour: gnu ? "GNU" : "PORTABLE", gnu };
  probed.set(driver.hostId, probe);
  return probe;
}

/** The rung index to start from, given a probe. */
export function firstRung(probe: Probe): number {
  return probe.gnu ? 0 : 2;
}

/** Drop a host's probe — on delete, or when its credential changes. */
export function forgetFlavour(hostId: string): void {
  probed.delete(hostId);
}

/** Test seam: the cache is module state and a spec must be able to clear it. */
export function forgetAllFlavours(): void {
  probed.clear();
}
