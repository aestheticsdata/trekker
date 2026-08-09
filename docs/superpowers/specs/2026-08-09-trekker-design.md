# Trekker — Design

**Date:** 2026-08-09
**Repo:** https://github.com/aestheticsdata/trekker — **public**
**Mockups:** Claude Design project `45f12e71` — `Trekker - App.dc.html`, `Trekker - Auth.dc.html`, `Trekker - File Explorer.dc.html`
**Epics:** M1 (vertical slice) → M2 (operations) → M3 (insight, shell, polish)
**Scope owner:** solo dev, sequential branch/PR merges, dark-only app.

---

## 1. Problem

Managing files across several Linux servers means an SSH session per host, `ls`/`du`/`chmod`
from memory, and no way to see two directories side by side — let alone two *hosts* side by
side. Copying between machines is a hand-written `rsync` with the flags guessed each time, and
"what is eating the disk" is a `du | sort` that takes minutes and is never kept.

Trekker is a web file explorer for the servers you actually run: dual panes across hosts,
transfers with per-file conflict resolution, permissions, and disk pressure at a glance.

## 2. Guiding principles

> **One abstraction for every host. Nothing secret in the repo. Every destructive action is
> confirmed, audited, and reversible in intent if not in fact.**

- **The local host is not a special case.** It is a row in the same table with a different
  driver. A remote-only install simply has no local row.
- **The repo is public.** No hostnames, IPs, usernames, key material, fingerprints or paths
  from real infrastructure — in code, fixtures, tests, docs or commit messages. Everything
  environment-specific comes from env at runtime.
- **Server-side is the authority.** Path safety, confirmation tokens, allowlists and quotas are
  enforced in the API. The UI's guards are ergonomics, never security.
- **Match pfa.** Same stack, same layout, same naming, same auth. A reader of pfa should find
  their way around Trekker without a map.

## 3. Stack and layout

Mirrors `pfa`:

```
trekker/
  front/         Next 16 · React 19 · Tailwind v4 · TanStack Query · nuqs · Zod · biome
  nest-api/      NestJS 11 · Prisma 7 · MySQL · Redis session · ssh2
  docs/superpowers/specs/
  biome.json · README.md · DEPLOY.md
```

Auth is pfa's, unchanged in shape: `express-session` on Redis, httpOnly cookie, per-session
CSRF token compared with `timingSafeEqual`, `CsrfGuard` on every unsafe verb, gated signup.

## 4. The host driver

The single structural decision. Every filesystem operation goes through one interface with two
implementations:

```
HostDriver
  list(path) · stat(path) · realpath(path)
  createReadStream(path) · createWriteStream(path)
  mkdir · rename · chmod · chown · unlink · rmdir
  exec(argv)      // allowlisted programs only
  df() · du(root)

  ├── LocalDriver   node:fs/promises + execFile        transport = LOCAL
  └── SshDriver     ssh2 Client + SFTPWrapper + pool   transport = SSH
```

**Why this shape.** The three deployment cases the app must serve — installed on the machine it
browses, installed on one machine and browsing others, both at once — are then the same code
with different rows in `Hosts`. A pane bound to the local host and a pane bound to a remote host
are one component. A cross-host copy is `srcDriver.createReadStream() → dstDriver.createWriteStream()`
with no branch for "is one of these local".

**Connection pool.** One `ssh2.Client` per (host, user), reused across requests, keepalive on,
evicted after an idle timeout, with a per-host concurrency cap so one runaway listing cannot
starve the others. Connections are established lazily and torn down on host deletion or
credential change.

**`exec` is not a shell.** Locally it is `execFile(program, argv)` — no shell, no interpolation.
Over SSH, `ssh2.exec` only takes a string, so the command is assembled server-side from an
allowlisted program plus shell-quoted arguments; user input never reaches the string
unquoted, and the program name is never user-supplied.

## 5. Security

Three concerns get their own tickets because each has its own failure mode.

### 5.1 Path resolution and roots

Every path from the client is resolved server-side (`realpath`) and checked against the host's
**allowed roots** before any operation. `..` is neutralised by resolution, not by string
inspection. A symlink pointing outside an allowed root resolves outside it and is refused —
which is the whole reason resolution happens before the check and not after.

The local host is the dangerous one: the API process owns Trekker's own files, including the
env file holding the master key that decrypts every SSH credential. Therefore:

- The install directory is denylisted by default and cannot be added as a root.
- The master key is read from a path outside every allowed root (env file or systemd credential),
  never from inside the app tree.

Without this, one authenticated session is one `cat` away from every private key in the system.

### 5.2 Host key pinning

On first connect the server's host key fingerprint is stored (trust on first use) and shown to
the user. On every later connect it must match, or the connection is refused with a distinct
error the UI presents as a warning, not a transient failure. The mockup claims "all fingerprints
verified"; that has to be true.

### 5.3 Credentials at rest

Private keys and passwords are encrypted with **AES-256-GCM**: random IV per record, auth tag
stored alongside, AAD bound to the host id so a ciphertext cannot be moved between rows, and a
`keyVersion` column so the master key can be rotated by re-encrypting in place. The master key
comes from env and never from the database.

### 5.4 Everything else

- `rm` requires a typed confirmation token, **verified server-side**. The client-side check is a
  courtesy.
- `sudo` is opt-in per session, per host, and time-boxed; every elevated operation is audited.
- Every mutating operation writes an `ActivityLog` row: who, which host, which paths, what
  changed. Destructive verbs are additionally rate-limited.
- All mutating routes sit behind the session guard and the CSRF guard. Without a cookie every
  route answers 401 — including the SSE streams.

## 6. Data model

MySQL via Prisma 7. Sessions live in Redis, not here.

| Model | Purpose |
|---|---|
| `Users` | account, password hash, recovery passphrase hash |
| `Hosts` | name, label, `transport` (LOCAL \| SSH), address, port, username, colour, home path |
| `HostCredentials` | kind (PRIVATE_KEY \| PASSWORD \| AGENT), ciphertext, iv, authTag, keyVersion |
| `HostKnownKeys` | pinned fingerprint per host, algorithm, first-seen and verified timestamps |
| `HostRoots` | allowed roots per host, READ or WRITE |
| `Bookmarks` | the sidebar favourites — a path plus a hint per host |
| `Views` | saved layouts: panes, split, solo, inspector, heat, glob, keyboard shortcut |
| `TransferJobs` / `TransferItems` | queue, byte counters, per-file conflict decision and status |
| `DiskScans` / `DiskScanEntries` | `du` results, kept so the treemap survives a reload |
| `ActivityLog` | audit trail and the activity strip, same rows |

`Views` move server-side; the mockup keeps them in `localStorage`, which loses them per browser.

## 7. Front-end

**Pane state lives in the URL**, through nuqs: active pane, host, path, sort key and direction,
glob, split mode, solo, inspector, heat. A "view" is then a shareable link for free, and the
back button navigates directory history the way the user already expects.

**TanStack Query** keys listings by `(hostId, path)`. Short `staleTime`, prefetch on directory
hover, explicit invalidation of the affected paths after every mutation — a chmod invalidates
one directory, a cross-host copy invalidates two.

**SSE** carries transfer progress, live tail and the activity strip. One stream per concern,
each with a per-subscriber buffer cap so a backgrounded tab cannot apply backpressure to the API.

**Virtualised rows.** `node_modules` is ten thousand entries. The list renders a window.

**Keyboard is a first-class layer**, not an afterthought: `⇥` switches pane, arrows and `↩` and
`⌫` navigate, `F2`/`F5`/`F6`/`⌦` open rename/copy/move/delete, `⌘K` the palette, `⌘I` the
inspector, `⌥1`–`⌥9` restore views, `⌥↩` the terminal. Every shortcut is also a visible control.

## 8. The terminal

A **restricted command runner**, not a PTY: `ls`, `cd`, `pwd`, `du`, `df`, `chmod`, `rm`,
`hostname`, `whoami`, `ssh` (which rebinds the pane). Each command is parsed client-side into an
intent and rebuilt server-side from an allowlist — the typed string is never forwarded to a
shell. A real PTY over WebSocket is out of scope; if it is ever wanted it is a separate mode with
its own threat model, not an extension of this one.

## 9. Milestones

**M1 — vertical slice.** Browse one host end to end: skeleton, schema, auth, tokens and chrome,
auth screens, encrypted secret store, host drivers and pool, key pinning, path safety, hosts CRUD,
list/stat, dual-pane explorer, inspector, sidebar and URL state, deploy, virtualisation, secret
hygiene.

**M2 — operations.** chmod/chown, regex rename, delete, the transfer engine and its UI,
download/upload, hashing, pane comparison, sudo, audit and rate limits.

**M3 — insight, shell, polish.** `df` and host metrics, `du` scans and treemap, disk panel and
heat map, live tail, the tail pane, the command runner, the `⌘K` palette, saved views, the git
overlay, and the test harness.

## 10. Out of scope

Real PTY. File editing in the browser. Archive create/extract. Cron and service management
(that is Zeus). Log search and alerting (that is Iknos). Mobile layout — the app assumes a wide
viewport and says so rather than degrading badly.
