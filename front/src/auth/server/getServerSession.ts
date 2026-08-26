import { AuthResponseSchema } from "@schemas/auth";
import { cookies, headers } from "next/headers";
import { cache } from "react";

import type { AuthResponse } from "@auth/interfaces/authTypes";

/**
 * The session as the server sees it (TRE-15 §3).
 *
 * Asking the API rather than decoding a cookie is the point: the session lives
 * in Redis and only the API can say whether it is still valid, so a cookie
 * kept after a sign-out elsewhere does not buy a rendered app.
 *
 * `cache` is React's per-request memo. Since TRE-89 only one layout asks per
 * render — the seed moved out of the root layout and into the group layouts,
 * and no route passes through both — so it is a guarantee rather than a saving
 * now: whatever asks second in the same render is free.
 */
export const getServerSession = cache(async (): Promise<AuthResponse | null> => {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  // No cookie is not an error and not worth a round trip — it is simply
  // an anonymous visitor, which every public page is full of.
  if (!cookieHeader) return null;

  const response = await fetch(`${await serverApiBaseUrl()}/api/users/me`, {
    method: "GET",
    cache: "no-store",
    headers: { cookie: cookieHeader },
  });

  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`users/me failed with status ${response.status}`);

  return AuthResponseSchema.parse(await response.json());
});

/**
 * Where this server can reach the API.
 *
 * In production nginx serves both halves from one domain, so the incoming
 * request's own host is the API's host too — which is why the front needs no
 * env file to find it (see next.config.js). In development they are two ports
 * and only the API's is fixed.
 */
async function serverApiBaseUrl(): Promise<string> {
  if (process.env.NODE_ENV !== "production") return "http://localhost:6800";

  const requestHeaders = await headers();
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  if (!host) throw new Error("Unable to build the API base URL: no host header.");

  return `${protocol}://${host}`;
}
