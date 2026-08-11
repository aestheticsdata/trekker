import type { AuthResponseSchema, AuthUserSchema, RegisterResponseSchema } from "@schemas/auth";
import type { z } from "zod";

// Inferred from the zod schemas so the runtime contract and the compile-time
// one can never drift apart. This stays the import site for the rest of the app
// (@auth/interfaces/authTypes); the schemas live with the other API schemas.
export type AuthUser = z.infer<typeof AuthUserSchema>;
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;
