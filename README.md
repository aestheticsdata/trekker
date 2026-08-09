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

`test:db` is separate from `pnpm test` because it asserts on constraints the database enforces,
not on anything Prisma could fake. It makes and removes its own rows, so it is safe against a
seeded dev database.

## Tracking

Tickets live in Spira under the `TRE` key. Code comments reference them by identifier.
