import { Readable } from "node:stream";
import type { FileStat, HostDriver, ReadOptions } from "@hosts/drivers/host-driver";
import { PollTailSource, type TailSink } from "@fs/tail-source";

/**
 * Rotation detection in the polling source (TRE-34 §2).
 *
 * This file exists because of one bug, and the bug is worth naming: `rotated()`
 * originally preferred the inode when the stat carried one and used the size
 * only as a fallback. That reports no rotation for a `copytruncate` — same
 * inode, emptied in place — which is the commonest `logrotate` mode there is,
 * and the next read then takes a byte range from the middle of a file that has
 * started again at zero. `pnpm verify:tail` caught it against a real file; this
 * keeps it caught without one.
 *
 * The driver is a fake so the file's size and inode can be moved between ticks
 * on demand. Provoking both rotation modes against a real filesystem is what
 * `verify:tail` is for; what is under test here is the arithmetic that decides.
 */

class MutableFile implements Partial<HostDriver> {
  readonly hostId = "host-1";
  content = "";
  inode: number | undefined = 100;

  stat = (path: string): Promise<FileStat> =>
    Promise.resolve({
      path,
      name: "access.log",
      kind: "file" as const,
      size: Buffer.byteLength(this.content),
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtimeMs: 0,
      ...(this.inode === undefined ? {} : { inode: this.inode }),
    });

  createReadStream = (_path: string, options?: ReadOptions): Promise<Readable> => {
    const bytes = Buffer.from(this.content, "utf8");
    const start = options?.start ?? 0;
    const end = options?.end ?? bytes.length - 1;
    return Promise.resolve(Readable.from([bytes.subarray(start, end + 1)]));
  };
}

class Recorder implements TailSink {
  lines: string[] = [];
  rotations = 0;
  errors: string[] = [];

  onLines = (lines: string[]): void => {
    this.lines.push(...lines);
  };
  onRotated = (): void => {
    this.rotations += 1;
  };
  onError = (message: string): void => {
    this.errors.push(message);
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Let the source run a fixed number of ticks against the fake clock. */
async function ticks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    // Each tick awaits a stat and possibly a ranged read, so the queues have to
    // drain between advances or the ticks pile up unresolved.
    await jest.advanceTimersByTimeAsync(800);
    await settle();
    await settle();
  }
}

describe("PollTailSource rotation", () => {
  let file: MutableFile;
  let recorder: Recorder;
  let controller: AbortController;

  beforeEach(() => {
    // `setImmediate` and `nextTick` are left real: the poll *timer* is what the
    // test needs to control, while the stream reads between ticks resolve on
    // those two. Faking all four leaves every await pending forever, which
    // presents as a five-second timeout rather than as a clue.
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    file = new MutableFile();
    recorder = new Recorder();
    controller = new AbortController();
  });

  afterEach(() => {
    controller.abort();
    jest.useRealTimers();
  });

  function start(): PollTailSource {
    const source = new PollTailSource({
      driver: file as unknown as HostDriver,
      realPath: "/var/log/nginx/access.log",
      initialLines: 200,
      resumeFrom: null,
      signal: controller.signal,
      sink: recorder,
    });
    source.start();
    return source;
  }

  it("follows an ordinary append", async () => {
    file.content = "one\n";
    start();
    await settle();
    await settle();

    file.content += "two\n";
    await ticks(1);

    expect(recorder.lines).toContain("two");
    expect(recorder.rotations).toBe(0);
  });

  it("catches a copytruncate, where the inode does not change", async () => {
    // A log that has been running for a while, which is the only kind anybody
    // rotates: the offset is well past whatever the fresh file starts with.
    file.content = `${"a line of a running log\n".repeat(20)}`;
    start();
    await settle();
    await settle();

    // Emptied in place and written again. The inode is untouched, which is
    // exactly what made this invisible to an inode-only test — and the reason
    // the first line after it was rendered as a fragment taken from the old
    // offset rather than as the line that was written.
    file.content = "after truncate\n";
    await ticks(2);

    expect(recorder.rotations).toBeGreaterThan(0);
    expect(recorder.lines).toContain("after truncate");
  });

  it("cannot see a truncate that is refilled past the old offset within one tick", async () => {
    // The honest limit of the size rule, pinned so it is a known shape rather
    // than a surprise. Same inode, and by the time the next tick looks the file
    // is *longer* than it was — so nothing in the two numbers says a rotation
    // happened, and the read takes a range from the middle of the new file.
    //
    // It needs the log to be rewritten past its entire previous length inside
    // one poll interval, which is the same window the create-mode caveat has.
    // The way out is an inode, and SFTP v3 does not carry one.
    file.content = "one\n";
    start();
    await settle();
    await settle();

    file.content = "a replacement already longer than the file it replaced\n";
    await ticks(2);

    expect(recorder.rotations).toBe(0);
  });

  it("catches a create-mode rotation, where the inode does change", async () => {
    file.content = "one\ntwo\nthree\n";
    start();
    await settle();
    await settle();

    // A new file in place of the old one, and deliberately *longer* than what
    // came before — so the size rule alone would see an ordinary append and
    // only the inode says otherwise.
    file.inode = 200;
    file.content = "a much longer first line of the replacement file\n";
    await ticks(2);

    expect(recorder.rotations).toBeGreaterThan(0);
    expect(recorder.lines).toContain("a much longer first line of the replacement file");
  });

  it("still catches a shrink on a host that reports no inode", async () => {
    // SFTP v3 has no attribute for an inode, so this is every remote host.
    file.inode = undefined;
    file.content = "one\ntwo\nthree\n";
    start();
    await settle();
    await settle();

    file.content = "new\n";
    await ticks(2);

    expect(recorder.rotations).toBeGreaterThan(0);
    expect(recorder.lines).toContain("new");
  });

  it("does not announce a rotation that did not happen", async () => {
    file.content = "one\n";
    start();
    await settle();
    await settle();

    file.content += "two\nthree\n";
    await ticks(3);

    expect(recorder.rotations).toBe(0);
  });
});
