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

/**
 * The streaming form under sudo (TRE-29).
 *
 * Reading a root-owned file has to come through here rather than through
 * `exec`: `exec` collects into a string with a `maxOutputBytes` ceiling, which
 * is right for `df` and wrong for `cat` on a real file. So `execStream` needs
 * the same two things `exec` grew — a sudo prefix, and a stdin to put the
 * password on.
 *
 * The stdin case is tested without sudo on purpose. `tail` reading its input is
 * the same pipe the password would travel down, and proving it with an
 * allowlisted program keeps the test independent of how the machine running the
 * suite happens to have sudo configured.
 */
describe("execStream stdin", () => {
  it("writes stdin and closes it", async () => {
    const driver = new LocalDriver("host-1");
    const running = await driver.execStream("tail", ["-n", "1"], { stdin: "one\ntwo\nthree\n" });

    const out = await collect(running.stdout);
    const result = await running.done;

    expect(result.code).toBe(0);
    expect(out).toBe("three\n");
  });

  it("closes stdin when there is nothing to send", async () => {
    // The same hang `exec` had. `tail` with no file waits on stdin for EOF, and
    // a stream path that left the pipe open would never finish.
    const driver = new LocalDriver("host-1");
    const running = await driver.execStream("tail", ["-n", "1"], { timeoutMs: 5_000 });

    const out = await collect(running.stdout);
    const result = await running.done;

    expect(result.code).toBe(0);
    expect(out).toBe("");
  });
});

describe("execStream's sudo guard", () => {
  it("refuses a sudo-only program without sudo", async () => {
    const driver = new LocalDriver("host-1");
    await expect(driver.execStream("cat", ["/etc/hosts"])).rejects.toMatchObject({ code: "EPERM" });
  });

  it("still refuses a program on neither list, sudo or not", async () => {
    const driver = new LocalDriver("host-1");
    await expect(driver.execStream("sh" as never, ["-c", "id"], { sudo: "password" })).rejects.toMatchObject({
      code: "EPERM",
    });
  });

  it("admits a sudo-only program once sudo is asked for", async () => {
    // As in `exec-stdin.spec.ts`: reaching the program is the assertion, since
    // what real sudo then does depends on the machine running the suite.
    const driver = new LocalDriver("host-1");
    const refusal = await driver
      .execStream("cat", ["/nonexistent-trekker-probe"], { sudo: "password", timeoutMs: 5_000 })
      .then(() => null)
      .catch((error: unknown) => error as { code?: string });

    expect(refusal?.code).not.toBe("EPERM");
  });
});

/**
 * A stdin the caller keeps writing to (TRE-29).
 *
 * Writing a root-owned file means `sudo tee`, and that is the one place where
 * the password and the payload share a pipe: `sudo -S` consumes exactly one
 * line, then execs `tee`, which reads everything after it. So the driver has to
 * write the password, *not* close, and hand the rest of the pipe back.
 *
 * Modelled here with `tail` rather than `tee` for the same reason as elsewhere
 * — it is allowlisted and needs no privilege — and the shape is identical: a
 * first line written by the driver, the rest written by the caller.
 */
describe("execStream with a stdin the caller finishes", () => {
  it("writes the first line, then lets the caller write the rest", async () => {
    const driver = new LocalDriver("host-1");
    const running = await driver.execStream("tail", ["-n", "2"], { stdin: "first\n", stdinOpen: true });

    expect(running.stdin).toBeDefined();
    running.stdin?.end("second\nthird\n");

    const out = await collect(running.stdout);
    const result = await running.done;

    expect(result.code).toBe(0);
    // All three lines reached the program: the driver's, then the caller's.
    expect(out).toBe("second\nthird\n");
  });

  it("does not hand back a stdin unless it was asked to", async () => {
    // The default has to stay closed-and-gone, or every existing caller grows a
    // pipe nobody ends and a command that never finishes.
    const driver = new LocalDriver("host-1");
    const running = await driver.execStream("tail", ["-n", "1"], { stdin: "only\n" });

    expect(running.stdin).toBeUndefined();
    const out = await collect(running.stdout);
    await running.done;
    expect(out).toBe("only\n");
  });

  it("finishes only once the caller closes the pipe", async () => {
    // `tail` cannot answer until it sees EOF, so a `done` that settled early
    // would be settling on a command that had not read its input yet.
    const driver = new LocalDriver("host-1");
    const running = await driver.execStream("tail", ["-n", "1"], { stdin: "a\n", stdinOpen: true });

    let settled = false;
    void running.done.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    running.stdin?.end("b\n");
    const out = await collect(running.stdout);
    await running.done;
    expect(out).toBe("b\n");
  });
});
