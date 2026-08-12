import { ConflictException } from "@nestjs/common";
import { UsersService } from "@users/users.service";
import type { RedisService } from "@redis/redis.service";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * TRE-48's central promise: the first account on an install owns it.
 *
 * It lives here rather than only in `owner.spec.ts` because that file tests the
 * two pure helpers, and a helper nothing calls correctly is still a bug. The
 * mutation this file exists to catch is a one-word edit to the `create` below
 * that hands every account a MEMBER role — with only the pure tests, the whole
 * suite stays green and the install refuses its own owner.
 */

const HASH_ROUNDS_ARE_SLOW = 30_000;
jest.setTimeout(HASH_ROUNDS_ARE_SLOW);

interface Created {
  role?: string;
  ownerSlot?: boolean | null;
  email?: string;
}

/**
 * A prisma stand-in narrow enough to be read at a glance: how many accounts
 * hold the owner slot, what `create` was handed, and whether it should reject.
 */
/**
 * Prisma's unique-constraint failure as it really arrives: an Error carrying
 * `code` and `meta`, not a bare object. `isOwnerSlotViolation` reads both, so a
 * fake that dropped the Error part would test a shape the driver never sends.
 */
function uniqueViolation(target: string): Error {
  return Object.assign(new Error(`Unique constraint failed on the fields: (\`${target}\`)`), {
    code: "P2002",
    meta: { target: [target] },
  });
}

function prismaWith(options: { ownersHeld: number; rejectFirstCreate?: Error }) {
  const created: Created[] = [];
  let attempts = 0;

  const prisma = {
    users: {
      findUnique: () => Promise.resolve(null),
      count: ({ where }: { where: { ownerSlot: boolean } }) => {
        expect(where).toEqual({ ownerSlot: true });
        return Promise.resolve(options.ownersHeld);
      },
      create: ({ data }: { data: Created }) => {
        attempts += 1;
        if (attempts === 1 && options.rejectFirstCreate) return Promise.reject(options.rejectFirstCreate);
        created.push(data);
        return Promise.resolve({ ...data, id: "u1", recoveryPassphraseHash: "x" });
      },
    },
  } as unknown as PrismaService;

  return { prisma, created, attemptCount: () => attempts };
}

const redis = {} as unknown as RedisService;

const dto = { email: "someone@example.com", password: "a-long-enough-password" };

describe("addUser and the owner slot", () => {
  it("makes the first account on an install its owner", async () => {
    const { prisma, created } = prismaWith({ ownersHeld: 0 });

    const result = await new UsersService(prisma, redis).addUser(dto);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ role: "OWNER", ownerSlot: true });
    // And the client is told, which is how a deploy is confirmed without a
    // database client.
    expect(result.user.role).toBe("OWNER");
  });

  it("makes an account created while the slot is held a member", async () => {
    const { prisma, created } = prismaWith({ ownersHeld: 1 });

    const result = await new UsersService(prisma, redis).addUser(dto);

    expect(created[0]).toMatchObject({ role: "MEMBER", ownerSlot: null });
    expect(result.user.role).toBe("MEMBER");
  });

  it("demotes the loser of a first-account race rather than failing them", async () => {
    // Both registrations read a free slot; the unique index is what stops the
    // second becoming an owner. They still asked for an account, and the only
    // thing they must not be given is the privilege.
    const { prisma, created, attemptCount } = prismaWith({
      ownersHeld: 0,
      rejectFirstCreate: uniqueViolation("ownerSlot"),
    });

    const result = await new UsersService(prisma, redis).addUser(dto);

    expect(attemptCount()).toBe(2);
    expect(created[0]).toMatchObject({ role: "MEMBER", ownerSlot: null });
    expect(result.user.role).toBe("MEMBER");
  });

  it("still surfaces a duplicate email instead of retrying it as a member", async () => {
    // The other race the pre-check cannot close. Retrying this one would turn
    // a collision into a second account for the same address.
    const { prisma } = prismaWith({
      ownersHeld: 0,
      rejectFirstCreate: uniqueViolation("email"),
    });

    await expect(new UsersService(prisma, redis).addUser(dto)).rejects.toMatchObject({ code: "P2002" });
  });

  it("refuses an email that already exists before deciding any role", async () => {
    const prisma = {
      users: {
        findUnique: () => Promise.resolve({ id: "existing" }),
        count: () => Promise.reject(new Error("must not be asked")),
        create: () => Promise.reject(new Error("must not be called")),
      },
    } as unknown as PrismaService;

    await expect(new UsersService(prisma, redis).addUser(dto)).rejects.toBeInstanceOf(ConflictException);
  });
});
