/**
 * Creates a host from the command line, on the machine the API runs on.
 *
 * **The bootstrap path only.** Since TRE-43 the app manages its own hosts —
 * the pane's host chip opens a manager that adds, edits, tests and removes
 * them, and an install with no hosts leads there from the empty pane. Use the
 * browser. This survives for the case the UI cannot cover: a deployment where
 * something is wrong enough that the front will not load, and for symmetry
 * with `account:create`, which has the same shape and the same reason to exist.
 *
 * It is also deliberately narrower than the UI: it seeds roots but cannot edit
 * them, and it refuses key material outright (see below).
 *
 *   HOST_EMAIL=you@example.com \
 *   HOST_ROOTS='/var/www:READ,/var/log:READ' \
 *   HOST_HOME=/var/www \
 *   pnpm --filter ./nest-api host:create
 *
 * Defaults make the common case short: a LOCAL host called "This machine",
 * which is the row that lets Trekker browse the server it is installed on.
 *
 * `HOST_TRANSPORT=SSH` also needs HOST_ADDRESS and HOST_USERNAME, and creates
 * the row with no stored credential — the connection then relies on the API
 * user's ssh-agent. Key material is deliberately not accepted here: a private
 * key or password passed through the environment lands in shell history and
 * in the process list, which is precisely what the encrypted store (TRE-8)
 * exists to avoid.
 */
import { homedir } from "node:os";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../generated/prisma/client";
import { parseDatabaseUrl } from "../src/config/database-url";
import { loadEnv } from "../src/config/load-env";
import { computeLocalDenylist } from "../src/hosts/path-guard/local-denylist";

type Access = "READ" | "WRITE";

interface Root {
  path: string;
  access: Access;
}

/** "/srv:WRITE,/var/log" — the access defaults to READ, the safer half. */
function parseRoots(raw: string): Root[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [path, access = "READ"] = entry.split(":");
      const upper = access.trim().toUpperCase();
      if (upper !== "READ" && upper !== "WRITE") {
        throw new Error(`Root "${entry}": access must be READ or WRITE.`);
      }
      if (!path.startsWith("/")) throw new Error(`Root "${entry}": path must be absolute.`);
      return { path: path.trim().replace(/\/+$/, "") || "/", access: upper };
    });
}

async function main(): Promise<void> {
  loadEnv();

  const email = process.env.HOST_EMAIL;
  if (!email) {
    console.error("Set HOST_EMAIL to the account that should own this host. See the header of this file.");
    process.exit(1);
  }

  const transport = (process.env.HOST_TRANSPORT ?? "LOCAL").toUpperCase();
  if (transport !== "LOCAL" && transport !== "SSH") {
    console.error("HOST_TRANSPORT must be LOCAL or SSH.");
    process.exit(1);
  }

  const address = process.env.HOST_ADDRESS ?? null;
  const username = process.env.HOST_USERNAME ?? null;
  if (transport === "SSH" && (!address || !username)) {
    console.error("HOST_TRANSPORT=SSH needs HOST_ADDRESS and HOST_USERNAME.");
    process.exit(1);
  }

  const roots = parseRoots(process.env.HOST_ROOTS ?? "");
  if (roots.length === 0) {
    console.error(
      "Set HOST_ROOTS, e.g. HOST_ROOTS='/var/www:READ,/var/log:READ'. A host with no roots serves nothing.",
    );
    process.exit(1);
  }

  const slug = process.env.HOST_SLUG ?? (transport === "LOCAL" ? "local" : "remote");
  const label = process.env.HOST_LABEL ?? (transport === "LOCAL" ? "This machine" : (address as string));
  const homePath = process.env.HOST_HOME ?? roots[0].path;
  const colour = process.env.HOST_COLOUR ?? "#7fa8c9";
  const port = Number(process.env.HOST_PORT ?? 22);

  if (!roots.some((root) => homePath === root.path || homePath.startsWith(`${root.path}/`))) {
    console.error(`HOST_HOME (${homePath}) sits outside every root, so the pane would open on a refusal.`);
    process.exit(1);
  }

  // The guard would refuse these at request time anyway (TRE-11 §3); saying so
  // now beats a host that lists nothing and does not explain why.
  if (transport === "LOCAL") {
    const denied = await computeLocalDenylist({ startDir: __dirname, homeDir: homedir() });
    const clash = roots.find((root) => denied.some((path) => root.path === path || path.startsWith(`${root.path}/`)));
    if (clash) {
      console.warn(
        `\n  warning  root ${clash.path} contains a denylisted directory (Trekker's own install tree, ~/.pm2 or ~/.ssh).` +
          "\n           The host will be created, but the guard refuses those paths — they hold the master key.\n",
      );
    }
  }

  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb(parseDatabaseUrl(process.env.DATABASE_URL)),
  });

  try {
    const user = await prisma.users.findUnique({ where: { email } });
    if (!user) {
      console.error(`No account for ${email}. Create one with account:create first.`);
      process.exit(1);
    }

    const clash = await prisma.hosts.findFirst({ where: { userId: user.id, slug } });
    if (clash) {
      console.error(`${email} already has a host with slug "${slug}". Set HOST_SLUG to something else.`);
      process.exit(1);
    }

    const host = await prisma.hosts.create({
      data: {
        userId: user.id,
        slug,
        label,
        transport,
        address: transport === "LOCAL" ? null : address,
        username: transport === "LOCAL" ? null : username,
        port,
        // The schema allows one LOCAL host per user, enforced by this column.
        localSlot: transport === "LOCAL" ? true : null,
        colour,
        homePath,
        roots: { create: roots.map((root) => ({ path: root.path, access: root.access })) },
      },
    });

    console.log(`\nHost created for ${email}:\n`);
    console.log(`  slug       ${host.slug}`);
    console.log(`  label      ${host.label}`);
    console.log(`  transport  ${host.transport}${transport === "SSH" ? `  ${username}@${address}:${port}` : ""}`);
    console.log(`  home       ${host.homePath}`);
    console.log(`  roots      ${roots.map((root) => `${root.path} (${root.access})`).join(", ")}`);
    if (transport === "SSH") {
      console.log("\n  No credential stored — this host connects through the API user's ssh-agent.");
    }
    console.log("");
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: Error) => {
  console.error(`\nhost:create failed: ${error.message}\n`);
  process.exit(1);
});
