import { getServerSession } from "@auth/server/getServerSession";
import { redirect } from "next/navigation";

/**
 * Nothing private renders without a session (TRE-15 §3).
 *
 * The check is here rather than in a client effect so an unauthenticated
 * visitor never receives the app's markup at all — and so a signed-in reload
 * goes straight to the explorer instead of flashing the login screen on its
 * way there.
 */
export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  return <>{children}</>;
}
