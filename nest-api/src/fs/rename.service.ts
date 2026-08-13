import { posix } from "node:path";
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { isDriverError } from "@hosts/drivers/driver-error";
import type { HostDriver } from "@hosts/drivers/host-driver";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { toHttp } from "@fs/driver-http";
import { MAX_PATHS } from "@fs/permissions.service";
import {
  type RenameMapping,
  type RenamePlan,
  isRefused,
  movesOf,
  nameProblem,
  planRename,
  problemsOf,
} from "@fs/rename-plan";

/**
 * Rename, single and by pattern (TRE-22).
 *
 * Two properties hold this together, and both are structural rather than
 * remembered:
 *
 * The plan the modal previews and the plan the batch applies come out of the
 * same call to `planRename`. The preview endpoint returns it; the apply
 * endpoint recomputes it from the same input and refuses if it is not clean.
 * There is no path through this file where a client-supplied list of new names
 * is trusted.
 *
 * And the directory is validated once, as a directory. A rename is derived
 * from the *parent's* resolved path, never from resolving the entry itself —
 * `realpath` follows symlinks, so renaming a link by its resolved path would
 * silently rename whatever it points at, three directories away and possibly
 * outside the roots. Resolving the parent settles containment; the final
 * segment is then joined on, unresolved, which is precisely the entry the user
 * clicked.
 */

export interface RenameOutcome {
  name: string;
  next: string;
  ok: boolean;
  code?: string;
  message?: string;
}

export interface RenameResult {
  /** The directory the batch ran in, as the client named it. */
  directory: string;
  renamed: number;
  results: RenameOutcome[];
  /**
   * Entries put back after a failure part-way through, and entries that could
   * not be put back. The second list is the one that matters: it names files
   * sitting under a temporary name, which nothing else in the app will explain.
   */
  rolledBack: string[];
  stranded: string[];
}

/** Prefix for the two-step rename that unties a cycle. Recognisable in a listing. */
const TEMP_PREFIX = ".trekker-rename-";

@Injectable()
export class RenameService {
  private readonly logger = new Logger(RenameService.name);

  constructor(
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
  ) {}

  /**
   * One entry, one new name (TRE-22 §1). No pattern involved, so no plan and no
   * thread — but the same name rules, from the same function the batch uses.
   */
  async renameOne(userId: string, hostId: string, path: string, newName: string): Promise<RenameResult> {
    const invalid = nameProblem(newName);
    if (invalid) throw new BadRequestException(invalid.message);

    const directory = posix.dirname(path);
    const { driver, realDirectory, denied } = await this.openDirectory(userId, hostId, directory);
    const name = posix.basename(path);

    if (name === "" || name === "/") {
      throw new BadRequestException("That path names a directory root, which has no name to change.");
    }

    const target = posix.join(realDirectory, newName);
    if (denied(posix.join(realDirectory, name)) || denied(target)) {
      throw new BadRequestException("That entry holds Trekker's own key material and cannot be renamed here.");
    }

    // The listing is what makes "already taken" answerable, and it is also the
    // difference between refusing and silently overwriting: POSIX `rename`
    // replaces an existing target without a word.
    const existing = await this.namesIn(driver, realDirectory);
    if (newName !== name && existing.includes(newName)) {
      throw new BadRequestException(`“${newName}” already exists in this directory.`);
    }

    if (newName === name) {
      return { directory, renamed: 0, results: [{ name, next: newName, ok: true }], rolledBack: [], stranded: [] };
    }

    try {
      await driver.rename(posix.join(realDirectory, name), target);
    } catch (error) {
      this.rethrow(error);
    }

    return { directory, renamed: 1, results: [{ name, next: newName, ok: true }], rolledBack: [], stranded: [] };
  }

  /**
   * What the pattern would do, without doing it (TRE-22 §1).
   *
   * Read intent: a preview changes nothing, and someone browsing a read-only
   * root should be able to see what a rename *would* produce before being told
   * they may not run it. The apply below validates the same directory for write.
   */
  async preview(
    userId: string,
    hostId: string,
    paths: readonly string[],
    pattern: string,
    replacement: string,
    global: boolean,
    ignoreCase: boolean,
  ): Promise<RenamePlan & { directory: string }> {
    const directory = this.oneDirectory(paths);
    const { driver, realDirectory } = await this.openDirectory(userId, hostId, directory, "read");
    const existing = await this.namesIn(driver, realDirectory);

    const plan = await planRename({
      names: paths.map((path) => posix.basename(path)),
      existing,
      pattern,
      replacement,
      global,
      ignoreCase,
    });

    return { ...plan, directory };
  }

  /**
   * The same plan, applied (TRE-22 §2).
   *
   * Recomputed here rather than accepted from the client. The preview is a
   * rendering of this computation, not an input to it — a batch that trusted
   * the names it was handed would be a rename endpoint with no collision rules
   * at all, reachable with one `curl`.
   */
  async batch(
    userId: string,
    hostId: string,
    paths: readonly string[],
    pattern: string,
    replacement: string,
    global: boolean,
    ignoreCase: boolean,
  ): Promise<RenameResult> {
    const directory = this.oneDirectory(paths);
    const { driver, realDirectory, denied } = await this.openDirectory(userId, hostId, directory);
    const existing = await this.namesIn(driver, realDirectory);

    const plan = await planRename({
      names: paths.map((path) => posix.basename(path)),
      existing,
      pattern,
      replacement,
      global,
      ignoreCase,
    });

    // Refused in full, before anything moves. Half a pattern rename is worse
    // than none: the entries that did change no longer match the pattern, so
    // the operation cannot simply be run again, and telling which half landed
    // means reading the directory by eye.
    if (isRefused(plan)) throw refusal(plan);

    const moves = movesOf(plan);
    if (moves.length === 0) {
      return { directory, renamed: 0, results: [], rolledBack: [], stranded: [] };
    }

    // The walk-invented-path problem from TRE-52, in its smallest form: the
    // guard saw the directory, not what a pattern would name inside it.
    for (const move of moves) {
      if (denied(posix.join(realDirectory, move.name)) || denied(posix.join(realDirectory, move.next))) {
        throw new BadRequestException(`“${move.name}” holds Trekker's own key material and cannot be renamed here.`);
      }
    }

    return this.applyMoves(driver, directory, realDirectory, moves, existing);
  }

  /**
   * Runs the moves in an order that does not need a free name to exist.
   *
   * A batch is a permutation, and a permutation applied naively fails on
   * itself: `a→b, b→a` refuses at the first step because `b` is still there,
   * even though the finished state is perfectly legal. So the moves whose
   * target is already free go first, which drains every chain, and whatever is
   * left is a cycle — broken by parking one entry under a temporary name, which
   * frees the name the rest of its cycle is waiting on.
   *
   * Cycles are rare and chains are not, and this costs one extra rename per
   * cycle rather than doubling every rename in the batch, which is what
   * parking everything up front would do.
   */
  private async applyMoves(
    driver: HostDriver,
    directory: string,
    realDirectory: string,
    moves: readonly RenameMapping[],
    existing: readonly string[],
  ): Promise<RenameResult> {
    // Keyed by where the entry currently sits, which is what a later move has
    // to wait for. Parking rewrites the key and nothing else.
    const pending = new Map(moves.map((move) => [move.name, move.next]));
    const taken = new Set(existing);
    const results: RenameOutcome[] = [];
    /** Every rename performed, newest last, for the rollback. */
    const done: { from: string; to: string }[] = [];
    /** The original name of anything parked, so a report can name it. */
    const parked = new Map<string, string>();
    /** What was being attempted when it went wrong, for the failure row. */
    let attempting: RenameOutcome = { name: "", next: "", ok: false };

    const move = async (from: string, to: string) => {
      await driver.rename(posix.join(realDirectory, from), posix.join(realDirectory, to));
      done.push({ from, to });
    };

    try {
      while (pending.size > 0) {
        const free = [...pending].filter(([, next]) => !pending.has(next));

        if (free.length === 0) {
          // Everything left is waiting on something else that is waiting: a
          // cycle. One park breaks it, and the loop finds the rest free.
          const [name, next] = [...pending][0];
          const temporary = this.parkingName(name, taken);
          attempting = { name, next: temporary, ok: false };
          await move(name, temporary);
          taken.add(temporary);
          parked.set(temporary, name);
          pending.delete(name);
          pending.set(temporary, next);
          continue;
        }

        for (const [name, next] of free) {
          const reported = parked.get(name) ?? name;
          attempting = { name: reported, next, ok: false };
          await move(name, next);
          pending.delete(name);
          results.push({ name: reported, next, ok: true });
        }
      }
    } catch (error) {
      const undone = await this.rollBack(driver, realDirectory, done);
      return {
        directory,
        renamed: 0,
        // Every earlier rename is reported as failed because it was put back:
        // the batch as a whole did not happen, and a row saying "ok" for an
        // entry now sitting under its original name would be a lie.
        results: [...results.map((result) => ({ ...result, ok: false })), { ...attempting, ...describe(error) }],
        rolledBack: undone.restored,
        stranded: undone.stranded,
      };
    }

    return { directory, renamed: results.length, results, rolledBack: [], stranded: [] };
  }

  /**
   * A name nothing else in the directory holds, that a person finding it can
   * recognise and trace back.
   *
   * The counter is not decoration: two cycles broken in the same millisecond
   * would otherwise pick the same parking name, and the second rename would
   * overwrite the first entry without a word.
   */
  private parkingName(name: string, taken: ReadonlySet<string>): string {
    for (let attempt = 0; ; attempt += 1) {
      // Truncated so prefix + suffix + a long original name still fit inside
      // NAME_MAX — a parking name that the filesystem refuses would turn a
      // cycle into the one failure path this whole routine exists to avoid.
      const candidate = `${TEMP_PREFIX}${attempt.toString(36)}-${name}`.slice(0, 200);
      if (!taken.has(candidate)) return candidate;
    }
  }

  /**
   * Puts back what was already moved, newest first.
   *
   * The ticket asks that a refused batch leave every file untouched, and every
   * *foreseeable* refusal happens before the first rename. This is for the
   * unforeseeable one — a full disk, a revoked permission, a host that went
   * away mid-batch — where the alternative is a directory half-renamed and,
   * worse, an entry sitting under a temporary name that nothing will explain.
   *
   * Best effort, and honest about it: a rollback step that fails is reported
   * rather than swallowed, because that entry is the one a person now has to
   * go and find.
   */
  private async rollBack(
    driver: HostDriver,
    realDirectory: string,
    done: readonly { from: string; to: string }[],
  ): Promise<{ restored: string[]; stranded: string[] }> {
    const restored: string[] = [];
    const stranded: string[] = [];

    for (const step of [...done].reverse()) {
      try {
        await driver.rename(posix.join(realDirectory, step.to), posix.join(realDirectory, step.from));
        restored.push(step.from);
      } catch (error) {
        stranded.push(step.to);
        this.logger.error(`Could not put ${step.to} back to ${step.from}: ${(error as Error).message}`);
      }
    }

    return { restored, stranded };
  }

  /**
   * Every path in one batch must live in one directory.
   *
   * Not a simplification: renaming across directories is a move, which is
   * TRE-23 and has a conflict model of its own. Keeping it out means the two
   * collision rules — "two entries collide" and "the target is taken" — are
   * answerable from a single listing, and that the guard validates one
   * directory instead of trusting a per-path check to have been made.
   */
  private oneDirectory(paths: readonly string[]): string {
    if (paths.length === 0) throw new BadRequestException("No paths given.");
    if (paths.length > MAX_PATHS) {
      throw new BadRequestException(`At most ${MAX_PATHS} paths per request; this one names ${paths.length}.`);
    }

    const directories = new Set(paths.map((path) => posix.dirname(path)));
    if (directories.size > 1) {
      throw new BadRequestException(
        `A rename stays in one directory; this selection spans ${directories.size}. Moving between directories is a copy or a move.`,
      );
    }

    const names = paths.map((path) => posix.basename(path));
    if (names.some((name) => name === "" || name === "." || name === "..")) {
      throw new BadRequestException("A path with no final segment cannot be renamed.");
    }
    if (new Set(names).size !== names.length) {
      throw new BadRequestException("The same entry is named twice in this selection.");
    }

    return [...directories][0];
  }

  /** The driver, the resolved directory, and the denylist predicate, in one step. */
  private async openDirectory(
    userId: string,
    hostId: string,
    directory: string,
    intent: "read" | "write" = "write",
  ): Promise<{ driver: HostDriver; realDirectory: string; denied: (path: string) => boolean }> {
    const driver = await this.driverFor(hostId, userId);
    const validated = await this.guard.validate({ driver, userId, path: directory, intent });
    const denied = await this.guard.localDenial(driver, userId);
    return { driver, realDirectory: validated.realPath, denied };
  }

  private async namesIn(driver: HostDriver, realDirectory: string): Promise<string[]> {
    try {
      return (await driver.list(realDirectory)).map((entry) => entry.name);
    } catch (error) {
      this.rethrow(error);
    }
  }

  private async driverFor(hostId: string, userId: string): Promise<HostDriver> {
    try {
      return await this.factory.forHost(hostId, userId);
    } catch (error) {
      this.rethrow(error);
    }
  }

  /** A driver failure as an HTTP one; anything else exactly as it was. */
  private rethrow(error: unknown): never {
    if (isDriverError(error)) throw toHttp(error);
    throw error;
  }
}

/** The driver's code and a line for the person who has to act on it. */
function describe(error: unknown): { code: string; message: string } {
  if (isDriverError(error)) return { code: error.code, message: humanDriverMessage(error.code) };
  return { code: "EUNKNOWN", message: (error as Error).message };
}

/**
 * The refusal, carrying every problem rather than the first one.
 *
 * 422 rather than 400: the request is well-formed and the pattern compiled —
 * what it produces is unacceptable, and the body says of which entries. The
 * modal renders the same list it was already showing, so the two agree even
 * when a directory changed under the preview.
 */
function refusal(plan: RenamePlan): HttpException {
  const problems = problemsOf(plan);
  const message = plan.error
    ? plan.error
    : problems.length === 1
      ? `${problems[0].name}: ${problems[0].problem.message}`
      : `${problems.length} names collide. Nothing was renamed.`;

  return new HttpException(
    {
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: plan.error ? "EPATTERN" : "ECOLLISION",
      message,
      mappings: plan.mappings,
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function humanDriverMessage(code: string): string {
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "Permission denied on the host.";
    case "ENOENT":
      return "The entry is no longer there.";
    case "EROFS":
      return "The filesystem is mounted read-only.";
    case "EXDEV":
      return "The entry cannot be renamed across filesystems.";
    default:
      return `The host refused the rename (${code}).`;
  }
}
