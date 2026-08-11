import { apiRequest } from "@lib/api/client";
import { AuthResponseSchema, RegisterResponseSchema, SignupStatusSchema } from "@schemas/auth";

import type { AuthResponse, RegisterResponse } from "@auth/interfaces/authTypes";

/** Everything TRE-7 exposes, parsed on the way in. */

export async function signIn(email: string, password: string): Promise<AuthResponse> {
  return AuthResponseSchema.parse(await apiRequest("/users", { method: "POST", body: { email, password } }));
}

export async function register(email: string, password: string): Promise<RegisterResponse> {
  // The recovery passphrase is in this response and in no other, ever.
  return RegisterResponseSchema.parse(await apiRequest("/users/add", { method: "POST", body: { email, password } }));
}

export async function recover(email: string, passphrase: string, newPassword: string): Promise<void> {
  await apiRequest("/users/recover", { method: "POST", body: { email, passphrase, newPassword } });
}

export async function logout(csrfToken: string | null): Promise<void> {
  await apiRequest("/users/logout", { method: "POST", csrfToken });
}

export async function fetchSignupStatus(): Promise<boolean> {
  const status = SignupStatusSchema.parse(await apiRequest("/users/signup-status"));
  return status.open;
}
