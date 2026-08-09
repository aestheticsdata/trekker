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

## What is not in this repo

The repo is public, so three files that name real infrastructure or hold secrets
are gitignored. Each has a tracked `.example` next to it:

| File | Copy from | Holds |
|---|---|---|
| `deploy.env` | `deploy.env.example` | SSH target, remote root, ports |
| `nest-api/ecosystem.config.js` | `ecosystem.config.example.js` | API env, including secrets |
| `front/ecosystem.config.cjs` | `ecosystem.config.example.cjs` | front PM2 config |

`nest-api/.env` lives **only on the server** and is never uploaded — the deploy
carries the live one forward across releases. It holds the master key.

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

Create the database and its user, then write `/var/www/trekker/nest-api/.env`
from `nest-api/.env.example`. Generate the secrets there, never on a workstation:

```bash
openssl rand -base64 48        # SESSION_SECRET
```

Locally:

```bash
cp deploy.env.example deploy.env                                   # then fill in
cp nest-api/ecosystem.config.example.js nest-api/ecosystem.config.js
cp front/ecosystem.config.example.cjs front/ecosystem.config.cjs
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

Not set up yet. pfa's `db-backup` cron is the model to copy once there is a schema
worth backing up (**TRE-6**).
