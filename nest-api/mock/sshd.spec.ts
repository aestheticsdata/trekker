import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";
import type { SFTPWrapper } from "ssh2";
import { REMOTE_HOSTS, REMOTE_PASSWORD } from "./manifest";
import { type RunningMachine, startMachine } from "./sshd";

/**
 * One machine, on a free port, over a tree made here: the API's driver speaks
 * SFTP and execs a handful of GNU commands, and this is that handful.
 */

const marlow = REMOTE_HOSTS.find((host) => host.slug === "marlow");
if (!marlow) throw new Error("the manifest has no marlow");
const MARLOW = marlow;

let home: string;
let machine: RunningMachine;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "trekker-sshd-"));
  process.env.TREKKER_MOCK_HOME = home;
  const root = join(home, "tree");
  mkdirSync(join(root, "srv", "backups", "logs"), { recursive: true });
  writeFileSync(join(root, "srv", "backups", "README"), "off-site\n");
  writeFileSync(join(root, "srv", "backups", "logs", "a.log"), "x".repeat(2_000));
  const df = join(home, "df");
  writeFileSync(
    df,
    '#!/usr/bin/env node\nprocess.stdout.write("Filesystem Type 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 ext4 100 40 60 40% /\\n");\n',
  );
  machine = await startMachine(MARLOW, { root, port: 0, dfShim: df });
});

afterAll(async () => {
  await machine.close();
  rmSync(home, { recursive: true, force: true });
});

function connect(password = REMOTE_PASSWORD): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on("ready", () => resolve(client))
      .on("error", reject)
      .connect({ host: "127.0.0.1", port: machine.port, username: MARLOW.username, password, readyTimeout: 5_000 });
  });
}

function sftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((error, wrapper) => (error ? reject(error) : resolve(wrapper))));
}

function exec(client: Client, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      stream.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      stream.on("close", (code: number) => resolve({ code, stdout, stderr }));
    });
  });
}

describe("the mock's sshd", () => {
  it("refuses a wrong password and takes the manifest's", async () => {
    await expect(connect("not it")).rejects.toThrow();
    const client = await connect();
    client.end();
  });

  it("serves the tree as / over SFTP, with the machine's own uid on everything", async () => {
    const client = await connect();
    const wrapper = await sftp(client);
    const home = await new Promise<string>((resolve, reject) =>
      wrapper.realpath(".", (error, path) => (error ? reject(error) : resolve(path))),
    );
    expect(home).toBe("/srv/backups");
    const entries = await new Promise<Array<{ filename: string; attrs: { uid?: number; size?: number } }>>(
      (resolve, reject) => wrapper.readdir("/srv/backups", (error, list) => (error ? reject(error) : resolve(list))),
    );
    expect(entries.map((entry) => entry.filename).sort()).toEqual(["README", "logs"]);
    expect(entries.every((entry) => entry.attrs.uid === MARLOW.uid)).toBe(true);
    const bytes = await new Promise<string>((resolve, reject) =>
      wrapper.readFile("/srv/backups/README", "utf8", (error, data) => (error ? reject(error) : resolve(String(data)))),
    );
    expect(bytes).toBe("off-site\n");
    await new Promise<void>((resolve, reject) =>
      wrapper.mkdir("/srv/backups/new", (error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      wrapper.rmdir("/srv/backups/new", (error) => (error ? reject(error) : resolve())),
    );
    client.end();
  });

  it("answers the commands the driver runs, as GNU coreutils would", async () => {
    const client = await connect();
    expect(await exec(client, "id '-un'")).toMatchObject({ code: 0, stdout: `${MARLOW.username}\n` });
    expect((await exec(client, "du '--version'")).stdout).toMatch(/GNU coreutils/);
    const scan = await exec(
      client,
      "nice -n '15' du '-x' '-a' '-0' '-B1' '--time' '--time-style=+%s' -- '/srv/backups'",
    );
    expect(scan.code).toBe(0);
    const records = scan.stdout.split("\0").filter(Boolean);
    expect(records).toContainEqual(expect.stringMatching(/^2000\t\d+\t\/srv\/backups\/logs\/a\.log$/));
    expect(records[records.length - 1]).toMatch(/^\d+\t\d+\t\/srv\/backups$/);
    expect((await exec(client, "du '-s' '-B1' -- '/srv/backups'")).stdout).toMatch(/^\d+\t\/srv\/backups\n$/);
    expect((await exec(client, "df '-P' '-k' '-T'")).stdout).toMatch(/^Filesystem Type/);
    const tails = await exec(
      client,
      "tail '-n' '500' '/proc/uptime' '/proc/loadavg' '/proc/stat' '/proc/diskstats' '/proc/meminfo'",
    );
    expect(tails.stdout).toMatch(/==> \/proc\/meminfo <==\nMemTotal:/);
    expect((await exec(client, "tail '-n' '20000' '/etc/passwd'")).stdout).toMatch(
      new RegExp(`^${MARLOW.username}:x:${MARLOW.uid}:`, "m"),
    );
    expect((await exec(client, "sha256sum -- '/srv/backups/README'")).stdout).toMatch(
      /^[0-9a-f]{64} {2}\/srv\/backups\/README\n$/,
    );
    expect(await exec(client, "sudo -n id '-u'")).toMatchObject({ code: 1 });
    expect((await exec(client, "git 'status'")).code).toBe(127);
    client.end();
  });
});
