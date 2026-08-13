# Recursive delete with typed confirmation (TRE-25)

## The problem

The one operation with no undo. There is no trash on a remote host, and a
recursive delete of the wrong directory is unrecoverable. The friction is the
feature: the operator types the name, or `delete N items`, before the button
comes alive.

## What is already there

Most of the dangerous machinery exists and was written for the recursive
`chmod` in TRE-21.

- **`walkTree`** is post-order, skips symlinks without following them, stops at
  an entry ceiling, and reports the directories it could not read. Post-order is
  precisely what a delete needs: children before the directory holding them.
- **The `rm` toolbar button** already exists, `danger: true`, disabled with
  `unavailableReason: "Delete arrives in TRE-25"`. It wires through `OPENERS` in
  `(private)/page.tsx` the way `rename` and `chmod` do.
- **The audit interceptor writes its row before the handler runs** and settles it
  afterwards, so "audited before it runs, survives a partial failure" needs no
  special handling — `@Audited` already behaves that way.
- **`consume(rule, scope, amount = 1)`** already takes an amount, so a limit can
  be spent in units of entries rather than requests.
- **`ActivityLog.kind`** is a shape-checked `VarChar(32)`, not an enum, so
  `file.delete` needs no migration.

`CountResult` is the one near-miss: it reports entries but no bytes and no
ownership, so the modal cannot be fed from it.

## Three tiers of refusal

The walk already stops at `DEFAULT_ENTRY_CEILING`, 10,000. That number sets the
scale for everything else, and the three thresholds are chosen to tell one
coherent story rather than to overlap:

| entries | outcome |
|---|---|
| ≤ 1,000 | ordinary delete |
| 1,000 – 10,000 | refused: needs an elevated session (TRE-29) |
| > 10,000 | refused by the walk ceiling, with the existing "raise the knob" message |

All three are environment-overridable, in the style `entryCeiling()` already
established. The elevation threshold defaults to `MAX_PATHS` — 1,000 — because
that constant already carries the sentiment this threshold needs: a selection,
not a filesystem.

## Design

### 1. Two routes, mirroring rename

`POST /fs/delete/plan` walks once and returns what the modal shows and the token
it must demand. `POST /fs/delete` executes.

The split is TRE-22's, and for the same reason: the number the operator confirms
has to come from the same walk that will do the work, not from a second guess.

### 2. The token, and what it honestly buys

The server recomputes the expected token from the request's own paths — the
basename for one entry, `delete N items` for several — and compares.

It is worth being exact about the value of this, because it is easy to oversell.
The token is not a secret: any client that can name the paths can compute it, so
it stops no determined caller. What it does stop is a client deleting a
**different set than the operator confirmed**. Three items confirmed and three
hundred sent no longer agree with the token that was typed, and the request is
refused. That is a real failure mode — a selection changing under a modal — and
it is the one the check is for.

### 3. Refused before anything runs

Independently of the roots, and independently of owner bypass (TRE-48):

- `/`, and any path shallower than a configurable depth (default 2)
- a path that is an allowed root itself
- a path outside a `WRITE` root, via the TRE-11 guard with `intent: "write"`
- any walked path that is a **mount point**
- any walked path that is **denylisted** (TRE-52)

The denylist case refuses the whole operation rather than skipping, which is
where this departs from recursive `chmod`. Skipping a protected path there
leaves a file unchanged; skipping one here leaves its parent non-empty, so the
`rmdir` fails and the operator is told the delete succeeded while the tree is
still standing. Refusing up front, naming the protected path, is the honest
answer.

### 4. Mount points, without `st_dev`

The requirement is that a recursive delete stops at a mount point rather than
walking into a mounted share. The obvious implementation compares `st_dev`
against the parent — and it is not available: `FileStat` has no `dev`, and SFTP
v3 carries no such attribute, which is the same reason `inode` is optional.

So the mount table is read instead. One `df -P` per delete — `df` is already in
`ALLOWED_PROGRAMS` — and its mount-point column is the list. Any walked path
that *is* one of those paths is a crossing, and the operation is refused.

One round trip for the whole tree rather than one per directory, identical on
local and SSH hosts, no argv length limit, and no dependence on GNU-versus-BSD
flags. The parser is pure and lives in its own file, so it is unit-tested
without a filesystem.

The alternative considered was a batched `stat -c %d` over the directories,
which is the textbook check and is more precise about exotic cases. It was not
chosen: `-c` is GNU-specific where `df -P` is POSIX, and this repository has
already been bitten once by a BSD/GNU `stat` difference.

### 5. Execution

Post-order from `walkTree`: `unlink` for everything that is not a directory,
`rmdir` for the directories, both already on `HostDriver`.

Per-path outcomes, so one unreadable file does not abandon the other nine
hundred, and the response names exactly which paths survived. Bytes freed are
summed from the walk's own `FileEntry.size` and counted only for entries that
were actually removed — the apparent size, not the block usage, which is what
the walk can stand behind without a second `du`.

### 6. Limits and audit — enforced by a test, not by discipline

`audit-coverage.spec.ts` fails the build unless every destructive route names a
limit and every limit in `LIMITS` is spent by a real `consume(LIMITS.x, …)`
call. `TO_ATTACH` names TRE-25 against two of them, and this is the change that
must spend them:

- `fileDelete` — 10 a minute, per request, attached through
  `@Audited({ kind: "file.delete", limit: LIMITS.fileDelete })`
- `entriesDeleted` — 50,000 an hour, spent in units after the walk, which is the
  limit that bounds volume rather than frequency

Both move out of `TO_ATTACH` and into `LIMITS`.

### 7. The modal

`delete-modal.tsx`, following `rename-modal.tsx`'s Overlay and panel shape: one
row per entry with its type tag and size, "recursive" carrying the real entry
count for a directory, the total to be freed, the risk line, and the exact
`rm -rf …` that would run. The token field is red until it matches and green
after; the CTA is dark red and inert until then.

A directory holding 400 GB and one holding 4 kB must not look the same, which is
the whole reason the plan endpoint walks before the modal renders.

## Not in scope

- Trash and restore, and secure erase — both named out of scope on the ticket.
- The elevation **prompt**. This ships the threshold and the refusal; TRE-29 has
  only to make it openable.

## Verification

Unlike `front/`, `nest-api` has a test runner, and the parts of this that can be
tested without a filesystem are the parts most worth testing:

- `delete-plan.spec.ts` — token derivation for one and for many, the risk flags,
  and the `df -P` parser against real `df` output including paths with spaces.
- `pnpm test` in `nest-api`, which includes `audit-coverage.spec.ts` and will
  fail until both limits are attached.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` in `front/`.
- By hand: delete a file, a multi-selection and a directory; a wrong token
  refused via `curl` with the UI bypassed; a mount point refused; a symlink to a
  directory unlinked with its target untouched.
