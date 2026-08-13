import { LOGIN_PATH } from "@auth/paths";
import { getServerSession } from "@auth/server/getServerSession";
import { SessionExpiry } from "@auth/session-expiry";
import { redirect } from "next/navigation";

/**
 * Nothing private renders without a session (TRE-15 §3).
 *
 * The check is here rather than in a client effect so an unauthenticated
 * visitor never receives the app's markup at all — and so a signed-in reload
 * goes straight to the explorer instead of flashing the login screen on its
 * way there.
 *
 * It answers for this render and no other, which is the whole reason
 * `SessionExpiry` sits beside it: the session can end at any point during the
 * hours that follow, and only the browser is still asking by then (TRE-63).
 */
export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect(LOGIN_PATH);

  return (
    <>
      <SessionExpiry />
      {children}
    </>
  );
}
