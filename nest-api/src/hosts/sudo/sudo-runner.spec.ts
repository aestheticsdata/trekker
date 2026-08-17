import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriverError } from "@hosts/drivers/driver-error";
import type { ExecOptions, ExecResult, HostDriver } from "@hosts/drivers/host-driver";
import type { AllowedProgram, SudoOnlyProgram } from "@hosts/drivers/shell-quote";
import { isPermissionRefusal, SudoRunnerService, writeElevated } from "@hosts/sudo/sudo-runner.service";
import { SudoService } from "@hosts/sudo/sudo.service";

/**
 * When an operation is allowed to become root, and when it is not (TRE-29).
 *
 * A fake driver here rather than a real one, and deliberately: every claim
 * below is about a *decision* — whether to escalate, what to send, what to do
 * when the window has gone — and none of them is about what a filesystem then
 * does. Proving the real thing would need a root-owned file, which a unit test
 * cannot make.
 */

const SESSION = "session-1";
const HOST = "host-a";

interface Call {
  program: string;
  args: readonly string[];
  options: ExecOptions;
}

function driverThatExecs(result: Partial<ExecResult> = {}): { driver: HostDriver; calls: Call[] } {
  const calls: Call[] = [];
  const driver = {
    exec: (program: AllowedProgram | SudoOnlyProgram, args: readonly string[], options: ExecOptions = {}) => {
      calls.push({ program, args, options });
      return Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "", ...result });
    },
  } as unknown as HostDriver;
  return { driver, calls };
}

function runnerWithWindow(): { runner: SudoRunnerService; sudo: SudoService } {
  const sudo = new SudoService();
  sudo.open(SESSION, HOST, "hunter2");
  return { runner: new SudoRunnerService(sudo), sudo };
}

describe("what counts as a refusal sudo could fix", () => {
  it("is EACCES and EPERM, and nothing else", () => {
    expect(isPermissionRefusal(new DriverError("EACCES", "denied"))).toBe(true);
    expect(isPermissionRefusal(new DriverError("EPERM", "not permitted"))).toBe(true);
  });

  it("is not a missing file, a full disk, or a plain error", () => {
    // Retrying these as root turns one clear failure into two, the second
    // wearing root's name in the audit log for nothing.
    expect(isPermissionRefusal(new DriverError("ENOENT", "no such file"))).toBe(false);
    expect(isPermissionRefusal(new DriverError("ENOSPC", "full"))).toBe(false);
    expect(isPermissionRefusal(new DriverError("EISDIR", "is a directory"))).toBe(false);
    expect(isPermissionRefusal(new Error("EACCES"))).toBe(false);
    expect(isPermissionRefusal(undefined)).toBe(false);
  });
});

describe("whether the window is open", () => {
  it("is false with no session at all", () => {
    // A route with no session cannot escalate, whatever is in the map.
    const { runner } = runnerWithWindow();
    expect(runner.isOpen(undefined, HOST)).toBe(false);
  });

  it("is false for another host", () => {
    const { runner } = runnerWithWindow();
    expect(runner.isOpen(SESSION, "host-b")).toBe(false);
  });

  it("is true for the host it was opened on", () => {
    const { runner } = runnerWithWindow();
    expect(runner.isOpen(SESSION, HOST)).toBe(true);
  });
});

describe("running something as root", () => {
  it("sends the password on stdin and never in the arguments", async () => {
    // The property the whole design rests on: argv is readable by every account
    // on the host, and stdin is not.
    const { runner } = runnerWithWindow();
    const { driver, calls } = driverThatExecs();

    await runner.run(driver, SESSION, HOST, "chmod", ["0644", "--", "/srv/app"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].options.sudo).toBe("password");
    expect(calls[0].options.stdin).toBe("hunter2\n");
    expect(JSON.stringify(calls[0].args)).not.toContain("hunter2");
    expect(calls[0].program).toBe("chmod");
  });

  it("refuses once the window has closed, rather than sending nothing", async () => {
    // Reached by racing the expiry: `isOpen` said yes, the window then ran out.
    // Sending an empty password would come back as an authentication failure
    // and read like a wrong password, which is a lie about what happened.
    const sudo = new SudoService();
    const runner = new SudoRunnerService(sudo);
    const { driver, calls } = driverThatExecs();

    await expect(runner.run(driver, SESSION, HOST, "chmod", ["0644", "--", "/x"])).rejects.toThrow(/window closed/);
    expect(calls).toHaveLength(0);
  });

  it("reports the command's own stderr when it fails", async () => {
    const { runner } = runnerWithWindow();
    const { driver } = driverThatExecs({ code: 1, stderr: "chmod: cannot access '/x': No such file\n" });

    await expect(runner.run(driver, SESSION, HOST, "chmod", ["0644", "--", "/x"])).rejects.toThrow(/No such file/);
  });

  it("still says something when the command fails silently", async () => {
    const { runner } = runnerWithWindow();
    const { driver } = driverThatExecs({ code: 3, stderr: "" });

    await expect(runner.run(driver, SESSION, HOST, "chmod", [])).rejects.toThrow(/exited 3/);
  });

  it("sends an empty password on a host that asks for none", async () => {
    // The NOPASSWD case. `SudoService` holds "" for those, sudo never reads
    // stdin, and the call is otherwise identical — there is no second code path.
    const sudo = new SudoService();
    sudo.open(SESSION, HOST, "");
    const runner = new SudoRunnerService(sudo);
    const { driver, calls } = driverThatExecs();

    await runner.run(driver, SESSION, HOST, "chown", ["0:0", "--", "/srv"]);

    expect(calls[0].options.stdin).toBe("\n");
    expect(calls[0].options.sudo).toBe("password");
  });
});

/**
 * Writing a root-owned file (TRE-29).
 *
 * A driver that behaves the way `sudo tee` does: it takes a first line and
 * swallows it, writes everything after it to a real file, and echoes the whole
 * lot back on stdout. Real `sudo` cannot be used here — it would prompt — and a
 * real `tee` would not exercise the part that matters, which is what
 * `writeElevated` does around it.
 */
describe("writeElevated", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "trekker-tee-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * @param echo whether the fake echoes to stdout the way `tee` really does.
   *   With `false` nothing drains, which is the stall `writeElevated` prevents.
   */
  function teeLikeDriver(options: { exit?: number; stderr?: string; chmodExit?: number } = {}) {
    const chmods: Array<readonly string[]> = [];
    const written: string[] = [];

    const driver = {
      hostId: "host-1",
      exec: (program: string, args: readonly string[]) => {
        if (program === "chmod") chmods.push(args);
        return Promise.resolve({
          code: options.chmodExit ?? 0,
          signal: null,
          stdout: "",
          stderr: options.chmodExit ? "chmod: refused" : "",
        });
      },
      execStream: (_program: string, args: readonly string[], streamOptions: { stdin?: string } = {}) => {
        const target = args[args.length - 1];
        const input = new PassThrough();
        const output = new PassThrough();

        // What a real driver does before handing the pipe back: the password
        // line goes in first, and everything after it is the caller's.
        if (streamOptions.stdin !== undefined) input.write(streamOptions.stdin);

        let seenFirstLine = false;
        let buffer = "";
        input.on("data", (chunk: Buffer) => {
          output.write(chunk);
          buffer += chunk.toString("utf8");
          if (!seenFirstLine) {
            const cut = buffer.indexOf("\n");
            if (cut === -1) return;
            // The password line, consumed by `sudo` and never written.
            buffer = buffer.slice(cut + 1);
            seenFirstLine = true;
          }
        });

        const done = new Promise<{ code: number; signal: null; stderr: string; stderrTruncated: boolean }>(
          (resolve) => {
            input.on("end", () => {
              written.push(buffer);
              writeFileSync(target, buffer);
              output.end();
              resolve({
                code: options.exit ?? 0,
                signal: null,
                stderr: options.stderr ?? "",
                stderrTruncated: false,
              });
            });
          },
        );

        return Promise.resolve({ stdout: output, done, stdin: input });
      },
    } as unknown as HostDriver;

    return { driver, chmods, written };
  }

  it("writes the payload and not the password", async () => {
    // The failure this catches is a config file whose first line is a root
    // password. `sudo` eats that line; the fake above models exactly that, and
    // what lands on disk must be only what the caller sent.
    const { driver } = teeLikeDriver();
    const path = join(dir, "nginx.conf");

    const write = writeElevated(driver, "hunter2", path, null);
    write.stdin.end("server {\n  listen 80;\n}\n");
    await write.done;

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toBe("server {\n  listen 80;\n}\n");
    expect(onDisk).not.toContain("hunter2");
  });

  it("applies the mode afterwards, because tee cannot be told one", async () => {
    const { driver, chmods } = teeLikeDriver();
    const path = join(dir, "secret.env");

    const write = writeElevated(driver, "hunter2", path, 0o600);
    write.stdin.end("TOKEN=abc\n");
    await write.done;

    expect(chmods).toEqual([["0600", "--", path]]);
  });

  it("asks for no chmod when the caller wanted no particular mode", async () => {
    const { driver, chmods } = teeLikeDriver();

    const write = writeElevated(driver, "hunter2", join(dir, "plain.txt"), null);
    write.stdin.end("x");
    await write.done;

    expect(chmods).toHaveLength(0);
  });

  it("fails with the command's stderr when tee exits non-zero", async () => {
    const { driver } = teeLikeDriver({ exit: 1, stderr: "tee: /etc/x: Permission denied" });

    const write = writeElevated(driver, "hunter2", join(dir, "x"), null);
    write.stdin.end("data");

    await expect(write.done).rejects.toThrow(/Permission denied/);
  });

  it("fails when the write landed but the mode did not", async () => {
    // Reported rather than swallowed: a secret written with the wrong
    // permissions is worse than one not written at all, and the caller has to
    // be able to say so.
    const { driver } = teeLikeDriver({ chmodExit: 1 });

    const write = writeElevated(driver, "hunter2", join(dir, "x"), 0o600);
    write.stdin.end("data");

    await expect(write.done).rejects.toThrow(/refused/);
  });

  it("moves more than a pipe buffer without stalling", async () => {
    // `tee` echoes everything back, and an unread echo fills its pipe and blocks
    // the command. Two megabytes is comfortably past any buffer, so a
    // `writeElevated` that forgot to drain would hang here rather than fail.
    const { driver } = teeLikeDriver();
    const path = join(dir, "big.bin");

    const write = writeElevated(driver, "hunter2", path, null);
    write.stdin.end("x".repeat(2 * 1024 * 1024));
    await write.done;

    expect((await readFile(path, "utf8")).length).toBe(2 * 1024 * 1024);
  }, 20_000);
});
