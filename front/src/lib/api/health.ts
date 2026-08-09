import { z } from "zod";

// Development runs the front on 3005 and the API on 6800. In production nginx
// puts both behind one domain, so /api/ is same-origin and a bare relative URL
// is correct. Next inlines NODE_ENV at build time, so there is nothing to
// configure and no env file on this side.
const API_ORIGIN = process.env.NODE_ENV === "production" ? "" : "http://localhost:6800";

export const healthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  uptimeSeconds: z.number(),
  dependencies: z.object({
    mysql: z.enum(["up", "down"]),
    redis: z.enum(["up", "down"]),
  }),
});

export type Health = z.infer<typeof healthSchema>;

export async function fetchHealth(): Promise<Health> {
  const response = await fetch(`${API_ORIGIN}/api/health`, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`API health check failed with ${response.status}`);
  }
  // Parsed rather than cast: the one place the API contract is checked at
  // runtime, and the pattern every later endpoint follows.
  return healthSchema.parse(await response.json());
}
