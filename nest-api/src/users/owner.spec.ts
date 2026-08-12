import { isOwnerSlotViolation, roleFields, roleForNewAccount } from "@users/owner";

/**
 * TRE-48. Pure — no database, so it runs in `pnpm test` and therefore inside
 * the pre-deploy gate rather than only where MySQL happens to be up.
 */

describe("roleForNewAccount", () => {
  it("claims the slot when nothing holds it, which is the first account on an install", async () => {
    await expect(roleForNewAccount({ count: () => Promise.resolve(0) })).resolves.toBe("OWNER");
  });

  it("makes every account after it a member", async () => {
    await expect(roleForNewAccount({ count: () => Promise.resolve(1) })).resolves.toBe("MEMBER");
  });

  it("asks whether the slot is free, not whether the table is empty", async () => {
    // The difference is an install that lost its owner — three accounts and
    // nobody holding the slot. Counting rows would leave it ownerless
    // permanently; counting the slot repairs it on the next account created.
    const seen: unknown[] = [];
    await roleForNewAccount({
      count: (args) => {
        seen.push(args);
        return Promise.resolve(0);
      },
    });
    expect(seen).toEqual([{ where: { ownerSlot: true } }]);
  });
});

describe("roleFields", () => {
  // The only statement in code of what the two columns mean together: the slot
  // is the unique index that makes a second owner impossible, and it is null
  // for a member precisely so that every member is distinct to that index.
  it("claims the owner slot for an owner and leaves it null for a member", () => {
    expect(roleFields("OWNER")).toEqual({ role: "OWNER", ownerSlot: true });
    expect(roleFields("MEMBER")).toEqual({ role: "MEMBER", ownerSlot: null });
  });
});

describe("isOwnerSlotViolation", () => {
  it("recognises the slot collision however the connector reports the target", () => {
    expect(isOwnerSlotViolation({ code: "P2002", meta: { target: ["ownerSlot"] } })).toBe(true);
    expect(isOwnerSlotViolation({ code: "P2002", meta: { target: "Users_ownerSlot_key" } })).toBe(true);
    expect(isOwnerSlotViolation({ code: "P2002", message: "Unique constraint failed on ownerSlot" })).toBe(true);
  });

  it("leaves every other failure alone", () => {
    // The one that matters: a duplicate email is a race the caller must still
    // surface, not retry as a demoted account.
    expect(isOwnerSlotViolation({ code: "P2002", meta: { target: ["email"] } })).toBe(false);
    expect(isOwnerSlotViolation(new Error("connection lost"))).toBe(false);
    expect(isOwnerSlotViolation(null)).toBe(false);
  });
});
