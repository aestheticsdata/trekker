import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../generated/prisma/client";
import { parseDatabaseUrl } from "../src/config/database-url";
import { loadEnv } from "../src/config/load-env";

/**
 * What every mock command must know before it touches anything (TRE-140):
 * whether this is production, where the database is, where the fake tree
 * lives, and who the house account is. Shared by `load.ts`, `tree.ts` and
 * `dev-up.ts` so the three cannot disagree about what "production" means.
 *
 * Every refusal here is a thrown `MockRefusal`, never a `process.exit`: the
 * two commands turn one into an exit code, and `dev-up` turns the same one
 * into a printed sentence and starts the API anyway. One guard, two callers,
 * two answers.
 */

/** A refusal with a remedy in it. The message is the whole of what the person sees. */
export class MockRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockRefusal";
  }
}

// ---------------------------------------------------------------- the house

/**
 * The house dev account, the same on every project in the fleet. Written
 * down here rather than derived from anything: the ticket is explicit that
 * a credential is never derived from the app's name, and the seed, the
 * loader and `dev-up` all have to agree on it.
 *
 * It is a known password in a public repository, and that is fine only
 * because of the guards below: it can only ever be created against a
 * loopback database in development. Production refuses the seed outright.
 */
export const HOUSE_EMAIL = "local.dev@mock.io";
export const HOUSE_PASSWORD = "azertyazerty";
export const HOUSE_PASSPHRASE = "mock local recovery";

// ---------------------------------------------------------------- the tree

/**
 * Where the mock lives: `<repository>/.mock/`, gitignored — the four trees,
 * every fake `df`, the remote machines' keys and the stamps, all in one
 * sub-folder of the project and nowhere else on the machine (TRE-148: "il
 * faut que tous les dossiers soient dans le dossier de trekker"). An
 * ignored folder is invisible to `git status --porcelain`, so the deploy
 * scripts' clean-tree check does not see it; and the local driver, which
 * refuses the install tree, is told about this one folder for development
 * only — `TREKKER_DEV_LOCAL_EXCEPTIONS`, set by `df-on-path.ts`, honoured by
 * the path guard under any NODE_ENV but production.
 *
 * `TREKKER_MOCK_HOME` moves it: the specs materialise into a temporary
 * directory rather than into the repository.
 */
export function mockHome(): string {
  // An empty value is the shell's way of unsetting, not a request for the
  // current directory; a relative one is resolved so `rm -rf` never acts on
  // a path that depends on where the command was started.
  const raw = process.env.TREKKER_MOCK_HOME?.trim();
  return raw ? resolve(raw) : join(installRoot(), ".mock");
}

export function treeRoot(): string {
  return join(mockHome(), "tree");
}

/**
 * The install tree — the nearest ancestor of this file holding
 * `pnpm-workspace.yaml`, the same test the local denylist makes. The tree is
 * refused inside it: a materialised tree in the repository is a dirty working
 * tree both deploy scripts refuse, and a directory the denylist would refuse
 * to serve anyway.
 */
export function installRoot(): string {
  for (let dir = __dirname; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return __dirname;
  }
}

/** Segment-wise containment, as the path guard tests it. */
export function isInside(ancestor: string, path: string): boolean {
  return path === ancestor || path.startsWith(ancestor.endsWith("/") ? ancestor : `${ancestor}/`);
}

// ---------------------------------------------------------------- guards

/**
 * The hosts a mock command will write to. Anything else is refused by name.
 *
 * `parseDatabaseUrl` has already turned `localhost` into `127.0.0.1`, so the
 * set is what is left after that: the loopback addresses as a URL spells them.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

/**
 * Refuses production before a byte is written, in the order that matters.
 *
 * `NODE_ENV` is checked first because `loadEnv()` returns without reading the
 * config file under `production` — asking it for a `DATABASE_URL` there would
 * fail with a message about a missing variable rather than the one that
 * counts. The loopback check comes after the environment is loaded, on the
 * parsed host, so `localhost` and `127.0.0.1` read the same.
 *
 * Returns the parsed connection so the caller opens exactly the database it
 * checked. There is no `--production` escape hatch, on purpose: a demo in
 * production is another ticket, and a flag nobody uses is a flag somebody
 * will one day use by accident.
 */
export function guardDevelopmentDatabase(): ReturnType<typeof parseDatabaseUrl> {
  if (process.env.NODE_ENV === "production") {
    throw new MockRefusal("Refusing to run with NODE_ENV=production. The mock is development-only.");
  }

  // The same loader the API, the seed and the schema tests use. Throws its
  // own message when nest-api/ecosystem.config.js is missing, which is the
  // right message: there is nothing for this command to do without it.
  loadEnv();

  const connection = parseDatabaseUrl(process.env.DATABASE_URL);
  if (!isLoopbackHost(connection.host)) {
    throw new MockRefusal(
      `Refusing to run against a non-loopback database host: ${connection.host}. ` +
        "The mock resets tables, and a remote database is never a target for that.",
    );
  }
  return connection;
}

// ---------------------------------------------------------------- prisma

/** A client the way `seed.ts` opens one, on the connection the guard returned. */
export function openPrisma(connection: ReturnType<typeof parseDatabaseUrl>): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaMariaDb({
      ...connection,
      connectionLimit: 5,
      // MySQL 8 wipes its auth cache on restart; without this a one-shot
      // script run after a reboot dies as a pool timeout instead of connecting.
      allowPublicKeyRetrieval: true,
    }),
  });
}
