import { HttpException, HttpStatus, Injectable, Logger, BadRequestException } from "@nestjs/common";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { isDriverError } from "@hosts/drivers/driver-error";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { toHttp } from "@fs/driver-http";
import {
  type DeleteRisk,
  assessRisk,
  basename,
  confirmationToken,
  equivalentCommand,
  freedBytes,
  pathDepth,
  tokenMatches,
} from "@fs/delete-plan";
import { isMountPoint, readMountPoints } from "@fs/mount-table";
import { entryCeiling, MAX_PATHS } from "@fs/permissions.service";
import { walkTree } from "@fs/tree-walk";
import { rmArgv } from "@hosts/sudo/sudo-argv";
import { isPermissionRefusal, SudoRunnerService } from "@hosts/sudo/sudo-runner.service";

import type { HostDriver } from "@hosts/drivers/host-driver";
import type { WalkedEntry } from "@fs/tree-walk";

/**
 * Recursive delete (TRE-25) — the one operation in this application with no
 * undo.
 *
 * Everything here is arranged around that. The walk happens before the operator
 * is asked anything, so the number they confirm is the number that will be
 * removed. The refusals are checked before a single entry is unlinked, because
 * a delete that stops halfway has already done the damage it was refused for.
 * And the confirmation is recomputed on this side, so the set that is removed
 * is the set that was agreed to.
 */

/**
 * Below this, a delete is refused outright regardless of the roots: `/` is 0,
 * `/var` is 1, `/var/log` is 2. Not a permission — the roots decide those —
 * but a statement about the shape of the mistake. The shallower a path, the
 * more of a machine leaves with it and the less likely anyone meant it.
 */
export const DEFAULT_MIN_DEPTH = 2;

/**
 * Above this many entries a delete needs an elevated session (TRE-29).
 *
 * `MAX_PATHS` is borrowed deliberately: that constant already means "a
 * selection, not a filesystem", which is exactly the line being drawn. It sits
 * an order of magnitude below the walk's own 10,000 ceiling, so the three
 * refusals a delete can meet say three different things rather than overlapping.
 */
export const DEFAULT_ELEVATION_THRESHOLD = MAX_PATHS;

export function minDepth(): number {
  const override = Number.parseInt(process.env.TREKKER_DELETE_MIN_DEPTH ?? "", 10);
  return Number.isNaN(override) || override < 1 ? DEFAULT_MIN_DEPTH : override;
}

export function elevationThreshold(): number {
  const override = Number.parseInt(process.env.TREKKER_DELETE_ELEVATION_THRESHOLD ?? "", 10);
  return Number.isNaN(override) || override < 1 ? DEFAULT_ELEVATION_THRESHOLD : override;
}

export interface DeletePlan {
  directory: string;
  /** One line per entry the operator selected, not per entry in the tree. */
  targets: DeleteTarget[];
  /** Everything the walk found, including the selected entries themselves. */
  entries: number;
  /** Apparent bytes, summed from the walk. Not disk usage — see the note below. */
  bytes: number;
  risk: DeleteRisk;
  /** What has to be typed. Recomputed on delete and compared. */
  token: string;
  /** Shown so the operation can be read in a language the operator already trusts. */
  command: string;
  /** True when this delete is over the threshold and elevation does not exist yet. */
  needsElevation: boolean;
  threshold: number;
}

export interface DeleteTarget {
  path: string;
  name: string;
  kind: string;
  /** Entries under this one, including itself. 1 for a plain file. */
  entries: number;
  bytes: number;
}

export interface DeleteOutcome {
  /**
   * Entries removed as root because the ordinary unlink was refused (TRE-29).
   * Zero unless a sudo window was open and something inside actually needed it.
   */
  elevated?: number;
  path: string;
  ok: boolean;
  entries: number;
  bytes: number;
  code?: string;
  message?: string;
}

export interface DeleteResult {
  results: DeleteOutcome[];
  entriesRemoved: number;
  bytesFreed: number;
  failed: number;
}

/** One walked target, with everything decided about it before anything is removed. */
interface Surveyed {
  requested: string;
  realPath: string;
  paths: string[];
  details: WalkedEntry[];
  /** Directories the walk could not list, so this target's total is a floor. */
  unreadable: number;
  /** Symlinks that will be unlinked without their targets being touched. */
  links: number;
}

@Injectable()
export class DeleteService {
  private readonly logger = new Logger(DeleteService.name);

  constructor(
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly limits: RateLimitService,
    private readonly sudoRunner: SudoRunnerService,
  ) {}

  /**
   * What this delete would take, walked rather than estimated (TRE-25 §3).
   *
   * Read-only and validated as a write: the question "may I delete this" is
   * answered here, so that the modal never shows a confirmation for something
   * the delete would refuse. Asking as a read would show the operator a plan
   * they cannot execute.
   */
  async plan(userId: string, hostId: string, paths: readonly string[]): Promise<DeletePlan> {
    const driver = await this.driverFor(hostId, userId);
    const surveyed = await this.survey(driver, userId, paths);

    const details = surveyed.flatMap((target) => target.details);
    const bytes = freedBytes(details);
    const entries = details.length;
    const threshold = elevationThreshold();

    return {
      directory: parentOf(paths[0]),
      // The walk pushes the target itself last, so its own kind is the last
      // detail rather than the first — the rest are what is underneath it.
      targets: surveyed.map((target) => ({
        path: target.requested,
        name: basename(target.requested),
        kind: target.details.at(-1)?.kind ?? "unknown",
        entries: target.paths.length,
        bytes: freedBytes(target.details),
      })),
      entries,
      bytes,
      risk: assessRisk(
        details,
        surveyed.reduce((total, target) => total + target.unreadable, 0),
        surveyed.reduce((total, target) => total + target.links, 0),
      ),
      token: confirmationToken(paths),
      command: equivalentCommand(
        paths,
        details.some((entry) => entry.kind === "directory"),
      ),
      needsElevation: entries > threshold,
      threshold,
    };
  }

  /**
   * Remove them.
   *
   * The walk is done again rather than carried over from the plan: minutes may
   * have passed, and the tree that is removed should be the tree that is there,
   * not the one that was described. The token guards the *selection* — which
   * entries — and that has not changed.
   */
  async remove(
    userId: string,
    hostId: string,
    paths: readonly string[],
    token: string,
    sessionId?: string,
  ): Promise<DeleteResult> {
    const expected = confirmationToken(paths);
    if (!tokenMatches(token, expected)) {
      // Deliberately says what was expected. It is not a secret — anything that
      // can name the paths can derive it — and a confirmation that refuses
      // without saying why is a confirmation people learn to fight rather than
      // to read.
      throw new BadRequestException(`Confirmation does not match. Type "${expected}" to delete.`);
    }

    const driver = await this.driverFor(hostId, userId);
    const surveyed = await this.survey(driver, userId, paths);
    const entries = surveyed.reduce((total, target) => total + target.paths.length, 0);

    // Spent in entries rather than in requests: this is the limit that bounds
    // how much a session may destroy, and one request can destroy thousands.
    // Spent before anything is removed, so a refusal costs nothing.
    const verdict = await this.limits.consume(LIMITS.entriesDeleted, userId, entries);
    if (!verdict.allowed) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: "ETOOMANYENTRIES",
          message: `This session has deleted too many entries. Try again in ${verdict.resetSeconds}s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const results: DeleteOutcome[] = [];
    let entriesRemoved = 0;
    let bytesFreed = 0;

    for (const target of surveyed) {
      const outcome = await this.removeTree(driver, target, hostId, sessionId);
      results.push(outcome);
      entriesRemoved += outcome.entries;
      bytesFreed += outcome.bytes;
    }

    const failed = results.filter((result) => !result.ok).length;
    if (failed === results.length) throw allFailed(results);

    return { results, entriesRemoved, bytesFreed, failed };
  }

  /**
   * Every refusal, decided for every target, before any of them is touched.
   *
   * Whole-request rather than per-path, which is where this departs from chmod.
   * A permission change that refuses one path of ten still leaves nine
   * legitimately changed. A delete that refuses one path of ten leaves a tree
   * half gone — and the half that remains is the half nobody can put back.
   */
  private async survey(driver: HostDriver, userId: string, paths: readonly string[]): Promise<Surveyed[]> {
    if (paths.length === 0) throw new BadRequestException("No paths given.");
    if (paths.length > MAX_PATHS) {
      throw new BadRequestException(`At most ${MAX_PATHS} paths per request; this one names ${paths.length}.`);
    }

    const floor = minDepth();
    const ceiling = entryCeiling();
    const denied = await this.guard.localDenial(driver, userId);

    // Read once for the whole request. A null table is not an empty one: it
    // means `df` could not be run, and a delete that cannot see the boundaries
    // is exactly the delete this check exists to stop.
    const mounts = await readMountPoints(driver);
    if (mounts === null) {
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: "ENOMOUNTS",
          message:
            "Cannot read the mount table on this host, so a recursive delete cannot be made safe. Nothing was removed.",
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const roots = await this.guard.resolveRoots(driver, userId);
    const rootPaths = new Set(roots.map((root) => root.realPath));

    const surveyed: Surveyed[] = [];
    let total = 0;

    for (const path of paths) {
      // Validated as a write. Unlike chmod, a refusal here throws for the whole
      // request rather than becoming this path's outcome — see the note above.
      const validated = await this.guard.validate({ driver, userId, path, intent: "write" });
      const realPath = validated.realPath;

      if (pathDepth(realPath) < floor) {
        throw refusal(
          "ETOOSHALLOW",
          `${realPath} is too close to the root of the filesystem to delete. Nothing was removed.`,
        );
      }
      if (rootPaths.has(realPath)) {
        throw refusal(
          "EISROOT",
          `${path} is one of this host's configured roots. Delete what is inside it, not the root itself.`,
        );
      }
      if (isMountPoint(realPath, mounts)) {
        throw refusal("EISMOUNT", `${path} is a mount point. Unmount it rather than deleting through it.`);
      }

      // Links included: `unlink` removes the link and never its target, and one
      // left behind would keep its parent non-empty and fail the rmdir above it.
      const walked = await walkTree(driver, realPath, ceiling, { includeLinks: true });
      if (walked.exceeded) {
        throw new HttpException(
          {
            statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
            code: "ETOOMANY",
            message: `${path} holds more than ${ceiling.toLocaleString("en-GB")} entries. Narrow the selection, or raise the ceiling on the server.`,
            ceiling,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      // A protected path anywhere under the target refuses the whole delete
      // rather than being skipped. Skipping one during a chmod leaves a file
      // unchanged; skipping one here leaves its parent non-empty, so the rmdir
      // fails and the operator is told a delete succeeded while the tree is
      // still standing.
      const protectedPath = walked.paths.find(denied);
      if (protectedPath !== undefined) {
        throw refusal("EDENYLISTED", `${protectedPath} is protected on this host and cannot be deleted.`);
      }

      // A mount point discovered inside the tree is the case this check exists
      // for: the target itself is ordinary and something underneath it is not.
      const crossed = walked.paths.find((walkedPath) => isMountPoint(walkedPath, mounts));
      if (crossed !== undefined) {
        throw refusal(
          "EISMOUNT",
          `${crossed} is a mount point inside ${path}. Unmount it, or delete around it. Nothing was removed.`,
        );
      }

      total += walked.paths.length;
      surveyed.push({
        requested: path,
        realPath,
        paths: walked.paths,
        details: walked.details,
        unreadable: walked.unreadable.length,
        links: walked.skippedLinks,
      });
    }

    const threshold = elevationThreshold();
    if (total > threshold) {
      // TRE-29 turns this into a prompt. Until it exists the answer is no,
      // which is the safe direction for the one operation with no undo.
      throw new HttpException(
        {
          statusCode: HttpStatus.FORBIDDEN,
          code: "ENEEDELEVATION",
          message: `This would remove ${total.toLocaleString("en-GB")} entries, above the ${threshold.toLocaleString("en-GB")} an unelevated session may delete. Elevation arrives in TRE-29; narrow the selection for now.`,
          threshold,
          entries: total,
        },
        HttpStatus.FORBIDDEN,
      );
    }

    return surveyed;
  }

  /**
   * One target and everything under it, post-order.
   *
   * Per entry, not per tree: one file that will not unlink does not abandon the
   * nine hundred that would. What it does do is leave the directories above it
   * non-empty, so their `rmdir` fails too — which is the truth, and the outcome
   * names the first thing that actually went wrong.
   */
  private async removeTree(
    driver: HostDriver,
    target: Surveyed,
    hostId: string,
    sessionId?: string,
  ): Promise<DeleteOutcome> {
    let entries = 0;
    let bytes = 0;
    let elevated = 0;
    let firstError: unknown = null;

    for (const entry of target.details) {
      try {
        // `unlink` for everything that is not a directory — a symlink included,
        // which removes the link and never what it points at. The walk already
        // refused to descend through one.
        if (entry.kind === "directory") {
          await driver.rmdir(entry.path);
        } else {
          await driver.unlink(entry.path);
        }
        entries += 1;
        // Counted the way the plan counted it, so "freed 4.2 MB" after the
        // fact and "frees 4.2 MB" before it are the same arithmetic.
        if (entry.kind !== "directory") bytes += entry.size;
      } catch (error) {
        // A root-owned entry inside a tree the account may otherwise delete
        // (TRE-29). Retried one entry at a time, exactly as the walk found it —
        // `rmArgv` never produces `-r`, so this cannot become a recursive root
        // delete that skips the checks above.
        if (isPermissionRefusal(error) && this.sudoRunner.isOpen(sessionId, hostId)) {
          try {
            await this.sudoRunner.run(driver, sessionId, hostId, "rm", rmArgv(entry.kind, entry.path));
            entries += 1;
            elevated += 1;
            if (entry.kind !== "directory") bytes += entry.size;
            continue;
          } catch (elevatedError) {
            firstError ??= elevatedError;
            continue;
          }
        }
        firstError ??= error;
      }
    }

    if (firstError !== null && entries === 0) {
      return { ...failureOf(target.requested, firstError), entries: 0, bytes: 0, elevated };
    }

    if (firstError !== null) {
      const partial = failureOf(target.requested, firstError);
      this.logger.warn(`Partial delete of ${target.requested}: ${entries} removed, first failure ${partial.code}`);
      return { ...partial, ok: false, entries, bytes, elevated };
    }

    return { path: target.requested, ok: true, entries, bytes, elevated };
  }

  private async driverFor(hostId: string, userId: string): Promise<HostDriver> {
    try {
      return await this.factory.forHost(hostId, userId);
    } catch (error) {
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }
}

function refusal(code: string, message: string): HttpException {
  return new HttpException({ statusCode: HttpStatus.FORBIDDEN, code, message }, HttpStatus.FORBIDDEN);
}

function failureOf(path: string, error: unknown): DeleteOutcome {
  if (isDriverError(error)) {
    return {
      path,
      ok: false,
      entries: 0,
      bytes: 0,
      code: error.code,
      message:
        error.code === "EPERM" || error.code === "EACCES"
          ? "Requires elevation on this host."
          : error.code === "ENOTEMPTY"
            ? "Directory was not empty — something under it could not be removed."
            : error.code === "ENOENT"
              ? "No longer there."
              : `The host refused with ${error.code}.`,
    };
  }

  return { path, ok: false, entries: 0, bytes: 0, code: "EUNKNOWN", message: "The host refused." };
}

function allFailed(results: readonly DeleteOutcome[]): HttpException {
  const first = results[0];
  const status =
    first.code === "EPERM" || first.code === "EACCES"
      ? HttpStatus.FORBIDDEN
      : first.code === "ENOENT"
        ? HttpStatus.NOT_FOUND
        : HttpStatus.BAD_GATEWAY;

  return new HttpException(
    {
      statusCode: status,
      code: first.code,
      message: results.length === 1 ? (first.message ?? "Nothing was deleted.") : "Nothing was deleted.",
      results,
    },
    status,
  );
}

/** The directory a selection was made in, for the modal's heading. */
function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}
