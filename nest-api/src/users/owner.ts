/**
 * Who owns the install (TRE-48).
 *
 * Trekker scopes every path to a host's roots allowlist (TRE-11) and stops an
 * account that keeps hitting the edge of it (TRE-30). Both were written for an
 * account someone else might be holding. The person who deployed the server is
 * not that account: refusing them a directory on their own machine protects
 * nothing, and the roots they set for themselves were never a boundary — they
 * can widen them from the host form at any time.
 *
 * So the role decides which of those two the guard applies, and nothing else.
 * It is not a permission system: a MEMBER is not "an account with fewer
 * rights", it is the ordinary account this application has always assumed, and
 * the restricted accounts a later ticket adds land on it already bound.
 *
 * No imports on purpose — `src/` reaches this as `@users/owner`, and
 * `scripts/` and `prisma/seed.ts` reach it as `../src/users/owner` without
 * pulling Nest in behind it.
 */

export type UserRole = "OWNER" | "MEMBER";

/**
 * The two columns a role is carried by, always written together.
 *
 * `ownerSlot` is the unique index that makes a second owner impossible; it
 * only means anything paired with `role`, so nothing sets one without the
 * other and this is the only function that knows the pairing.
 */
export function roleFields(role: UserRole): { role: UserRole; ownerSlot: true | null } {
  return { role, ownerSlot: role === "OWNER" ? true : null };
}

/**
 * An account claims the owner slot when nothing holds it, and is a member
 * otherwise — so the first account on an install owns it.
 *
 * Decided as the account is created, not by a rule evaluated later. "There is
 * only one account, so it must be the owner" would be true today and would
 * revoke itself the moment a second account existed — in the very commit that
 * introduces restricted accounts, which is the commit that can least afford
 * the owner to quietly lose their access.
 *
 * The question is whether the slot is free rather than whether the table is
 * empty, and the difference is the install that lost its owner: a database
 * with three members and nobody holding the slot is an install nobody can
 * fully administer, and asking about the table would leave it that way
 * permanently. It is reachable by deleting the owner's row by hand, and by
 * `pnpm seed` on a box where the developer has their own account. That an
 * account created afterwards claims the slot is the repair, not a hole —
 * registration is closed by default, and every path that creates an account
 * on a healthy install still produces a member.
 */
export async function roleForNewAccount(users: {
  count: (args?: { where: { ownerSlot: boolean } }) => Promise<number>;
}): Promise<UserRole> {
  return (await users.count({ where: { ownerSlot: true } })) === 0 ? "OWNER" : "MEMBER";
}

/**
 * Whether a Prisma failure is the owner slot colliding.
 *
 * `roleForNewAccount` counts and then creates, which two concurrent
 * registrations can both do from zero. The unique index is what turns that race
 * into this error instead of a second owner, and this function is where that
 * coupling is written down: remove the index because "role already says who the
 * owner is" and the race comes back silently.
 *
 * Reads `meta.target` the same three ways `violatedTarget` does in
 * hosts.service.ts — an array on some connectors, a string on others, and on
 * MySQL sometimes only in the message.
 */
export function isOwnerSlotViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: string }).code !== "P2002") return false;

  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const named = Array.isArray(target)
    ? target.join(",")
    : typeof target === "string"
      ? target
      : String((error as { message?: string }).message ?? "");

  return named.includes("ownerSlot");
}
