# Trekker

A file explorer for the servers you actually run — dual panes across hosts, transfers with
per-file conflict resolution, permissions, and disk pressure at a glance.

Trekker reaches a host either as the machine it runs on or over SSH, behind one `HostDriver`
interface. There is nothing to install on the servers you browse: any Linux with `sshd` works,
and the machine hosting Trekker is just another entry with a different driver.

> **Status: early.** The skeleton and the schema are in place (TRE-4, TRE-6). Hosts, browsing and
> every operation are still ahead — see `docs/superpowers/specs/2026-08-09-trekker-design.md`.

## Before you run this

Trekker holds SSH credentials and knows the address of every machine you manage. Two things
follow from that:

- **Generate your own secrets.** Every value in `ecosystem.config.example.js` is a placeholder.
  The real `ecosystem.config.js` is never committed, and the master key that encrypts stored
  credentials must live outside every path Trekker is allowed to browse.
- **Do not expose it to the public internet** without a reverse proxy in front, registration
  closed, and ideally an IP or VPN restriction. An authenticated Trekker session is shell-adjacent
  access to every host it knows.

The master key is yours to generate and is never derived from anything in this repo — 32 bytes of
randomness, into `TREKKER_MASTER_KEY`, kept outside every root a host is allowed to browse. The
version travels with the key as `<version>:<base64>`, so the two cannot be set inconsistently,
which is the commonest way a rotation goes wrong:

```bash
node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"
```

Losing it makes every stored credential unrecoverable, which is the intended failure mode.

### Contributing to a public repo about SSH credentials

This repo is public and it is about holding the keys to machines. Nothing environment-specific
ever gets committed: no hostnames, IPs, usernames, absolute paths from real machines, host key
fingerprints or key material. Placeholders instead — `host.example.com`, `deploy`, `/srv/app`,
`127.0.0.1`.

```bash
pnpm hooks:install
```

That points `core.hooksPath` at `.githooks/`, which refuses both a diff and a **commit message**
carrying any of the above. Hooks are not cloned, so it is one command per checkout; CI runs
`gitleaks` over the full history on every push regardless, and that is the actual guarantee.
`pnpm scan` runs the same check locally if you have gitleaks installed — it walks the working tree
rather than the index, so it also reports your own `deploy.env` and `ecosystem.config.js`. That is
the point of it and not a failure: those files hold real secrets, and the check that matters is
that they are never tracked. `pnpm scan:history` is the one that mirrors CI.

The hooks exist because the leak this repo actually had was not a key. It was a real `user@host`
pair sitting in a comment — inside a sentence explaining that publishing such a pair is free
reconnaissance. Entropy-based scanners do not catch prose, so `.gitleaks.toml` adds rules that
match the *shape* of infrastructure and allowlist the placeholders.

The same pair reached four commit messages, which is the quieter half of the problem: a message is
not a blob, so `gitleaks git` walks past it in every mode, and a pre-commit hook only ever sees the
diff. Hence `commit-msg` alongside `pre-commit`, sharing one set of patterns. Both had to be fixed
by rewriting published history, which is the cost this is here to avoid paying twice.

## Stack

| | |
|---|---|
| `front/` | Next 16 · React 19 · Tailwind v4 · TanStack Query · nuqs · Zod · Biome |
| `nest-api/` | NestJS 11 · Prisma 7 · MySQL · Redis · ssh2 |

## Running it

Requires Node 24, pnpm 11, and a reachable MySQL and Redis.

```bash
pnpm install
cp nest-api/ecosystem.config.example.js nest-api/ecosystem.config.js
```

**There are no `.env` files.** Configuration lives in `nest-api/ecosystem.config.js`: PM2 reads
its `env_production` on the server, and `src/config/load-env.ts` reads `env_development` locally,
so `pnpm dev`, `prisma migrate dev`, `pnpm seed` and `pnpm test:db` all draw from the same file.
The front needs no configuration at all — behind nginx the API is same-origin under `/api/`, and
in development the port is a constant.

Fill in `env_development` with the credentials from the step below, then create the database and
a user for it. Nothing in the repo does this for you, and the password is yours to invent:

```sql
CREATE DATABASE trekker CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE trekker_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'trekker'@'127.0.0.1' IDENTIFIED BY 'pick-your-own';
GRANT ALL PRIVILEGES ON trekker.* TO 'trekker'@'127.0.0.1';
GRANT ALL PRIVILEGES ON trekker_shadow.* TO 'trekker'@'127.0.0.1';
```

Both `CREATE DATABASE` lines are required — Prisma cannot stand in for them. Given a URL whose
database is missing it does try to create it, but it does so by connecting to the `mysql` system
database, which an app user has no business reaching. It fails with `P1010: User was denied
access on the database mysql`.

`trekker_shadow` is scratch space for `prisma migrate dev`: it replays the migration history into
an empty database to work out the next migration and to detect drift, wiping it each run — which
is why it cannot be `trekker`. Production never needs it, since `migrate deploy` neither replays
nor diffs.

Then apply the schema and start:

```bash
pnpm --filter ./nest-api exec prisma migrate deploy
pnpm --filter ./nest-api seed
pnpm dev
```

The seed makes `demo@example.com` with two placeholder hosts and prints a generated password.

`GET /api/health` reports uptime and each dependency separately — a probe that says "ok" while the
database is down is worse than none, so MySQL and Redis are reported as their own fields and the
endpoint answers even when both are unreachable.

```bash
curl -s localhost:6800/api/health
```

Redis being down is survivable and the API says so. MySQL being down is not: the API refuses to
boot rather than serve an endpoint that fails every request.

## Auth

Session cookie on Redis plus a per-session CSRF token, same shape as pfa.

| Route | Auth |
|---|---|
| `POST /api/users` | public — sign in |
| `POST /api/users/add` | public, gated by `SIGNUPS_ENABLED` |
| `POST /api/users/recover` | public, throttled 5/hour |
| `GET /api/users/me` | session |
| `GET /api/users/csrf` | session |
| `PATCH /api/users/password` | session + CSRF |
| `POST /api/users/logout` | CSRF |

Three things worth knowing:

- **Sign-ups are closed unless `SIGNUPS_ENABLED` is exactly `"true"`.** pfa closes only on the
  literal `"false"`, so a typo leaves registration open. On an app holding SSH credentials the
  default has to be the other way round.
- **The recovery passphrase is generated, not chosen**, shown once at sign-up and kept only as a
  bcrypt hash. There is no email reset — an account with no passphrase can only be reset on the
  host. A successful recovery destroys every session the account has.
- **One live session per account.** Signing in revokes the others, so a stolen cookie stops
  working as soon as the owner signs in again.

### Ports

Allocated from the Zeus port registry, which is the authoritative source — never pick a port
without claiming it there first.

| | |
|---|---|
| front | `3005` |
| API | `6800` (block `6800-6899`) |

## Layout

```
front/                 Next app — (public) and (private) route groups
nest-api/              NestJS API — config, database, prisma, redis, health
nest-api/prisma/       schema, migrations, seed
docs/                  design docs (docs/superpowers/specs/)
```

Path aliases mirror the module layout on both sides: `@config/…`, `@database/…`, `@redis/…`,
`@health/…` in the API; `@app/…`, `@components/…`, `@lib/…`, `@styles/…` in the front. There is
deliberately no `@prisma/…` alias — it would shadow the npm scope the Prisma packages live in, so
`src/prisma/` is imported relatively.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | front and API together |
| `pnpm build` | production build, both sides |
| `pnpm lint` | Biome on the front, ESLint on the API |
| `pnpm typecheck` | `tsc --noEmit`, both sides |
| `pnpm --filter ./nest-api migrate` | new migration from a schema change |
| `pnpm --filter ./nest-api seed` | rebuild the demo account |
| `pnpm --filter ./nest-api test:db` | schema tests — needs a real MySQL |
| `pnpm --filter ./nest-api verify:fs` | listing cost and driver parity — run on the deploy host |

`test:db` is separate from `pnpm test` because it asserts on constraints the database enforces,
not on anything Prisma could fake. It makes and removes its own rows, so it is safe against a
seeded dev database.

`verify:fs` belongs on the deploy host, pointed at that host's own sshd, because its point is to
read one directory through both drivers and compare: run from a workstation the two would be
looking at different machines and the comparison would mean nothing. See the file's header.

### Listing cost

`GET /api/fs/list` never stats an entry. It reads the directory and takes mode, size, owner and
mtime from what that read already returned; the only extra round trip is one `readlink` per
symlink. A stat per entry is what turns ten thousand rows into ten thousand round trips, and it
is the thing this endpoint is built to avoid.

Measured over SFTP on a 10,003-entry directory (`verify:fs`, on the deploy host against its own
sshd): **258 ms**, 103 `readdir` requests and 3 `readlink`, and **zero** stats. The hundred-odd
reads are the protocol, not the code — SFTP returns a directory in batches of about a hundred,
so ssh2 re-reads the handle until EOF. On the local driver the same shape costs **86 ms**
(`meta.tookMs`).

Owner and group names come from `/etc/passwd` and `/etc/group`, read once per host and cached
for five minutes, with concurrent first-callers sharing a single read — not one lookup per row.
A host that will not surrender those files shows numeric ids, which is what `ls -n` does.

The cap is 10,000 entries, above which the response sets `meta.truncated` and reports the real
total rather than quietly ending short.

## Tracking

Tickets live in Spira under the `TRE` key. Code comments reference them by identifier.
