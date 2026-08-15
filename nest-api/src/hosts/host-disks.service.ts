import type { HostDriver } from "@hosts/drivers/host-driver";
import { Injectable, Logger } from "@nestjs/common";

/**
 * How full every filesystem on a host is (TRE-31) — the sidebar's disk panel.
 *
 * The summary service (TRE-12) answers what a host *is* and the metrics service
 * (TRE-73) what it is *doing*; this one answers what it is *holding*, per mount
 * rather than as one figure for the machine. A host with a comfortable root and
 * a full `/srv` is not a host that is 60% full, and one number cannot say so.
 *
 * All of it comes from `df`, which is on the exec allowlist (shell-quote.ts) and
 * needs no path from the client — so there is nothing here for PathGuard to
 * check, and nothing here should ever grow a path parameter without it.
 */

export interface DiskInodes {
  total: number;
  used: number;
  available: number;
  /** Computed from used and total, as the block percentage is. */
  percent: number;
}

export interface DiskMount {
  mountPoint: string;
  device: string;
  /** As `df -T` reports it, or null on a host whose `df` has no `-T` to give. */
  type: string | null;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  /** 0-100, computed from used and total. Never `df`'s own `Capacity`. */
  percent: number;
  /**
   * Full enough to draw amber (TRE-33 §1). Computed here rather than compared
   * against a number in the panel, for the reason `ScanView.stale` is: the
   * threshold is a policy, it is env-tunable, and two clients reading the same
   * `df` must not disagree about which mounts are in trouble. The pane badge and
   * the sidebar row both take this flag, so they agree by construction.
   */
  warn: boolean;
  /** Null where the filesystem keeps no inode count — btrfs, and BSD's dash. */
  inodes: DiskInodes | null;
  /** Whether this is one of the mounts the default view leaves out. */
  pseudo: boolean;
}

interface CacheEntry {
  at: number;
  value: DiskMount[];
}

export interface DiskOptions {
  /** Show `tmpfs` and friends too — the flag TRE-31 asks for. */
  includePseudo?: boolean;
}

/**
 * Longer than the metrics TTL, because a filesystem does not fill in five
 * seconds. The cache is here to absorb a burst of tabs, not to keep a bar live.
 */
const DISKS_TTL_MS = 10_000;

/** Long enough for a stale network mount to answer, short enough not to hang a panel. */
const DF_TIMEOUT_MS = 10_000;

/**
 * `-k` on top of `-P`, for the reason mount-table.ts gives: plain `-P` is
 * 512-byte blocks by POSIX and 1024 on GNU builds that read `POSIXLY_CORRECT`
 * differently, and a factor of two in "how full is this disk" is not a thing to
 * leave to the host's mood.
 *
 * `-T` is the one flag here that is not POSIX. It is asked for first because the
 * type is what tells a ramdisk from a disk, and the call is retried without it
 * on hosts that refuse — see `readBlocks`.
 */
const DF_TYPED_ARGS = ["-P", "-k", "-T"] as const;
const DF_PLAIN_ARGS = ["-P", "-k"] as const;
const DF_INODE_ARGS = ["-P", "-i"] as const;

/**
 * `Filesystem Type 1024-blocks Used Available Capacity Mounted on`.
 *
 * Anchored on three integers and a mount point that starts with `/`, which
 * drops the header and any warning `df` printed above it by shape rather than
 * by counting lines. The mount point is everything after the capacity column,
 * not the next word: `/mnt/My Backup` is one path.
 */
const TYPED_ROW = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\/.*)$/;

/**
 * The six-column form, which serves two different outputs: `df -P -k` is
 * `Filesystem 1024-blocks Used Available Capacity Mounted on` and `df -P -i` is
 * `Filesystem Inodes IUsed IFree IUse% Mounted on`. Same shape, different units.
 */
const PLAIN_ROW = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\/.*)$/;

/**
 * Filesystems that are memory, or somebody else's blocks counted again.
 *
 * The four TRE-31 names, plus the two that turn up beside them on a modern
 * Linux. Nobody wants twelve `tmpfs` rows in a panel about disk pressure — and
 * `/` is exempt from all of it (see `isPseudo`), because a container's root is
 * an overlay and hiding it answers such a host with an empty panel.
 */
const PSEUDO_TYPES = new Set(["tmpfs", "devtmpfs", "overlay", "squashfs", "ramfs", "efivarfs"]);

/**
 * Where a filesystem starts being worth a colour.
 *
 * Seventy, and it is a judgement rather than a measurement: it is the point at
 * which a disk is close enough that somebody should know before the thing that
 * fills it runs. Higher and the warning arrives after the outage; lower and
 * every healthy `/` on a well-used machine is amber, which is the same as no
 * warning at all.
 *
 * Env-tunable because the right number depends on how fast a particular volume
 * fills, and because a fleet operator should not have to fork the app to move a
 * threshold. Clamped to 1-100: a zero here would paint every mount amber, and
 * that is the failure mode of a mistyped variable rather than a policy anyone
 * chose.
 */
export const DISK_WARN_PERCENT = warnPercentFromEnv();

const KIB = 1024;

function warnPercentFromEnv(): number {
  const override = Number.parseInt(process.env.TREKKER_DISK_WARN_PERCENT ?? "", 10);
  return Number.isNaN(override) || override < 1 || override > 100 ? 70 : override;
}

@Injectable()
export class HostDisksService {
  private readonly logger = new Logger(HostDisksService.name);
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Readings in progress, by host — the same coalescing as HostMetricsService.
   * Two `df` calls per reading, and ten tabs polling one host should produce two
   * and not twenty.
   */
  private readonly inFlight = new Map<string, Promise<DiskMount[]>>();

  /**
   * Every mount the host reports, filtered per request.
   *
   * The filter is applied *after* the cache rather than folded into the key, so
   * one caller asking for `tmpfs` does not decide what the next caller sees, and
   * both are served by one `df`.
   */
  async forHost(driver: HostDriver, options: DiskOptions = {}): Promise<DiskMount[]> {
    const all = await this.read(driver);
    return options.includePseudo ? [...all] : all.filter((disk) => !disk.pseudo);
  }

  /** Drop a host's reading — on delete or credential change. */
  forget(hostId: string): void {
    this.cache.delete(hostId);
  }

  private async read(driver: HostDriver): Promise<DiskMount[]> {
    const cached = this.cache.get(driver.hostId);
    if (cached && Date.now() - cached.at < DISKS_TTL_MS) return cached.value;

    const pending = this.inFlight.get(driver.hostId);
    if (pending) return pending;

    const reading = this.collect(driver)
      .then((value) => {
        this.cache.set(driver.hostId, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(driver.hostId);
      });

    this.inFlight.set(driver.hostId, reading);
    return reading;
  }

  private async collect(driver: HostDriver): Promise<DiskMount[]> {
    // Together: two channels opened at once cost one round trip rather than two,
    // and neither reading depends on the other.
    const [blocks, inodes] = await Promise.all([this.readBlocks(driver), this.readInodes(driver)]);

    return blocks
      .map((row) => ({ ...row, inodes: inodes.get(row.mountPoint) ?? null }))
      .sort((left, right) => left.mountPoint.localeCompare(right.mountPoint));
  }

  /**
   * The block figures, typed if the host's `df` can.
   *
   * The retry is judged on rows parsed rather than on the exit code, for both of
   * the reasons that can differ: a busybox `df` rejects `-T` outright with an
   * empty stdout, while a host with a stale NFS mount complains on stderr, exits
   * non-zero, and has already described every filesystem that answered.
   */
  private async readBlocks(driver: HostDriver): Promise<Omit<DiskMount, "inodes">[]> {
    const typed = parseTyped(await this.df(driver, DF_TYPED_ARGS));
    if (typed.length > 0) return typed;

    return parseUntyped(await this.df(driver, DF_PLAIN_ARGS));
  }

  /**
   * Inode usage by mount point, empty when the host does not report any.
   *
   * `-i` on Linux *replaces* the block columns with inode ones, which is what
   * `PLAIN_ROW` describes. A BSD `df -i` appends three columns instead, and a
   * row in that shape matches nothing here — so such a host reports no inode
   * figures rather than a number read out of the wrong column.
   */
  private async readInodes(driver: HostDriver): Promise<Map<string, DiskInodes>> {
    const found = new Map<string, DiskInodes>();

    for (const line of unwrap(await this.df(driver, DF_INODE_ARGS))) {
      const fields = PLAIN_ROW.exec(line);
      if (!fields) continue;

      const total = Number(fields[2]);
      const used = Number(fields[3]);
      const available = Number(fields[4]);
      // Zero total is btrfs and friends saying they keep no such count. Reporting
      // it as "0 of 0 used, 0%" would put a reassuring bar under a question the
      // filesystem never answered.
      if (total <= 0) continue;

      found.set(fields[6], { total, used, available, percent: percentOf(used, total) });
    }

    return found;
  }

  private async df(driver: HostDriver, args: readonly string[]): Promise<string> {
    try {
      const result = await driver.exec("df", args, { timeoutMs: DF_TIMEOUT_MS });
      // The output is judged, not the code — see readBlocks.
      return result.stdout;
    } catch (error) {
      this.logger.debug(`disks: df ${args.join(" ")} failed on ${driver.hostId}: ${(error as Error).message}`);
      return "";
    }
  }
}

function parseTyped(output: string): Omit<DiskMount, "inodes">[] {
  const disks: Omit<DiskMount, "inodes">[] = [];

  for (const line of unwrap(output)) {
    const fields = TYPED_ROW.exec(line);
    if (!fields) continue;

    const disk = blockRow({
      device: fields[1],
      type: fields[2],
      totalKib: fields[3],
      usedKib: fields[4],
      availableKib: fields[5],
      mountPoint: fields[7],
    });
    if (disk) disks.push(disk);
  }

  return disks;
}

/**
 * The same rows from a `df` with no `-T`.
 *
 * Every mount is kept, because without a type there is nothing to call pseudo:
 * hiding rows on a guess about the device name would be worse than showing a
 * ramdisk. Such a host shows one panel too many rather than none.
 */
function parseUntyped(output: string): Omit<DiskMount, "inodes">[] {
  const disks: Omit<DiskMount, "inodes">[] = [];

  for (const line of unwrap(output)) {
    const fields = PLAIN_ROW.exec(line);
    if (!fields) continue;

    const disk = blockRow({
      device: fields[1],
      type: null,
      totalKib: fields[2],
      usedKib: fields[3],
      availableKib: fields[4],
      mountPoint: fields[6],
    });
    if (disk) disks.push(disk);
  }

  return disks;
}

function blockRow(row: {
  device: string;
  type: string | null;
  totalKib: string;
  usedKib: string;
  availableKib: string;
  mountPoint: string;
}): Omit<DiskMount, "inodes"> | null {
  const total = Number(row.totalKib);
  const used = Number(row.usedKib);
  const available = Number(row.availableKib);
  // A filesystem with no blocks — `proc`, `sysfs`, a `df -a` placeholder — has
  // no fullness to report, and a percentage of it is a division by zero with a
  // number where the error should be.
  if (total <= 0) return null;

  const mountPoint = row.mountPoint.trimEnd();
  const percent = percentOf(used, total);
  return {
    mountPoint,
    device: row.device,
    type: row.type,
    totalBytes: total * KIB,
    usedBytes: used * KIB,
    availableBytes: available * KIB,
    percent,
    // At the threshold, not past it: a volume that has just reached 70% has
    // reached it, and an off-by-one here is a warning that arrives a percent late.
    warn: percent >= DISK_WARN_PERCENT,
    pseudo: isPseudo(row.type, mountPoint),
  };
}

/**
 * Used over total, and never `df`'s `Capacity` column.
 *
 * `df` computes that column against `used + available`, which on ext4 excludes
 * the 5% reserved for root — so it prints 32% beside numbers that make 30%, and
 * a panel showing all three is showing arithmetic the reader cannot check.
 *
 * Rounded to whole percent, which is the precision the panel draws.
 */
function percentOf(used: number, total: number): number {
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

/**
 * Whether the default view leaves this mount out.
 *
 * `/` never is, whatever it is made of: a container's root is an `overlay`, and
 * a panel that hid it would say "no disks" to a machine that has one — which is
 * a different claim, and a wrong one.
 */
function isPseudo(type: string | null, mountPoint: string): boolean {
  if (mountPoint === "/") return false;
  return type !== null && PSEUDO_TYPES.has(type);
}

/**
 * `df`'s lines, with wrapped rows put back together.
 *
 * `-P` is meant to guarantee one line per filesystem, and several implementations
 * still print a long device name alone and the fields on the next line. Read by
 * column position that row is a filesystem called `/dev/mapper/...` with the
 * type where its size should be — so a line holding nothing but a device name is
 * joined to the one after it before anything is parsed.
 */
function unwrap(output: string): string[] {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const joined: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\s/.test(line) && index + 1 < lines.length) {
      joined.push(`${line} ${lines[index + 1]}`);
      index += 1;
      continue;
    }
    joined.push(line);
  }

  return joined;
}
