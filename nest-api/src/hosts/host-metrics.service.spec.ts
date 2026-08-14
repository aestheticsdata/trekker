import { HostMetricsService } from "@hosts/host-metrics.service";
import type { HostDriver } from "@hosts/drivers/host-driver";

/**
 * What the top bar's numbers are made of (TRE-73).
 *
 * Every case here is a parsing or arithmetic decision that has exactly one
 * correct answer and several plausible wrong ones, all of which produce a
 * number rather than a failure — which is the whole difficulty with this
 * service. A doubled io figure, a cpu charged for `iowait`, a percentage
 * computed against the wrong interval: each renders happily in the bar and
 * there is nothing on screen to say it is wrong.
 *
 * So the fixtures are real /proc text with arithmetic that can be checked by
 * hand, and the driver is a fake that hands back canned readings and counts how
 * many times it was asked.
 */

const STAT_BEFORE = `cpu  100 0 100 800 0 0 0 0 0 0
cpu0 50 0 50 400 0 0 0 0 0 0
intr 12345 0 0
ctxt 98765`;

// 1000 more jiffies in total, 800 of them idle: a fifth of the interval busy.
const STAT_AFTER = `cpu  200 0 200 1600 0 0 0 0 0 0
cpu0 100 0 100 800 0 0 0 0 0 0
intr 22345 0 0
ctxt 108765`;

/**
 * A disk, one of its partitions, and a loopback. Only `sda` may be counted:
 * `sda1`'s sectors are `sda`'s sectors, and `loop0` is a mounted file.
 *
 * Columns are the kernel's: major, minor, name, then reads completed, reads
 * merged, **sectors read**, ms reading, writes completed, writes merged,
 * **sectors written**, and the rest.
 */
const DISKSTATS_BEFORE = `   8       0 sda 100 0 1000 200 50 0 500 100 0 100 300
   8       1 sda1 50 0 500 100 25 0 250 50 0 50 150
   7       0 loop0 1 0 10 1 0 0 0 0 0 0 0`;

// sda: 2000 more sectors read, 1000 more written — 3000 over the interval.
const DISKSTATS_AFTER = `   8       0 sda 300 0 3000 400 150 0 1500 200 0 200 600
   8       1 sda1 150 0 1500 200 75 0 750 100 0 100 300
   7       0 loop0 1 0 10 1 0 0 0 0 0 0 0`;

const MEMINFO = `MemTotal:       32000000 kB
MemFree:         2000000 kB
MemAvailable:   22600000 kB
Buffers:          500000 kB`;

const LOADAVG = "0.42 0.30 0.25 1/234 5678";

/** Two seconds apart by the host's own clock, whatever the network did. */
const UPTIME_BEFORE = "1000.00 900.00";
const UPTIME_AFTER = "1002.00 902.00";

/** 3000 sectors × 512 bytes over 2 seconds. */
const EXPECTED_BYTES_PER_SEC = 768_000;

function tailOutput(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, body]) => `==> ${path} <==\n${body}`)
    .join("\n\n");
}

function reading(index: 0 | 1, overrides: Record<string, string | null> = {}): string {
  const files: Record<string, string> = {
    "/proc/uptime": index === 0 ? UPTIME_BEFORE : UPTIME_AFTER,
    "/proc/loadavg": LOADAVG,
    "/proc/stat": index === 0 ? STAT_BEFORE : STAT_AFTER,
    "/proc/diskstats": index === 0 ? DISKSTATS_BEFORE : DISKSTATS_AFTER,
    "/proc/meminfo": MEMINFO,
  };
  for (const [path, body] of Object.entries(overrides)) {
    if (body === null) delete files[path];
    else files[path] = body;
  }
  return tailOutput(files);
}

/** Hands back canned readings in a loop, and counts how often it was asked. */
class FakeDriver {
  readonly hostId = "host-1";
  calls = 0;

  constructor(private readonly outputs: readonly string[]) {}

  exec = (): Promise<{ code: number; signal: null; stdout: string; stderr: string }> => {
    const stdout = this.outputs[this.calls % this.outputs.length];
    this.calls += 1;
    return Promise.resolve({ code: 0, signal: null, stdout, stderr: "" });
  };
}

function serviceFor(outputs: readonly string[]): { service: HostMetricsService; driver: FakeDriver } {
  const driver = new FakeDriver(outputs);
  // Zero gap: the interval that matters is the one /proc/uptime reports, not
  // the one this process waits out.
  return { service: new HostMetricsService(0), driver };
}

function collect(outputs: readonly string[] = [reading(0), reading(1)]) {
  const { service, driver } = serviceFor(outputs);
  return { service, driver, metrics: service.forHost(driver as unknown as HostDriver) };
}

describe("HostMetricsService", () => {
  it("reports cpu as the busy share of the interval, not of all time since boot", async () => {
    const { metrics } = collect();
    await expect(metrics).resolves.toMatchObject({ cpuPercent: 20 });
  });

  it("counts iowait as idle", async () => {
    // The same 1000 jiffies, all of them waiting on a disk. A cpu with nothing
    // it can run is not a busy cpu, and charging this as work reports 100% for
    // a machine doing nothing at all.
    const busyWaiting = `cpu  100 0 100 800 1000 0 0 0 0 0`;
    const { metrics } = collect([reading(0), reading(1, { "/proc/stat": busyWaiting })]);
    await expect(metrics).resolves.toMatchObject({ cpuPercent: 0 });
  });

  it("ignores the guest columns, which the kernel has already counted in user", async () => {
    // guest 1000 and guest_nice 1000 trail the eight real columns. Summed in,
    // they inflate the total and drag the busy share down.
    const withGuests = `cpu  200 0 200 1600 0 0 0 0 1000 1000`;
    const { metrics } = collect([reading(0), reading(1, { "/proc/stat": withGuests })]);
    await expect(metrics).resolves.toMatchObject({ cpuPercent: 20 });
  });

  it("reports io from the sector delta, timed by the host's own clock", async () => {
    const { metrics } = collect();
    await expect(metrics).resolves.toMatchObject({ io: { bytesPerSec: EXPECTED_BYTES_PER_SEC } });
  });

  it("counts a disk once when its partitions are listed beside it", async () => {
    // sda alone moved 3000 sectors. With sda1 summed in it reads 4500, and the
    // bar shows half again as much traffic as the disk actually did.
    const { metrics } = collect();
    const { io } = await metrics;
    expect(io?.bytesPerSec).toBe(EXPECTED_BYTES_PER_SEC);
  });

  it("recognises an nvme partition, which is not simply its device plus a digit", async () => {
    const nvme = (
      read: number,
      written: number,
    ) => `   259       0 nvme0n1 100 0 ${read} 200 50 0 ${written} 100 0 100 300
   259       1 nvme0n1p1 50 0 ${read / 2} 100 25 0 ${written / 2} 50 0 50 150`;
    const { metrics } = collect([
      reading(0, { "/proc/diskstats": nvme(1000, 500) }),
      reading(1, { "/proc/diskstats": nvme(3000, 1500) }),
    ]);
    await expect(metrics).resolves.toMatchObject({ io: { bytesPerSec: EXPECTED_BYTES_PER_SEC } });
  });

  it("reports the memory the host has and the memory it can still hand out", async () => {
    const { metrics } = collect();
    await expect(metrics).resolves.toMatchObject({
      memory: { totalKb: 32_000_000, availableKb: 22_600_000 },
    });
  });

  it("reports all three load averages", async () => {
    const { metrics } = collect();
    await expect(metrics).resolves.toMatchObject({ load: { one: 0.42, five: 0.3, fifteen: 0.25 } });
  });

  it("keeps every field a host can answer when one /proc file is missing", async () => {
    // `tail` exits non-zero here and prints the four files that opened. Losing
    // the cpu along with the io would be the easy mistake, and the one that
    // makes a container look like a host with no /proc at all.
    const { metrics } = collect([reading(0, { "/proc/diskstats": null }), reading(1, { "/proc/diskstats": null })]);
    await expect(metrics).resolves.toMatchObject({
      cpuPercent: 20,
      io: null,
      memory: { totalKb: 32_000_000 },
      load: { one: 0.42 },
    });
  });

  it("reports nothing at all for a host with no /proc", async () => {
    const { metrics } = collect(["", ""]);
    await expect(metrics).resolves.toMatchObject({
      cpuPercent: null,
      io: null,
      memory: null,
      load: null,
      history: [],
    });
  });

  it("refuses a rate from counters that went backwards", async () => {
    // A reboot between the two readings. Both counters restart, and the
    // subtraction that follows is arithmetic on unrelated numbers.
    const { metrics } = collect([reading(1), reading(0)]);
    await expect(metrics).resolves.toMatchObject({ cpuPercent: null, io: null });
  });

  it("ignores output it cannot attribute to a file", async () => {
    const { metrics } = collect([STAT_BEFORE, STAT_AFTER]);
    await expect(metrics).resolves.toMatchObject({ cpuPercent: null, memory: null });
  });

  it("turns ten concurrent requests into one sample", async () => {
    const { service, driver } = serviceFor([reading(0), reading(1)]);
    const host = driver as unknown as HostDriver;

    const answers = await Promise.all(Array.from({ length: 10 }, () => service.forHost(host)));

    // Two reads — one sample — for all ten, and every caller gets it.
    expect(driver.calls).toBe(2);
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it("serves the cache rather than resampling within the TTL", async () => {
    const { service, driver } = serviceFor([reading(0), reading(1)]);
    const host = driver as unknown as HostDriver;

    await service.forHost(host);
    await service.forHost(host);

    expect(driver.calls).toBe(2);
  });

  describe("history", () => {
    let clock = 0;

    beforeEach(() => {
      clock = 1_000_000;
      jest.spyOn(Date, "now").mockImplementation(() => clock);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    /** Past the TTL, so each call takes a fresh sample. */
    const sampleAgain = async (service: HostMetricsService, host: HostDriver) => {
      clock += 10_000;
      return service.forHost(host);
    };

    it("appends the 1-minute load once per sample", async () => {
      const { service, driver } = serviceFor([reading(0), reading(1)]);
      const host = driver as unknown as HostDriver;

      await sampleAgain(service, host);
      await sampleAgain(service, host);
      const third = await sampleAgain(service, host);

      expect(third.history).toEqual([0.42, 0.42, 0.42]);
    });

    it("keeps only what the sparkline can draw", async () => {
      const { service, driver } = serviceFor([reading(0), reading(1)]);
      const host = driver as unknown as HostDriver;

      let latest = await sampleAgain(service, host);
      for (let index = 0; index < 24; index += 1) latest = await sampleAgain(service, host);

      expect(latest.history).toHaveLength(20);
    });

    it("hands out a copy, so a response cannot be written back into the buffer", async () => {
      const { service, driver } = serviceFor([reading(0), reading(1)]);
      const host = driver as unknown as HostDriver;

      const first = await sampleAgain(service, host);
      first.history.push(99);
      const second = await sampleAgain(service, host);

      expect(second.history).toEqual([0.42, 0.42]);
    });

    it("drops a forgotten host's history", async () => {
      const { service, driver } = serviceFor([reading(0), reading(1)]);
      const host = driver as unknown as HostDriver;

      await sampleAgain(service, host);
      service.forget("host-1");
      const after = await sampleAgain(service, host);

      expect(after.history).toEqual([0.42]);
    });
  });
});
