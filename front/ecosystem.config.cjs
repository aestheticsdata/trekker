/**
 * PM2 process definition for the Trekker front.
 *
 * Committed, no secrets, nothing to fill in. It ships with the release like
 * any other source file.
 *
 * The front needs no runtime configuration: NEXT_PUBLIC_* values are baked in
 * at build time, and the deploy carries `.env.production` forward from the
 * live release before building.
 *
 * Bound to 127.0.0.1 — nginx is the only thing that should reach it.
 */
module.exports = {
  apps: [
    {
      name: "trekker-front",
      cwd: __dirname,
      script: "./node_modules/next/dist/bin/next",
      // From the Zeus port registry: 3005.
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
