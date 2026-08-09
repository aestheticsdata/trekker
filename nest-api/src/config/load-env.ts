import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Puts `ecosystem.config.js`'s `env_development` block into process.env.
 *
 * There is no .env in this project. PM2 reads the same file's
 * `env_production` on the server; locally nothing reads a PM2 config on its
 * own, so this does it — for `pnpm dev`, `prisma migrate dev`, `pnpm seed` and
 * `pnpm test:db` alike. One file, both environments.
 *
 * Must run before anything imports AppModule: env.validation checks the
 * environment while the module is being constructed, not when it boots.
 */
export function loadEnv(): void {
  // In production PM2 has already supplied everything, and the config file
  // lives above the app directory rather than in it.
  if (process.env.NODE_ENV === "production") return;

  const configPath = join(process.cwd(), "ecosystem.config.js");
  if (!existsSync(configPath)) {
    throw new Error(
      `No ${configPath}. Copy nest-api/ecosystem.config.example.js to ` +
        "nest-api/ecosystem.config.js and fill it in — it is not committed.",
    );
  }

  // Loaded at call time rather than imported: the file is gitignored, so it
  // does not exist in a fresh clone and must not be a build-time dependency.
  // createRequire keeps this working whether the caller is CommonJS (Nest,
  // ts-jest) or ESM (the Prisma CLI loading prisma.config.ts).
  const config = createRequire(configPath)(configPath) as {
    apps?: Array<{ env?: Record<string, unknown>; env_development?: Record<string, unknown> }>;
  };

  const app = config.apps?.[0];
  if (!app) throw new Error(`${configPath} defines no apps.`);

  // Anything already in the environment wins, so `PORT=1234 pnpm dev` and CI
  // variables still override the file.
  for (const [key, value] of Object.entries({ ...app.env, ...app.env_development })) {
    if (process.env[key] === undefined) process.env[key] = String(value);
  }
}
