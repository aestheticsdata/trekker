import { posix } from "node:path";
import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { AuditService } from "@audit/audit.service";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { DriverError, isDriverError } from "@hosts/drivers/driver-error";
import type { HostDriver } from "@hosts/drivers/host-driver";
import type { UserRole } from "@users/owner";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * TRE-11 — the path authority. Every filesystem route validates through here
 * before a driver touches anything; see docs/superpowers/specs §5.1.
 *
 * The order is the security property: resolve on the target host first
 * (`realpath` neutralises `..` and symlinks), compare against the roots
 * second, denylist last. String inspection alone cannot do this — a symlink
 * contains no `..` and still escapes.
 *
 * TRE-48 — the install's owner is measured against a different allowlist, not
 * against none. The resolution always happens and the comparison always
 * happens; what the owner changes is which roots the comparison is made
 * against, and whether being outside them is worth counting. A bypass written
 * as an early return would skip `realpath`, and every caller downstream takes
 * the resolved path on trust.
 */

/** What the caller intends to do with the path. WRITE roots grant both. */
export type PathIntent = "read" | "write";

declare const validatedPathBrand: unique symbol;

/**
 * A path that went through the guard. The brand is compile-time only — the
 * symbol has no runtime existence, so the only way to obtain one outside this
 * file is to call `PathGuardService.validate()`. File services accept nothing
 * else, which is what makes a handler that skips validation fail to compile.
 */
export interface ValidatedPath {
  readonly [validatedPathBrand]: true;
  readonly hostId: string;
  /** The path exactly as the client sent it — for logs and error context. */
  readonly requestedPath: string;
  /** The resolved real path. Drivers operate on this, never on the request. */
  readonly realPath: string;
  readonly intent: PathIntent;
}

/** A HostRoots row with its on-host resolution, ready for containment checks. */
export interface ResolvedRoot {
  /** The root as stored. */
  path: string;
  /** The root as the target host resolves it. */
  realPath: string;
  access: "READ" | "WRITE";
}

/**
 * The one refusal message. Outside the roots, denylisted, unresolvable,
 * read-only — every refusal reads the same, so a response never discloses
 * whether a path exists or why exactly it was refused. The reason is logged
 * server-side instead.
 */
export const PATH_REFUSED_MESSAGE = "Path is not allowed on this host.";

/**
 * The one refusal that explains itself, and only to the install's owner
 * (TRE-48).
 *
 * The owner browses without the roots binding them, so this handful of
 * directories is the only thing that still refuses — and a uniform message
 * would read as the bug that ticket was filed about rather than as the one
 * boundary deliberately left standing. Saying why leaks nothing to them: the
 * denylist is computed from where this server is installed, by the person who
 * installed it.
 *
 * Members never see this line. For them the denylist is exactly as
 * indistinguishable from every other refusal as it was before.
 */
export const PATH_DENYLISTED_MESSAGE =
  "This path holds Trekker's own key material — the master key that decrypts every stored credential. " +
  "It stays closed to the browser even for the install's owner. Reach it over SSH.";

/** DI token for the boot-computed local denylist (see local-denylist.ts). */
export const LOCAL_DENYLIST = "LOCAL_DENYLIST";

/**
 * Pure containment predicate, exported for TRE-13's symlink annotation —
 * "does this target land inside a root" as a boolean, without the throwing
 * ceremony of validate().
 */
export function withinRoots(realPath: string, roots: readonly ResolvedRoot[], intent: PathIntent): boolean {
  return roots.some((root) => {
    if (intent === "write" && root.access !== "WRITE") return false;
    return contains(root.realPath, realPath);
  });
}

/** Segment-wise containment: `/data` must not admit `/database`. */
function contains(ancestor: string, path: string): boolean {
  return path === ancestor || path.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);
}

/**
 * Collapses duplicate separators and drops the trailing slash. `.` and `..`
 * are deliberately left in place — resolving those is the host's job, where
 * symlinks are visible, never a string operation here.
 */
function cleanPath(path: string): string {
  const joined = path.split("/").filter(Boolean).join("/");
  return `/${joined}`;
}

/** Carries the log category of a refusal decided during resolution. */
class ResolveRefusal extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}

function mint(hostId: string, requestedPath: string, realPath: string, intent: PathIntent): ValidatedPath {
  return Object.freeze({ hostId, requestedPath, realPath, intent }) as unknown as ValidatedPath;
}

export interface ValidateArgs {
  driver: HostDriver;
  userId: string;
  path: string;
  intent: PathIntent;
}

interface RootRow {
  path: string;
  access: "READ" | "WRITE";
}

/**
 * The owner's roots, as the rest of the application has to see them (TRE-48).
 *
 * One WRITE root at `/`, and deliberately not an empty array. `withinRoots` is
 * `roots.some(...)`, which is false on nothing at all — so expressing "no
 * boundary" as an absence would invert TRE-13's symlink annotation and mark
 * every link on every host as leaving the roots, for the one account allowed
 * to follow all of them.
 *
 * WRITE rather than READ because containment and intent are checked
 * independently: a READ root refuses write intent wherever it lands, which
 * would leave chmod and chown refused outside the configured roots while
 * browsing worked.
 */
const UNRESTRICTED_ROOTS: readonly ResolvedRoot[] = Object.freeze([
  Object.freeze({ path: "/", realPath: "/", access: "WRITE" as const }),
]);

@Injectable()
export class PathGuardService {
  private readonly logger = new Logger(PathGuardService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOCAL_DENYLIST) private readonly localDenylist: readonly string[],
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  async validate({ driver, userId, path, intent }: ValidateArgs): Promise<ValidatedPath> {
    const host = await this.loadHost(driver.hostId, userId);
    // Read without optional chaining on purpose: an edit that drops the
    // include from loadHost must throw here rather than quietly demote the
    // owner and reopen TRE-48 in silence.
    const owner = host.user.role === "OWNER";

    if (path.includes("\0") || !posix.isAbsolute(path)) {
      throw await this.refuse("malformed", userId, driver.hostId, path, owner);
    }

    let realPath: string;
    try {
      realPath = await this.resolveOnHost(driver, cleanPath(path));
    } catch (error) {
      // A host that cannot be reached is not a path judgment — let the
      // connection error surface as itself.
      if (isDriverError(error) && error.isConnectionError) throw error;
      const category = error instanceof ResolveRefusal ? error.category : "unresolvable";
      throw await this.refuse(category, userId, driver.hostId, path, owner);
    }

    const roots = await this.resolveRootRows(driver, host.roots, owner);
    if (!withinRoots(realPath, roots, intent)) {
      throw await this.refuse(
        intent === "write" ? "outside-write-roots" : "outside-roots",
        userId,
        driver.hostId,
        path,
        owner,
      );
    }

    // Checked after resolution on purpose: a symlink into the install
    // directory has already been unmasked by realpath at this point.
    //
    // This one still binds the owner (TRE-48). The roots were never a
    // privilege boundary — the account sets its own from the host form — but
    // the denylist is: past it sit the master key that decrypts every stored
    // credential and the API user's own SSH keys. Lifting it would mean a
    // stolen session cookie exfiltrates all of it over HTTP, which is a
    // different and worse thing than that session merely being able to use
    // the app. The owner is told why, which nothing else here does.
    if (host.transport === "LOCAL" && this.isDeniedLocally(realPath)) {
      throw await this.refuse("denylist", userId, driver.hostId, path, owner);
    }

    return mint(driver.hostId, path, realPath, intent);
  }

  /**
   * The host's roots, resolved on the host — TRE-13 calls this once per
   * listing and then uses `withinRoots` per symlink.
   */
  async resolveRoots(driver: HostDriver, userId: string): Promise<ResolvedRoot[]> {
    const host = await this.loadHost(driver.hostId, userId);
    // The owner's reach travels with the answer, which is what makes TRE-13's
    // `linkInsideRoot` come back true for them — the front blocks a symlink
    // click on that flag, so a bypass that stopped at validate() would still
    // refuse the owner in the browser.
    return this.resolveRootRows(driver, host.roots, host.user.role === "OWNER");
  }

  private async loadHost(
    hostId: string,
    userId: string,
  ): Promise<{ transport: string; roots: RootRow[]; user: { role: UserRole } }> {
    const host = await this.prisma.hosts.findFirst({
      where: { id: hostId, userId },
      // The role rides on the query the guard was already making. A separate
      // lookup would double the queries on an operation like chmod, which
      // validates once per path and accepts thousands of them.
      include: { roots: true, user: { select: { role: true } } },
    });
    // Same shape as HostDriverFactory: a host that is not yours does not
    // exist, so the answer never confirms the id is real.
    if (!host) throw new DriverError("ENOENT", `No such host: ${hostId}`);
    return host;
  }

  /**
   * Resolve on the target host, tolerating a path that does not exist yet:
   * the nearest existing ancestor is resolved for real and the remaining
   * segments are re-appended after being checked for `.` and `..`.
   *
   * The existence probe is a `stat` after `realpath`, not the `realpath`
   * error, because SFTP realpath happily canonicalises paths that do not
   * exist — the two drivers only agree on stat.
   */
  private async resolveOnHost(driver: HostDriver, cleaned: string): Promise<string> {
    const suffix: string[] = [];
    let current = cleaned;
    for (;;) {
      const resolved = await this.tryResolveExisting(driver, current);
      if (resolved !== null) {
        if (suffix.length === 0) return resolved;
        if (suffix.some((segment) => segment === "." || segment === "..")) {
          throw new ResolveRefusal("dot-segment-in-new-path");
        }
        return resolved === "/" ? `/${suffix.join("/")}` : `${resolved}/${suffix.join("/")}`;
      }
      if (current === "/") throw new ResolveRefusal("nothing-resolvable");
      suffix.unshift(posix.basename(current));
      current = posix.dirname(current);
    }
  }

  /** The resolved real path when it exists on the host, null when it does not. */
  private async tryResolveExisting(driver: HostDriver, path: string): Promise<string | null> {
    let resolved: string;
    try {
      resolved = await driver.realpath(path);
    } catch (error) {
      if (isDriverError(error) && error.isConnectionError) throw error;
      return null;
    }
    try {
      await driver.stat(resolved);
      return resolved;
    } catch (error) {
      if (isDriverError(error) && error.isConnectionError) throw error;
      return null;
    }
  }

  /** A root that does not exist on the host grants nothing. */
  private async resolveRootRows(driver: HostDriver, rows: readonly RootRow[], owner: boolean): Promise<ResolvedRoot[]> {
    // The one place the owner's allowlist is substituted, so both callers get
    // it and neither has to remember to. `/` needs no probing — it is the one
    // path that exists on every host — which also spares an SSH round trip per
    // configured root on every listing.
    if (owner) return [...UNRESTRICTED_ROOTS];

    const resolved: ResolvedRoot[] = [];
    for (const row of rows) {
      const realPath = await this.tryResolveExisting(driver, cleanPath(row.path));
      if (realPath !== null) resolved.push({ path: row.path, realPath, access: row.access });
    }
    return resolved;
  }

  private isDeniedLocally(realPath: string): boolean {
    return this.localDenylist.some((entry) => contains(entry, realPath));
  }

  /**
   * The single exit for every refusal — and, because of that, the only place a
   * refusal can be counted (TRE-30 §3).
   *
   * The limit lives here rather than on the routes because refusals are
   * decided below the routing layer: the audit interceptor sees a 403 come out
   * of a handler long after the guard has made up its mind, and on a read route
   * it does not look at all. Every path decision in the application funnels
   * through this method, so counting here is the one placement that cannot be
   * bypassed by adding a route.
   *
   * Past the limit the answer becomes a 429. That discloses nothing the 403 did
   * not: it is triggered by how many paths were refused, never by which — a
   * path that exists and a path that does not still read identically.
   */
  private async refuse(
    category: string,
    userId: string,
    hostId: string,
    requestedPath: string,
    owner: boolean,
  ): Promise<HttpException> {
    // The category stays server-side; the response is always the same line.
    this.logger.warn(`refused (${category}) user=${userId} host=${hostId} path=${JSON.stringify(requestedPath)}`);

    // Per user, not per session: signing in again mints a new session, so a
    // per-session counter is no counter at all. The limit is named literally
    // here rather than through a local alias — `audit-coverage.spec.ts` reads
    // the call site to tell an enforced limit from a documented one.
    // The uniform line, except for the owner meeting the denylist — the only
    // refusal they can still get from a path that exists, and therefore the
    // only one worth explaining. See PATH_DENYLISTED_MESSAGE.
    const forbidden = () =>
      new ForbiddenException(owner && category === "denylist" ? PATH_DENYLISTED_MESSAGE : PATH_REFUSED_MESSAGE);

    const verdict = await this.limits.consume(LIMITS.pathRefusal, userId);
    if (verdict.allowed) return forbidden();

    const message = RateLimitService.describe(LIMITS.pathRefusal, verdict.resetSeconds);

    // One row per window, written as the line is crossed and not once per
    // refusal after it. A walker producing a thousand refusals a minute would
    // otherwise write a thousand identical rows and bury the signal under its
    // own volume — and read routes are not audited at all, so for a filesystem
    // walk this row is the only record there is.
    if (verdict.count === LIMITS.pathRefusal.max + 1) {
      await this.audit.refused(
        {
          userId,
          hostId,
          kind: "path.refused",
          // The owner was not blocked, and the row must not say they were. It
          // is still written: a burst of refusals is worth a record whoever
          // produced it, and for a filesystem walk it is the only one there is.
          summary: owner
            ? `${LIMITS.pathRefusal.max} refused paths within the limit window`
            : `Blocked: ${LIMITS.pathRefusal.max} refused paths within the limit window`,
          payload: { category, path: requestedPath },
        },
        // Same reason as the summary: `message` describes a limit being
        // enforced, and for an owner it was not. The row is read as one thing
        // — the strip renders summary and detail together — so a detail
        // contradicting its own summary is worse than no detail at all.
        owner ? `${LIMITS.pathRefusal.max} refused paths, not limited: this account owns the install` : message,
      );
    }

    // The owner is counted but never stopped (TRE-48).
    //
    // Refusals survive the roots bypass, and the denylist is the one that
    // survives in bulk: those directories sit under the API user's home,
    // which is the LOCAL host's default home and default root — the directory
    // the pane opens on. The explorer prefetches on hover, so an owner moving
    // the cursor across the install tree spends refusals several at a time
    // without ever clicking. Without this line the very walk the ticket asked
    // for would 429 them out of navigation in seconds.
    if (owner) return forbidden();

    return new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
