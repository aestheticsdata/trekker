import { posix } from "node:path";
import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { AuditService } from "@audit/audit.service";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { DriverError, isDriverError } from "@hosts/drivers/driver-error";
import type { HostDriver } from "@hosts/drivers/host-driver";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * TRE-11 — the path authority. Every filesystem route validates through here
 * before a driver touches anything; see docs/superpowers/specs §5.1.
 *
 * The order is the security property: resolve on the target host first
 * (`realpath` neutralises `..` and symlinks), compare against the roots
 * second, denylist last. String inspection alone cannot do this — a symlink
 * contains no `..` and still escapes.
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

    if (path.includes("\0") || !posix.isAbsolute(path)) {
      throw await this.refuse("malformed", userId, driver.hostId, path);
    }

    let realPath: string;
    try {
      realPath = await this.resolveOnHost(driver, cleanPath(path));
    } catch (error) {
      // A host that cannot be reached is not a path judgment — let the
      // connection error surface as itself.
      if (isDriverError(error) && error.isConnectionError) throw error;
      const category = error instanceof ResolveRefusal ? error.category : "unresolvable";
      throw await this.refuse(category, userId, driver.hostId, path);
    }

    const roots = await this.resolveRootRows(driver, host.roots);
    if (!withinRoots(realPath, roots, intent)) {
      throw await this.refuse(
        intent === "write" ? "outside-write-roots" : "outside-roots",
        userId,
        driver.hostId,
        path,
      );
    }

    // Checked after resolution on purpose: a symlink into the install
    // directory has already been unmasked by realpath at this point.
    if (host.transport === "LOCAL" && this.isDeniedLocally(realPath)) {
      throw await this.refuse("denylist", userId, driver.hostId, path);
    }

    return mint(driver.hostId, path, realPath, intent);
  }

  /**
   * The host's roots, resolved on the host — TRE-13 calls this once per
   * listing and then uses `withinRoots` per symlink.
   */
  async resolveRoots(driver: HostDriver, userId: string): Promise<ResolvedRoot[]> {
    const host = await this.loadHost(driver.hostId, userId);
    return this.resolveRootRows(driver, host.roots);
  }

  private async loadHost(hostId: string, userId: string): Promise<{ transport: string; roots: RootRow[] }> {
    const host = await this.prisma.hosts.findFirst({
      where: { id: hostId, userId },
      include: { roots: true },
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
  private async resolveRootRows(driver: HostDriver, rows: readonly RootRow[]): Promise<ResolvedRoot[]> {
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
  ): Promise<HttpException> {
    // The category stays server-side; the response is always the same line.
    this.logger.warn(`refused (${category}) user=${userId} host=${hostId} path=${JSON.stringify(requestedPath)}`);

    // Per user, not per session: signing in again mints a new session, so a
    // per-session counter is no counter at all. The limit is named literally
    // here rather than through a local alias — `audit-coverage.spec.ts` reads
    // the call site to tell an enforced limit from a documented one.
    const verdict = await this.limits.consume(LIMITS.pathRefusal, userId);
    if (verdict.allowed) return new ForbiddenException(PATH_REFUSED_MESSAGE);

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
          summary: `Blocked: ${LIMITS.pathRefusal.max} refused paths within the limit window`,
          payload: { category, path: requestedPath },
        },
        message,
      );
    }

    return new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
