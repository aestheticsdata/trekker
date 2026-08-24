# Undo for recursive chmod and chown (TRE-75)

## The problem

TRE-21 shipped `chmod` and `chown` with a recursive toggle. One click can
change thousands of entries, and nothing records what they were. The modal
already warns — it fetches the affected-entry count before you commit — but a
warning is not a way back. A checkbox is easier to tick than `-R` is to type,
and the consequence is identical. This is the one place Trekker is genuinely
more dangerous than the shell it wraps: not because it can do more, but
because the mistake is cheaper to make. It gets worse once a recursive
`chown` can run under sudo, across a tree the account could not otherwise
touch at all.

## What is already there

- **The walk already fetches what undo needs, and throws it away.**
  `walkTree` (`tree-walk.ts`) returns `details: WalkedEntry[]`, one per
  entry, carrying `mode` and `uid` already. `permissions.service.ts`'s
  `apply()` calls `walkTree` at line 262 for the recursive case and only ever
  reads `walked.paths`, `.skippedLinks`, `.unreadable` — `.details` is
  computed and discarded. Capturing it is not a new fetch.
- **`WalkedEntry` is missing `gid`.** `FileEntry` (what `driver.list()`
  returns) already carries `gid` on both drivers — `tree-walk.ts` just never
  copies it onto `WalkedEntry`. Two call sites build it: the main push and
  `describeRoot`'s entry for the root itself.
- **The non-recursive case is not actually a gap.** `driver.stat()` already
  exists on both `LocalDriver` and `SshDriver` and already returns `gid`
  alongside `mode`/`uid`. The non-recursive branch of `apply()`
  (`targets = [realPath]`, line 259) just never calls it. No driver work
  needed — one `stat()` per named path, bounded by `MAX_PATHS` the same way
  a selection already is.
- **Every guard this needs already exists and is reusable as-is:** the path
  guard (`PathGuardService.validate`, intent `"write"`), the denylist
  (`localDenial`), the rate limiter (`RateLimitService.consume` via
  `@Audited`'s `limit`), and the sudo window (`SudoRunnerService.isOpen` /
  `.run`, tried after an unprivileged attempt fails with `EACCES`/`EPERM`).
- **No existing table shape to copy.** `ActivityLog` has no child relation at
  all today. `TransferItems` and `DiskScanEntries` are the closest thing —
  one row per entry, referencing a parent — but both hang off their own job
  table, not `ActivityLog`. This is a new pattern, not a reuse of one.
- **Nothing outside the audit module can currently read the row it just
  opened.** `AuditService` binds the pending row's id onto the request
  (`bindRow`) so the interceptor can settle it later, but the only public
  accessor is `annotationOf` — for a handler to *add* facts, not to *read*
  the id. Attaching snapshot rows to the right `ActivityLog` row needs a
  symmetric `rowIdOf(request)`.

## Design

### 1. Data model

A new table, `PermissionSnapshots` — one row per file the operation touched:

| column | meaning |
|---|---|
| `id` | row id |
| `activityLogId` | FK → `ActivityLog.id`, `onDelete: Cascade` |
| `path` | the entry's path |
| `mode`, `uid`, `gid` | the values *before* this operation changed them |
| `createdAt` | for the retention pass |

No "which fields matter" column. Restoring a chmod reads `mode`; restoring a
chown reads `uid`+`gid`. Which one applies comes from the parent
`ActivityLog.kind` (`file.chmod` vs `file.chown`), not from anything stored
redundantly on the snapshot row.

Kept out of `ActivityLog.payload` for the reason the ticket already gives: a
recursive change over a large tree would write a payload orders of magnitude
bigger than every other row in a table the activity strip reads on every
load.

### 2. Getting the row id into the fs module

Add `rowIdOf(request): string | null` to `AuditService`, mirroring
`annotationOf`. The chmod/chown controller methods read it after the
interceptor has opened the row and pass it into
`this.permissions.chmod(..., activityLogId)` /
`.chown(..., activityLogId)`.

### 3. Capture

- Recursive: after `walkTree` returns, write one `PermissionSnapshots` row
  per `WalkedEntry`, from `walked.details` (now carrying `gid` too) — no
  second walk, no extra round trip.
- Non-recursive: one `driver.stat()` per path in `targets`, same shape,
  written the same way. This is the one place that pays a round trip it
  didn't before, and it's bounded by `MAX_PATHS` — a handful of calls.
- Written only for paths that end up in the operation's own `changed` set —
  never for one that failed or was skipped — so a snapshot never claims to
  cover an entry the change never actually reached.

### 4. Undo

Two routes, mirroring the existing split: `POST /fs/chmod/undo` and
`POST /fs/chown/undo`, each taking the `activityLogId` of the operation to
reverse.

Same treatment as any other write: path guard, denylist, rate limit
(reusing `LIMITS.permissionChange` — it's the same class of operation, no
reason for a second knob), sudo window if the original needed one,
`destructive: true`. Its own audit row (`file.chmod.undo` /
`file.chown.undo`), with `payload: { undoes: activityLogId }` — a plain
reference, not a schema relation, for the same reason `ActivityLog` stays
free of a self-referencing FK: this is one small fact about the row, not
bulk data anything needs to join on.

Restores only what that operation touched — `chmod.undo` writes `mode`
only, `chown.undo` writes `uid`+`gid` only. A chown that happened after an
older chmod is never clobbered by undoing the chmod, even though the
snapshot captured `uid`/`gid` too at the time (free, from the same walk).

Per-path outcome, same as the original operations: a path that has since
vanished or changed identity is skipped and reported, not silently passed
over.

### 5. Retention

Snapshot rows are deleted 30 days after their own `createdAt` — independent
of the `ActivityLog` row's normal retention (90 days ordinary / 365
destructive). The audit summary line survives as long as it always did;
only the ability to undo it expires, and sooner.

A new pass in `RetentionService`, same batched-delete-by-id shape as the
existing ordinary/destructive prune, on its own 30-day schedule — this is
the pass that actually removes the rows in the normal case. The FK's
`onDelete: Cascade` is only a backstop for referential integrity if an
`ActivityLog` row is ever deleted first; it is not the retention mechanism.
Relying on that cascade alone, instead of an independent 30-day pass, would
mean snapshots inherit the 365-day destructive window, which is exactly what
this is avoiding.

### 6. Frontend

`Toast` gains an optional action slot:

```ts
action?: { label: string; onClick: () => void }
```

rendered as a button in the toast row, no change to the 6-second
auto-dismiss. The chmod/chown completion toast passes `action: { label:
"Undo", onClick: () => undo(activityLogId) }` when the operation actually
changed something.

The activity strip gets the same button on `file.chmod`/`file.chown` rows.
Both call the same undo route; the server-side skip/report handles a
snapshot that's aged out or a path that's moved, so the UI doesn't need to
know how old is too old.

**Reachability is intentionally narrow.** The only two places undo can be
triggered are the toast (seconds) and the strip, which shows the last 8
activity items — there is no history page today. 30 days of retained
snapshots is a safety margin, not a promise of a 30-day browsable undo list;
in practice this covers "I just did that" and "I did that a few actions
ago," which is the case the ticket itself says undo is actually wanted for.
A paginated history view is a separate, larger feature and is not part of
this.

## Not in scope

- A browsable/paginated undo history. The backend `/activity` endpoint
  already supports `cursor`/`from`/`to` for one, but no frontend page
  consumes it yet, and building one is a separate feature.
- Anything besides `chmod`/`chown`. Delete is not undoable and this must not
  suggest otherwise; copy/move have their own story.
- Undoing an undo.

## Verification

- A spec for snapshot capture (recursive and non-recursive) and restore
  logic that needs no filesystem: which fields a chmod-undo vs chown-undo
  writes, that an operation which changed nothing writes no rows, that a
  vanished/changed path is skipped and reported.
- `audit-coverage.spec.ts` will refuse to pass until both new routes carry a
  limit — reusing `LIMITS.permissionChange` satisfies it without a new entry.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` in both
  `nest-api` and `front`.
- By hand: recursive chmod, undo from the toast; recursive chown, undo from
  the strip; chmod an entry, chown it again, undo the chmod — confirm only
  mode reverts and the newer owner survives; undo after a path has been
  deleted or replaced — confirm it's reported, not silently skipped.
