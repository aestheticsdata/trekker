/**
 * PM2 config for the Trekker API — production configuration lives here.
 *
 * Copy to `ecosystem.config.js` and fill in. That file is NOT committed: it
 * holds secrets and this repo is public.
 *
 * There is no `.env` on the server. Everything the API reads is below, and the
 * deploy script reads DATABASE_URL back out of this same file for the
 * migration step, so there is exactly one place each value is written down.
 *
 * Development is the other way round: `pnpm dev` does not go through PM2, so
 * locally the same variables live in `nest-api/.env`. One source per
 * environment, never two in the same one.
 *
 * Note that `pm2 save` copies the resolved environment into ~/.pm2/dump.pm2.
 * Worth a `chmod 600` on it.
 */
const { join } = require("node:path");

const prodEnv = {
  NODE_ENV: "production",

  // From the Zeus port registry: block 6800-6899.
  PORT: 6800,

  DATABASE_URL: "mysql://trekker:REPLACE_ME@127.0.0.1:3306/trekker",
  REDIS_URL: "redis://127.0.0.1:6379",
  FRONTEND_URL: "https://trekker.example.com",

  // openssl rand -base64 48
  SESSION_SECRET: "REPLACE_ME",

  // Registration is closed by default. An open sign-up on an app that stores
  // SSH keys is not a feature (TRE-7).
  SIGNUPS_ENABLED: "false",

  // SHADOW_DATABASE_URL does NOT belong here. It exists only for
  // `prisma migrate dev`, which needs a scratch database to replay migrations
  // in. Production runs `migrate deploy`, which does no replay and no diffing.
  // Setting it here would mean a second, writable database on the server that
  // nothing ever reads.

  // Added by later tickets:
  //   TREKKER_MASTER_KEY         TRE-8  — decrypts every stored SSH credential.
  //     Do NOT put it here if the API's own directory is browsable. Prefer a
  //     file outside every allowed root, or a systemd credential (TRE-11).
  //   TREKKER_DOWNLOAD_LINK_KEY  TRE-26 — signs expiring download links.
};

module.exports = {
  apps: [
    {
      name: "trekker-api",
      // This file lives one level above the app. `nest-api/` is replaced
      // wholesale on every deploy, so a PM2 config inside it would be swapped
      // out from under the running process.
      cwd: join(__dirname, "nest-api"),
      // dist/src, not dist: the Prisma client is generated to ../generated, so
      // tsc's root covers the whole package and the layout is mirrored.
      script: "dist/src/main.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      env_production: prodEnv,
    },
  ],
};
