import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { isDriverError } from "@hosts/drivers/driver-error";
import type { FileEntry, HostDriver } from "@hosts/drivers/host-driver";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService, type ResolvedRoot, withinRoots } from "@hosts/path-guard/path-guard.service";
import { toHttp } from "@fs/driver-http";
import { type FileRow, type FileRowDetail, toDetail, toRow } from "@fs/file-row";
import { IdResolverService } from "@fs/id-resolver.service";

/**
 * The endpoint the whole explorer is built on (TRE-13).
 *
 * Order matters and is the security property: the path is validated by the
 * TRE-11 guard before any driver is touched, and the driver then operates on
 * the *resolved* path the guard returned, never on the string the client sent.
 */

export interface ListMeta {
  count: number;
  totalBytes: number;
  truncated: boolean;
  /** How many entries the directory actually holds, when truncation applied. */
  totalEntries: number;
  tookMs: number;
}

export interface ListResult {
  entries: FileRow[];
  meta: ListMeta;
}

/**
 * Far above any directory a person browses, and the point at which returning
 * more stops helping: the client renders a window anyway (TRE-19). Beyond it
 * the response says it was truncated rather than quietly ending early.
 */
export const DEFAULT_MAX_ENTRIES = 10_000;

@Injectable()
export class FsService {
  private readonly logger = new Logger(FsService.name);

  constructor(
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly ids: IdResolverService,
  ) {}

  async list(userId: string, hostId: string, path: string): Promise<ListResult> {
    const started = Date.now();
    const driver = await this.driverFor(hostId, userId);

    const validated = await this.guard.validate({ driver, userId, path, intent: "read" });

    const entries = await this.run(() => driver.list(validated.realPath));
    const totalEntries = entries.length;
    const kept = entries.slice(0, DEFAULT_MAX_ENTRIES);

    // Two reads for the whole listing, not two per row.
    const [{ users, groups }, roots] = await Promise.all([
      this.ids.forHost(driver),
      // Only needed to annotate symlinks; skipped entirely when there are none.
      kept.some((entry) => entry.kind === "symlink")
        ? this.guard.resolveRoots(driver, userId)
        : Promise.resolve<ResolvedRoot[]>([]),
    ]);

    const rows = kept.map((entry) =>
      toRow(entry, { owner: users.get(entry.uid) ?? null, group: groups.get(entry.gid) ?? null }),
    );

    await this.annotateSymlinks(driver, validated.realPath, kept, rows, roots);

    return {
      entries: rows,
      meta: {
        count: rows.length,
        totalBytes: rows.reduce((sum, row) => sum + row.size, 0),
        truncated: totalEntries > kept.length,
        totalEntries,
        tookMs: Date.now() - started,
      },
    };
  }

  /**
   * One entry in full, for the inspector (TRE-13 §4).
   *
   * It describes what the path *resolves to*, because that is what the guard
   * validated and what the driver is given. Asking about a symlink therefore
   * returns its target's details, with `path` naming what was asked for and
   * `realPath` where that landed — the two differing is how a client knows a
   * link was followed. A link whose target escapes the roots is refused here
   * exactly as opening it would be; the listing already carries its
   * `linkTarget` and `linkInsideRoot: false`, so the panel can explain the
   * refusal without this endpoint.
   */
  async stat(userId: string, hostId: string, path: string): Promise<FileRowDetail> {
    const driver = await this.driverFor(hostId, userId);
    const validated = await this.guard.validate({ driver, userId, path, intent: "read" });

    const info = await this.run(() => driver.stat(validated.realPath));
    const { users, groups } = await this.ids.forHost(driver);

    const detail = toDetail(
      info,
      { owner: users.get(info.uid) ?? null, group: groups.get(info.gid) ?? null },
      validated.realPath,
    );
    // The request's own path, so the client can key its cache on what it asked
    // for; realPath carries where that actually landed.
    detail.path = path;
    return detail;
  }

  /**
   * A symlink's target, and whether following it would be allowed. One
   * resolution per symlink and none for anything else — the ticket's one
   * sanctioned per-entry round trip.
   */
  private async annotateSymlinks(
    driver: HostDriver,
    directory: string,
    entries: readonly FileEntry[],
    rows: FileRow[],
    roots: readonly ResolvedRoot[],
  ): Promise<void> {
    const links = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.kind === "symlink");
    if (links.length === 0) return;

    await Promise.all(
      links.map(async ({ entry, index }) => {
        const full = directory.endsWith("/") ? `${directory}${entry.name}` : `${directory}/${entry.name}`;
        rows[index].linkInsideRoot = await this.targetInsideRoot(driver, full, roots);
      }),
    );
  }

  private async targetInsideRoot(
    driver: HostDriver,
    linkPath: string,
    roots: readonly ResolvedRoot[],
  ): Promise<boolean> {
    try {
      const target = await driver.realpath(linkPath);
      return withinRoots(target, roots, "read");
    } catch {
      // A broken link resolves nowhere, so following it leads nowhere allowed.
      return false;
    }
  }

  private async driverFor(hostId: string, userId: string): Promise<HostDriver> {
    return this.run(() => this.factory.forHost(hostId, userId));
  }

  /** Driver failures become HTTP through the shared table in driver-http.ts. */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ForbiddenException) throw error; // A guard refusal is already shaped.
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }
}
