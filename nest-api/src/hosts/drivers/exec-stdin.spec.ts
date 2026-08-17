import { PassThrough, Writable } from "node:stream";
import { sendStdin } from "@hosts/drivers/exec-stdin";
import { LocalDriver } from "@hosts/drivers/local.driver";

/**
 * Writing to a command's standard input (TRE-29).
 *
 * This exists for one caller: `sudo -S` reads the password from stdin, and
 * until this the driver layer had no way to put anything there. It is tested
 * against a real child process rather than a fake, for the reason the rest of
 * `drivers` gives — the claim is about a pipe between two processes, and a
 * double would only prove the double closes its own pipe.
 *
 * `tail` is the vehicle because it is already on the allowlist and, given no
 * file argument, reads stdin on every machine this runs on. `sha256sum` would
 * read stdin too and is also allowlisted, but it is coreutils and absent from
 * macOS, where this suite is developed.
 *
 * The remote half needs an sshd and is covered by `pnpm verify:drivers`, the
 * same split `exec-stream.spec.ts` makes.
 */

describe("exec stdin", () => {
  it("sends what it is given to the process", async () => {
    const driver = new LocalDriver("host-1");

    const result = await driver.exec("tail", ["-n", "1"], { stdin: "one\ntwo\nthree\n" });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("three\n");
  });

  it("closes stdin when there is nothing to send", async () => {
    const driver = new LocalDriver("host-1");

    // The failure this catches is a hang, not a wrong answer. `tail` with no
    // file waits on stdin until it sees EOF, so a driver that opens the pipe
    // and neither writes nor closes it leaves the child waiting for input that
    // is never coming, and the call ends at whatever timeout is furthest away.
    const result = await driver.exec("tail", ["-n", "1"], { timeoutMs: 5_000 });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("sends stdin that is not newline-terminated", async () => {
    const driver = new LocalDriver("host-1");

    // A password typed into a form has no trailing newline, and `sudo -S` wants
    // one. Whoever adds it, it is not this layer's job to guess: what goes in
    // comes out, byte for byte.
    const result = await driver.exec("tail", ["-c", "6"], { stdin: "hunter2" });

    expect(result.stdout).toBe("unter2");
  });

  it("keeps stdin out of the error when the program is refused", async () => {
    const driver = new LocalDriver("host-1");

    const failure: unknown = await driver
      .exec("sh" as never, ["-c", "id"], { stdin: "hunter2" })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "EPERM" });
    expect(JSON.stringify(failure)).not.toContain("hunter2");
    expect(String(failure)).not.toContain("hunter2");
  });
});

/**
 * The driver's own guard, which has to agree with the builder's (TRE-29).
 *
 * `buildRemoteCommand` is only reached on the SSH side; `LocalDriver.exec`
 * checks the allowlist itself and never builds a string at all. So the rule
 * "sudo-only programs need sudo" has to hold in both, and this is the half
 * that can be run here.
 */
describe("the driver's sudo guard", () => {
  it("refuses a sudo-only program when sudo was not asked for", async () => {
    const driver = new LocalDriver("host-1");

    await expect(driver.exec("rm", ["-rf", "/tmp/nothing"])).rejects.toMatchObject({ code: "EPERM" });
    await expect(driver.exec("tee", ["/etc/passwd"])).rejects.toMatchObject({ code: "EPERM" });
  });

  it("still refuses a program on neither list, sudo or not", async () => {
    const driver = new LocalDriver("host-1");

    await expect(driver.exec("sh" as never, ["-c", "id"], { sudo: "password" })).rejects.toMatchObject({
      code: "EPERM",
    });
    await expect(driver.exec("sudo" as never, ["id"], { sudo: "password" })).rejects.toMatchObject({ code: "EPERM" });
  });

  it("admits a sudo-only program once sudo is asked for", async () => {
    const driver = new LocalDriver("host-1");

    // Reaching the program is the assertion, and the only one available here:
    // what real `sudo` then does depends on how the machine running the suite
    // is configured, which is not something to encode. EPERM is the guard's
    // own refusal, so its absence is what says the name got through.
    const refusal = await driver
      .exec("cat", ["/nonexistent-trekker-probe"], { sudo: "password" })
      .then(() => null)
      .catch((error: unknown) => error as { code?: string });

    expect(refusal?.code).not.toBe("EPERM");
  });
});

/**
 * The same function, against a stream instead of a process.
 *
 * This is as close as the suite gets to the SSH driver. An ssh2 `ClientChannel`
 * is a duplex stream and `SshDriver.exec` hands it to `sendStdin` unchanged, so
 * what these cover is every behaviour of that call except the one assumption
 * that cannot be checked without an sshd: that ssh2's channel is a duplex
 * stream that behaves like one.
 */
describe("sendStdin", () => {
  /** Everything written, resolving only once the stream has actually ended. */
  async function drain(stream: PassThrough): Promise<string> {
    let text = "";
    for await (const chunk of stream) text += (chunk as Buffer).toString("utf8");
    return text;
  }

  it("writes the input and closes the stream", async () => {
    const channel = new PassThrough();
    const written = drain(channel);

    sendStdin(channel, "hunter2");

    expect(await written).toBe("hunter2");
  });

  it("closes the stream when there is no input", async () => {
    const channel = new PassThrough();
    const written = drain(channel);

    sendStdin(channel, undefined);

    // That this resolves at all is the assertion. Without the close it never
    // ends, and the test times out rather than reporting a wrong value.
    expect(await written).toBe("");
  });

  it("survives a write to a stream that has already gone", () => {
    // `sudo` can refuse the account and close the channel before it ever reads
    // the password. Unhandled, the failed write is an `error` event with no
    // listener, which ends the process rather than the command.
    const gone = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("EPIPE: write to a closed pipe"));
      },
    });

    expect(() => sendStdin(gone, "hunter2")).not.toThrow();
  });

  it("does nothing when there is no stream at all", () => {
    expect(() => sendStdin(null, "hunter2")).not.toThrow();
    expect(() => sendStdin(undefined, "hunter2")).not.toThrow();
  });
});
