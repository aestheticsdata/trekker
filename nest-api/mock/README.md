# The mock (TRE-140)

In development the application never shows this machine's real content. Not the documents,
not the home, nothing. What it shows instead is a **fake tree**: a believable web server —
`etc`, `home`, `opt`, `srv`, `var/www` with releases, `var/log` with logs that open and tail,
`var/lib/mysql` with the fat files — written as real files under the repository's own `.mock/tree`, and a
database that describes it: bookmarks, saved views, a treemap, cached checksums, a transfer
history and an activity log, all pointing into that tree.

It is **955 files in a hundred-odd directories**, and the crowded ones are crowded on purpose (TRE-148):
a catalogue of 120 product renders, one event's 72-frame gallery, ninety avatars, a month of
nightly dumps and a year of monthly tarballs, a fortnight of rotated logs, an InnoDB data
directory with its binlogs, an apt cache. The first cut held a hundred and fifty files and every
listing fitted on one screen, so a film of the explorer never scrolled. The families are written
once each as a rule at the top of `manifest.ts` (`crowd`, `filesOf`, `rotated`) and spelled out by
a seeded generator; nothing in a family is named by a fixture, so the hand-written entries the
views, hashes and transfers point at are still the ones to read.

Nothing in `src/` knows about any of this. The drivers, `du`, the tail, the treemap and the
inspector run their production code on the fake content — the lock is the application's own
allowlist. The dev LOCAL host carries **one** `HostRoots` row, the tree's root, and the house
account is a **MEMBER**, so the path guard refuses everything outside it. (The install's owner
browses against `/` — TRE-48 — which is why the account must not be one; see `prisma/seed.ts`.)

## Two commands, and one that runs them for you

| Command | What it does |
|---|---|
| `pnpm --filter ./nest-api mock:tree` | Materialises the tree from the manifest. Run again without a manifest change it touches nothing; `--force` rewrites it. A rewritten tree has new mtimes, so the cached checksums and scans in the database describe the previous one: run `pnpm mock` afterwards (`dev-up` notices and does it). |
| `pnpm --filter ./nest-api mock` | Rewrites the tree — every time, so whatever was uploaded, renamed or deleted through the app goes too — then loads the fixtures into the database against it. Resets what it owns. **The only reset.** |
| `pnpm dev` | Runs `mock/dev-up.ts` before Nest: seeds the house account if it is missing, and runs the loader if the pinned host is not in the database, the tree is absent, or the tree was rewritten since the fixtures were loaded (two stamps beside the tree say). Otherwise touches nothing — a tree whose manifest has moved on stays as long as its rows still describe it. Never blocks the API. |

Both commands refuse `NODE_ENV=production` and any `DATABASE_URL` whose host is not a loopback
address, before writing a byte. There is no `--production` flag: a demo in production is another
ticket. Configuration comes from `ecosystem.config.js`'s `env_development` through
`src/config/load-env.ts`, like everything else.

## The account

The house dev account, the same on every project: `local.dev@mock.io` / `azertyazerty`, recovery
passphrase `mock local recovery`. `pnpm seed` creates it (SEED_PASSWORD still overrides the
password) behind the same guard as the mock commands; it also lives in the repo's gitignored
`ACCOUNTS.md`, and `dev-up` prints it the day it has to seed it. Never derive a credential from the
app's name.

The seed's own LOCAL host is rooted at the tree's path from the start, so nothing real is browsable
between a seed and a load. The account the seed used to make, `demo@example.com`, is **left
alone** — it may hold hosts and credentials somebody stored while testing — and named in the
output; delete it by hand when it is no longer needed (it holds the owner slot, which the house
account does not want).

## One source

Everything starts from `manifest.ts`: the tree (paths, sizes, modes, mtimes relative to one fixed
reference instant, content for the small text files, a seeded generator for the logs) and the
tables' fixtures beside it, written with `$TREE` where the root will go. `corpus.spec.ts` refuses a
fixture naming a path the tree does not make, which is what lets a treemap rectangle promise to
land on a listing that really holds that file at that size.

The two halves meet at load time rather than at authoring time, on purpose:

- **The treemap** is computed by the real `ScanAggregator` over a walk of the materialised tree,
  fed in `du`'s own post-order. Directory subtotals get one 4096-byte block, so every level has the
  `OTHER` remainder a real scan has. Duplicate groups are confirmed from the manifest — two sparse
  files of one size *are* byte-identical.
- **The checksums** are sha256 of the materialised bytes, with the size and mtime read back from
  the file, because the inspector compares those for equality against a fresh `stat`.
- **The activity log** is the manifest's hand-written rows plus one derived row per scan,
  transfer, saved view and bookmark, so the strip tells the same story as the tables. Ids are
  uuid v7 built from each row's shifted timestamp, which is the ordering the API pages by.

Every id is a function of a name — the activity log's of a name and the manifest's fixed
reference, which is what keeps them sorted as the API expects. Two consecutive `pnpm mock` runs
leave the same rows; only the anchor every timestamp is shifted onto moves, and the tree's mtimes
and the checksums' `mtimeMs` move with it. `Users` is never written, `HostCredentials` stays
empty, and an SSH host that is there is left exactly as found — a developer may have stored a
credential on it. The three the manifest names (`marlow`, `sable`, `tundra`) are made when
missing; an SSH host of the house account the manifest no longer names, with no credential, is
removed (`demo-remote`, from before TRE-148).

## Hosts and volumes (TRE-148)

Four invented machines. **Kestrel** is the dev LOCAL host, pinned to one id, locked inside the
fake tree. **Marlow** (the off-site backups), **Sable** (the database replica) and **Tundra** (the
media origin) are SSH hosts under `example.com` — and they answer.

**The three remote machines are servers the mock runs itself**, in Node, from this repository and
nothing else: `mock/sshd.ts` is ssh2's server half, one listener per machine on the loopback
(`127.0.0.1:2221`–`2223`, from the manifest), started by the same wrapper that runs the API
(`pnpm dev`, or `pnpm exec tsx mock/df-on-path.ts node dist/src/main` for a built one) and
stopped with it, or on their own by `pnpm mock:hosts`. Nothing is installed, no system setting
is touched, no container, no daemon. Each serves its tree — `REMOTE_TREES` in the manifest,
written by `pnpm mock` under `<mock home>/hosts/<slug>/tree/` — as `/` over SFTP, which is
everything the SSH driver does with a file: list, stat, read, write, mkdir, rename, delete,
chmod, utimes, uploads, transfers, the tail viewer. And it answers the handful of commands the
driver execs the way a Debian box would: `df` from the machine's own generated shim
(`REMOTE_VOLUMES`), `du` with GNU's flags and record format (a live scan of Marlow walks the
real files), `tail` of the `/proc` and `/etc` files the summary, the metrics and the owner names
are read from, `id`, `sha256sum`. `sudo` says what a box with no sudoers entry says.
`mock/sshd.spec.ts` connects to one on a free port and checks all of that.

**The API reaches them by name.** The rows keep `marlow.example.com` as their address — the host
manager and the activity log print it, and a loopback IP on camera would be neither believable
nor wanted — and the API's process is started with `mock/example-dns.cjs` preloaded
(`NODE_OPTIONS=--require`, set by `df-on-path.ts`), which answers `127.0.0.1` for any name under
`example.com` and leaves every other name to the real resolver. That process tree alone; nothing
else on the machine resolves the names.

**The credential and the key.** Each row carries a sealed `PASSWORD` credential — `REMOTE_PASSWORD`
in the manifest, sealed by the loader with the API's own `SecretStoreService` under
`TREKKER_MASTER_KEY`, to the row's own id — unless a developer stored one of their own, which is
kept. Each machine's ed25519 host key lives under `<mock home>/hosts/<slug>/keys/`, made once by
`mock/host-keys.ts` (ssh2 generates it; no `ssh-keygen`) by whoever asks first, and pinned as
verified on the row by the loader, so no `host.key.pinned` row ever lands in the activity strip
on camera. Regenerate the keys and `pnpm mock` re-pins them.

Kestrel's disks are the manifest's `VOLUMES`, not the machine's. The VOLUMES rail, the DISK USAGE
strip's "of …" and the path-row badge all read the host's `df`, and a LOCAL host's `df` is the
laptop's — a rail of `/System/Volumes/…` on camera. So `tree.ts` writes `<mock home>/bin/df`, a
node script that prints `VOLUMES` in the three shapes the API asks for (`-P -k -T`, `-P -k`,
`-P -i`, with or without a path), and the API is started with that directory first on its PATH:
`pnpm dev` does it through `mock/df-on-path.ts`; a built API for a film is
`pnpm exec tsx mock/df-on-path.ts node dist/src/main`. Nothing in the API is faked — the same
`execFile("df", …)`, the same parsers — and nothing outside that process tree sees the shim.

**Every volume is mounted inside the tree.** A mount point is a directory, and the rail opens it
in the active pane on a click; a `df` that said `/srv/media` the way a Linux box would sent that
click to "permission denied", because nothing outside the tree may be listed. The manifest
writes them as `$TREE`, `$TREE/boot`, `$TREE/var/lib/mysql`, `$TREE/srv/media`,
`$TREE/opt/backups`, `$TREE/mnt/archive` and the hidden `$TREE/run`, the shim gets the real root
written in, `corpus.spec.ts` checks each one is a directory the tree makes, and `df <path>`
answers with the volume that holds the path — a pane in `srv/media/images` gets the media
volume's 42%, not the root's. The rail shows a long mount point from its end (`…/tree/srv/media`,
`helpers/disks.ts`) and the tooltip carries it whole. The remote machines' volumes are at their
own real paths (`/srv/backups` on Marlow) — their sshd's `/` is their tree.

## Pictures

An image file in the manifest is `kind: "image"` (`mock/images.ts`): a small, deterministic,
procedurally painted picture — a product render, a photograph, a banner, an avatar; abstract,
nothing real — encoded as a PNG and extended to the size the manifest declares by a sparse tail
of zeroes after IEND, which decoders ignore and which costs no disk. A `.jpg` name holds a PNG
too; the browser decodes by signature, and Chromium was checked with the bytes served as
`image/jpeg`. The path seeds the picture, so `sku-10021.jpg` is the same picture in Kestrel's
tree and in Tundra's. The point: the inspector's preview shows the picture when the row is
clicked, where a sparse file showed a hatched box. Every image stays under the preview's
8,000,000-byte ceiling.

## Times, and the two anchors

Every time in the manifest is relative to `REFERENCE` and negative. The loader shifts the fixtures
onto the moment it runs and writes the tree on that same anchor, with every mtime snapped to a
whole second (APFS hands a millisecond back as `…122.999`, and the hash cache compares for
equality). `mock:tree` on its own anchors on its own moment, which is why a tree it rewrote needs
`pnpm mock` afterwards.

The activity rows sit inside the retention windows `retention.service.ts` prunes by (90 days,
365 for destructive rows, 30 for permission snapshots), with a margin; a row older than that would
evaporate silently while you work.

## What is fake about the fake

- **Sparse files.** Anything large is `truncate`d to its size and allocates no blocks. The listing
  and the loaded scan show the apparent sizes; a *live* `du` — a new scan, the directory sizes
  column — reports those files as nearly nothing. That is `du` being right about the disk. The
  whole 955-file tree costs a few megabytes of real disk, and `orders.ibd` stays the largest
  file — `corpus.spec.ts` checks it, so a new family must size itself under 2,140 MB.
- **No live writer.** The logs are real text and tail correctly, but nothing appends to them.
- **The SSH hosts are the mock's own servers.** They hold what the manifest says and nothing
  else; `whoami` is the manifest's user; `/proc` is invented and its clocks run. A host key or
  credential a developer changes by hand in the host form is theirs — and the loader keeps a
  credential it finds.
- **`df` is the manifest's.** Only when the API found `<mock home>/bin` first on its PATH; a
  `pnpm start` without it shows the real disks again, which the film's storyboard refuses.
- **The house account is a member.** The owner-only surfaces — the denylist explaining itself,
  browsing outside the roots — are not reachable with it. That is the lock working. A member can
  still widen the host's roots from the host form; the lock is against accident, not a security
  boundary.

## Files

| File | Role |
|---|---|
| `manifest.ts` | The one source: tree spec, host, bookmarks, views, scans, hashes, transfers, activity. |
| `corpus.ts` | Pure: the spec as bytes (`flatten`, generators), a walk as `du` records. |
| `fixtures.ts` | Pure: `$TREE` resolution, transfer items from the tree, the derived activity rows. |
| `ids.ts` | Deterministic uuids (v7 from a timestamp, v4-shaped from a name) and a seeded PRNG. |
| `env.ts` | The guards, the house account, where the tree lives, how a client is opened. |
| `tree.ts` | The materialiser and `pnpm mock:tree` — Kestrel's tree, the three remote trees, every `df`. Stamps what it wrote; a second stamp says what the loader last loaded against. |
| `images.ts` | The pictures: painted, encoded, padded. |
| `sshd.ts` | The three remote machines' servers, and `pnpm mock:hosts`. |
| `host-keys.ts` | Each machine's host key and its fingerprint, made once. |
| `example-dns.cjs` | The names under `example.com`, answered for the API's process alone. |
| `df-on-path.ts` | Runs the API inside the mock's world: the PATH, the names, the machines. |
| `load.ts` | The loader and `pnpm mock`. |
| `dev-up.ts` | What `pnpm dev` runs first. |
| `*.spec.ts` | Run by `pnpm test`. The materialiser spec writes into a temporary `TREKKER_MOCK_HOME`; the sshd spec starts a machine on a free port. |

`TREKKER_MOCK_HOME` moves the whole thing (default `<repository>/.mock`; empty reads as unset, a
relative path is made absolute). Everything of the mock — Kestrel's tree, the three remote trees,
every fake `df`, the machines' host keys, the stamps — sits in that one gitignored folder of the
project and nowhere else on the machine. Git does not see it (`git status --porcelain` skips
ignored paths, which is what both deploy scripts check), and the local driver serves it like any
other folder of the repository — the denylist names the PM2 config, not the install tree around it
(TRE-150). The specs materialise into a temporary directory instead.