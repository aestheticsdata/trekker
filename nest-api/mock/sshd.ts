import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { posix } from "node:path";
import { Server, utils } from "ssh2";
import type { Attributes, FileEntry, SFTPWrapper, ServerChannel } from "ssh2";
import { guardDevelopmentDatabase, MockRefusal } from "./env";
import { hostPrivateKey } from "./host-keys";
import { REMOTE_HOSTS, REMOTE_PASSWORD, type RemoteHostSpec, type RemoteSlug } from "./manifest";
import { remoteDfShimPath, remoteRoot } from "./tree";

/**
 * The three remote machines, answering (TRE-148).
 *
 * Marlow, Sable and Tundra are SSH servers this file runs on the loopback —
 * ssh2's server half, in the API's own process tree, started by
 * `df-on-path.ts` under `pnpm dev` and stopped with it, or on their own by
 * `pnpm mock:hosts`. Nothing is installed and nothing outside this repository
 * runs: no sshd, no container, no system setting.
 *
 * Each machine serves its tree (`<mock home>/hosts/<slug>/tree`, written by
 * `pnpm mock`) as `/` over SFTP — listing, stat, reading, writing, mkdir,
 * rename, delete, chmod, utimes: everything the SSH driver does with a file it
 * does over SFTP — and answers the handful of commands the driver execs, the
 * way a Debian box would: `df` from the machine's own generated shim, `du`
 * with GNU's flags and record format, `tail` of the `/proc` and `/etc` files
 * the summary, the metrics and the owner names are read from, `id`,
 * `sha256sum`. `sudo` says what a box with no sudoers entry says. Anything
 * else is "command not found".
 *
 * The API reaches them by name — `marlow.example.com` — through
 * `example-dns.cjs`, with the demo password the loader seals onto each row
 * and the host key `host-keys.ts` makes once and the loader pins.
 */

const SFTP = utils.sftp;
const { STATUS_CODE } = SFTP;

/** What a machine says about itself when the API reads `/proc`. Invented, and steady. */
interface Vitals {
  /** Days since boot at the reference; uptime grows from there. */
  uptimeDays: number;
  load: readonly [number, number, number];
  memTotalKb: number;
  memAvailableKb: number;
  cpus: number;
  disk: string;
}

const VITALS: Readonly<Record<RemoteSlug, Vitals>> = {
  marlow: {
    uptimeDays: 212,
    load: [0.08, 0.11, 0.09],
    memTotalKb: 8_192_000,
    memAvailableKb: 6_310_000,
    cpus: 2,
    disk: "sda",
  },
  sable: {
    uptimeDays: 38,
    load: [1.42, 1.31, 1.27],
    memTotalKb: 32_768_000,
    memAvailableKb: 9_120_000,
    cpus: 8,
    disk: "nvme0n1",
  },
  tundra: {
    uptimeDays: 96,
    load: [0.61, 0.58, 0.55],
    memTotalKb: 16_384_000,
    memAvailableKb: 11_040_000,
    cpus: 4,
    disk: "vda",
  },
};

const STARTED_AT = Date.now();

export interface MachineOptions {
  /** Where `/` is. Defaults to the machine's tree under the mock home. */
  root?: string;
  /** Overrides the manifest's port; 0 picks a free one (the specs). */
  port?: number;
  /** The `df` to run; defaults to the machine's generated shim. */
  dfShim?: string;
  log?: (line: string) => void;
}

export interface RunningMachine {
  spec: RemoteHostSpec;
  port: number;
  close: () => Promise<void>;
}

/** Starts every machine in the manifest. Resolves once all three answer; the function returned stops them. */
export async function startRemoteMachines(log: (line: string) => void = () => undefined): Promise<() => Promise<void>> {
  const running: RunningMachine[] = [];
  for (const spec of REMOTE_HOSTS) {
    const machine = await startMachine(spec, { log }).catch((error: unknown) => {
      if (error instanceof MockRefusal) {
        // Another API run has the machines up — `pnpm dev` beside a film's built API. Fine: they are the same machines.
        log(`  ${spec.label.padEnd(8)} already answering on 127.0.0.1:${spec.port}`);
        return null;
      }
      throw error;
    });
    if (machine) running.push(machine);
  }
  return async () => {
    await Promise.all(running.map((machine) => machine.close()));
  };
}

export function startMachine(spec: RemoteHostSpec, options: MachineOptions = {}): Promise<RunningMachine> {
  const machine = new Machine(
    spec,
    options.root ?? remoteRoot(spec.slug),
    options.dfShim ?? remoteDfShimPath(spec.slug),
  );
  const log = options.log ?? (() => undefined);
  const server = new Server({ hostKeys: [hostPrivateKey(spec.slug)] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === spec.username && context.password === REMOTE_PASSWORD) {
        context.accept();
      } else {
        context.reject(["password"]);
      }
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp) => machine.serveSftp(acceptSftp()));
        session.on("exec", (acceptExec, _reject, info) => machine.exec(info.command, acceptExec()));
        session.on("pty", (_accept, reject) => reject());
        session.on("shell", (_accept, reject) => reject());
      });
    });
    client.on("error", () => undefined);
  });

  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new MockRefusal(
              `127.0.0.1:${spec.port} is taken — ${spec.label} is already up, or something else is on that port.`,
            )
          : error,
      );
    });
    server.listen(options.port ?? spec.port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : spec.port;
      log(`  ${spec.label.padEnd(8)} ${spec.username}@${spec.address}  127.0.0.1:${port}`);
      resolve({
        spec,
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// ---------------------------------------------------------------- one machine

class Machine {
  private nextHandle = 1;
  private readonly handles = new Map<number, Handle>();

  constructor(
    readonly spec: RemoteHostSpec,
    private readonly root: string,
    private readonly dfShim: string,
  ) {}

  // ---- paths

  /** The path as the machine knows it — absolute, normalised, `..` folded — from whatever the client sent. */
  private virtual(path: string): string {
    if (path === "" || path === ".") return this.spec.homePath;
    return posix.normalize(path.startsWith("/") ? path : posix.join(this.spec.homePath, path));
  }

  /** Where that path really is: under the tree, always. A normalised absolute path cannot leave it. */
  private real(path: string): string {
    return posix.join(this.root, this.virtual(path).replace(/^\/+/, ""));
  }

  // ---- SFTP

  serveSftp(sftp: SFTPWrapper): void {
    const ok = (reqId: number) => sftp.status(reqId, STATUS_CODE.OK);
    const fail = (reqId: number, error: unknown) => sftp.status(reqId, statusOf(error), messageOf(error));
    const attempt = (reqId: number, work: () => void) => {
      try {
        work();
      } catch (error) {
        fail(reqId, error);
      }
    };

    sftp.on("OPEN", (reqId, filename, flags, attrs) =>
      attempt(reqId, () => {
        const mode = SFTP.flagsToString(flags) ?? "r";
        const fd = fs.openSync(this.real(filename), mode, attrs?.mode ?? 0o644);
        sftp.handle(reqId, this.open({ kind: "file", fd, path: this.real(filename) }));
      }),
    );
    sftp.on("READ", (reqId, handle, offset, length) =>
      attempt(reqId, () => {
        const file = this.file(handle);
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(file.fd, buffer, 0, length, offset);
        if (read === 0) sftp.status(reqId, STATUS_CODE.EOF);
        else sftp.data(reqId, buffer.subarray(0, read));
      }),
    );
    sftp.on("WRITE", (reqId, handle, offset, data) =>
      attempt(reqId, () => {
        fs.writeSync(this.file(handle).fd, data, 0, data.length, offset);
        ok(reqId);
      }),
    );
    sftp.on("CLOSE", (reqId, handle) =>
      attempt(reqId, () => {
        const id = handle.readUInt32BE(0);
        const open = this.handles.get(id);
        if (open?.kind === "file") fs.closeSync(open.fd);
        this.handles.delete(id);
        ok(reqId);
      }),
    );
    sftp.on("FSTAT", (reqId, handle) =>
      attempt(reqId, () => sftp.attrs(reqId, this.attrs(fs.fstatSync(this.file(handle).fd)))),
    );
    sftp.on("FSETSTAT", (reqId, handle, attrs) =>
      attempt(reqId, () => {
        this.setstat(this.file(handle).path, attrs);
        ok(reqId);
      }),
    );
    sftp.on("OPENDIR", (reqId, path) =>
      attempt(reqId, () => {
        const real = this.real(path);
        if (!fs.statSync(real).isDirectory()) throw errno("ENOTDIR");
        const entries = fs
          .readdirSync(real)
          .sort()
          .map((name): FileEntry => {
            const stat = fs.lstatSync(posix.join(real, name));
            const attrs = this.attrs(stat);
            return { filename: name, longname: longname(name, stat, attrs, this.spec.username), attrs };
          });
        sftp.handle(reqId, this.open({ kind: "dir", entries, sent: false }));
      }),
    );
    sftp.on("READDIR", (reqId, handle) =>
      attempt(reqId, () => {
        const dir = this.dir(handle);
        if (dir.sent) sftp.status(reqId, STATUS_CODE.EOF);
        else {
          dir.sent = true;
          sftp.name(reqId, dir.entries);
        }
      }),
    );
    sftp.on("LSTAT", (reqId, path) =>
      attempt(reqId, () => sftp.attrs(reqId, this.attrs(fs.lstatSync(this.real(path))))),
    );
    sftp.on("STAT", (reqId, path) => attempt(reqId, () => sftp.attrs(reqId, this.attrs(fs.statSync(this.real(path))))));
    sftp.on("SETSTAT", (reqId, path, attrs) =>
      attempt(reqId, () => {
        this.setstat(this.real(path), attrs);
        ok(reqId);
      }),
    );
    sftp.on("REMOVE", (reqId, path) =>
      attempt(reqId, () => {
        fs.unlinkSync(this.real(path));
        ok(reqId);
      }),
    );
    sftp.on("RMDIR", (reqId, path) =>
      attempt(reqId, () => {
        fs.rmdirSync(this.real(path));
        ok(reqId);
      }),
    );
    sftp.on("MKDIR", (reqId, path, attrs) =>
      attempt(reqId, () => {
        fs.mkdirSync(this.real(path), { mode: attrs?.mode ?? 0o755 });
        ok(reqId);
      }),
    );
    sftp.on("RENAME", (reqId, from, to) =>
      attempt(reqId, () => {
        fs.renameSync(this.real(from), this.real(to));
        ok(reqId);
      }),
    );
    sftp.on("REALPATH", (reqId, path) =>
      attempt(reqId, () => {
        const resolved = this.virtual(path);
        const real = this.real(resolved);
        const entry: FileEntry = fs.existsSync(real)
          ? { filename: resolved, longname: resolved, attrs: this.attrs(fs.lstatSync(real)) }
          : { filename: resolved, longname: resolved, attrs: {} as Attributes };
        sftp.name(reqId, [entry]);
      }),
    );
    sftp.on("READLINK", (reqId, path) =>
      attempt(reqId, () => {
        const target = fs.readlinkSync(this.real(path));
        sftp.name(reqId, [{ filename: target, longname: target, attrs: {} as Attributes }]);
      }),
    );
    sftp.on("SYMLINK", (reqId, linkPath, targetPath) =>
      attempt(reqId, () => {
        fs.symlinkSync(targetPath, this.real(linkPath));
        ok(reqId);
      }),
    );
    sftp.on("EXTENDED", (reqId) => sftp.status(reqId, STATUS_CODE.OP_UNSUPPORTED));
  }

  private open(handle: Handle): Buffer {
    const id = this.nextHandle++;
    this.handles.set(id, handle);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(id);
    return buffer;
  }

  private file(handle: Buffer): Extract<Handle, { kind: "file" }> {
    const open = this.handles.get(handle.readUInt32BE(0));
    if (open?.kind !== "file") throw errno("EBADF");
    return open;
  }

  private dir(handle: Buffer): Extract<Handle, { kind: "dir" }> {
    const open = this.handles.get(handle.readUInt32BE(0));
    if (open?.kind !== "dir") throw errno("EBADF");
    return open;
  }

  /** The file as the machine reports it: its own uid on everything, whatever the Mac says. */
  private attrs(stat: fs.Stats): Attributes {
    return {
      mode: stat.mode,
      uid: this.spec.uid,
      gid: this.spec.uid,
      size: stat.size,
      atime: Math.floor(stat.atimeMs / 1000),
      mtime: Math.floor(stat.mtimeMs / 1000),
    };
  }

  private setstat(real: string, attrs: Attributes): void {
    if (attrs.mode !== undefined) fs.chmodSync(real, attrs.mode & 0o7777);
    if (attrs.atime !== undefined && attrs.mtime !== undefined) fs.utimesSync(real, attrs.atime, attrs.mtime);
    if (attrs.size !== undefined) fs.truncateSync(real, attrs.size);
  }

  // ---- exec

  exec(command: string, channel: ServerChannel): void {
    const words = shellWords(command);
    // `nice -n 'N' du …` — the scan's courtesy, which a machine of ours does not need to honour.
    if (words[0] === "nice" && words[1] === "-n") words.splice(0, 3);

    const finish = (code: number, stdout = "", stderr = "") => {
      if (stdout) channel.write(stdout);
      if (stderr) channel.stderr.write(stderr);
      channel.exit(code);
      channel.end();
    };

    const [program, ...args] = words;
    try {
      switch (program) {
        case "sudo":
          return finish(1, "", `${this.spec.username} is not in the sudoers file.  This incident will be reported.\n`);
        case "df":
          return void execFile(process.execPath, [this.dfShim, ...args], (error, stdout, stderr) =>
            finish(error ? 1 : 0, stdout, stderr),
          );
        case "du":
          return finish(...this.du(args));
        case "tail":
          return finish(...this.tail(args));
        case "id":
          return finish(...this.id(args));
        case "sha256sum":
          return finish(...this.sha256sum(args));
        case undefined:
          return finish(0);
        default:
          return finish(127, "", `bash: ${program}: command not found\n`);
      }
    } catch (error) {
      return finish(1, "", `${program}: ${messageOf(error)}\n`);
    }
  }

  /** GNU `du`, as far as the API asks: `--version`, the scan's four rungs, and `-s` for a directory's size. */
  private du(args: readonly string[]): [number, string, string] {
    if (args.includes("--version")) return [0, "du (GNU coreutils) 9.4\n", ""];
    const flags = new Set<string>();
    const paths: string[] = [];
    let seen = false;
    for (const arg of args) {
      if (seen || !arg.startsWith("-")) paths.push(arg);
      else if (arg === "--") seen = true;
      else if (arg.startsWith("--")) flags.add(arg.split("=")[0]);
      else for (const letter of arg.slice(1)) flags.add(`-${letter === "B" ? "B" : letter}`);
    }
    const kib = flags.has("-k") && !flags.has("-B");
    const withTime = flags.has("--time");
    const separator = flags.has("-0") ? "\0" : "\n";
    const summary = flags.has("-s");
    const all = flags.has("-a");
    const out: string[] = [];
    const errors: string[] = [];

    const record = (bytes: number, mtimeMs: number, path: string) => {
      const size = kib ? Math.ceil(bytes / 1024) : bytes;
      out.push(withTime ? `${size}\t${Math.floor(mtimeMs / 1000)}\t${path}` : `${size}\t${path}`);
    };
    const walk = (virtual: string): number => {
      const real = this.real(virtual);
      const stat = fs.lstatSync(real);
      if (!stat.isDirectory()) {
        if (all && !summary) record(stat.size, stat.mtimeMs, virtual);
        return stat.size;
      }
      let total = 4096;
      for (const name of fs.readdirSync(real).sort()) total += walk(posix.join(virtual, name));
      if (!summary) record(total, stat.mtimeMs, virtual);
      return total;
    };

    for (const path of paths) {
      try {
        const virtual = this.virtual(path);
        const total = walk(virtual);
        if (summary) record(total, fs.lstatSync(this.real(virtual)).mtimeMs, path);
      } catch (error) {
        errors.push(`du: cannot access '${path}': ${messageOf(error)}\n`);
      }
    }
    return [
      errors.length > 0 && out.length === 0 ? 1 : 0,
      out.length > 0 ? out.join(separator) + separator : "",
      errors.join(""),
    ];
  }

  /** `tail -n N file…` over the machine's `/proc` and `/etc`; several files get GNU's `==> path <==` headers. */
  private tail(args: readonly string[]): [number, string, string] {
    const files = args.filter((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-n");
    const sections: string[] = [];
    const errors: string[] = [];
    for (const file of files) {
      const content = this.virtualFile(file);
      if (content === null) {
        errors.push(`tail: cannot open '${file}' for reading: No such file or directory\n`);
        continue;
      }
      sections.push(files.length > 1 ? `==> ${file} <==\n${content}` : content);
    }
    return [errors.length > 0 && sections.length === 0 ? 1 : 0, sections.join("\n"), errors.join("")];
  }

  private id(args: readonly string[]): [number, string, string] {
    const named = args.find((arg) => !arg.startsWith("-"));
    if (named !== undefined && named !== this.spec.username && named !== "root") {
      return [1, "", `id: '${named}': no such user\n`];
    }
    const uid = named === "root" ? 0 : this.spec.uid;
    if (args.includes("-un")) return [0, `${named ?? this.spec.username}\n`, ""];
    if (args.includes("-u")) return [0, `${uid}\n`, ""];
    return [
      0,
      `uid=${uid}(${this.spec.username}) gid=${uid}(${this.spec.username}) groups=${uid}(${this.spec.username})\n`,
      "",
    ];
  }

  private sha256sum(args: readonly string[]): [number, string, string] {
    const paths = args.filter((arg, index) => arg !== "--" && (index === 0 || args[index - 1] !== undefined));
    const out: string[] = [];
    const errors: string[] = [];
    for (const path of paths) {
      if (path.startsWith("-")) continue;
      try {
        const digest = createHash("sha256")
          .update(fs.readFileSync(this.real(path)))
          .digest("hex");
        out.push(`${digest}  ${path}\n`);
      } catch (error) {
        errors.push(`sha256sum: ${path}: ${messageOf(error)}\n`);
      }
    }
    return [errors.length > 0 ? 1 : 0, out.join(""), errors.join("")];
  }

  /** The machine's `/proc` and `/etc`, as text. The clocks run: uptime grows and the counters climb. */
  private virtualFile(path: string): string | null {
    const vitals = VITALS[this.spec.slug];
    const elapsed = (Date.now() - STARTED_AT) / 1000;
    const uptime = vitals.uptimeDays * 86_400 + elapsed;
    const jitter = Math.sin(elapsed / 7) * 0.05;
    const tick = Math.floor(uptime * 100); // jiffies at USER_HZ 100
    switch (path) {
      case "/proc/uptime":
        return `${uptime.toFixed(2)} ${(uptime * (1 - vitals.load[0] / vitals.cpus)).toFixed(2)}\n`;
      case "/proc/loadavg":
        return `${(vitals.load[0] + jitter).toFixed(2)} ${vitals.load[1].toFixed(2)} ${vitals.load[2].toFixed(2)} 1/${180 + vitals.cpus * 12} ${1187 + Math.floor(elapsed)}\n`;
      case "/proc/sys/kernel/hostname":
        return `${this.spec.slug}\n`;
      case "/proc/meminfo": {
        const available = Math.round(vitals.memAvailableKb + jitter * 400_000);
        return (
          `MemTotal:       ${vitals.memTotalKb} kB\nMemFree:        ${Math.round(available * 0.4)} kB\nMemAvailable:   ${available} kB\n` +
          `Buffers:        ${Math.round(available * 0.05)} kB\nCached:         ${Math.round(available * 0.55)} kB\nSwapTotal:      ${vitals.memTotalKb / 4} kB\nSwapFree:       ${vitals.memTotalKb / 4} kB\n`
        );
      }
      case "/proc/stat": {
        const busy = vitals.load[0] / vitals.cpus;
        const user = Math.floor(tick * busy * 0.7);
        const system = Math.floor(tick * busy * 0.25);
        const iowait = Math.floor(tick * busy * 0.05);
        const idle = tick * vitals.cpus - user - system - iowait;
        const lines = [`cpu  ${user} 0 ${system} ${idle} ${iowait} 0 ${Math.floor(tick * 0.001)} 0`];
        for (let cpu = 0; cpu < vitals.cpus; cpu += 1) {
          lines.push(
            `cpu${cpu} ${Math.floor(user / vitals.cpus)} 0 ${Math.floor(system / vitals.cpus)} ${Math.floor(idle / vitals.cpus)} ${Math.floor(iowait / vitals.cpus)} 0 0 0`,
          );
        }
        lines.push(
          `intr ${tick * 40} 0`,
          `ctxt ${tick * 90}`,
          `btime ${Math.floor(Date.now() / 1000 - uptime)}`,
          `processes ${Math.floor(uptime / 3)}`,
          "procs_running 1",
          "procs_blocked 0",
        );
        return `${lines.join("\n")}\n`;
      }
      case "/proc/diskstats": {
        const readSectors = Math.floor(uptime * 220);
        const writeSectors = Math.floor(uptime * 340);
        return `   8       0 ${vitals.disk} ${Math.floor(readSectors / 8)} 12 ${readSectors} ${Math.floor(uptime * 3)} ${Math.floor(writeSectors / 8)} 40 ${writeSectors} ${Math.floor(uptime * 9)} 0 ${Math.floor(uptime * 2)} ${Math.floor(uptime * 12)}\n`;
      }
      case "/etc/passwd":
        return (
          "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n" +
          `sshd:x:100:65534::/run/sshd:/usr/sbin/nologin\n${this.spec.username}:x:${this.spec.uid}:${this.spec.uid}:${this.spec.label} operator:${this.spec.homePath}:/bin/bash\n`
        );
      case "/etc/group":
        return `root:x:0:\ndaemon:x:1:\nwww-data:x:33:\n${this.spec.username}:x:${this.spec.uid}:\n`;
      default:
        return null;
    }
  }
}

type Handle = { kind: "file"; fd: number; path: string } | { kind: "dir"; entries: FileEntry[]; sent: boolean };

// ---------------------------------------------------------------- helpers

/** The driver's commands are POSIX single-quoted words: `du '-x' '-a' -- '/srv/backups'`. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quoted = false;
  let pending = false;
  for (const char of command) {
    if (quoted) {
      if (char === "'") quoted = false;
      else current += char;
      pending = true;
    } else if (char === "'") {
      quoted = true;
      pending = true;
    } else if (char === " " || char === "\t") {
      if (pending) words.push(current);
      current = "";
      pending = false;
    } else {
      current += char;
      pending = true;
    }
  }
  if (pending) words.push(current);
  return words;
}

/** `ls -l`'s line for an entry, which is what the `longname` SFTP field carries. */
function longname(name: string, stat: fs.Stats, attrs: Attributes, owner: string): string {
  const type = stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : "-";
  const bits = "rwxrwxrwx"
    .split("")
    .map((bit, index) => (((attrs.mode ?? 0) >> (8 - index)) & 1 ? bit : "-"))
    .join("");
  const when = new Date((attrs.mtime ?? 0) * 1000);
  const month = when.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const stamp = `${month} ${String(when.getUTCDate()).padStart(2)} ${String(when.getUTCHours()).padStart(2, "0")}:${String(when.getUTCMinutes()).padStart(2, "0")}`;
  return `${type}${bits}    1 ${owner.padEnd(8)} ${owner.padEnd(8)} ${String(attrs.size ?? 0).padStart(12)} ${stamp} ${name}`;
}

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

function statusOf(error: unknown): number {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return STATUS_CODE.NO_SUCH_FILE;
  if (code === "EACCES" || code === "EPERM") return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function messageOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "No such file or directory";
  if (code === "ENOTDIR") return "Not a directory";
  if (code === "EACCES" || code === "EPERM") return "Permission denied";
  if (code === "EEXIST") return "File exists";
  if (code === "ENOTEMPTY") return "Directory not empty";
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- the command

if (require.main === module) {
  (async () => {
    try {
      guardDevelopmentDatabase();
      console.log("The three remote machines, on the loopback (Ctrl-C stops them):\n");
      const stop = await startRemoteMachines((line) => console.log(line));
      console.log("\nThe API reaches them by name through mock/example-dns.cjs — `pnpm dev` sets that up itself.");
      const quit = () => {
        void stop().then(() => process.exit(0));
      };
      process.once("SIGINT", quit);
      process.once("SIGTERM", quit);
    } catch (error) {
      if (error instanceof MockRefusal) {
        console.error(`\nmock:hosts refused: ${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }
  })().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
