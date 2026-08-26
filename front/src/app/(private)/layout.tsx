import { LOGIN_PATH } from "@auth/paths";
import { getServerSession } from "@auth/server/getServerSession";
import { redirect } from "next/navigation";

/**
 * Nothing private renders without a session (TRE-15 §3).
 *
 * The check is here rather than in a client effect so an unauthenticated
 * visitor never receives the app's markup at all — and so a signed-in reload
 * goes straight to the explorer instead of flashing the login screen on its
 * way there.
 *
 * It answers for this render and no other. The hours that follow belong to the
 * browser, and a session that ends in one is caught by `redirectToLogin` in
 * `lib/api/client.ts` — whose navigation is a hard one, which brings the next
 * request back through here (TRE-88).
 */
export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect(LOGIN_PATH);

  return children;
}
