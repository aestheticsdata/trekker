// Prisma CLI configuration. The app never reads this — at runtime the
// connection comes from PrismaService's driver adapter. This is only how
// `prisma migrate` and `prisma db` find the schema and the database.
import { defineConfig } from "prisma/config";
import { loadEnv } from "./src/config/load-env";

// No dotenv: configuration lives in ecosystem.config.js, in dev as in prod.
loadEnv();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL,
    // Development only — `migrate dev` replays the migration history into this
    // scratch database. Absent in production, where `migrate deploy` neither
    // replays nor diffs.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
