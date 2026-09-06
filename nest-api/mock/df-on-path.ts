import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { startRemoteMachines } from "./sshd";
import { mockHome } from "./env";
import { dfShimPath } from "./tree";

/**
 * Runs the API inside the mock's world (TRE-148):
 *
 * - the mock's `bin` first on its PATH — the fake `df` that `tree.ts` writes
 *   beside the tree, so the VOLUMES rail, the DISK USAGE strip and the
 *   path-row badge read the manifest's `VOLUMES` rather than the machine the
 *   API happens to run on;
 * - `mock/example-dns.cjs` preloaded, so the three remote machines' names
 *   under `example.com` resolve to the loopback for this process tree alone;
 * - the three remote machines themselves (`sshd.ts`), started here before the
 *   API and stopped when it exits — nothing to run beforehand;
 * - the mock home named to the local driver's denylist as the one place inside
 *   the install tree it may serve (`TREKKER_DEV_LOCAL_EXCEPTIONS`, honoured
 *   under any NODE_ENV but production), because the mock lives in the
 *   repository's own `.mock/` folder.
 *
 *   pnpm exec tsx mock/df-on-path.ts nest start --watch     # what `pnpm dev` runs
 *   pnpm exec tsx mock/df-on-path.ts node dist/src/main     # a built API, for a film
 *
 * This process tree only: nothing else on the machine sees the shim, the
 * names or the servers. Production never runs this — `pnpm dev` is a laptop
 * verb.
 */

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("df-on-path: a command to run is required, e.g. `tsx mock/df-on-path.ts nest start --watch`");
  process.exit(2);
}

void (async () => {
  console.log("The three remote machines, on the loopback:\n");
  const stop = await startRemoteMachines((line) => console.log(line));
  console.log("");

  const bin = dirname(dfShimPath());
  const preload = join(__dirname, "example-dns.cjs");
  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${preload}`].filter(Boolean).join(" "),
      TREKKER_DEV_LOCAL_EXCEPTIONS: mockHome(),
    },
  });

  const forward = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  child.on("exit", (code, signal) => {
    void stop().then(() => process.exit(code ?? (signal ? 1 : 0)));
  });
  child.on("error", (error) => {
    console.error(`df-on-path: could not start ${command}: ${error.message}`);
    void stop().then(() => process.exit(1));
  });
})();
