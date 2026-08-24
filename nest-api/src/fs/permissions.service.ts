import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { isDriverError } from "@hosts/drivers/driver-error";
import type { HostDriver } from "@hosts/drivers/host-driver";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { toHttp } from "@fs/driver-http";
import { octalMode } from "@fs/file-row";
import { IdResolverService } from "@fs/id-resolver.service";
import { PermissionSnapshotService, type SnapshotEntry } from "@fs/permission-snapshot.service";
import { walkTree } from "@fs/tree-walk";
import type { SudoOnlyProgram } from "@hosts/drivers/shell-quote";
import { chmodArgv, chownArgv } from "@hosts/sudo/sudo-argv";
import { isPermissionRefusal, SudoRunnerService } from "@hosts/sudo/sudo-runner.service";

/**
 * chmod and chown (TRE-21) — the first thing in this application that changes
 * another machine.
 *
 * Every path goes through the TRE-11 guard with `intent: "write"` before a
 * driver sees it, and the driver is then given the *resolved* path the guard
 * returned. A recursive change walks from there and never leaves it.
 */

export const DEFAULT_ENTRY_CEILING = 10_000;

/**
 * Above this many entries a recursive change is refused rather than started.
 * The ceiling is not about load — it is about a person clicking "recursive" on
 * a directory they have not looked inside.
 *
 * Read per call rather than frozen at import, alone among this codebase's
 * knobs: the refusal message tells the operator they may raise it, and a
 * setting that only takes effect at the next restart makes that advice half
 * true. One `parseInt` on a path that is about to walk a filesystem is not a
 * cost worth optimising.
 */
export function entryCeiling(): number {
  const override = Number.parseInt(process.env.TREKKER_RECURSIVE_ENTRY_CEILING ?? "", 10);
  return Number.isNaN(override) || override < 1 ? DEFAULT_ENTRY_CEILING : override;
}

/** One request may name this many paths. A selection, not a filesystem. */
export const MAX_PATHS = 1_000;

/**
 * The same change, spelled as a command, for when SFTP is refused (TRE-29).
 *
 * Every operation that can be elevated has to supply one, and the type is what
 * makes that a compile error rather than an omission: SFTP cannot be sudo'd, so
 * an operation with no command form simply cannot escalate, and finding that
 * out at the call site beats finding it out on a root-owned file.
 */
export interface ElevatedForm {
  program: SudoOnlyProgram;
  argv: (path: string) => string[];
}

export interface PathOutcome {
  path: string;
  ok: boolean;
  /** Entries actually changed under this path. 1 unless recursive. */
  entries: number;
  /**
   * How many of this path's entries had to go through sudo (TRE-29). Absent or
   * zero on every operation that needed no privilege it did not already have.
   */
  elevated?: number;
  /** Driver code when it failed — EPERM, EACCES, ENOENT. */
  code?: string;
  message?: string;
}

export interface ChangeResult {
  results: PathOutcome[];
  changed: number;
  failed: number;
  /**
   * Entries changed as root because the ordinary attempt was refused (TRE-29).
   * Zero when no sudo window was open, and zero when one was but nothing
   * needed it — which is the common case and worth being able to tell apart.
   */
  elevated: number;
  /** Symlinks passed over during a recursive walk. */
  skippedLinks: number;
  /** Directories a recursive walk could not read; nothing under them changed. */
  unreadable: string[];
  /**
   * Entries the walk found inside the denylist and did not touch (TRE-52).
   *
   * Reported rather than silently dropped, and named individually rather than
   * counted: a recursive chmod that says it changed everything under a home
   * directory while quietly stepping over `~/.ssh` is a worse answer than one
   * that says which entries it left alone.
   */
  refused: string[];
}

export interface CountResult {
  path: string;
  /** Entries below and including the path, capped: see `exceeded`. */
  entries: number;
  /** True when the tree is bigger than the ceiling, so `entries` is a floor. */
  exceeded: boolean;
  ceiling: number;
  skippedLinks: number;
  unreadable: number;
  /**
   * Entries a recursive change would step over because they are denylisted
   * (TRE-52). Excluded from `entries`, so the figure the modal shows is what
   * would actually be touched rather than what the walk happened to find.
   */
  refused: number;
}

@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  constructor(
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly ids: IdResolverService,
    private readonly sudoRunner: SudoRunnerService,
    private readonly snapshots: PermissionSnapshotService,
  ) {}

  /**
   * What a recursive change would touch, for the checkbox that asks for it
   * (TRE-21 §2). Read-only, and validated as a read: counting is looking.
   */
  async count(userId: string, hostId: string, path: string): Promise<CountResult> {
    const driver = await this.driverFor(hostId, userId);
    const validated = await this.guard.validate({ driver, userId, path, intent: "read" });

    const ceiling = entryCeiling();
    const walked = await walkTree(driver, validated.realPath, ceiling);
    // Counted the same way the change itself filters, so the number in the
    // modal is what would be touched rather than what the walk found.
    const denied = await this.guard.localDenial(driver, userId);
    const refused = walked.paths.filter(denied).length;

    return {
      path,
      entries: walked.paths.length - refused,
      exceeded: walked.exceeded,
      ceiling,
      skippedLinks: walked.skippedLinks,
      unreadable: walked.unreadable.length,
      refused,
    };
  }

  /**
   * `mode` arrives as digits and is parsed here, to an integer, once. It is
   * never interpolated into anything: the drivers take a number, and the SSH
   * one hands it to SFTP rather than to a command line.
   */
  async chmod(
    userId: string,
    hostId: string,
    paths: readonly string[],
    mode: number,
    recursive: boolean,
    sessionId?: string,
    activityLogId?: string,
  ): Promise<ChangeResult> {
    return this.apply(
      userId,
      hostId,
      paths,
      recursive,
      (driver, target) => driver.chmod(target, mode),
      { program: "chmod", argv: (target) => chmodArgv(mode, target) },
      sessionId,
      undefined,
      activityLogId,
    );
  }

  /**
   * Owner and group are resolved to numeric ids **before** anything is changed,
   * so a typo in a group name cannot leave half a selection owned by someone
   * new. Either every path is attempted with the same pair, or none is.
   */
  async chown(
    userId: string,
    hostId: string,
    paths: readonly string[],
    owner: string | undefined,
    group: string | undefined,
    recursive: boolean,
    sessionId?: string,
    activityLogId?: string,
  ): Promise<ChangeResult> {
    if (owner === undefined && group === undefined) {
      throw new BadRequestException("Give an owner, a group, or both.");
    }

    const driver = await this.driverFor(hostId, userId);
    const { uid, gid } = await this.resolveIds(driver, owner, group);

    return this.apply(
      userId,
      hostId,
      paths,
      recursive,
      // -1 is POSIX for "leave this one alone", and both drivers pass it
      // through: chown(path, -1, gid) changes the group and nothing else. The
      // command has no such convention, which is what `chownArgv` is for.
      (host, path) => host.chown(path, uid, gid),
      { program: "chown", argv: (target) => chownArgv(uid, gid, target) },
      sessionId,
      driver,
      activityLogId,
    );
  }

  /**
   * The shared body: validate every path, expand the recursive ones, then
   * change them one at a time.
   *
   * Per path, not per batch. Ten paths where three fail is a report naming
   * those three — a single 403 for the batch would leave the user unable to
   * tell which files are now different from the ones that are not.
   */
  private async apply(
    userId: string,
    hostId: string,
    paths: readonly string[],
    recursive: boolean,
    change: (driver: HostDriver, path: string) => Promise<void>,
    elevated: ElevatedForm,
    sessionId?: string,
    existing?: HostDriver,
    activityLogId?: string,
  ): Promise<ChangeResult> {
    if (paths.length === 0) throw new BadRequestException("No paths given.");
    if (paths.length > MAX_PATHS) {
      throw new BadRequestException(`At most ${MAX_PATHS} paths per request; this one names ${paths.length}.`);
    }

    const driver = existing ?? (await this.driverFor(hostId, userId));
    // One lookup for the whole request; a walk holds thousands of paths and
    // none of them is worth a query (TRE-52).
    const denied = await this.guard.localDenial(driver, userId);
    const results: PathOutcome[] = [];
    const unreadable: string[] = [];
    const refused: string[] = [];
    let skippedLinks = 0;
    let changed = 0;
    let elevatedEntries = 0;
    const snapshots: SnapshotEntry[] = [];

    for (const path of paths) {
      // Validated one at a time, and a refusal on one path does not cancel the
      // others: the guard throws, and that throw is this path's outcome. A
      // selection spanning a root boundary changes what it may and reports the
      // rest, which is more useful than refusing all of it.
      let realPath: string;
      try {
        const validated = await this.guard.validate({ driver, userId, path, intent: "write" });
        realPath = validated.realPath;
      } catch (error) {
        results.push(failure(path, error));
        continue;
      }

      let targets = [realPath];
      // Before-values for this one top-level path, keyed by target — built
      // only when there is an activityLogId to attach them to (TRE-75).
      const before = new Map<string, { mode: number; uid: number; gid: number }>();

      if (recursive) {
        const ceiling = entryCeiling();
        const walked = await walkTree(driver, realPath, ceiling);
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
        targets = walked.paths;
        skippedLinks += walked.skippedLinks;
        unreadable.push(...walked.unreadable);
        if (activityLogId) {
          for (const entry of walked.details) {
            before.set(entry.path, { mode: entry.mode, uid: entry.uid, gid: entry.gid });
          }
        }
      } else if (activityLogId) {
        // One stat to capture what this single path was before the change —
        // affordable precisely because there is only one (TRE-75).
        const stat = await driver.stat(realPath);
        before.set(realPath, { mode: stat.mode, uid: stat.uid, gid: stat.gid });
      }

      // The walk invents paths the guard never saw, and a change aimed at a
      // home directory reaches `~/.ssh` through them. Skipped rather than
      // failed: the rest of the tree is a legitimate change and refusing all of
      // it would be the batch failure this route exists to avoid.
      //
      // `realPath` itself went through the guard above, so it is never in here
      // — which is also why `targets` cannot come back empty.
      const permitted = targets.filter((target) => {
        if (!denied(target)) return true;
        refused.push(target);
        return false;
      });

      const onChanged = activityLogId
        ? (target: string) => {
            const value = before.get(target);
            if (value) snapshots.push({ activityLogId, path: target, ...value });
          }
        : undefined;

      const outcome = await this.applyTo(driver, path, permitted, change, elevated, sessionId, hostId, onChanged);
      results.push(outcome);
      changed += outcome.entries;
      if (outcome.elevated) elevatedEntries += outcome.elevated;
    }

    const failed = results.filter((result) => !result.ok).length;

    // Recorded before the all-failed check below: an entry can have genuinely
    // changed even on a request that is overall classified as failed (one
    // path's targets partially succeeded before that path hit its own
    // failure), and that change is exactly as undoable as any other.
    if (activityLogId) await this.snapshots.record(snapshots);

    // Nothing worked: the request achieved nothing, so it answers as a failure
    // rather than as a 200 whose body has to be read to discover that. A
    // partial success stays a 200 — some files really did change, and the
    // client has to know which.
    if (failed === results.length) throw allFailed(results);

    return { results, changed, failed, skippedLinks, unreadable, refused, elevated: elevatedEntries };
  }

  /** One path and everything the walk found under it. */
  private async applyTo(
    driver: HostDriver,
    reported: string,
    targets: readonly string[],
    change: (driver: HostDriver, path: string) => Promise<void>,
    elevated: ElevatedForm,
    sessionId: string | undefined,
    hostId: string,
    onChanged?: (target: string) => void,
  ): Promise<PathOutcome> {
    let entries = 0;
    let viaSudo = 0;
    for (const target of targets) {
      try {
        await change(driver, target);
        entries += 1;
        onChanged?.(target);
      } catch (error) {
        // Refused for want of privilege, with a window open: this is the case
        // the whole ticket exists for. Retried through `sudo chmod` rather than
        // SFTP, because SFTP cannot be elevated at all.
        //
        // Tried the ordinary way first on every entry, deliberately. A tree
        // where four files are root-owned and four thousand are not runs four
        // commands as root, not four thousand — and the four thousand keep
        // their existing code path, which is the one that is already tested.
        if (isPermissionRefusal(error) && this.sudoRunner.isOpen(sessionId, hostId)) {
          try {
            await this.sudoRunner.run(driver, sessionId, hostId, elevated.program, elevated.argv(target));
            entries += 1;
            viaSudo += 1;
            onChanged?.(target);
            continue;
          } catch (elevatedError) {
            // The refusal that gets reported is this one, not the original: it
            // is the last thing tried and the one whose message says what is
            // actually in the way.
            const outcome = failure(reported, elevatedError);
            outcome.entries = entries;
            outcome.elevated = viaSudo;
            return outcome;
          }
        }

        // The first failure ends this path. Continuing would report a count
        // that mixes changed and unchanged entries under one "ok", and a
        // half-applied recursive chmod is worth stopping to look at.
        const outcome = failure(reported, error);
        outcome.entries = entries;
        outcome.elevated = viaSudo;
        return outcome;
      }
    }
    return { path: reported, ok: true, entries, elevated: viaSudo };
  }

  /**
   * Names to ids, on the target host.
   *
   * `/etc/passwd` and `/etc/group` are already cached per host for the listing,
   * so the common case costs nothing. A user that is not in the file — LDAP,
   * SSSD, anything directory-backed — falls back to `id -u`, which is on the
   * exec allowlist. Groups have no such fallback: nothing allowlisted resolves
   * a group name, so a group outside `/etc/group` must be given numerically,
   * and the message says exactly that rather than failing as "not found".
   */
  private async resolveIds(
    driver: HostDriver,
    owner: string | undefined,
    group: string | undefined,
  ): Promise<{ uid: number; gid: number }> {
    const { users, groups } = await this.ids.forHost(driver);

    return {
      uid: owner === undefined ? -1 : await this.resolveUser(driver, owner, users),
      gid: group === undefined ? -1 : this.resolveGroup(group, groups),
    };
  }

  private async resolveUser(driver: HostDriver, owner: string, users: Map<number, string>): Promise<number> {
    const numeric = asNumericId(owner);
    if (numeric !== null) return numeric;

    for (const [id, name] of users) if (name === owner) return id;

    try {
      const result = await driver.exec("id", ["-u", owner], { timeoutMs: 5_000 });
      const id = Number.parseInt(result.stdout.trim(), 10);
      if (result.code === 0 && Number.isFinite(id)) return id;
    } catch (error) {
      this.logger.debug(`id -u ${owner} failed on host ${driver.hostId}: ${(error as Error).message}`);
    }

    throw new BadRequestException(`No user named "${owner}" on this host. A numeric uid always works.`);
  }

  private resolveGroup(group: string, groups: Map<number, string>): number {
    const numeric = asNumericId(group);
    if (numeric !== null) return numeric;

    for (const [id, name] of groups) if (name === group) return id;

    throw new BadRequestException(
      `No group named "${group}" in /etc/group on this host. Give the numeric gid instead — nothing on the command allowlist can resolve a group name.`,
    );
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

/** "0644" → 420, and a refusal for anything that is not three or four octal digits. */
export function parseMode(mode: string): number {
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new BadRequestException(`"${mode}" is not a mode. Give three or four octal digits, such as 0644.`);
  }
  const parsed = Number.parseInt(mode, 8);
  // Unreachable through the regex above, and kept anyway: this number goes
  // straight to chmod(2), and the check costs nothing.
  if (parsed < 0 || parsed > 0o7777) throw new BadRequestException(`Mode ${mode} is out of range.`);
  return parsed;
}

/** The bits that leave privilege behind. Flagged in the UI and in the row. */
export function specialBits(mode: number): string[] {
  const marks: string[] = [];
  if (mode & 0o4000) marks.push("setuid");
  if (mode & 0o2000) marks.push("setgid");
  if (mode & 0o1000) marks.push("sticky");
  return marks;
}

export function describeMode(mode: number): string {
  const marks = specialBits(mode);
  return marks.length === 0 ? octalMode(mode) : `${octalMode(mode)} (${marks.join(", ")})`;
}

function asNumericId(value: string): number | null {
  if (!/^[0-9]{1,10}$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * A failed path, described the way the person who has to fix it needs.
 *
 * `EPERM` on a chown is the expected outcome for an unprivileged user rather
 * than a malfunction, so it says what to do about it instead of "permission
 * denied" — which reads as "you may not", when the truth is "not without root".
 */
export function failure(path: string, error: unknown): PathOutcome {
  if (isDriverError(error)) {
    return {
      path,
      ok: false,
      entries: 0,
      code: error.code,
      message: error.code === "EPERM" ? "Requires elevation on this host." : humanDriverMessage(error.code),
    };
  }
  if (error instanceof HttpException) {
    const body = error.getResponse() as { code?: string; message?: string };
    return {
      path,
      ok: false,
      entries: 0,
      code: body.code ?? String(error.getStatus()),
      message: typeof body.message === "string" ? body.message : error.message,
    };
  }
  return { path, ok: false, entries: 0, code: "EUNKNOWN", message: (error as Error).message };
}

function humanDriverMessage(code: string): string {
  switch (code) {
    case "EACCES":
      return "Permission denied on the host.";
    case "ENOENT":
      return "No such file or directory.";
    case "EROFS":
      return "The filesystem is mounted read-only.";
    default:
      return `The host refused the change (${code}).`;
  }
}

/**
 * Every path failed, so the request failed. The status is the first failure's,
 * because a batch that fails for one reason should not be reported under a
 * different one — and the body carries every path either way.
 */
function allFailed(results: readonly PathOutcome[]): HttpException {
  const first = results[0];
  const status =
    first.code === "EPERM" || first.code === "EACCES" || first.code === "403"
      ? HttpStatus.FORBIDDEN
      : first.code === "ENOENT"
        ? HttpStatus.NOT_FOUND
        : HttpStatus.BAD_GATEWAY;

  return new HttpException(
    {
      statusCode: status,
      code: first.code,
      message:
        results.length === 1
          ? (first.message ?? "The change failed.")
          : `None of the ${results.length} paths could be changed.`,
      results,
    },
    status,
  );
}
