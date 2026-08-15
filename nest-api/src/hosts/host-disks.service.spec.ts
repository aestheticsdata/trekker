import type { HostDriver } from "@hosts/drivers/host-driver";
import { HostDisksService } from "@hosts/host-disks.service";

/**
 * How full every filesystem is (TRE-31).
 *
 * `df` is a formatting program being read as an interface, so every case here
 * is a parsing decision with one correct answer and several plausible wrong
 * ones — all of which produce a row that renders happily in the sidebar. A
 * percentage taken from the `Capacity` column, a device name that wrapped and
 * shifted every field, a `tmpfs` counted as a disk: none of them fail, they
 * just report something that is not true of the machine.
 *
 * So the fixtures are real `df` output, wrapping and all, and the driver is a
 * fake that answers by argv and counts how often it was asked.
 */

/**
 * `df -P -k -T` on a host with two disks and a ramdisk.
 *
 * The root's `Capacity` says 32% and the ticket's rule says 30%: `df` computes
 * that column against `used + available`, which excludes the 5% root reserve,
 * so it disagrees with the two numbers printed beside it. Both are in the
 * fixture because the difference is the point.
 */
const TYPED = `Filesystem     Type    1024-blocks     Used Available Capacity Mounted on
/dev/sda1      ext4       41147472 12345678  26800000      32% /
tmpfs          tmpfs       2048000        0   2048000       0% /dev/shm
/dev/sdb1      xfs       524288000 78643200 445644800      15% /srv/data`;

/** The same host, from a `df` with no `-T` to give. */
const UNTYPED = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         41147472 12345678  26800000      32% /
tmpfs              2048000        0   2048000       0% /dev/shm
/dev/sdb1        524288000 78643200 445644800      15% /srv/data`;

const INODES = `Filesystem      Inodes   IUsed    IFree IUse% Mounted on
/dev/sda1      2621440  345678  2275762   14% /
tmpfs           500000       1   499999    1% /dev/shm
/dev/sdb1     52428800  120000 52308800    1% /srv/data`;

/** 41147472 KiB, and 12345678 of them used: 30.0%, not the 32% df prints. */
const ROOT_TOTAL_BYTES = 41_147_472 * 1024;
const ROOT_USED_BYTES = 12_345_678 * 1024;
const ROOT_AVAILABLE_BYTES = 26_800_000 * 1024;

interface Answers {
  typed?: string | null;
  untyped?: string;
  inodes?: string | null;
}

/**
 * Answers `df` by argv and counts the calls.
 *
 * `null` for either output is a host whose `df` refuses that form — a busybox
 * without `-T`, a kernel with no inode figures — and answers the way such a
 * host does: non-zero, nothing on stdout.
 */
class FakeDriver {
  readonly hostId = "host-1";
  readonly calls: string[][] = [];

  constructor(private readonly answers: Answers = {}) {}

  exec = (program: string, args: readonly string[]) => {
    this.calls.push([program, ...args]);
    const stdout = this.answerFor(args);
    return Promise.resolve(
      stdout === null
        ? { code: 1, signal: null, stdout: "", stderr: "df: invalid option" }
        : { code: 0, signal: null, stdout, stderr: "" },
    );
  };

  private answerFor(args: readonly string[]): string | null {
    if (args.includes("-i")) return this.answers.inodes === undefined ? INODES : this.answers.inodes;
    if (args.includes("-T")) return this.answers.typed === undefined ? TYPED : this.answers.typed;
    return this.answers.untyped ?? UNTYPED;
  }
}

function serviceFor(answers: Answers = {}): { service: HostDisksService; driver: FakeDriver; host: HostDriver } {
  const driver = new FakeDriver(answers);
  return { service: new HostDisksService(), driver, host: driver as unknown as HostDriver };
}

function disksOf(answers: Answers = {}, options?: { includePseudo?: boolean }) {
  const { service, driver, host } = serviceFor(answers);
  return { service, driver, disks: service.forHost(host, options) };
}

/** How many times `df` was asked anything at all. */
const dfCalls = (driver: FakeDriver) => driver.calls.length;

describe("HostDisksService", () => {
  it("reports a row per mount, in bytes", async () => {
    const { disks } = disksOf();
    const [root] = await disks;

    expect(root).toMatchObject({
      mountPoint: "/",
      device: "/dev/sda1",
      type: "ext4",
      totalBytes: ROOT_TOTAL_BYTES,
      usedBytes: ROOT_USED_BYTES,
      availableBytes: ROOT_AVAILABLE_BYTES,
    });
  });

  it("computes the percentage from used and total, not from the Capacity column", async () => {
    // df says 32%, because it divides by used + available and the root reserve
    // is in neither. A panel that shows 32% beside numbers that make 30% is
    // showing arithmetic nobody can check.
    const { disks } = disksOf();
    const [root] = await disks;

    expect(root.percent).toBe(30);
  });

  it("sorts by mount point, so the same host lists the same way twice running", async () => {
    const { disks } = disksOf({}, { includePseudo: true });

    expect((await disks).map((disk) => disk.mountPoint)).toEqual(["/", "/dev/shm", "/srv/data"]);
  });

  describe("pseudo-filesystems", () => {
    it("leaves them out by default", async () => {
      const { disks } = disksOf();

      expect((await disks).map((disk) => disk.mountPoint)).toEqual(["/", "/srv/data"]);
    });

    it("includes them when asked, marked as what they are", async () => {
      const { disks } = disksOf({}, { includePseudo: true });
      const shm = (await disks).find((disk) => disk.mountPoint === "/dev/shm");

      expect(shm).toMatchObject({ type: "tmpfs", pseudo: true });
    });

    it("keeps the root filesystem whatever its type", async () => {
      // A container's `/` is an overlay. Filtering by type alone answers such a
      // host with an empty panel, which reads as "no disks" rather than as "the
      // one disk you have is of a type we hid".
      const container = `Filesystem     Type   1024-blocks     Used Available Capacity Mounted on
overlay        overlay   41147472 12345678  26800000      32% /
tmpfs          tmpfs      2048000        0   2048000       0% /dev/shm`;
      const { disks } = disksOf({ typed: container, inodes: "" });

      expect((await disks).map((disk) => disk.mountPoint)).toEqual(["/"]);
    });

    it("drops a filesystem with no blocks at all", async () => {
      // `proc` and `sysfs` have no size to be full of. A percentage here is a
      // division by zero dressed up as a number.
      const withProc = `${TYPED}\nproc           proc              0        0         0       0% /proc`;
      const { disks } = disksOf({ typed: withProc }, { includePseudo: true });

      expect((await disks).map((disk) => disk.mountPoint)).not.toContain("/proc");
    });
  });

  describe("inodes", () => {
    it("reports them beside the blocks of the same mount", async () => {
      const { disks } = disksOf();
      const [root] = await disks;

      expect(root.inodes).toEqual({ total: 2_621_440, used: 345_678, available: 2_275_762, percent: 13 });
    });

    it("shows a host near its inode limit as near it, whatever its blocks say", async () => {
      // The failure this column exists to catch: a disk with room on it that
      // cannot create another file.
      const exhausted = `Filesystem      Inodes   IUsed    IFree IUse% Mounted on
/dev/sda1      2621440 2620000     1440   99% /`;
      const { disks } = disksOf({ inodes: exhausted });
      const [root] = await disks;

      expect(root.percent).toBe(30);
      expect(root.inodes?.percent).toBe(100);
    });

    it("reports none for a filesystem that keeps no inode count", async () => {
      // btrfs reports zero, BSD reports a dash. Neither is "0% used".
      const btrfs = `Filesystem      Inodes   IUsed    IFree IUse% Mounted on
/dev/sda1            0       0        0     - /`;
      const { disks } = disksOf({ inodes: btrfs });
      const [root] = await disks;

      expect(root.inodes).toBeNull();
    });

    it("still reports the blocks when df cannot be asked for inodes at all", async () => {
      const { disks } = disksOf({ inodes: null });
      const [root] = await disks;

      expect(root).toMatchObject({ totalBytes: ROOT_TOTAL_BYTES, inodes: null });
    });
  });

  describe("parsing df", () => {
    it("reads a row whose device name wrapped onto its own line", async () => {
      // The reason column positions cannot be trusted: a long device name is
      // printed alone and the fields follow on the next line, so field 2 of the
      // continuation is the type and field 2 of a whole row is the size.
      const wrapped = `Filesystem     Type    1024-blocks     Used Available Capacity Mounted on
/dev/mapper/vg--srv-lv--data--archive--2026
               ext4       41147472 12345678  26800000      32% /srv/data`;
      const { disks } = disksOf({ typed: wrapped, inodes: "" });
      const [data] = await disks;

      expect(data).toMatchObject({
        device: "/dev/mapper/vg--srv-lv--data--archive--2026",
        type: "ext4",
        mountPoint: "/srv/data",
        totalBytes: ROOT_TOTAL_BYTES,
      });
    });

    it("keeps a mount point that contains a space", async () => {
      const spaced = `Filesystem     Type   1024-blocks     Used Available Capacity Mounted on
/dev/sdc1      ext4      41147472 12345678  26800000      32% /mnt/My Backup`;
      const { disks } = disksOf({ typed: spaced, inodes: "" });

      expect((await disks)[0].mountPoint).toBe("/mnt/My Backup");
    });

    it("falls back to a df with no -T, and says the type is unknown", async () => {
      const { disks, driver } = disksOf({ typed: null });
      const [root] = await disks;

      expect(root).toMatchObject({ device: "/dev/sda1", type: null, totalBytes: ROOT_TOTAL_BYTES });
      // Without a type there is nothing to call pseudo, so the ramdisk stays:
      // hiding rows on a guess is worse than showing one too many.
      expect((await disks).map((disk) => disk.mountPoint)).toContain("/dev/shm");
      expect(driver.calls.filter((call) => !call.includes("-i"))).toHaveLength(2);
    });

    it("answers a host with no usable df with no disks rather than an error", async () => {
      const { disks } = disksOf({ typed: "", untyped: "", inodes: "" });

      await expect(disks).resolves.toEqual([]);
    });
  });

  describe("cost", () => {
    it("never asks a host nobody is looking at", () => {
      const { driver } = serviceFor();

      // No timer, no warm-up: the first question is what opens a channel.
      expect(dfCalls(driver)).toBe(0);
    });

    it("turns ten concurrent requests into one pair of df calls", async () => {
      const { service, driver, host } = serviceFor();

      const answers = await Promise.all(Array.from({ length: 10 }, () => service.forHost(host)));

      expect(dfCalls(driver)).toBe(2);
      for (const answer of answers) expect(answer).toEqual(answers[0]);
    });

    it("serves the cache rather than re-running df within the TTL", async () => {
      const { service, driver, host } = serviceFor();

      await service.forHost(host);
      await service.forHost(host);

      expect(dfCalls(driver)).toBe(2);
    });

    it("filters the cached reading per request, so one caller's flag is not another's", async () => {
      const { service, driver, host } = serviceFor();

      const withPseudo = await service.forHost(host, { includePseudo: true });
      const without = await service.forHost(host);

      expect(withPseudo.map((disk) => disk.mountPoint)).toContain("/dev/shm");
      expect(without.map((disk) => disk.mountPoint)).not.toContain("/dev/shm");
      expect(dfCalls(driver)).toBe(2);
    });

    it("re-reads a forgotten host", async () => {
      const { service, driver, host } = serviceFor();

      await service.forHost(host);
      service.forget("host-1");
      await service.forHost(host);

      expect(dfCalls(driver)).toBe(4);
    });
  });
});
