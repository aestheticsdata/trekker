import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLocalDenylist } from "@hosts/path-guard/local-denylist";

/**
 * What the LOCAL host never serves (TRE-11 §3, narrowed by TRE-150): the PM2
 * config that carries the master key, at each level the deploy can put it, and
 * the API user's `~/.pm2` and `~/.ssh`. Not the install tree around them — that
 * was the rule until TRE-150, and it closed the one directory the owner most
 * needs to manage.
 */
describe("computeLocalDenylist", () => {
  let base: string;
  let home: string;

  beforeEach(() => {
    // Resolved: macOS keeps the temp directory behind a symlink, and the list
    // holds resolved paths because that is what the guard compares.
    base = realpathSync(mkdtempSync(join(tmpdir(), "trekker-denylist-")));
    home = join(base, "home");
    mkdirSync(home);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("on a deployed layout, names the PM2 config at the deploy root and nothing of the tree around it", async () => {
    // $TREKKER_REMOTE_ROOT/ecosystem.config.js sits above api/, which holds the
    // whole workspace, so that the config survives the release swap.
    const deployRoot = join(base, "trekker");
    const installRoot = join(deployRoot, "api");
    const packageRoot = join(installRoot, "nest-api");
    const startDir = join(packageRoot, "dist", "src", "hosts", "path-guard");
    mkdirSync(startDir, { recursive: true });
    writeFileSync(join(installRoot, "pnpm-workspace.yaml"), "");
    writeFileSync(join(packageRoot, "package.json"), "{}");
    writeFileSync(join(deployRoot, "ecosystem.config.js"), "module.exports = {};");

    const result = await computeLocalDenylist({ startDir, homeDir: home });

    expect(result).toEqual([
      join(packageRoot, "ecosystem.config.js"),
      join(installRoot, "ecosystem.config.js"),
      join(deployRoot, "ecosystem.config.js"),
      join(home, ".pm2"),
      join(home, ".ssh"),
    ]);
    // Said outright, because these two were the entries until TRE-150.
    expect(result).not.toContain(installRoot);
    expect(result).not.toContain(deployRoot);
  });

  it("in development, names the config beside the API package", async () => {
    const repo = join(base, "repo");
    const packageRoot = join(repo, "nest-api");
    const startDir = join(packageRoot, "src", "hosts", "path-guard");
    mkdirSync(startDir, { recursive: true });
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "");
    writeFileSync(join(packageRoot, "package.json"), "{}");
    writeFileSync(join(packageRoot, "ecosystem.config.js"), "module.exports = {};");

    const result = await computeLocalDenylist({ startDir, homeDir: home });

    expect(result).toEqual([
      join(packageRoot, "ecosystem.config.js"),
      join(repo, "ecosystem.config.js"),
      join(base, "ecosystem.config.js"),
      join(home, ".pm2"),
      join(home, ".ssh"),
    ]);
    expect(result).not.toContain(repo);
  });

  it("names the config by its real path when the install is reached through a symlink", async () => {
    // The guard compares resolved paths, so an entry built from a symlinked
    // __dirname would never match the request it is meant to refuse — and the
    // two configs that do not exist yet have to be named under the real
    // directory for the same reason.
    const deployRoot = join(base, "trekker");
    const installRoot = join(deployRoot, "api");
    const packageRoot = join(installRoot, "nest-api");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(installRoot, "pnpm-workspace.yaml"), "");
    writeFileSync(join(packageRoot, "package.json"), "{}");
    writeFileSync(join(deployRoot, "ecosystem.config.js"), "module.exports = {};");
    symlinkSync(deployRoot, join(base, "current"));

    const result = await computeLocalDenylist({
      startDir: join(base, "current", "api", "nest-api", "dist"),
      homeDir: home,
    });

    expect(result).toEqual([
      join(packageRoot, "ecosystem.config.js"),
      join(installRoot, "ecosystem.config.js"),
      join(deployRoot, "ecosystem.config.js"),
      join(home, ".pm2"),
      join(home, ".ssh"),
    ]);
  });
});
