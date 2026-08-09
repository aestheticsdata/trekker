/**
 * Development seed: one account, two hosts, enough around them that the app
 * has something to draw.
 *
 * Everything in here is a placeholder. No real hostname, address, username or
 * path from any machine the author runs — this repo is public (TRE-5). The
 * remote host uses `host.example.com`, which RFC 2606 reserves for exactly
 * this, and the roots are stock FHS directories.
 *
 *   pnpm --filter ./nest-api seed
 *
 * The account password comes from SEED_PASSWORD when set. Otherwise one is
 * generated and printed: a seed that creates a known-password account is a
 * bad thing to leave lying around, and a public repo is the worst place to
 * write the default down.
 */
import { randomBytes } from "node:crypto";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { hash } from "bcryptjs";
import { parseDatabaseUrl } from "../src/config/database-url";
import { loadEnv } from "../src/config/load-env";
import { PrismaClient } from "../generated/prisma/client";

loadEnv();

const DEMO_EMAIL = "demo@example.com";

function makePrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaMariaDb({
      ...parseDatabaseUrl(process.env.DATABASE_URL),
      connectionLimit: 5,
      allowPublicKeyRetrieval: true,
    }),
  });
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed with NODE_ENV=production.");
  }

  const prisma = makePrisma();
  const generated = process.env.SEED_PASSWORD ? null : randomBytes(9).toString("base64url");
  const password = process.env.SEED_PASSWORD ?? (generated as string);

  try {
    // Deleting the user cascades to hosts, views and everything under them, so
    // re-running is a clean rebuild rather than a pile-up.
    await prisma.users.deleteMany({ where: { email: DEMO_EMAIL } });

    const user = await prisma.users.create({
      data: { email: DEMO_EMAIL, passwordHash: await hash(password, 10) },
    });

    const local = await prisma.hosts.create({
      data: {
        userId: user.id,
        slug: "local",
        label: "This machine",
        transport: "LOCAL",
        // Nothing to dial, and the one LOCAL slot for this user is now taken.
        address: null,
        username: null,
        localSlot: true,
        colour: "#7fa8c9",
        homePath: "/srv",
        roots: {
          create: [
            { path: "/srv", access: "WRITE" },
            { path: "/var/log", access: "READ" },
          ],
        },
        bookmarks: {
          create: [
            { path: "/srv", label: "Services", hint: "deployed apps", position: 0 },
            { path: "/var/log", label: "Logs", hint: "read only", position: 1 },
          ],
        },
      },
    });

    const remote = await prisma.hosts.create({
      data: {
        userId: user.id,
        slug: "demo-remote",
        label: "Demo remote",
        transport: "SSH",
        address: "host.example.com",
        port: 22,
        username: "example-user",
        colour: "#c9a05a",
        homePath: "/home/example-user",
        roots: {
          create: [{ path: "/home/example-user", access: "WRITE" }],
        },
        bookmarks: {
          create: [{ path: "/home/example-user", label: "Home", hint: null, position: 0 }],
        },
      },
    });

    // No HostCredentials row: there is nothing to connect to, and a fake
    // ciphertext would only fail to decrypt later in a confusing way.

    await prisma.views.create({
      data: {
        userId: user.id,
        name: "Side by side",
        shortcut: "1",
        panes: [
          { hostId: local.id, path: "/srv" },
          { hostId: remote.id, path: "/home/example-user" },
        ],
        split: 50,
        inspector: true,
      },
    });

    await prisma.activityLog.createMany({
      data: [
        {
          userId: user.id,
          hostId: local.id,
          kind: "host.created",
          summary: "Added This machine",
          tag: "local",
        },
        {
          userId: user.id,
          hostId: remote.id,
          kind: "host.created",
          summary: "Added Demo remote",
          tag: "ssh",
        },
      ],
    });

    console.log(`Seeded ${DEMO_EMAIL} with hosts: ${local.slug}, ${remote.slug}`);
    if (generated) {
      console.log(`Generated password: ${generated}`);
      console.log("Set SEED_PASSWORD to choose your own.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
