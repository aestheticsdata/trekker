# Deploying Trekker

The same shape as its sibling apps: PM2 for the processes, nginx in front, one subdomain,
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
`.env` on the server. Same as the sibling apps.

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

From the fleet's port registry, which is the authoritative source. Register the
two services there before the first deploy; do not pick a port without claiming
it.

| | |
|---|---|
| front | `3005` |
| API | `6800` (block `6800-6899`) |

Both processes bind `127.0.0.1` — nginx is the only public entrance, and the
host firewall must never be the sole thing keeping these ports off the internet.
The API defaults to loopback even with `HOST` unset (TRE-40); keep
`HOST: "127.0.0.1"` in `ecosystem.config.js` anyway, so the file states what the
process does. After a deploy, `ss -ltn` on the server must show both ports on
`127.0.0.1`, never on `*` or `0.0.0.0`.

## First install

Once per machine. Steps 1–4 are on the server, 5–7 on your workstation.

### 1. What has to be on the server already

Nothing in this repo installs these, and each one fails at a different point:

| | Without it |
|---|---|
| Node, pnpm | `❌ ERROR: pnpm not found on the server`, before anything is built |
| PM2 | `❌ ERROR: pm2 not found on the server`, after the release switch |
| MySQL | the deploy reaches `prisma migrate deploy` and stops there |
| Redis | the deploy runs to completion and the API comes up **degraded** |
| nginx, certbot | the deploy succeeds and the subdomain answers nothing |

Redis is the one to check twice. It is the only dependency whose absence used to
let a deploy report success: `REDIS_URL` merely has to be *set* for the API to
boot, and nothing connects to it until a session is used. The deploy now reads
`status` out of `/api/health` rather than just checking it answered, so a missing
Redis fails the deploy — but it fails it at the very last step, after a full
build. Cheaper to install it first.

### 2. The base directory, owned by the deploy user

The scripts create everything under `TREKKER_REMOTE_ROOT` themselves — releases,
backups, deploy logs. What they cannot do is create that root inside a root-owned
`/var/www`, so do that once:

```bash
sudo mkdir -p /var/www/trekker && sudo chown deploy:deploy /var/www/trekker
```

Nothing else needs creating by hand, and in particular **there is no `nest-api`
directory at that level**. The API is deployed to `<root>/api/nest-api`, and
`ecosystem.config.js` lives at `<root>` itself — one level above the directory
that gets swapped, which is what lets it survive a release switch.

### 3. Make PM2 come back after a reboot

Two separate mechanisms, and having only one of them is the usual way to find
this out at the worst possible moment:

- **`pm2 save`** writes the running process list to `~/.pm2/dump.pm2`. Both
  deploy scripts already do this on every run, so it needs no attention.
- **`pm2 startup`** installs a systemd service that starts PM2 itself at boot and
  replays that list. Nothing in this repo does it. Without it, a reboot leaves
  both processes down until someone starts them by hand — `pm2 save` alone does
  not survive a restart.

Run it once, as the deploy user. It prints a `sudo ...` line; run that line:

```bash
pm2 startup
```

Then confirm it took — `enabled` is the answer you want, and `not-found` means
the `sudo` line was printed but never run:

```bash
systemctl is-enabled pm2-$USER
```

### 4. Database

```sql
CREATE DATABASE trekker CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'trekker'@'127.0.0.1' IDENTIFIED BY 'a-generated-password';
GRANT ALL PRIVILEGES ON trekker.* TO 'trekker'@'127.0.0.1';
```

No shadow database here — that is a `migrate dev` concern, and production only
ever runs `migrate deploy`, which needs nothing beyond the app's own schema.

### 5. What has to be on your workstation

`pnpm`, an SSH key that reaches the deploy user without a passphrase prompt, and
**`gitleaks`** — the pre-deploy gate refuses to ship without it rather than
treating a sweep it could not run as a sweep that passed:

```bash
brew install gitleaks
```

### 6. The two untracked config files

```bash
cp deploy.env.example deploy.env && cp nest-api/ecosystem.config.example.js nest-api/ecosystem.config.js
```

`deploy.env` needs the SSH target, the remote root and the two ports. Read its
comments on `TREKKER_REMOTE_PATH` before filling it in — an SSH session that does
not source a profile has neither `pnpm` nor `pm2` on `PATH`, and that variable is
the fix.

`ecosystem.config.js` needs every variable the API reads, `PORT` included;
`env.validation.ts` refuses to boot without them and names the one that is
missing. Two of them are generated rather than chosen, both **on the server**,
then pasted into this file — it is untracked and never committed, and the deploy
copies it up:

```bash
openssl rand -base64 48                                                          # SESSION_SECRET
node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"  # TREKKER_MASTER_KEY
```

`FRONTEND_URL` is the real subdomain, not a placeholder — it is what the API
allows as an origin.

### 7. Deploy, API first

The front's health panel expects the API to answer:

```bash
./nest-api/deploy-api.sh
./front/deploy-front.sh
```

Each ends by checking the half it just shipped actually works. Then set up nginx
below — until it exists, both processes are listening on loopback and nothing
external can reach them.

### 8. The first account

Registration is closed on a deployed instance and stays that way, so the way in
is the script, run on the server:

```bash
ACCOUNT_EMAIL=you@example.com pnpm --filter ./nest-api account:create
```

It prints the password and the recovery passphrase once. It also prints the
role: the **first account on an install owns it** (TRE-48), which means it
browses every path on every host it configures, without a host's roots
allowlist binding it. Every account after it is a `MEMBER` and is bound in
full. The denylist around the master key binds both.

On an install that already had an account before this was introduced, the
migration marks the earliest one as owner. `curl` the API's `/api/users/me`
with a signed-in session to confirm which row it landed on.

## Routine deploy

```bash
./nest-api/deploy-api.sh      # API only
./front/deploy-front.sh       # front only
```

**Both refuse to run with uncommitted changes, and there is no override.**

A deploy sends your files as they are on disk — `rsync` copies the working
folder and skips `.git` — but three things take their commit from `HEAD`: the
release directory name, the changelog on the server, and the deploy report. So
deploying a dirty tree would label all three with a commit whose content is not
what is running, and the version that *is* running would exist nowhere in git.
"What is live?" would then have a confident wrong answer instead of no answer.

Commit first. That is the whole rule.

Each ends by checking the half it just shipped actually works. The front has to
answer `/` with a 200 or a redirect. The API has to report `"status":"ok"` from
`/api/health` — not merely answer it, since that endpoint returns 200 even while
degraded so it can name the dependency that is down instead of collapsing every
failure into a 503. An API that cannot reach MySQL is a running process that
serves no login, no host list and no session, and a green deploy over it is the
failure this prevents.

### The gate

Before a single byte is uploaded, both scripts run five checks and refuse to
ship if any of them fails:

| | |
|---|---|
| `pnpm lint` | biome on the front, eslint on the API |
| `pnpm typecheck` | `tsc --noEmit` on both |
| `pnpm test` | the API's jest suites |
| `pnpm build` | both packages, exactly as the server will build them |
| `pnpm scan:history` | `gitleaks` over **every commit**, not just the tree |

This is where a CI job would normally live. Trekker has no CI and is not getting
one, and for a fleet deployed from a laptop this is the better home anyway: CI
gates what reaches the remote, and what reaches the *server* is this script.

Everything runs locally and before anything touches the box, so a failure always
means nothing was uploaded — never a deploy that had to roll back. The output
names the check and repeats the command to run on its own.

Two things worth knowing:

- **A missing `gitleaks` is a refusal, not a pass.** The repo is public and holds
  SSH credentials, so a sweep that cannot run is not a sweep that succeeded.
  `brew install gitleaks`, or `TREKKER_ALLOW_UNSCANNED=1` if you have just swept
  it another way.
- **Deploying both halves does not run the suite twice.** A pass is recorded in
  `.git/trekker-preflight` against the commit it passed for, and reused for 30
  minutes. Since a deploy requires a clean tree, that commit always identifies
  exactly what was checked.

There is deliberately no flag that skips the whole gate. `rollback` runs none of
it — it ships nothing new, and refusing to restore a known-good release because
a test is red would be the failure mode upside down.

To check the gate still refuses for the right reasons — it breaks each check in
turn and puts the tree back:

```bash
pnpm verify:gate
```

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

Write the server block to `/etc/nginx/sites-available/trekker`, symlink it into
`sites-enabled`, then let certbot add the TLS listener and the redirect:

```bash
sudo ln -s /etc/nginx/sites-available/trekker /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d trekker.example.com
```

`nginx -t` before every reload. A reload of a config that does not parse is
refused and the old one keeps serving, so the damage is not immediate — which is
the problem: the failure looks like your changes having no effect. The bill
arrives at the next restart, when nginx will not come up at all, for every site
on the box rather than this one.

The `location` blocks, inside that server block:

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

## The master key

`TREKKER_MASTER_KEY` decrypts every stored SSH credential. Format is
`<version>:<base64 of 32 bytes>`. Generate it **on the server**:

```bash
node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"
```

The API refuses to boot if it is missing, the wrong length, or still
`REPLACE_ME`, and the error names the variable.

The directory holding it must stay denylisted. Otherwise a signed-in user
browsing the local host reads the key that unlocks every other machine, and the
encryption is decoration. TRE-11's denylist enforces that, and it is the check
that binds every account — the install's owner browses without the roots
allowlist applying to them (TRE-48), so keeping the key merely outside the
configured roots would no longer be enough. An owner who navigates there is
told why the path refuses instead of getting the uniform refusal.

**What this protects against is database disclosure, not host compromise.**
Anyone who owns the API host reads the key out of the process environment and
it is over. That is the accepted limit, not an oversight.

### File modes

Two files hold the key in clear, and both must be `600`:

| File | Written by |
| --- | --- |
| `$TREKKER_REMOTE_ROOT/ecosystem.config.js` | `deploy-api.sh`, through a private temp file and an atomic `mv` |
| `~/.pm2/dump.pm2` | `pm2 save`, then chmodded by both deploy scripts |

`deploy-api.sh` fails the deploy if the config is anything but `600`, so finding
either at `644` means a regression rather than a choice (TRE-54).

The dump is the one to remember: `pm2 save` writes it with the PM2 daemon's
umask, not the deploy shell's, so it cannot be fixed by setting `umask` before
the call — and **every** deploy on this box rewrites it, the front's included,
because all the processes share one dump. That is why the chmod sits in both
scripts rather than only in the API's.

This is defence in depth against another unprivileged account on the machine,
not against the host compromise the paragraph above already concedes.

### Rotation

No downtime. Both keys are live during the rotation, and the version travels
inside each key string so the pair cannot go out of step.

1. Generate the new key with the **next** version number:

   ```bash
   node -e "console.log('2:' + require('crypto').randomBytes(32).toString('base64'))"
   ```

2. In `ecosystem.config.js`, move the current value to
   `TREKKER_MASTER_KEY_PREVIOUS` and put the new one in `TREKKER_MASTER_KEY`.
   Reload so the API can read both:

   ```bash
   pm2 reload trekker-api --update-env
   ```

3. Re-encrypt every row. `--dry-run` first if you want to see the count:

   ```bash
   pnpm rotate-key
   ```

   One transaction per row, and rows already at the new version are skipped —
   an interrupted run is finished by running it again.

4. Remove `TREKKER_MASTER_KEY_PREVIOUS` and reload again. Any row still on the
   old version now fails to decrypt with a message saying exactly that, so a
   missed row is loud rather than silent.

Local sanity check of the whole envelope, no database needed:

```bash
pnpm --filter ./nest-api verify:secrets
```

## Database backup

Not set up yet, and now overdue — there is a schema as of TRE-6. A sibling app's
`db-backup` cron is the model to copy. Worth doing before the first migration
that drops or rewrites a column.
