import { apiRequest } from "@lib/api/client";
import { AuthResponseSchema, RegisterResponseSchema, SignupStatusSchema } from "@schemas/auth";
import { StoredLayoutSchema } from "@schemas/layout";

import type { AuthResponse, RegisterResponse } from "@auth/interfaces/authTypes";
import type { StoredLayout } from "@schemas/layout";

/** Everything TRE-7 exposes, parsed on the way in. */

export async function signIn(email: string, password: string): Promise<AuthResponse> {
  return AuthResponseSchema.parse(await apiRequest("/users", { method: "POST", body: { email, password } }));
}

export async function register(email: string, password: string, passphrase: string): Promise<RegisterResponse> {
  return RegisterResponseSchema.parse(
    await apiRequest("/users/add", { method: "POST", body: { email, password, passphrase } }),
  );
}

export async function recover(email: string, passphrase: string, newPassword: string): Promise<void> {
  await apiRequest("/users/recover", { method: "POST", body: { email, passphrase, newPassword } });
}

export async function logout(csrfToken: string | null): Promise<void> {
  await apiRequest("/users/logout", { method: "POST", csrfToken });
}

/**
 * The layout this account last had open (TRE-51), or null when it has never
 * had one.
 *
 * Parsed, not cast: it is a Json column the browser wrote, so a stale shape
 * from an older build is the ordinary case rather than the exceptional one.
 * `safeParse` turns that into "no layout" — a cold open on the defaults, which
 * is exactly what the account saw before this existed.
 */
export async function fetchLastLayout(): Promise<StoredLayout | null> {
  const payload = await apiRequest("/users/layout");
  const parsed = StoredLayoutSchema.safeParse((payload as { layout?: unknown } | null)?.layout ?? null);
  return parsed.success ? parsed.data : null;
}

export async function saveLastLayout(layout: StoredLayout, csrfToken: string | null): Promise<void> {
  await apiRequest("/users/layout", { method: "PUT", body: layout, csrfToken });
}

export async function fetchSignupStatus(): Promise<boolean> {
  const status = SignupStatusSchema.parse(await apiRequest("/users/signup-status"));
  return status.open;
}
