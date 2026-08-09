/**
 * PM2 config for the Trekker front.
 *
 * Copy to `ecosystem.config.cjs` and adjust. That file is NOT committed, for
 * consistency with the API side — nothing naming real infrastructure belongs in
 * a public repo, even when it holds no secret.
 *
 * Bound to 127.0.0.1: nginx is the only thing that should reach it.
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
        PORT: "3005",
        HOST: "127.0.0.1",
      },
    },
  ],
};
