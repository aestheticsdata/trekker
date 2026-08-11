import { Injectable, Logger } from "@nestjs/common";
import type { HostDriver } from "@hosts/drivers/host-driver";

/**
 * uid and gid to names, per host (TRE-13 §2).
 *
 * The whole point is that this is *not* one lookup per row: `/etc/passwd` and
 * `/etc/group` are read once per host and cached, so a ten-thousand-entry
 * listing costs two reads rather than twenty thousand.
 *
 * Read with `tail`, which is on the exec allowlist — `cat` is not. The line
 * count is deliberately far above any real passwd file; asking for fewer lines
 * than the file holds would silently drop the users at the top of it.
 *
 * A host that will not surrender these files (a container, a locked-down box)
 * resolves nothing and the rows fall back to numeric ids, which is exactly what
 * `ls -n` shows and never an error.
 */

const CACHE_TTL_MS = 5 * 60_000;
const WHOLE_FILE_LINES = 20_000;

interface Maps {
  users: Map<number, string>;
  groups: Map<number, string>;
  at: number;
}

@Injectable()
export class IdResolverService {
  private readonly logger = new Logger(IdResolverService.name);
  private readonly cache = new Map<string, Maps>();
  /** Reads in flight, so ten concurrent listings share one pair of reads. */
  private readonly inFlight = new Map<string, Promise<Maps>>();

  async forHost(driver: HostDriver): Promise<Maps> {
    const cached = this.cache.get(driver.hostId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;

    const pending = this.inFlight.get(driver.hostId);
    if (pending) return pending;

    const load = this.load(driver).finally(() => this.inFlight.delete(driver.hostId));
    this.inFlight.set(driver.hostId, load);
    return load;
  }

  forget(hostId: string): void {
    this.cache.delete(hostId);
  }

  private async load(driver: HostDriver): Promise<Maps> {
    const [users, groups] = await Promise.all([
      this.readIdFile(driver, "/etc/passwd"),
      this.readIdFile(driver, "/etc/group"),
    ]);
    const maps: Maps = { users, groups, at: Date.now() };
    this.cache.set(driver.hostId, maps);
    return maps;
  }

  /**
   * Both files share a layout: `name:x:id:...`, one record per line. Anything
   * that does not parse is skipped rather than failing the listing.
   */
  private async readIdFile(driver: HostDriver, path: string): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    try {
      const result = await driver.exec("tail", ["-n", String(WHOLE_FILE_LINES), path], { timeoutMs: 5_000 });
      if (result.code !== 0) return map;
      for (const line of result.stdout.split("\n")) {
        const [name, , rawId] = line.split(":");
        if (!name || rawId === undefined) continue;
        const id = Number.parseInt(rawId, 10);
        // First definition wins: passwd may list an id twice and the earlier
        // entry is the one `id` itself reports.
        if (Number.isFinite(id) && !map.has(id)) map.set(id, name);
      }
    } catch (error) {
      this.logger.debug(`${path} unreadable on host ${driver.hostId}: ${(error as Error).message}`);
    }
    return map;
  }
}
