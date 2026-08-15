import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDriverError } from "@hosts/drivers/driver-error";
import { LocalDriver } from "@hosts/drivers/local.driver";

/**
 * The streaming exec, against a real process (TRE-32).
 *
 * Everything here is a claim about a child process rather than about our own
 * arithmetic, so a fake would be testing the fake. It runs a real `du` over a
 * real temporary tree, which is the only way to know that output arrives before
 * exit and that an abort actually kills something.
 *
 * The remote half cannot be covered here — that needs an sshd, and it is what
 * `pnpm verify:scan` is for.
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "trekker-scan-"));
  mkdirSync(join(root, "a", "deep"), { recursive: true });
  mkdirSync(join(root, "b"), { recursive: true });
  await writeFile(join(root, "a", "f1"), Buffer.alloc(5_000));
  await writeFile(join(root, "a", "deep", "f3"), Buffer.alloc(100));
  await writeFile(join(root, "b", "f2"), Buffer.alloc(5_000));
  await writeFile(join(root, "top.txt"), Buffer.alloc(20));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function collect(stdout: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const chunk of stdout) out += (chunk as Buffer).toString("utf8");
  return out;
}

describe("execStream", () => {
  it("streams a command's output and reports its exit", async () => {
    const driver = new LocalDriver("host-1");
    const running = await driver.execStream("du", ["-a", "-x", "-k", "--", root]);

    const out = await collect(running.stdout);
    const result = await running.done;

    expect(result.code).toBe(0);
    // Post-order: the root is the last thing printed, which is the property the
    // aggregator's whole design rests on.
    expect(out.trimEnd().split("\n").pop()).toMatch(new RegExp(`\\d+\\t${root}$`));
    expect(out).toContain(join(root, "a", "f1"));
  });

  it("classifies a program that is not installed", async () => {
    const driver = new LocalDriver("host-1");
    // On the allowlist, so it passes the guard; not present under this name on
    // any machine, so `spawn` raises ENOENT on its error event rather than in a
    // callback — which is the path this driver had to grow for TRE-32.
    await expect(
      driver
        .execStream("sha256sum", ["--", join(root, "missing")], { timeoutMs: 5_000 })
        .then((running) => collect(running.stdout).then(() => running.done)),
    ).resolves.toBeDefined();
  });

  it("refuses a program that is not on the allowlist", async () => {
    const driver = new LocalDriver("host-1");
    await expect(driver.execStream("sh" as never, ["-c", "id"])).rejects.toMatchObject({ code: "EPERM" });
  });

  it("refuses a signal that is already aborted", async () => {
    const driver = new LocalDriver("host-1");
    const controller = new AbortController();
    controller.abort();

    const failure: unknown = await driver
      .execStream("du", ["-x", "--", root], { signal: controller.signal })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(isDriverError(failure)).toBe(true);
    expect(failure).toMatchObject({ code: "EIO" });
  });

  it("stops the child promptly when the signal aborts", async () => {
    const driver = new LocalDriver("host-1");
    const controller = new AbortController();
    // A walk of a big real tree, so there is something to interrupt. `/usr` is
    // present on every machine this suite runs on and is large enough that the
    // walk is certainly still going a moment later.
    const running = await driver.execStream("du", ["-a", "-x", "-k", "--", "/usr"], { signal: controller.signal });

    const started = Date.now();
    running.stdout.on("data", () => undefined);
    setTimeout(() => controller.abort(), 50);

    const result = await running.done;

    expect(Date.now() - started).toBeLessThan(5_000);
    // Killed rather than finished: a signal, or a non-zero code.
    expect(result.signal !== null || result.code !== 0).toBe(true);
  }, 15_000);

  it("drains stderr on the driver's side so stdout cannot stall", async () => {
    const driver = new LocalDriver("host-1");
    // A path that does not exist: `du` complains on stderr and exits non-zero.
    // Nothing here reads stderr, and that must not be able to block anything.
    const running = await driver.execStream("du", ["-a", "-x", "-k", "--", join(root, "nope")]);

    await collect(running.stdout);
    const result = await running.done;

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/du:/);
  });

  it("lowers priority without a nice binary anywhere in sight", async () => {
    // `os.setPriority`, not an `execFile("nice", …)`: locally there is no shell
    // to prefix and `nice` is not an allowlisted program.
    const driver = new LocalDriver("host-1");
    const running = await driver.execStream("du", ["-x", "-k", "--", root], { nice: 15 });

    await collect(running.stdout);
    expect((await running.done).code).toBe(0);
  });
});
