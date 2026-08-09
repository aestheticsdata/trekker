/**
 * PM2 config for the Trekker API.
 *
 * Copy to `ecosystem.config.js` and fill in. That file is NOT committed —
 * it holds production secrets, and this repo is public.
 *
 * The deploy script scp's it to the remote root, so `cwd` below points at the
 * live API directory, not at wherever this file sits locally.
 */
const prodConfig = {
  // Same variables env.validation.ts requires. Boot fails if one is missing.
  DATABASE_URL: "mysql://trekker:REPLACE_ME@127.0.0.1:3306/trekker",
  REDIS_URL: "redis://127.0.0.1:6379",
  FRONTEND_URL: "https://trekker.example.com",

  // openssl rand -base64 48
  SESSION_SECRET: "REPLACE_ME",

  // Registration is closed by default. An open sign-up on an app that stores
  // SSH keys is not a feature (TRE-7).
  SIGNUPS_ENABLED: "false",

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
      cwd: "/var/www/trekker/nest-api",
      script: "dist/main.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      env_production: {
        NODE_ENV: "production",
        // From the Zeus port registry: block 6800-6899.
        PORT: 6800,
        ...prodConfig,
      },
    },
  ],
};
