import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  guardDevelopmentDatabase,
  HOUSE_EMAIL,
  HOUSE_PASSPHRASE,
  HOUSE_PASSWORD,
  MockRefusal,
  openPrisma,
  treeRoot,
} from "./env";
import { loadFixtures } from "./load";
import { LOCAL_HOST } from "./manifest";
import { fixturesMatchTree } from "./tree";

/**
 * What `pnpm dev` runs first, so that developing means one command
 * (TRE-140, after a sibling app's lesson: a mock you have to remember to run
 * is a mock you forget).
 *
 * Two questions, each answered only when the answer is "no":
 *
 *   1. Is the house account there? If not, `pnpm seed` makes it, and the
 *      credentials are printed — they are also in the gitignored ACCOUNTS.md.
 *   2. Do the fixtures in the database describe the tree on disk? They do
 *      when the pinned LOCAL host is there, the tree is there, and the two
 *      stamps beside the tree agree. Otherwise the loader runs — and the
 *      loader writes the tree, so a missing tree is the same case as missing
 *      rows, and a tree rewritten since the last load (`mock:tree --force`, a
 *      delete by hand) is reloaded rather than left with checksums that no
 *      longer match a single file.
 *
 * A "yes" to both touches nothing. A tree whose manifest has moved on is left
 * standing as long as its rows still describe it; `pnpm mock` is the reset.
 *
 * Nothing here blocks the API. Every refusal and every failure is a printed
 * sentence and the exit code is zero — `pnpm dev` runs Nest right after,
 * whatever happened here.
 */

const say = (line: string): void => console.log(`dev-up: ${line}`);

/** What the seed used to call the account. Left alone; see the seed. */
const LEGACY_DEMO_EMAIL = "demo@example.com";

async function main(): Promise<void> {
  let connection: ReturnType<typeof guardDevelopmentDatabase>;
  try {
    connection = guardDevelopmentDatabase();
  } catch (error) {
    say(`${(error as Error).message} — nothing to do here, the API starts anyway`);
    return;
  }

  const prisma = openPrisma(connection);
  try {
    // 1. The account. The seed owns it; this only notices it is missing.
    let user = await prisma.users.findUnique({
      where: { email: HOUSE_EMAIL },
      select: { id: true },
    });
    if (!user) {
      const legacy = await prisma.users.findUnique({
        where: { email: LEGACY_DEMO_EMAIL },
        select: { id: true },
      });
      if (legacy) {
        say(
          `${LEGACY_DEMO_EMAIL} is still there; the seed leaves it alone — delete it yourself when it is no longer needed`,
        );
      }
      say(`no ${HOUSE_EMAIL} account — running pnpm seed`);
      const seed = spawnSync("pnpm", ["seed"], {
        stdio: "inherit",
        env: { ...process.env, SEED_PASSWORD: HOUSE_PASSWORD },
      });
      if (seed.status !== 0) {
        say("the seed did not finish — see above; the API starts anyway");
        return;
      }
      user = await prisma.users.findUnique({
        where: { email: HOUSE_EMAIL },
        select: { id: true },
      });
      if (!user) {
        say(`the seed ran and ${HOUSE_EMAIL} is still missing; the API starts anyway`);
        return;
      }
      say(`account: ${HOUSE_EMAIL} / ${HOUSE_PASSWORD} — recovery passphrase "${HOUSE_PASSPHRASE}" (see ACCOUNTS.md)`);
    }

    // 2. The tree and the rows that describe it, decided together.
    const host = await prisma.hosts.findFirst({
      where: { id: LOCAL_HOST.id, userId: user.id },
      select: { id: true },
    });
    const treePresent = existsSync(treeRoot());
    if (host && treePresent && fixturesMatchTree()) {
      say(`tree present at ${treeRoot()}, fixtures present — \`pnpm mock\` is the reset`);
      return;
    }

    if (!host) say("dev LOCAL host absent — loading the fixtures, which writes the tree");
    else if (!treePresent) say(`tree absent at ${treeRoot()} — rewriting it and reloading the fixtures`);
    else say("the tree was rewritten since the fixtures were loaded — reloading them against it");

    const loaded = await loadFixtures({ prisma, log: say });
    const summary = Object.entries(loaded.counts)
      .map(([table, count]) => `${count} ${table}`)
      .join(", ");
    say(`loaded: ${summary}`);
  } catch (error) {
    const reason = error instanceof MockRefusal ? error.message : (error as Error).message;
    say(`${reason} — the API starts anyway`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  say(`${(error as Error).message} — the API starts anyway`);
});
