import { Injectable, Logger } from "@nestjs/common";
import type { HostDriver } from "@hosts/drivers/host-driver";

/**
 * The numbers behind a sidebar row (TRE-12 §3): uptime, load, memory, a
 * round-trip time and the home directory. Every field is independently
 * nullable — a container without `/proc/meminfo`, a BSD without `/proc` at all,
 * shows what it has rather than failing whole.
 *
 * The `/proc` files are read with `tail`, which is on the exec allowlist
 * (shell-quote.ts) — `cat` is not. The paths are fixed server-side constants,
 * never client input, so they need no PathGuard.
 */

export interface HostSummary {
  uptimeSeconds: number | null;
  load: { one: number; five: number; fifteen: number } | null;
  memory: { totalKb: number; availableKb: number } | null;
  pingMs: number | null;
  homeDir: string | null;
  remoteUser: string | null;
  /**
   * What the machine calls itself, which is not what Trekker calls it.
   *
   * A host has a slug and a label here, and neither is its hostname: they are
   * this installation's names for a machine, chosen by whoever added it. The
   * terminal's `hostname` command (TRE-35) has to answer the other question,
   * and answering it with a slug would be a plausible-looking lie.
   *
   * Read from `/proc/sys/kernel/hostname` with `tail`, exactly as the four
   * probes above are read, so this costs the exec allowlist nothing — `hostname`
   * the *program* is not on it and does not need to be. A machine without
   * `/proc` reports null, as it already does for uptime, load and memory.
   */
  hostname: string | null;
}

interface CacheEntry {
  at: number;
  value: HostSummary;
}

/** Long enough that a sidebar polling every second opens at most one channel. */
const SUMMARY_TTL_MS = 5_000;

/**
 * "Read the whole file" expressed in the only verb available: `tail` is on the
 * exec allowlist and `cat`/`head` are not, so a line count comfortably above
 * the file's length is how a small /proc file is read in full.
 *
 * This is not a detail. `/proc/meminfo` is ~54 lines with MemTotal and
 * MemAvailable at the *top*, so asking `tail` for fewer lines than the file
 * holds silently drops exactly the two fields wanted — and the failure looks
 * identical to a host that has no /proc at all.
 */
const WHOLE_SMALL_FILE = 500;

@Injectable()
export class HostSummaryService {
  private readonly logger = new Logger(HostSummaryService.name);
  private readonly cache = new Map<string, CacheEntry>();

  async forHost(driver: HostDriver): Promise<HostSummary> {
    const cached = this.cache.get(driver.hostId);
    if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.value;

    const value = await this.collect(driver);
    this.cache.set(driver.hostId, { at: Date.now(), value });
    return value;
  }

  /** Drop a host's cached summary — on delete or credential change. */
  forget(hostId: string): void {
    this.cache.delete(hostId);
  }

  private async collect(driver: HostDriver): Promise<HostSummary> {
    const [uptimeSeconds, load, memory, home, remoteUser, hostname] = await Promise.all([
      this.readProcNumber(driver, "/proc/uptime"),
      this.readLoad(driver),
      this.readMemory(driver),
      this.timedRealpath(driver),
      this.readUser(driver),
      this.readHostname(driver),
    ]);

    return {
      uptimeSeconds,
      load,
      memory,
      pingMs: home.pingMs,
      homeDir: home.path,
      remoteUser,
      hostname,
    };
  }

  private async tailOrNull(driver: HostDriver, path: string, lines = WHOLE_SMALL_FILE): Promise<string | null> {
    try {
      const result = await driver.exec("tail", ["-n", String(lines), path], { timeoutMs: 4_000 });
      if (result.code !== 0) return null;
      return result.stdout;
    } catch (error) {
      this.logger.debug(`summary: ${path} unavailable on ${driver.hostId}: ${(error as Error).message}`);
      return null;
    }
  }

  private async readProcNumber(driver: HostDriver, path: string): Promise<number | null> {
    const text = await this.tailOrNull(driver, path, 1);
    if (text === null) return null;
    const first = Number.parseFloat(text.trim().split(/\s+/)[0] ?? "");
    return Number.isFinite(first) ? first : null;
  }

  private async readLoad(driver: HostDriver): Promise<HostSummary["load"]> {
    const text = await this.tailOrNull(driver, "/proc/loadavg", 1);
    if (text === null) return null;
    const [one, five, fifteen] = text.trim().split(/\s+/).map(Number);
    if (![one, five, fifteen].every(Number.isFinite)) return null;
    return { one, five, fifteen };
  }

  private async readMemory(driver: HostDriver): Promise<HostSummary["memory"]> {
    const text = await this.tailOrNull(driver, "/proc/meminfo", WHOLE_SMALL_FILE);
    if (text === null) return null;
    const totalKb = matchKb(text, "MemTotal");
    const availableKb = matchKb(text, "MemAvailable");
    if (totalKb === null || availableKb === null) return null;
    return { totalKb, availableKb };
  }

  private async readUser(driver: HostDriver): Promise<string | null> {
    try {
      const result = await driver.exec("id", ["-un"], { timeoutMs: 4_000 });
      const name = result.stdout.trim();
      return result.code === 0 && name.length > 0 ? name : null;
    } catch {
      return null;
    }
  }

  private async readHostname(driver: HostDriver): Promise<string | null> {
    const text = await this.tailOrNull(driver, "/proc/sys/kernel/hostname", 1);
    if (text === null) return null;
    const name = text.trim();
    return name.length > 0 ? name : null;
  }

  private async timedRealpath(driver: HostDriver): Promise<{ path: string | null; pingMs: number | null }> {
    const started = Date.now();
    try {
      const path = await driver.realpath(".");
      return { path, pingMs: Date.now() - started };
    } catch {
      return { path: null, pingMs: null };
    }
  }
}

function matchKb(meminfo: string, key: string): number | null {
  const line = meminfo.split("\n").find((row) => row.startsWith(`${key}:`));
  if (!line) return null;
  const value = Number.parseInt(line.replace(`${key}:`, "").trim(), 10);
  return Number.isFinite(value) ? value : null;
}
