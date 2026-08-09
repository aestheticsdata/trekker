# Trekker

A file explorer for the servers you actually run — dual panes across hosts, transfers with
per-file conflict resolution, permissions, and disk pressure at a glance.

Trekker reaches a host either as the machine it runs on or over SSH, behind one `HostDriver`
interface. There is nothing to install on the servers you browse: any Linux with `sshd` works,
and the machine hosting Trekker is just another entry with a different driver.

> **Status: early.** The skeleton is in place (TRE-4). Hosts, browsing and every operation are
> still ahead — see `docs/superpowers/specs/2026-08-09-trekker-design.md`.

## Before you run this

Trekker holds SSH credentials and knows the address of every machine you manage. Two things
follow from that:

- **Generate your own secrets.** Every value in `.env.example` is a placeholder. `.env` is never
  committed, and the master key that encrypts stored credentials must live outside every path
  Trekker is allowed to browse.
- **Do not expose it to the public internet** without a reverse proxy in front, registration
  closed, and ideally an IP or VPN restriction. An authenticated Trekker session is shell-adjacent
  access to every host it knows.

## Stack

| | |
|---|---|
| `front/` | Next 16 · React 19 · Tailwind v4 · TanStack Query · nuqs · Zod · Biome |
| `nest-api/` | NestJS 11 · MySQL · Redis · ssh2 (Prisma from TRE-6) |

## Running it

Requires Node 24, pnpm 11, and a reachable MySQL and Redis.

```bash
pnpm install
cp nest-api/.env.example nest-api/.env      # then fill it in
cp front/.env.example front/.env.local
pnpm dev
```

`GET /api/health` reports uptime and each dependency separately — a probe that says "ok" while the
database is down is worse than none, so MySQL and Redis are reported as their own fields and the
endpoint answers even when both are unreachable.

```bash
curl -s localhost:6800/api/health
```

### Ports

Allocated from the Zeus port registry, which is the authoritative source — never pick a port
without claiming it there first.

| | |
|---|---|
| front | `3005` |
| API | `6800` (block `6800-6899`) |

## Layout

```
front/          Next app — (public) and (private) route groups
nest-api/       NestJS API — config, database, redis, health
docs/           design docs (docs/superpowers/specs/)
```

Path aliases mirror the module layout on both sides: `@config/…`, `@database/…`, `@redis/…`,
`@health/…` in the API; `@app/…`, `@components/…`, `@lib/…`, `@styles/…` in the front.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | front and API together |
| `pnpm build` | production build, both sides |
| `pnpm lint` | Biome on the front, ESLint on the API |
| `pnpm typecheck` | `tsc --noEmit`, both sides |

## Tracking

Tickets live in Spira under the `TRE` key. Code comments reference them by identifier.
