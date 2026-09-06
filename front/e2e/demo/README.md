# Demo films

One Playwright run that drives the explorer the way a hand would, records it as a single continuous
video, and writes the chapter list beside it. No editing: the take *is* the video, and the chapter
file is what goes in the description.

```bash
pnpm video:generate
```

Output lands in `e2e/demo/out/` (gitignored):

- `trekker-demo.mp4` — the take, h264, at the exact viewport size, no scaling, with the chapters
  written into the file itself
- `chapters.txt` — `0:00 Title` per line, for a human to read
- `chapters.vtt` — WebVTT, for `<track kind="chapters">` on the portfolio's own `<video>`
- `chapters.ffmeta` — ffmpeg metadata; already applied to the mp4, kept so a re-encode can reapply it
- `chapters.json` — the same marks with millisecond precision
- `shots/01-two-panes.png` and eleven more — stills at 3840×2160, for a page that wants pictures too
- `upload/` — the three zero-filled files chapter 8 uploads, written by the storyboard itself

This is a port of Zeus's harness, which is a port of Spira's. `pacing.ts`, `recorder.ts`,
`chapters.ts` and `cursor.ts` are byte-identical to Zeus's; `fixture.ts`, `preflight.ts`,
`demo.setup.ts` and `playwright.demo.config.ts` are the same files with the Trekker-specific parts
changed. The full write-up of how it works and why — the CDP screencast, the drawn pointer, the
encode, and every trap found building it — is
`front/e2e/demo/HOW-TO-FILM-A-DEMO.md` in the
Spira repo, and Zeus's `e2e/demo/README.md` carries the traps that console found. Only
`trekker.demo.ts` knows what Trekker is.

## What it needs before it will record

`preflight.ts` refuses to launch a browser until the first three are true, and names whichever one
is not. The rest it cannot check; the storyboard checks the last one itself.

1. **The front on `127.0.0.1:3005`, and it must be the production build**, built with the API
   origin — `pnpm dev` floats overlays over the page that `hideDevChrome()` does not know about,
   and a build without the variable cannot reach the API from a laptop at all:

   ```bash
   cd front && NEXT_PUBLIC_API_ORIGIN=http://localhost:6800 pnpm build
   pnpm exec next start -p 3005 -H 127.0.0.1
   ```

   `NEXT_PUBLIC_API_ORIGIN` is honoured by the browser client, the server-side session check and
   the CSP's `connect-src`; it is undefined in every real deploy, where the API is a path under the
   front. Build-time: **rebuild after changing it, and rebuild before filming anyway** — `next start`
   serves whatever `.next` already holds.
2. **The Nest API on `127.0.0.1:6800`, in development mode, on the mock tree, inside the mock's
   world** — the fake `df` first on its PATH, the three remote machines started beside it, their
   names resolved — from `nest-api/`, after the corpus below:

   ```bash
   NODE_ENV=development pnpm exec tsx mock/df-on-path.ts node dist/src/main
   ```

   (`pnpm dev` does the same through `df-on-path.ts`, on a watch build; the three machines
   appear in its first lines.) Development mode because
   the mock guards demand it and the session cookie is `secure` only in production — an `http://`
   take never receives it otherwise.
3. **`DEMO_USERNAME` / `DEMO_PASSWORD` in `front/.env.test.local`** — the house dev account,
   `local.dev@mock.io`. Copy `.env.test.local.example` beside it. Never a real credential: the video
   is for a public page.
4. **ffmpeg on `PATH`** with libx264, the mp4 muxer and the `concat` demuxer — `brew install ffmpeg`,
   or `DEMO_FFMPEG` pointing at one.
5. **The corpus, materialised somewhere neutral** — see below.

## The corpus, and the two leaks it had to lose

The take films TRE-140's fake server tree — 955 files since TRE-148 grew it, sparse where they
are big, under the house account's allowlist — and TRE-148's four invented hosts. Nothing from the
film machine may be on screen, and three things were by default:

- **The tree's absolute path** is printed as breadcrumb crumbs in both panes, in the status bar,
  the inspector, the DISK USAGE title, palette rows and activity summaries. The mock lives in the
  repository's own `.mock/` folder — nothing of it anywhere else on the machine — so what the
  film prints is the path of this checkout, `/Users/<login>/dev/trekker/.mock/tree/…`. That is
  the checkout's location on camera; the account, the hostname and the disks are still never the
  machine's.
- **The OS user name** was the terminal prompt: `who()` in `terminal-runner.ts` fell back to the
  machine's `whoami` because a LOCAL host had no username. The loader now gives the dev LOCAL host
  `username: "deploy"` — the corpus's own operator — and `who()` prefers a host's username. The
  prompt reads `deploy@kestrel`.
- **The laptop's disks** were the VOLUMES rail, the DISK USAGE strip's "of …" and the path-row
  badge: a LOCAL host's `df` is the machine the API runs on, so the rail was `/System/Volumes/…`
  eight times over. `tree.ts` now writes `<mock home>/bin/df`, generated from the manifest's
  `VOLUMES` — a root, a fat MySQL volume at 79%, an XFS media volume, an LVM backups volume at 88%,
  `boot`, an NFS archive, one hidden tmpfs — and the API is started with that directory first on
  its PATH. Nothing in the API is faked: the same `execFile("df", …)`, the same parsers. **Every
  volume is a directory of the tree** (`$TREE/srv/media`, not `/srv/media`), so a click on a
  VOLUMES block lands in a listing instead of on "permission denied", and the path-row badge and
  the strip's "of …" name the volume that really holds the pane's path. The rail shows a long
  mount point from its end, `…/tree/srv/media`. **The storyboard refuses to film a real `df`**:
  before the first shot it asserts the `var/lib/mysql` volume block, with the fix in the failure
  message.

Four hosts, all invented, and all four answer: **Kestrel** (the LOCAL host, the tree),
**Marlow** (the off-site backups), **Sable** (the database replica) and **Tundra** (the media
origin). The three SSH ones are servers the mock runs itself in Node (`nest-api/mock/sshd.ts`),
on the loopback, started with the API by the same wrapper that puts the fake `df` on its PATH
and reached by their `example.com` names through a preload that answers `127.0.0.1` for that
process alone — nothing installed, nothing started outside the repository. Pane B is bound to
each of them in chapter 4, chapter 7 makes, copies and renames on Marlow, chapter 8 uploads to
Tundra, and chapter 13 scans Marlow live and opens the shell on it. See `nest-api/mock/README.md`.

The tree itself was grown for this film: the first cut held 163 files and no listing was longer
than a screen, so the explorer never scrolled and the treemap had nothing to say. The crowded
directories — 120 product renders, a 72-frame gallery, ninety avatars, a month of dumps, a
fortnight of rotated logs, an InnoDB data directory — are families written once as a rule at the
top of `nest-api/mock/manifest.ts` and spelled out by a seeded generator (`nest-api/mock/README.md`),
and the partitions the rail opens — `boot`, the NFS `mnt/archive` — are real directories of it.

In `nest-api/`:

```bash
pnpm seed   # the house account and the four hosts — once, and again after a host change
pnpm mock   # rewrites the four trees, every fake df and every picture; loads the fixtures, seals the
            # remote machines' demo credential, pins their host keys; re-anchors every time on now
```

`pnpm mock` is the reset and it costs nothing — there is no live writer — so **run it immediately
before filming**: `access.log` then reads `5min`, the root scan `42 min ago`; after 24 h the strip
shows `⚠ stale`. The loader finds the SSH hosts by slug and leaves a found one exactly as it is (a
developer may have stored a credential on it), so a bookmark or label change on one of the three
needs `pnpm seed` first.

## The take

Thirteen chapters, **333.3s — five minutes thirty-three**, at the default `DEMO_SPEED=1`. One
private route: every "screen" is a panel, a strip, a modal or a menu inside `/`, and the whole
layout lives in the query string, so the one URL the take types is a complete layout and everything
after it is a thing a hand would do to that layout.

| | |
|---|---|
| 0:00 Two panes | the top bar read left to right — the host chip, the saved views — then the rail: the four machines and three of Kestrel's volumes; the live release selected, its age chip read, ↩ in, breadcrumb out |
| 0:24 Sort, heat, glob | `SIZE` then `NAME`; heat off and on; `*.gz` on pane B, the hit count, cleared inside the input |
| 0:39 Panes go places | the MySQL volume clicked into pane A (79%, the path-row badge), sorted by size, into `app/`; the media volume into pane B, `images/` scrolled, `products/` — 120 renders — the inspector's count, one render clicked and its picture shown, scrolled; the split control to one pane and back; a second tab in B sent to `srv/media` by the favourite, the first brought back; the NFS archive into pane A, scrolled |
| 1:38 Servers | Marlow bound to pane B from the rail and listed — its chip, its rows, `deploy` in the owner column; Sable; Tundra; the host manager from pane A's chip, the four rows, Marlow's form (`marlow.example.com`, port 2221), cancelled; Kestrel back into B at its root |
| 2:15 Disk usage | the treemap's bands swept, `duplicates` and `files > 1 year`, the `opt` band clicked |
| 2:31 Live tail | pane B to the logs by the favourite and into `nginx/`; `access.log` followed, lines coloured by status, scrolled away and `↓ follow` back |
| 2:49 Make, copy, rename | the strip hidden; pane A to alice's exports, by name; pane B to Marlow, active; F7, `reports-2026` on Marlow, the toast; three exports selected with ⇧ and F5 — Kestrel to Marlow — the plan, `copy 3 entries`, the toast; F2 on the copies, the pattern typed and watched, `rename 3 files`, the toast |
| 3:38 Upload | Tundra's `incoming/` into pane B, sorted by age; the toolbar's `upload ↑` on the other machine, `choose files…`, three files, `overwrite`, `upload`; the tray's three bars, the three new rows at `now` |
| 4:02 Saved views | `Backups → Marlow` — the nightly dumps left, their off-site copies right, the same names an hour apart — scrolled; `Log triage`; `Media`, the hero clicked and its picture shown; back to `Releases ↔ logs` |
| 4:24 The context menu | `error.log` right-clicked, the safe rows hovered, dismissed |
| 4:31 The palette | `Control+K`, `back`, the rows walked; a typed path, opened |
| 4:44 Compare | the live release against the one before it, the filter chips, `dist`, dismissed |
| 5:03 Marlow: a scan, and the shell | Marlow into pane B, active; its two volumes on the rail; `show disk usage`, "Never scanned", `scan now` — the treemap fills over SSH; the bands and facts; a click in the prompt, `deploy@marlow`, `ls -al`, read, ⎋; two machines side by side to close |

Five things the first cut of this take did not do, and the reasons it does them now:

- **It writes, on the other machines.** A film of a file manager that never makes, copies,
  renames or uploads anything is a film of a viewer. Chapter 7 makes `/srv/backups/reports-2026`
  on Marlow, copies three of alice's exports into it from Kestrel and renames them with a
  pattern; chapter 8 uploads three files into Tundra's `/srv/media/incoming`. Six writes, all
  inside the fake trees under `TREKKER_MOCK_HOME`. The toasts — `reports-2026 created`, `Copied 3
  entries`, `Renamed 3 entries` — are the explorer reporting each one, and the take hovers them so
  they are read rather than glimpsed.
- **The panes move.** Between the favourites, the rail's A/B buttons, the split control, a second
  tab, the treemap's bands, the crumbs and the palette, each pane visits eleven directories on
  the way, and the long ones — the catalogue, the backups — are scrolled so the crowd shows.
- **The other machines answer.** Marlow, Sable and Tundra are bound into pane B from the rail
  and list; Marlow takes a directory, three copies and a rename; Tundra takes an upload; Marlow
  is scanned live and gets the shell. The first cut showed them failing — `host unreachable` on a
  placeholder — and a rail of machines that cannot be opened is decoration. They are servers the
  mock runs itself, in Node, started with the API (`nest-api/mock/README.md`).
- **A click shows the picture.** The mock's image files are real PNGs now, painted from their
  own path and padded to their declared size with a sparse tail; the inspector's preview shows a
  render in the catalogue and the hero on the media view, where a sparse file showed a hatched
  box.

The through-line is still the nightly dump, `opt/backups/db-2026-08-31.sql.gz`: a favourite, a
saved view's subject, the target of the transfer history, holder of a fixture sha256, the second
band of the root treemap, the top of a month of dumps and a year of tarballs — and, on Marlow,
its off-site copy, an hour younger, in the `Backups → Marlow` view and in the closing frames.

## The stills

`demo.shot("name", prepare?)` marks fourteen screens. It takes no picture at the time — it
writes down the URL, and the pictures are taken at the very end, once the recorder has stopped and
the mp4 is closed, by sending the same signed-in page back to each URL. They come out at 3840×2160,
lossless PNG, animations frozen, caret hidden, the harness's overlays painted out.

Eight of them show something a URL cannot hold — a render and the hero with their picture in
the inspector, the host manager, a transfer plan, the rename preview, the upload modal with its
files chosen, the upload tray after the batch, the palette on `back` — so those pass a `prepare`
step, run on the revisited page after it has settled and before the shutter. It does with plain
Playwright what the take did with the drawn pointer (a row clicked; a click on the pane's host
chip; the selection and F5; the selection, F2 and the pattern; the toolbar's `upload ↑` and the
`filechooser` answered; ⌘K and four letters), and it has to be repeatable on whatever the take
left: the rename still previews the pattern that would put the renamed files *back*, and the
upload still re-uploads the same three names with `overwrite`, which is why the take chooses that
policy too. The Marlow scan needs none: the kept scan is in the URL's pin.

**No still carries a toast.** The first cut's did — eleven of them, stacked up the right edge of
the opening frame: `transfers.tsx` toasted every finished job in the history on every page load,
because its "already announced" set started empty. It is primed with the first snapshot now, and
only a job seen ending *after* it gets a toast (`TransferProvider`). A production bug the mock's
twelve-job history made visible.

## Running it again

**The take writes six things into the fake trees**, and `pnpm mock` is the reset — it rewrites
the four trees and forgets what the app learned about the three machines (their scans, their
checksums): run it before every take. The storyboard refuses to start on a Marlow tree that still
holds `srv/backups/reports-2026`, with the command in the failure message, because `mkdir` would
say "already exists" two minutes in. It writes nothing outside the trees: the three upload
sources are zero-filled files it makes under `e2e/demo/out/upload/`, gitignored with the rest of
`out/`.

Everything else is still read-only, and this explorer still puts a destructive control beside
nearly everything it does use: `rm` is the LAST row of every entries menu, directly under `add to
favourites`; `scan ⟳` and `hide ▾` sit at the right end of the disk-usage title; a favourite's `✕`
appears on hover of the very row you click; `delete this host` shares a footer with the host
form's `cancel`. So every click near a row is aimed with `aim: "text"`, and F2/F5/F7 are pressed
only with the pane that should answer them already active.

⚠️ **One live session per account.** The setup project's sign-in destroys every other session, so
your own Trekker tab is signed out when a take starts, and a sign-in of yours mid-take 401s every
request the film makes.

Nothing that moves is asserted: every age chip, every `N ago` and the pings read the wall clock.
Waits are on names and sizes, which the manifest fixes — and since TRE-148 that includes the
VOLUMES rail, which reads the manifest's `df`.

## Trekker-specific traps

**Every URL change is written back to the account's last layout a second later**, and a bare `/`
restores whatever the previous take left. The opening URL is a full query string on purpose, with
`duRoot` pinned so the root treemap does not vanish the moment a pane opens a directory.

**The DISK USAGE strip follows the ACTIVE pane's host, and a pin lets go on a host that has never
scanned under it** (`disk-usage.tsx`). Binding pane B to another machine while pane B was active
unpinned Kestrel's root treemap for the rest of the first full take, and nothing short of a live
scan pins one again. So in chapter 4 pane A stays active while pane B visits the three machines
(rows in B are hovered, never clicked), chapter 7 hides the strip with `hide ▾` before pane B, on
Marlow, becomes active, and chapter 13 brings it back on Marlow and scans it — which pins Marlow's
root, and is the closing frame.

**A ⇧-click run is a run of NEIGHBOURS in the pane's current order.** Pane A had been sorted by
size since chapter 3, and the run from `sales-2026-06` to `-08` took `-05` and left `-07` behind:
three rows, the wrong three, and the copy went through. `selectRun` sorts nothing — the storyboard
clicks `NAME` first — but it reads back the selected names and compares them, and does the run
again if a re-list between the two clicks (a finished transfer re-reads its destination twice)
dropped the anchor.

**Both panes can show the same file names.** Nothing in a pane is addressed bare: `rowIn(pane,
name)` scopes `[data-row]` under `[data-pane=N]`.

**A listing is virtualised.** A row outside the window is not in the DOM. The storyboard scrolls
by pixels or walks the cursor rather than asking for a row that has not been rendered — the archive
is asserted by its crumb and its first row, because sorted by size its one small file is below the
window.

**The favourite's companion is on the row, not the button.** `data-label` lives on
`favourite-row`; `favourite-open` inside it has none. And bookmark labels are unique across the four
hosts on purpose — a second `Backups` (Marlow's) made the storyboard's selector resolve to two
elements and the take fail at chapter 3, which is why Marlow's reads `Off-site copy`.

**The inspector's panel is `data-panel` on `inspector`**, not a separate testid; the path-row
badge (`path-badge`) exists only while the pane's volume is above the warning line, so the
storyboard hovers it only if it is there.

**`compare` offers only the chips it has** — `all` / `differs` for this pair — so the storyboard
walks the chips by index rather than by name.

**`tail-follow` is not always there**: the strip only offers it once the tail has scrolled away
from the bottom. The storyboard waits for content and treats the control as optional.

**A file input cannot be clicked through.** The upload modal's `choose files…` raises the system
dialogue, which never draws under Playwright; the storyboard waits for the `filechooser` event the
click raises and answers it with the three files. The click is real, so the film shows the press.

**The screencast used to open on a blank frame** in one of the four harness copies (Iknos). The
recorder starts over `about:blank`; `Demo.open` now rebases the film and the chapter clock to the
instant the first navigation settles. Trekker was never affected — its ground painted before the
first frame — but it carries the same fix.

## Knobs

The same as Zeus's, all environment variables: `DEMO_SPEED`, `DEMO_HEADED=1`, `DEMO_WIDTH` /
`DEMO_HEIGHT`, `DEMO_SCALE=1`, `DEMO_TITLES=on`, `DEMO_CURSOR=off`, `DEMO_FPS`, `DEMO_CRF`,
`DEMO_FFMPEG`, `DEMO_RECORDER=playwright`, `E2E_BASE_URL` (default `http://localhost:3005`), plus
`TREKKER_MOCK_HOME` (default: the repository's `.mock/`, in the storyboard as in the mock — it must be
the value `pnpm mock` was run with).

## What this run actually measured

On an 8-core M1, at 1920×1080 with the default 2× supersampling.

| | |
|---|---|
| The take | 333.3s, 13 chapters, **7730 frames at 23.2fps** — a still explorer sits near the screencast's floor, as Zeus does; the tail, the transfer bars, the upload tray and Marlow's scan lift it a little |
| The file | **29.4 MB** (29,369,019 bytes), h264, 1920×1080, chapters inside it |
| Stills | 14 × 3840×2160 PNG, 444–1001 KB each, 8.6 MB the set |
| The machines | Marlow's `pingMs` reads 4–19 ms through the loopback; its scan of `/srv/backups` (49 entries, 29.6 GB apparent) lands in about a second |
| Repeatability | the same storyboard at 1× came out at 316.3s (failed on the last beat, on a kept scan — since reset by the loader), 333.2s and, after the move into `.mock/`, 333.3s; nine dry runs at `DEMO_SPEED=4` found every trap above before a real take was spent on it |

## What this ticket changed outside the harness

- `front/src/lib/api/client.ts`, `auth/server/getServerSession.ts`, `next.config.js`: an opt-in
  `NEXT_PUBLIC_API_ORIGIN`, undefined in every real deploy.
- `front/src/components/explorer/terminal-runner.ts`: `who()` prefers the host's username.
- `front/src/components/ui/transfers.tsx`: the first transfer list is marked announced without a
  toast — a page load no longer toasts the whole recent history.
- `front/src/helpers/disks.ts`, `sidebar/volumes.tsx`: `shortMount` shows a long mount point from
  its end in the rail.
- `nest-api/mock/manifest.ts`: four hosts (`LOCAL_HOST` is Kestrel; `REMOTE_HOSTS`), `VOLUMES`
  mounted inside the tree, the views, transfers and activity that name them, and the crowd — the
  `crowd` / `filesOf` / `rotated` families that take the tree from 163 files to 955, plus `boot`,
  `mnt/archive` and `run` behind the volumes.
- `nest-api/mock/tree.ts`: writes `<mock home>/bin/df` from `VOLUMES` with the real root in the
  mount points; `MATERIALISER_VERSION` 3.
- `nest-api/mock/df-on-path.ts`: runs a command with that directory first on PATH; `pnpm dev`
  goes through it.
- `nest-api/mock/load.ts`: finds or makes the three remote machines, brings a found one's
  coordinates and roots to the manifest, seals the demo password onto each (keeping a developer's
  own credential), pins each machine's host key as verified, removes a credential-less SSH host
  the manifest no longer names, gives the LOCAL host `username: "deploy"`.
- `nest-api/mock/sshd.ts`, `host-keys.ts`, `example-dns.cjs`, `sshd.spec.ts`: the three machines'
  servers, their host keys, their names; `df-on-path.ts` starts the machines and preloads the
  names around the API.
- `nest-api/mock/images.ts`, `corpus.ts` (`kind: "image"`): real pictures for every image file.
- `nest-api/mock/corpus.spec.ts`: every volume's mount point must be a directory the tree makes.
- `nest-api/prisma/seed.ts`: the hosts come from the manifest.
- ~270 `data-testid`s across `src/components/`; `Overlay` takes `testId`; `ContextMenu` items are
  `menu-item` + `data-action`.
