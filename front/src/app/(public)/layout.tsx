import { AuthProvider } from "@auth/context/AuthContext";

/**
 * A provider, and no session lookup (TRE-89).
 *
 * It is not decoration: `/login` and `/signup` call `setCredentials`, which
 * writes into this context through `setAuthState` and would throw outside a
 * provider. But nothing under here ever *reads* `user` or `csrfToken` — the
 * three screens are forms and the about page is prose — so there is nothing to
 * seed it with and no reason to ask.
 *
 * That is the whole of the change. The screen an operator reaches for when the
 * API is down has no dependency on the API at all now, rather than having one
 * whose failure is swallowed. The seed arrives on the way out of here:
 * `setCredentials` navigates to the explorer, and that layout asks for itself.
 *
 * A sibling app does ask here and swallows the failure, seeding the provider
 * from whatever comes back. Worth doing the day a public screen needs to know
 * who is signed in; until then it is a round trip whose answer is discarded.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
