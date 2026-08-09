/**
 * The parts of the schema that are promises rather than shapes: what a delete
 * takes with it, what it leaves behind, and the one-LOCAL-host-per-user rule.
 *
 * These need a real MySQL — the constraints under test are the database's, not
 * Prisma's, and an in-memory stand-in would prove nothing. Run with:
 *
 *   pnpm --filter ./nest-api test:db
 *
 * Every test makes its own user and deletes it afterwards, so this is safe to
 * point at a dev database that already has a seed in it.
 */
import { randomUUID } from "node:crypto";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { parseDatabaseUrl } from "../src/config/database-url";
import { loadEnv } from "../src/config/load-env";
import { PrismaClient } from "../generated/prisma/client";

loadEnv();

function makePrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaMariaDb({
      ...parseDatabaseUrl(process.env.DATABASE_URL),
      connectionLimit: 5,
      allowPublicKeyRetrieval: true,
    }),
  });
}

const prisma = makePrisma();
const createdUserIds: string[] = [];

async function makeUser(): Promise<string> {
  const user = await prisma.users.create({
    data: { email: `test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" },
  });
  createdUserIds.push(user.id);
  return user.id;
}

function sshHost(userId: string, slug: string) {
  return {
    userId,
    slug,
    label: slug,
    transport: "SSH" as const,
    address: "host.example.com",
    username: "example-user",
  };
}

afterAll(async () => {
  await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("deleting a host", () => {
  it("takes everything that only makes sense with it", async () => {
    const userId = await makeUser();
    const host = await prisma.hosts.create({
      data: {
        ...sshHost(userId, "doomed"),
        credential: {
          create: {
            kind: "PASSWORD",
            ciphertext: Buffer.from("ciphertext"),
            iv: Buffer.alloc(12, 1),
            authTag: Buffer.alloc(16, 2),
          },
        },
        knownKeys: { create: [{ algorithm: "ssh-ed25519", fingerprint: "SHA256:placeholder" }] },
        roots: { create: [{ path: "/srv", access: "WRITE" }] },
        bookmarks: { create: [{ path: "/srv", label: "Services" }] },
        diskScans: { create: [{ root: "/srv" }] },
      },
    });

    await prisma.hosts.delete({ where: { id: host.id } });

    expect(await prisma.hostCredentials.count({ where: { hostId: host.id } })).toBe(0);
    expect(await prisma.hostKnownKeys.count({ where: { hostId: host.id } })).toBe(0);
    expect(await prisma.hostRoots.count({ where: { hostId: host.id } })).toBe(0);
    expect(await prisma.bookmarks.count({ where: { hostId: host.id } })).toBe(0);
    expect(await prisma.diskScans.count({ where: { hostId: host.id } })).toBe(0);
  });

  it("leaves the transfer it was part of, with the reference nulled", async () => {
    const userId = await makeUser();
    const src = await prisma.hosts.create({ data: sshHost(userId, "src") });
    const dst = await prisma.hosts.create({ data: sshHost(userId, "dst") });

    const job = await prisma.transferJobs.create({
      data: {
        userId,
        srcHostId: src.id,
        srcPath: "/srv/app",
        dstHostId: dst.id,
        dstPath: "/srv/backup",
        operation: "COPY",
        status: "DONE",
        items: { create: [{ name: "app.tar.gz", bytes: 1024n, status: "DONE" }] },
      },
    });

    await prisma.hosts.delete({ where: { id: src.id } });

    const survivor = await prisma.transferJobs.findUnique({ where: { id: job.id } });
    expect(survivor).not.toBeNull();
    expect(survivor?.srcHostId).toBeNull();
    expect(survivor?.dstHostId).toBe(dst.id);
    expect(survivor?.srcPath).toBe("/srv/app");
    expect(await prisma.transferItems.count({ where: { jobId: job.id } })).toBe(1);
  });

  it("leaves the activity it produced, with the reference nulled", async () => {
    const userId = await makeUser();
    const host = await prisma.hosts.create({ data: sshHost(userId, "noisy") });
    await prisma.activityLog.create({
      data: { userId, hostId: host.id, kind: "fs.delete", summary: "Deleted 3 files" },
    });

    await prisma.hosts.delete({ where: { id: host.id } });

    const rows = await prisma.activityLog.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].hostId).toBeNull();
  });
});

describe("one LOCAL host per user", () => {
  it("rejects a second one", async () => {
    const userId = await makeUser();
    await prisma.hosts.create({
      data: { userId, slug: "local", label: "This machine", transport: "LOCAL", localSlot: true },
    });

    await expect(
      prisma.hosts.create({
        data: { userId, slug: "local-2", label: "Also local", transport: "LOCAL", localSlot: true },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("does not get in the way of several SSH hosts", async () => {
    const userId = await makeUser();
    await prisma.hosts.create({ data: sshHost(userId, "one") });
    await prisma.hosts.create({ data: sshHost(userId, "two") });

    expect(await prisma.hosts.count({ where: { userId } })).toBe(2);
  });

  it("is per user, not global", async () => {
    const firstUserId = await makeUser();
    const secondUserId = await makeUser();
    const local = { slug: "local", label: "This machine", transport: "LOCAL" as const, localSlot: true };

    await prisma.hosts.create({ data: { userId: firstUserId, ...local } });
    await prisma.hosts.create({ data: { userId: secondUserId, ...local } });

    expect(await prisma.hosts.count({ where: { userId: secondUserId } })).toBe(1);
  });
});

describe("deleting a user", () => {
  it("takes their hosts, views, transfers and activity", async () => {
    const userId = await makeUser();
    const host = await prisma.hosts.create({ data: sshHost(userId, "everything") });
    await prisma.views.create({
      data: { userId, name: "Side by side", panes: [{ hostId: host.id, path: "/srv" }] },
    });
    await prisma.transferJobs.create({
      data: { userId, srcPath: "/a", dstPath: "/b", operation: "MOVE" },
    });
    await prisma.activityLog.create({ data: { userId, kind: "auth.login", summary: "Signed in" } });

    await prisma.users.delete({ where: { id: userId } });

    expect(await prisma.hosts.count({ where: { userId } })).toBe(0);
    expect(await prisma.views.count({ where: { userId } })).toBe(0);
    expect(await prisma.transferJobs.count({ where: { userId } })).toBe(0);
    expect(await prisma.activityLog.count({ where: { userId } })).toBe(0);
  });
});
