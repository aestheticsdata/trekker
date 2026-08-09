# Deploying Trekker

Same shape as pfa and bkmk: PM2 for the processes, nginx in front, one subdomain,
one deploy script per side. Each deploy rsyncs into a fresh release directory,
builds on the server, switches atomically while keeping the previous version as a
backup, reloads PM2, and rolls back on its own if anything fails after the switch.

> **Before anything else.** Trekker holds SSH credentials and knows the address of
> every machine you manage. An authenticated session is shell-adjacent access to
> all of them. Keep registration closed, keep it behind the reverse proxy, and
> consider restricting it by IP or VPN. Do not put it on the open internet because
> it happens to have a login form.

## Where configuration lives

**In production: `nest-api/ecosystem.config.js`, and nothing else.** There is no
`.env` on the server. Same as pfa and bkmk.

| File | Tracked? | Contents |
|---|---|---|
| `nest-api/ecosystem.config.js` | no | every variable the API reads, secrets included |
| `deploy.env` | no | SSH host, remote root, ports |
| `front/ecosystem.config.cjs` | **yes** | front process definition — holds nothing secret |

Both untracked files have a `.example` beside them. Copy and fill in:

```bash
cp deploy.env.example deploy.env
cp nest-api/ecosystem.config.example.js nest-api/ecosystem.config.js
```

Two things follow from PM2 owning the environment. `pm2 save` copies the
resolved values into `~/.pm2/dump.pm2`, so that file deserves a `chmod 600`.
And `prisma migrate deploy` runs from the deploy script, outside PM2, so it
cannot inherit them — rather than keep a second copy of `DATABASE_URL` in a
`.env` beside it, `deploy-api.sh` reads the value back out of
`ecosystem.config.js` with `node -e` and exports it for that one command. One
place each value is written down.

`SHADOW_DATABASE_URL` never appears in production. It exists only for
`prisma migrate dev`, which needs a scratch database to replay migrations in.
`migrate deploy` does no replay and no diffing.

### Development

The same file, its `env_development` block. `pnpm dev` runs Nest directly
rather than under PM2, so `src/config/load-env.ts` reads the block and puts it
into `process.env` before Nest boots — as do `prisma migrate dev`, `pnpm seed`
and `pnpm test:db`. **This project has no `.env` files at all**, on either side.

## Ports

From the Zeus port registry, which is the authoritative source. Register the two
services there before the first deploy; do not pick a port without claiming it.

| | |
|---|---|
| front | `3005` |
| API | `6800` (block `6800-6899`) |

## First install

On the server, as the deploy user:

```bash
mkdir -p /var/www/trekker/nest-api
```

Create the database and its user:

```sql
CREATE DATABASE trekker CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'trekker'@'127.0.0.1' IDENTIFIED BY 'a-generated-password';
GRANT ALL PRIVILEGES ON trekker.* TO 'trekker'@'127.0.0.1';
```

No shadow database here — that is a `migrate dev` concern, and production only
ever runs `migrate deploy`, which needs nothing beyond the app's own schema.

Locally, fill in the two untracked files:

```bash
cp deploy.env.example deploy.env && cp nest-api/ecosystem.config.example.js nest-api/ecosystem.config.js
```

`ecosystem.config.js` needs every variable the API requires, `PORT` included —
`env.validation.ts` refuses to boot without them and names the one that is
missing. Generate the secrets on the server, never on a workstation:

```bash
openssl rand -base64 48        # SESSION_SECRET
```

Then deploy the API first — the front's health panel expects it to answer:

```bash
./nest-api/deploy-api.sh
./front/deploy-front.sh
```

Finally `pm2 save` so both come back after a reboot (the scripts already do this,
it is listed here for the manual case).

## Routine deploy

```bash
./nest-api/deploy-api.sh      # API only
./front/deploy-front.sh       # front only
```

Each refuses to run on a dirty working tree — the deploy changelog is only
meaningful if `HEAD` is a real commit. Override with `TREKKER_ALLOW_DIRTY=1` when
you genuinely mean it.

Each ends by checking the thing it just shipped actually answers: the API on
`/api/health`, the front on `/`. A deploy that reports success while the service
is down is the failure this prevents.

### Migrations

`deploy-api.sh` runs `prisma migrate deploy` after the build and before PM2
serves the new code, so the schema is never behind the code that expects it.
`migrate deploy` applies only what is committed — it never generates, never
resets and never prompts.

MySQL DDL is not transactional. A migration that fails halfway leaves the
database part-applied, and the script's rollback restores the *code* but cannot
undo that. If a deploy fails during this step:

```bash
pnpm exec prisma migrate status      # in /var/www/trekker/nest-api
```

and finish or revert the migration by hand before deploying again.

## Rollback

```bash
./nest-api/deploy-api.sh rollback
./front/deploy-front.sh rollback
```

Restores the `.bak` directory kept by the previous deploy and reloads PM2. Only
one level deep — older releases are under `*-releases/` and are restored by hand.

## nginx

One subdomain, TLS through the existing certbot setup, `/api/` to the API and
everything else to the front.

```nginx
location / {
    proxy_pass http://127.0.0.1:3005;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /api/ {
    proxy_pass http://127.0.0.1:6800;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Transfers and downloads outlive the default 60s by a wide margin.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_max_body_size 0;
}

# Server-sent events: transfer progress, live tail, the activity strip.
# Without proxy_buffering off these arrive in multi-second bursts and the UI
# looks broken (TRE-23, TRE-34).
location ~ ^/api/(transfers/stream|fs/tail|activity/stream) {
    proxy_pass http://127.0.0.1:6800;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
}
```

The SSE block must come before the general `/api/` one, or `/api/` wins.

## Master key rotation

Not implemented yet — it arrives with the secret store in **TRE-8**, along with
the `keyVersion` column that makes it possible. The procedure will live here.

## Database backup

Not set up yet, and now overdue — there is a schema as of TRE-6. pfa's
`db-backup` cron is the model to copy. Worth doing before the first migration
that drops or rewrites a column.
