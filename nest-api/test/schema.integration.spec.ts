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
        items: { create: [{ name: "app.tar.gz", kind: "file", bytes: 1024n, status: "DONE" }] },
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

describe("one owner per install", () => {
  it("rejects a second one", async () => {
    // The constraint TRE-48's check-then-act leans on: two registrations can
    // both read an empty table, and the database is what stops the second one
    // becoming an owner rather than the timing.
    //
    // Written to tolerate an owner already existing, because unlike localSlot
    // this index is table-wide rather than per user — on a developer's box the
    // seeded account usually holds the slot already.
    const existing = await prisma.users.findFirst({ where: { ownerSlot: true } });
    if (!existing) {
      const userId = await makeUser();
      await prisma.users.update({ where: { id: userId }, data: { role: "OWNER", ownerSlot: true } });
    }

    const contender = await makeUser();
    await expect(
      prisma.users.update({ where: { id: contender }, data: { role: "OWNER", ownerSlot: true } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("lets every member leave the slot alone", async () => {
    // A null slot has to stay distinct from every other null, or the second
    // ordinary account an install ever creates would collide.
    const first = await makeUser();
    const second = await makeUser();

    expect(await prisma.users.count({ where: { id: { in: [first, second] }, role: "MEMBER" } })).toBe(2);
  });
});

describe("deleting a user", () => {
  it("takes their hosts, views, transfers and activity", async () => {
    const userId = await makeUser();
    const host = await prisma.hosts.create({ data: sshHost(userId, "everything") });
    await prisma.views.create({
      data: {
        userId,
        name: "Side by side",
        layout: { a: { host: host.id, path: "/srv", sort: "name", dir: 1 } },
        hostLabels: {},
      },
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

describe("one shortcut per account", () => {
  /** A view with nothing but a name and a layout, so a test can say what it means. */
  function view(userId: string, name: string, slot: number | null) {
    return {
      userId,
      name,
      slot,
      layout: { a: { host: null, path: "/", sort: "name", dir: 1 } },
      hostLabels: {},
    };
  }

  it("refuses a second view claiming the same ⌥n", async () => {
    // The promise the shortcut picker leans on (TRE-37 §1). Two views on `⌥3`
    // is a key that does one of two things depending on which row a query
    // happened to return first, and the service works around this constraint
    // deliberately — it clears the other view's slot in the same transaction.
    // If the database stopped refusing, that transaction would silently become
    // a no-op and the duplicate would ship.
    const userId = await makeUser();
    await prisma.views.create({ data: view(userId, "deploy", 3) });

    await expect(prisma.views.create({ data: view(userId, "log triage", 3) })).rejects.toThrow();
  });

  it("lets any number of views have no shortcut at all", async () => {
    // MySQL counts every NULL as distinct, which is the whole reason the column
    // is nullable rather than zero-for-none. Most views never get a chord.
    const userId = await makeUser();
    await prisma.views.create({ data: view(userId, "one", null) });
    await prisma.views.create({ data: view(userId, "two", null) });

    expect(await prisma.views.count({ where: { userId } })).toBe(2);
  });

  it("is per account, so two people can both hold ⌥1", async () => {
    const first = await makeUser();
    const second = await makeUser();
    await prisma.views.create({ data: view(first, "mine", 1) });
    await prisma.views.create({ data: view(second, "theirs", 1) });

    expect(await prisma.views.count({ where: { slot: 1, userId: { in: [first, second] } } })).toBe(2);
  });

  it("refuses two views of the same name, which is what the strip would show twice", async () => {
    const userId = await makeUser();
    await prisma.views.create({ data: view(userId, "deploy", null) });

    await expect(prisma.views.create({ data: view(userId, "deploy", null) })).rejects.toThrow();
  });
});

describe("one scan per host", () => {
  it("refuses a second running scan of the same host", async () => {
    // The promise `runningSlot` exists to keep, made by the database rather
    // than by a check in a service — which could not survive a restart, and
    // which across two Node ticks is a race whose prize is two `du`s walking
    // somebody's filesystem at once.
    const userId = await makeUser();
    const host = await prisma.hosts.create({ data: sshHost(userId, "busy") });

    await prisma.diskScans.create({ data: { hostId: host.id, root: "/srv", runningSlot: host.id } });

    await expect(
      prisma.diskScans.create({ data: { hostId: host.id, root: "/var", runningSlot: host.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("lets every finished scan leave the slot alone", async () => {
    // A finished scan nulls the slot, and a null has to stay distinct from
    // every other null or the second scan a host ever completes would collide.
    const userId = await makeUser();
    const host = await prisma.hosts.create({ data: sshHost(userId, "history") });

    await prisma.diskScans.create({ data: { hostId: host.id, root: "/srv", status: "DONE" } });
    await prisma.diskScans.create({ data: { hostId: host.id, root: "/srv", status: "DONE" } });

    expect(await prisma.diskScans.count({ where: { hostId: host.id } })).toBe(2);
  });

  it("frees the slot for the next scan once one has ended", async () => {
    const userId = await makeUser();
    const host = await prisma.hosts.create({ data: sshHost(userId, "sequential") });

    const first = await prisma.diskScans.create({
      data: { hostId: host.id, root: "/srv", runningSlot: host.id },
    });
    await prisma.diskScans.update({
      where: { id: first.id },
      data: { status: "DONE", runningSlot: null, finishedAt: new Date() },
    });

    await expect(
      prisma.diskScans.create({ data: { hostId: host.id, root: "/srv", runningSlot: host.id } }),
    ).resolves.toMatchObject({ hostId: host.id });
  });
});

describe("superseding a scan", () => {
  it("keeps the survivor when the scan it replaced is deleted", async () => {
    // SET NULL rather than CASCADE. The terminal transaction deletes the
    // superseded row on success, and under CASCADE that delete would take the
    // living scan with it — the one it was keeping the panel warm for.
    const userId = await makeUser();
    const host = await prisma.hosts.create({ data: sshHost(userId, "rolling") });

    const previous = await prisma.diskScans.create({
      data: { hostId: host.id, root: "/srv", status: "DONE", totalBytes: 1_000n },
    });
    const current = await prisma.diskScans.create({
      data: { hostId: host.id, root: "/srv", status: "DONE", totalBytes: 2_000n, supersedesId: previous.id },
    });

    await prisma.diskScans.delete({ where: { id: previous.id } });

    const survivor = await prisma.diskScans.findUnique({ where: { id: current.id } });
    expect(survivor).toMatchObject({ id: current.id, supersedesId: null, totalBytes: 2_000n });
  });

  it("takes a scan's entries with it", async () => {
    const userId = await makeUser();
    const host = await prisma.hosts.create({ data: sshHost(userId, "entries") });

    const scan = await prisma.diskScans.create({
      data: {
        hostId: host.id,
        root: "/srv",
        status: "DONE",
        totalBytes: 10_200n,
        entries: {
          create: [
            { path: "/srv", bytes: 10_200n, percent: 100, parentPath: "", depth: 0, kind: "DIRECTORY" },
            { path: "/srv/a", bytes: 5_100n, percent: 50, parentPath: "/srv", depth: 1, kind: "DIRECTORY" },
            { path: "/srv", bytes: 80n, percent: 0.78, parentPath: "/srv", depth: 1, kind: "OTHER" },
          ],
        },
      },
    });

    expect(await prisma.diskScanEntries.count({ where: { scanId: scan.id } })).toBe(3);

    await prisma.diskScans.delete({ where: { id: scan.id } });

    expect(await prisma.diskScanEntries.count({ where: { scanId: scan.id } })).toBe(0);
  });
});
