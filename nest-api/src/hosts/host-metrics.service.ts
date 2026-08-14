import { setTimeout as delay } from "node:timers/promises";
import { Injectable, Logger } from "@nestjs/common";
import type { HostDriver } from "@hosts/drivers/host-driver";

/**
 * What a host is *doing* (TRE-73): cpu, memory, disk throughput and load, with
 * enough recent load behind them to draw the top bar's sparkline.
 *
 * Deliberately not part of HostSummaryService, which answers what a host *is* —
 * uptime, home directory, a round-trip time — for every host in the sidebar.
 * This one answers for the single host somebody is looking at, and costs a
 * second of wall clock to answer: two of its numbers are rates, and a rate needs
 * two readings of a counter.
 *
 * Every field is independently nullable, as the summary is. A container with no
 * `/proc/diskstats` reports its cpu and hides its io rather than failing whole.
 */

export interface HostMetrics {
  /** Every core aggregated, 0-100. */
  cpuPercent: number | null;
  memory: { totalKb: number; availableKb: number } | null;
  /** Reads and writes together — the single number the bar has room for. */
  io: { bytesPerSec: number } | null;
  load: { one: number; five: number; fifteen: number } | null;
  /** Recent 1-minute load, oldest first. The sparkline's only source. */
  history: number[];
}

interface CacheEntry {
  at: number;
  value: HostMetrics;
}

/** One reading of every counter, taken in a single call. */
interface Sample {
  /** Seconds since boot — the host's own clock, used to time the interval. */
  bootSeconds: number | null;
  load: HostMetrics["load"];
  cpu: { idle: number; total: number } | null;
  /** Sectors read and written across whole devices. */
  sectors: number | null;
  memory: HostMetrics["memory"];
}

/** Short enough that the bar stays live, long enough to absorb a burst of tabs. */
const METRICS_TTL_MS = 5_000;

/**
 * How far apart the two readings are.
 *
 * A second is the smallest gap that still resolves a cpu percentage: the kernel
 * accounts in jiffies, 100 per second on most builds, so a 100ms window is a
 * hundred-tick sample and every rounding error in it is a whole percent.
 */
const SAMPLE_GAP_MS = 1_000;

/** Matches the sparkline's own MAX_BARS — more samples would never be drawn. */
const HISTORY_SAMPLES = 20;

/**
 * "Read the whole file" in the only verb the allowlist offers, as the summary
 * service does. See host-summary.service.ts: asking `tail` for fewer lines than
 * a /proc file holds drops the fields at its top, and fails looking exactly like
 * a host that has no /proc at all.
 */
const WHOLE_SMALL_FILE = 500;

/**
 * One `exec` for the lot. `tail` takes several files and labels each with a
 * `==> path <==` header, so five counters cost one channel instead of five —
 * which over SSH is the difference between one round trip per reading and five.
 *
 * `/proc/uptime` is here to time the interval rather than to report uptime; see
 * `elapsedSeconds`. Order is the order the headers come back in, but nothing
 * depends on it: sections are keyed by path.
 */
const PROC_FILES = ["/proc/uptime", "/proc/loadavg", "/proc/stat", "/proc/diskstats", "/proc/meminfo"] as const;

/** The kernel reports diskstats in 512-byte sectors whatever the disk's own. */
const SECTOR_BYTES = 512;

/**
 * Devices whose traffic is somebody else's counted twice: loopbacks and ramdisks
 * are not disks, and a device-mapper or RAID volume passes every byte through to
 * the members below it, which report them again.
 */
const VIRTUAL_DEVICE = /^(loop|ram|zram|dm-|md|sr|fd)\d/;

const SECTION_HEADER = /^==> (.+) <==$/;

@Injectable()
export class HostMetricsService {
  private readonly logger = new Logger(HostMetricsService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly history = new Map<string, number[]>();

  /**
   * Samples in progress, by host.
   *
   * The summary service caches and stops there, which is enough for a poll on a
   * timer but not for a burst: two requests arriving together both miss the
   * cache and both open a channel. A sample here costs a second and two round
   * trips, so the second caller waits on the first's promise instead (TRE-73 §4)
   * — ten tabs on one host produce one sample.
   */
  private readonly inFlight = new Map<string, Promise<HostMetrics>>();

  /** Overridable so a test does not spend a real second per case. */
  constructor(private readonly sampleGapMs: number = SAMPLE_GAP_MS) {}

  async forHost(driver: HostDriver): Promise<HostMetrics> {
    const cached = this.cache.get(driver.hostId);
    if (cached && Date.now() - cached.at < METRICS_TTL_MS) return cached.value;

    const pending = this.inFlight.get(driver.hostId);
    if (pending) return pending;

    const sampling = this.collect(driver)
      .then((value) => {
        this.cache.set(driver.hostId, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(driver.hostId);
      });

    this.inFlight.set(driver.hostId, sampling);
    return sampling;
  }

  /** Drop a host's samples and its history — on delete or credential change. */
  forget(hostId: string): void {
    this.cache.delete(hostId);
    this.history.delete(hostId);
  }

  private async collect(driver: HostDriver): Promise<HostMetrics> {
    const before = await this.read(driver);
    const startedAt = Date.now();
    await delay(this.sampleGapMs);
    const after = await this.read(driver);

    const seconds = elapsedSeconds(before, after, Date.now() - startedAt);
    // The second reading is the fresher one; the first only stands in when the
    // host answered once and not twice.
    const load = after.load ?? before.load;

    return {
      cpuPercent: cpuPercent(before.cpu, after.cpu),
      memory: after.memory ?? before.memory,
      io: ioRate(before.sectors, after.sectors, seconds),
      load,
      history: this.remember(driver.hostId, load),
    };
  }

  private async read(driver: HostDriver): Promise<Sample> {
    const sections = splitSections(await this.tailAll(driver));
    return {
      bootSeconds: parseUptime(sections.get("/proc/uptime")),
      load: parseLoad(sections.get("/proc/loadavg")),
      cpu: parseCpu(sections.get("/proc/stat")),
      sectors: parseSectors(sections.get("/proc/diskstats")),
      memory: parseMemory(sections.get("/proc/meminfo")),
    };
  }

  private async tailAll(driver: HostDriver): Promise<string> {
    try {
      const result = await driver.exec("tail", ["-n", String(WHOLE_SMALL_FILE), ...PROC_FILES], { timeoutMs: 4_000 });
      // Not gated on the exit code, unlike the summary service's single-file
      // reads. `tail` exits non-zero when *any* of its files is missing, having
      // already printed every one that was there — so a host without
      // /proc/diskstats would lose its cpu, memory and load along with its io.
      return result.stdout;
    } catch (error) {
      this.logger.debug(`metrics: /proc unavailable on ${driver.hostId}: ${(error as Error).message}`);
      return "";
    }
  }

  /** Appends this sample's 1-minute load and returns the window to draw. */
  private remember(hostId: string, load: HostMetrics["load"]): number[] {
    const kept = this.history.get(hostId) ?? [];
    if (load === null) return [...kept];

    kept.push(load.one);
    if (kept.length > HISTORY_SAMPLES) kept.splice(0, kept.length - HISTORY_SAMPLES);
    this.history.set(hostId, kept);
    // Copied: the caller serialises this into a response, and the buffer behind
    // it keeps being written to.
    return [...kept];
  }
}

/**
 * `tail`'s multi-file output, split on its headers.
 *
 * Anything before the first header is dropped rather than guessed at. `tail`
 * prints headers whenever it is given more than one file — including for the
 * one file that opened when the other four did not — so unlabelled output means
 * something answered that was not `tail`, and attributing it to a path would be
 * inventing a reading.
 */
function splitSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;

  for (const line of text.split("\n")) {
    const header = SECTION_HEADER.exec(line.trim());
    if (header) {
      current = [];
      sections.set(header[1], current);
      continue;
    }
    current?.push(line);
  }
  return sections;
}

/** Seconds since boot — the first of the two figures on the only line. */
function parseUptime(lines: string[] | undefined): number | null {
  const seconds = Number.parseFloat(lines?.join("").trim().split(/\s+/)[0] ?? "");
  return Number.isFinite(seconds) ? seconds : null;
}

function parseLoad(lines: string[] | undefined): HostMetrics["load"] {
  const [one, five, fifteen] = (lines?.join("").trim().split(/\s+/) ?? []).map(Number);
  if (![one, five, fifteen].every(Number.isFinite)) return null;
  return { one, five, fifteen };
}

/**
 * The aggregate `cpu` line, which is the one without a core number after it.
 *
 * Only the first eight columns are read. `guest` and `guest_nice` follow them
 * and the kernel has already counted both inside `user` and `nice`, so summing
 * every column charges a virtualised host twice for the same time and puts a
 * busy guest above 100%.
 */
function parseCpu(lines: string[] | undefined): Sample["cpu"] {
  const line = lines?.find((row) => row.startsWith("cpu "));
  if (!line) return null;

  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (fields.length < 4 || !fields.every(Number.isFinite)) return null;

  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
  // iowait counts as idle: the cpu had nothing it could run, it was waiting on a
  // disk. Charging it as busy reports 100% for a machine doing nothing but wait.
  const idleAll = idle + iowait;
  return { idle: idleAll, total: user + nice + system + idleAll + irq + softirq + steal };
}

function cpuPercent(before: Sample["cpu"], after: Sample["cpu"]): number | null {
  if (!before || !after) return null;

  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  // A counter that went backwards is a host that rebooted between the two
  // readings. There is no percentage in that, only a number that looks like one.
  if (total <= 0 || idle < 0) return null;

  return clampPercent(Math.round((1 - idle / total) * 100));
}

/**
 * Sectors moved across the host's whole devices.
 *
 * `/proc/diskstats` lists every partition beside the disk it sits on, and both
 * count the same bytes — summing the file raw doubles every figure it reports.
 * A device whose name extends another listed device's is that partition: `sda1`
 * under `sda`, `nvme0n1p1` under `nvme0n1`.
 *
 * Rows with fewer than ten columns are dropped before any of this. Kernels
 * before 4.18 gave partitions a short four-field form, and those rows are the
 * duplicates anyway.
 */
function parseSectors(lines: string[] | undefined): number | null {
  if (!lines) return null;

  const rows = lines
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 10 && !VIRTUAL_DEVICE.test(fields[2]));
  if (rows.length === 0) return null;

  const names = rows.map((fields) => fields[2]);
  const whole = rows.filter((fields) => !names.some((other) => other !== fields[2] && fields[2].startsWith(other)));

  let sectors = 0;
  for (const fields of whole) {
    const read = Number(fields[5]);
    const written = Number(fields[9]);
    if (!Number.isFinite(read) || !Number.isFinite(written)) return null;
    sectors += read + written;
  }
  return sectors;
}

function ioRate(before: number | null, after: number | null, seconds: number | null): HostMetrics["io"] {
  if (before === null || after === null || seconds === null || seconds <= 0) return null;

  const sectors = after - before;
  // Backwards, for the same reason cpu can be: a reboot between the readings.
  if (sectors < 0) return null;

  return { bytesPerSec: Math.round((sectors * SECTOR_BYTES) / seconds) };
}

function parseMemory(lines: string[] | undefined): HostMetrics["memory"] {
  if (!lines) return null;
  const totalKb = matchKb(lines, "MemTotal");
  const availableKb = matchKb(lines, "MemAvailable");
  if (totalKb === null || availableKb === null) return null;
  return { totalKb, availableKb };
}

function matchKb(lines: string[], key: string): number | null {
  const line = lines.find((row) => row.startsWith(`${key}:`));
  if (!line) return null;
  const value = Number.parseInt(line.replace(`${key}:`, "").trim(), 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * How long the counters actually advanced for, by the host's own clock.
 *
 * `/proc/uptime` is read in the same call as the counters, so the difference
 * between the two readings of it *is* the interval — measured on the machine
 * being measured. The wall clock here would carry two SSH round trips as well,
 * and dividing a real delta by an interval the network inflated reports a busy
 * remote disk as a quiet one.
 *
 * The local clock is the fallback, not the default, for hosts with no
 * `/proc/uptime` to offer.
 */
function elapsedSeconds(before: Sample, after: Sample, fallbackMs: number): number | null {
  if (before.bootSeconds !== null && after.bootSeconds !== null) {
    const seconds = after.bootSeconds - before.bootSeconds;
    if (seconds > 0) return seconds;
  }
  return fallbackMs > 0 ? fallbackMs / 1000 : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
