/**
 * PM2 process definition for the Trekker front.
 *
 * Committed, no secrets, nothing to fill in. It ships with the release like
 * any other source file.
 *
 * The front needs no runtime configuration and no env file: behind nginx the
 * API is same-origin under /api/, so there is nothing to point it at, and no
 * NEXT_PUBLIC_* value exists to bake in (see next.config.js).
 *
 * Bound to 127.0.0.1 — nginx is the only thing that should reach it.
 */
module.exports = {
  apps: [
    {
      name: "trekker-front",
      cwd: __dirname,
      script: "./node_modules/next/dist/bin/next",
      // From the fleet's port registry: 3005.
      args: "start -p 3005 -H 127.0.0.1",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
