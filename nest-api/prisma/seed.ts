/**
 * Development seed: the house account, the mock's four hosts, enough around
 * them that the app has something to draw.
 *
 * Everything in here is a placeholder. No real hostname, address, username or
 * path from any machine the author runs — this repo is public (TRE-5). The
 * hosts are the manifest's (TRE-148): one LOCAL, three SSH placeholders under
 * `example.com`, which RFC 2606 reserves for exactly this, with stock FHS
 * directories for roots.
 *
 *   pnpm --filter ./nest-api seed
 *
 * The account is the fleet's house dev account (TRE-140): the same email,
 * password and recovery passphrase on every project, written down in
 * `mock/env.ts` and in each repo's gitignored ACCOUNTS.md. A known password
 * in a public repo is tolerable only because it can never be created
 * anywhere but a development database: the seed runs behind the same guard
 * as `pnpm mock` — production refused, any non-loopback database refused by
 * name, before a byte is written. SEED_PASSWORD still overrides it.
 *
 * The LOCAL host made here is rooted at the fake tree's path, whether or not
 * the tree exists yet: a root that does not exist grants nothing, so a
 * member browsing between the seed and the load is refused everywhere rather
 * than shown a real directory. `pnpm mock` replaces the host with the pinned
 * one, and `pnpm dev` does that on its own.
 */
import { hash } from "bcryptjs";
import {
  guardDevelopmentDatabase,
  HOUSE_EMAIL,
  HOUSE_PASSPHRASE,
  HOUSE_PASSWORD,
  openPrisma,
  treeRoot,
} from "../mock/env";
import { LOCAL_HOST, REMOTE_HOSTS } from "../mock/manifest";
import { roleFields } from "../src/users/owner";

const DEMO_EMAIL = HOUSE_EMAIL;
/**
 * What this account was called before TRE-140. Never deleted here: it may
 * hold hosts and credentials a developer stored while testing, and a seed
 * that took those with it on the first `pnpm dev` after a pull would be a
 * data loss nobody asked for. Reported instead, with the remedy.
 */
const LEGACY_DEMO_EMAIL = "demo@example.com";

async function main(): Promise<void> {
  // The same refusals as the mock commands, and for the same reason: this
  // writes a known password.
  const connection = guardDevelopmentDatabase();
  const prisma = openPrisma(connection);
  const password = process.env.SEED_PASSWORD ?? HOUSE_PASSWORD;
  const tree = treeRoot();

  try {
    const legacy = await prisma.users.findUnique({
      where: { email: LEGACY_DEMO_EMAIL },
      select: { role: true },
    });
    if (legacy) {
      console.log(
        `${LEGACY_DEMO_EMAIL} still exists (${legacy.role}) and is left alone — delete it yourself when it is no longer needed.`,
      );
    }

    // Deleting the user cascades to hosts, views and everything under them, so
    // re-running is a clean rebuild rather than a pile-up.
    await prisma.users.deleteMany({ where: { email: DEMO_EMAIL } });

    // A MEMBER, deliberately and always — never the owner slot (TRE-48).
    //
    // The owner browses every host against `/`: the roots allowlist does not
    // bind them, only the local denylist does. The dev LOCAL host exists to
    // lock the app inside the fake tree so the machine's real content is
    // never shown (TRE-140), and that lock is the roots. An owner account
    // would step straight over it. The cost is that the owner-only surfaces —
    // the denylist explaining itself, unrestricted browsing — are not
    // reachable with this account; flip the role by hand if a ticket needs
    // them, knowing what that opens.
    //
    // The slot stays free. Whichever account is created next claims it, which
    // is the repair `roleForNewAccount` describes and is fine on a dev box.
    const role = "MEMBER" as const;

    const user = await prisma.users.create({
      data: {
        email: DEMO_EMAIL,
        passwordHash: await hash(password, 10),
        // The house passphrase, so the recovery screen can be exercised too.
        recoveryPassphraseHash: await hash(HOUSE_PASSPHRASE, 10),
        ...roleFields(role),
      },
    });

    const local = await prisma.hosts.create({
      data: {
        userId: user.id,
        slug: LOCAL_HOST.slug,
        label: LOCAL_HOST.label,
        transport: "LOCAL",
        // Nothing to dial, and the one LOCAL slot for this user is now taken.
        address: null,
        username: null,
        localSlot: true,
        colour: LOCAL_HOST.colour,
        // The fake tree, and nothing else — see the header. Absent, it grants
        // nothing; present, it is what the loader locks the host into anyway.
        homePath: tree,
        roots: {
          create: [{ path: tree, access: "WRITE" }],
        },
        bookmarks: {
          create: [
            {
              path: `${tree}/var/www`,
              label: "Web root",
              hint: "app + api releases",
              position: 0,
            },
            {
              path: `${tree}/var/log`,
              label: "Logs",
              hint: "nginx, app, system",
              position: 1,
            },
          ],
        },
      },
    });

    // The three remote machines, as the manifest describes them. No
    // HostCredentials row here: the loader seals the demo password onto each
    // one, and pins the host key `pnpm mock:hosts` made for it.
    const remotes: Array<Awaited<ReturnType<typeof prisma.hosts.create>>> = [];
    for (const spec of REMOTE_HOSTS) {
      remotes.push(
        await prisma.hosts.create({
          data: {
            userId: user.id,
            slug: spec.slug,
            label: spec.label,
            transport: "SSH",
            address: spec.address,
            port: spec.port,
            username: spec.username,
            colour: spec.colour,
            homePath: spec.homePath,
            roots: {
              create: spec.roots.map((path) => ({ path, access: "WRITE" as const })),
            },
            bookmarks: {
              create: spec.bookmarks.map((bookmark, position) => ({
                path: bookmark.path,
                label: bookmark.label,
                hint: bookmark.hint,
                position,
              })),
            },
          },
        }),
      );
    }
    const [marlow] = remotes;

    // The layout blob is the front's `ViewLayout` (TRE-37) — both panes, the
    // split, the inspector, the heat map and the glob. Written out here rather
    // than imported: the seed cannot reach across into `front/`, and a shape
    // this file guessed at would be a shape the app refuses to parse.
    await prisma.views.create({
      data: {
        userId: user.id,
        name: "Side by side",
        slot: 1,
        layout: {
          a: { host: local.id, path: `${tree}/var/www`, sort: "name", dir: 1 },
          b: { host: marlow.id, path: marlow.homePath, sort: "name", dir: 1 },
          split: "split",
          insp: true,
          heat: true,
          glob: "",
        },
        hostLabels: Object.fromEntries([local, ...remotes].map((host) => [host.id, host.label])),
      },
    });

    await prisma.activityLog.createMany({
      data: [local, ...remotes].map((host) => ({
        userId: user.id,
        hostId: host.id,
        kind: "host.created",
        summary: `Added ${host.label}`,
        tag: host.transport === "LOCAL" ? "local" : "ssh",
      })),
    });

    console.log(
      `Seeded ${DEMO_EMAIL} (${role}) with hosts: ${[local, ...remotes].map((host) => host.slug).join(", ")}`,
    );
    console.log(
      process.env.SEED_PASSWORD
        ? "Password: as SEED_PASSWORD gave it."
        : `Password: ${HOUSE_PASSWORD} — recovery passphrase: ${HOUSE_PASSPHRASE} (the house account, see ACCOUNTS.md)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
