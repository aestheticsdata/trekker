/**
 * Trekker API configuration — the only config file. There is no .env, in
 * either environment.
 *
 * Copy to `ecosystem.config.js` and fill in. That file is NOT committed: it
 * holds secrets and this repo is public.
 *
 * PM2 reads `env_production` on the server. Locally nothing reads a PM2 config
 * on its own, so `src/config/load-env.ts` puts `env_development` into
 * process.env before Nest boots — `pnpm dev`, `prisma migrate dev`, `pnpm seed`
 * and `pnpm test:db` all take their configuration from right here. One file,
 * both environments.
 *
 * The deploy script also reads DATABASE_URL back out of the copied file for
 * the migration step, so there is exactly one place each value is written down.
 *
 * Note that `pm2 save` copies the resolved environment into ~/.pm2/dump.pm2.
 * Worth a `chmod 600` on it.
 */
const { join } = require("node:path");

// ---- local development -----------------------------------------------------
const devEnv = {
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: 6800,

  DATABASE_URL: "mysql://trekker:REPLACE_ME@127.0.0.1:3306/trekker",

  // Scratch database for `prisma migrate dev`: it replays the migration
  // history into an empty database to work out the next migration and to spot
  // drift. It gets wiped on every run, which is why it cannot be `trekker`.
  SHADOW_DATABASE_URL: "mysql://trekker:REPLACE_ME@127.0.0.1:3306/trekker_shadow",

  REDIS_URL: "redis://127.0.0.1:6379",
  FRONTEND_URL: "http://localhost:3005",

  // Padded past 32 chars: env.validation rejects anything shorter and the API
  // would not boot. Local only, so it does not need to be random.
  SESSION_SECRET: "local-dev-only-not-secret-padded-to-32-chars",
  SIGNUPS_ENABLED: "true",

  // Decrypts every stored SSH credential (TRE-8). "<version>:<base64 32 bytes>".
  // Throwaway, local only — generate with:
  //   node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"
  TREKKER_MASTER_KEY: "REPLACE_ME",
  // Set only during a rotation, to the key being retired. See DEPLOY.md.
  // TREKKER_MASTER_KEY_PREVIOUS: "",

  // Optional. Password for the account `pnpm seed` creates. Left unset, the
  // seed generates one and prints it.
  // SEED_PASSWORD: "",
};

// ---- production, on the server ---------------------------------------------
const prodEnv = {
  NODE_ENV: "production",

  // Loopback only — nginx is the single public entrance. Node with no bind
  // host listens on every interface, leaving the host firewall as the only
  // thing between an SSH gateway and the internet (TRE-40).
  HOST: "127.0.0.1",

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

  // Decrypts every stored SSH credential (TRE-8). Generate ON THE SERVER:
  //   node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"
  // It must sit outside every path Trekker is allowed to browse (TRE-11),
  // otherwise a signed-in user browsing the local host reads the key that
  // unlocks every other machine.
  TREKKER_MASTER_KEY: "REPLACE_ME",
  // Set only during a rotation, to the key being retired. See DEPLOY.md.
  // TREKKER_MASTER_KEY_PREVIOUS: "",

  // SHADOW_DATABASE_URL does NOT belong here. It exists only for
  // `prisma migrate dev`, which needs a scratch database to replay migrations
  // in. Production runs `migrate deploy`, which does no replay and no diffing.
  // Setting it here would mean a second, writable database on the server that
  // nothing ever reads.

  // Added by later tickets:
  //   TREKKER_DOWNLOAD_LINK_KEY  TRE-26 — signs expiring download links.
};

module.exports = {
  apps: [
    {
      name: "trekker-api",
      // This file sits at the remote root; the deployed unit below it is the
      // whole pnpm workspace (the lockfile lives at its root), so the API
      // package is one level further down: <root>/api/nest-api. Keeping the
      // config outside `api/` is what lets it survive the release swap.
      cwd: join(__dirname, "api", "nest-api"),
      // dist/src, not dist: the Prisma client is generated to ../generated, so
      // tsc's root covers the whole package and the layout is mirrored.
      script: "dist/src/main.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      env_development: devEnv,
      env_production: prodEnv,
    },
  ],
};
