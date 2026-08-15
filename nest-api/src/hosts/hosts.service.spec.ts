import { BadRequestException } from "@nestjs/common";
import { HostsService } from "@hosts/hosts.service";
import type { CreateHostDto } from "@hosts/dto/create-host.dto";
import type { UpdateHostDto } from "@hosts/dto/update-host.dto";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { SshConnectionPool } from "@hosts/drivers/ssh-connection.pool";
import type { HostDisksService } from "@hosts/host-disks.service";
import type { HostMetricsService } from "@hosts/host-metrics.service";
import type { HostSummaryService } from "@hosts/host-summary.service";
import type { SecretStoreService } from "@secrets/secret-store.service";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Which of a host's roots rules bind whom (TRE-49).
 *
 * The rules themselves are a few lines of string comparison; what is worth
 * pinning is that `create` and `update` ask who is saving before applying them.
 * The mutations this file exists to catch are the two one-word ones: an
 * `isOwner` that always answers false, which puts an owner back behind a
 * boundary TRE-48 removed, and one that always answers true, which drops the
 * only check standing between a MEMBER and a host whose every pane opens on a
 * refusal.
 *
 * So each rule is asserted twice, once per role, against the service — not
 * against the predicate, which a caller can hold correctly and still never
 * consult.
 */

const ROLES: Record<string, "OWNER" | "MEMBER"> = { boss: "OWNER", guest: "MEMBER" };

const EXISTING_HOST = {
  id: "h1",
  userId: "boss",
  slug: "web",
  label: "web",
  transport: "SSH" as const,
  address: "example.com",
  port: 22,
  username: "debian",
  colour: "#7fa8c9",
  homePath: "/home/debian",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  credential: null,
  knownKeys: [],
  roots: [{ path: "/home/debian", access: "WRITE" }],
};

/**
 * A prisma stand-in that runs the real transaction body, because the question
 * is not only whether a save is refused but what it writes when it is allowed:
 * an owner removing their last root has to leave the table empty rather than
 * quietly keeping the row they deleted.
 */
function prismaFor() {
  const rootWrites: Array<{ kind: "delete" | "create"; rows?: unknown[] }> = [];

  const tx = {
    hosts: {
      create: ({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...EXISTING_HOST, ...data, id: "h1" }),
      update: () => Promise.resolve(EXISTING_HOST),
      findFirstOrThrow: () => Promise.resolve(EXISTING_HOST),
    },
    hostRoots: {
      deleteMany: () => {
        rootWrites.push({ kind: "delete" });
        return Promise.resolve({ count: 1 });
      },
      createMany: ({ data }: { data: unknown[] }) => {
        rootWrites.push({ kind: "create", rows: data });
        return Promise.resolve({ count: data.length });
      },
      findFirst: () => Promise.resolve(null),
    },
  };

  const prisma = {
    users: {
      findUnique: ({ where }: { where: { id: string } }) => Promise.resolve({ role: ROLES[where.id] }),
    },
    hosts: {
      // uniqueSlug: no host of this name is taken.
      findMany: () => Promise.resolve([]),
      findFirst: () => Promise.resolve(EXISTING_HOST),
    },
    $transaction: (body: (client: typeof tx) => Promise<unknown>) => body(tx),
  } as unknown as PrismaService;

  const service = new HostsService(
    prisma,
    {} as unknown as SecretStoreService,
    {} as unknown as SshConnectionPool,
    {} as unknown as HostDriverFactory,
    {} as unknown as HostSummaryService,
    {} as unknown as HostMetricsService,
    {} as unknown as HostDisksService,
  );

  return { service, rootWrites, created: () => rootWrites.filter((write) => write.kind === "create") };
}

const newHost = (roots: unknown): CreateHostDto =>
  ({ label: "web", transport: "LOCAL", homePath: "/srv/app", roots }) as CreateHostDto;

/** A PATCH naming roots that do not contain the host's home. */
const narrowTo = (roots: unknown): UpdateHostDto => ({ roots }) as UpdateHostDto;

describe("create, and who the roots rules bind", () => {
  it("refuses a member an empty allowlist, in the words the DTO used", async () => {
    const { service } = prismaFor();

    await expect(service.create("guest", newHost([]))).rejects.toThrow(BadRequestException);
    await expect(service.create("guest", newHost([]))).rejects.toThrow(/no roots can serve nothing/);
  });

  it("refuses a member a home outside every root", async () => {
    const { service } = prismaFor();

    await expect(service.create("guest", newHost([{ path: "/var/log", access: "READ" }]))).rejects.toThrow(
      /sits outside every root/,
    );
  });

  it("lets the owner save a host with no roots at all, and writes none", async () => {
    const { service, created } = prismaFor();

    await expect(service.create("boss", newHost([]))).resolves.toMatchObject({ id: "h1" });
    // Not `createMany` with an empty array: a round trip to insert nothing.
    expect(created()).toHaveLength(0);
  });

  it("lets the owner put the home outside the roots they listed", async () => {
    const { service, created } = prismaFor();

    await expect(service.create("boss", newHost([{ path: "/var/log", access: "READ" }]))).resolves.toBeDefined();
    // Stored as given: relaxing the rule must not also stop recording the rows.
    expect(created()[0]?.rows).toEqual([{ hostId: "h1", path: "/var/log", access: "READ" }]);
  });

  it("still defaults an omitted allowlist to the home, for either role", async () => {
    for (const who of ["boss", "guest"]) {
      const { service, created } = prismaFor();
      await service.create(who, { label: "web", transport: "LOCAL", homePath: "/srv/app" });
      expect(created()[0]?.rows).toEqual([{ hostId: "h1", path: "/srv/app", access: "WRITE" }]);
    }
  });
});

describe("update, and who the roots rules bind", () => {
  it("refuses a member a patch that narrows the roots away from the home", async () => {
    const { service } = prismaFor();

    await expect(service.update("guest", "h1", narrowTo([{ path: "/var/log", access: "READ" }]))).rejects.toThrow(
      /sits outside every root/,
    );
  });

  it("refuses a member a patch that empties the allowlist", async () => {
    const { service } = prismaFor();

    await expect(service.update("guest", "h1", narrowTo([]))).rejects.toThrow(/no roots can serve nothing/);
  });

  it("lets the owner delete their last root, and leaves the table empty", async () => {
    const { service, rootWrites, created } = prismaFor();

    await expect(service.update("boss", "h1", narrowTo([]))).resolves.toBeDefined();
    // The replacement still happens — the old rows go, and nothing replaces
    // them. An owner who removed a root and found it still there next time
    // would be reading a form that lies about what is stored.
    expect(rootWrites).toEqual([{ kind: "delete" }]);
    expect(created()).toHaveLength(0);
  });
});
