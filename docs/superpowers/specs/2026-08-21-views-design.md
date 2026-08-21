# Saved views (TRE-37)

## The problem

The mockup keeps its views in `localStorage`, which loses them per browser and
per machine. Moving them into the database is the ticket's headline, and it is
the easy half. The half that decides the design is §3:

> The active view shows an amber dot once the current layout no longer matches
> what was saved. Comparison is over the same fields the view stores […]
> Selection and cursor are excluded — a dot that appears because you pressed an
> arrow key is noise.

That dot can be wrong in two directions and neither one throws.

A dot that fails to appear is the worse of the two: somebody changes a pane,
presses `⌥3` expecting to get back, and gets what they already had — with no
error, because nothing failed. A dot that appears on its own is merely
exhausting, and it is what happens if the comparison includes anything that
moves while a person is only reading.

So the question this ticket had to answer first is *what a view is*, precisely
enough that both halves of that comparison are a list rather than a habit.

## What was already there

Two of the three hard parts were built by other tickets.

`Views` has existed in the schema since TRE-6. Its columns described a layout
this app has never had — `split` as a percentage, `solo` as a separate
nullable pane name — because they were written before TRE-18 settled what the
URL actually carries, which is one three-valued `split` where `left` and
`right` *are* solo.

TRE-51 built the rest: `StoredLayout`, a strict schema for the whole layout,
and `serialiseLayout`, a canonical serialisation of it. It exists because the
same trap lives one model over — the restored layout comes out of a schema (`a`
and `b` first) and the live one is assembled from the URL (`a` and `b`
appended), and `JSON.stringify` keeps insertion order, so two identical layouts
compare unequal.

And TRE-18 put the layout in the URL, which is what makes restoring a
navigation. The back button undoes a view for free, and the address that
results *is* the view.

## The decisions

### 1. A view stores a layout, not a translation of one

The six layout columns were replaced by one `layout` blob, and brevity is not
the reason. The front already has exactly one description of a layout and
exactly one canonical serialisation of it, and the dirty dot is a string
comparison against that serialisation. Columns in a second vocabulary would be
a translation on every read and every write, and a translation is where the dot
starts lying.

`shortcut VARCHAR(32)` became `slot INT`. It held `"⌥3"`; it holds `3`. How a
chord is spelled belongs to `helpers/keys.ts` and to nowhere else (TRE-36), and
moving a glyph there must never be a migration here.

`hostLabels` was added: host id to the label that host had when the view was
saved. It is never compared — renaming a host must not make a view look unsaved
— and it exists for exactly one sentence. A view whose host has been deleted has
to be able to name the machine that is gone, and the id alone cannot, because
the row it names is the row that no longer exists.

The migration drops columns and adds two `NOT NULL` Json ones with no backfill,
which is safe for one reason and only one: nothing has ever written to this
table. `Views` shipped with the schema and this is the first ticket to give it
an endpoint, so every install's copy is empty. Checked on the server before the
deploy.

### 2. What a view remembers, and what it refuses to

`ViewLayout` is a strict subset of `StoredLayout`:

| stored | | excluded | |
| --- | --- | --- | --- |
| `a`/`b` host, path, sort, dir | | `active` | the keyboard moves between panes constantly |
| `split` | incl. solo | `view` | list or detail is a preference, not an arrangement |
| `insp` | | `du`, `duRoot` | the strip is opened and closed while reading |
| `heat` | | `a.tail`, `b.tail` | a mark on one file, not a layout |
| `glob` | | | |

`helpers/views.ts` holds the narrowing (`layoutOf`), the serialisation
(`serialise`) and the comparison (`isDirty`), which means "which fields does a
view compare" is answered once rather than at the save, the update and the dot
separately. Every field is named explicitly in `serialise` rather than spread:
TypeScript catches a field *removed* from `ViewLayout`, and `verify:views`
catches one *added* by asserting the key list.

`verify:views` tables both halves. Ten changes that must show, five that must
not, and the five are the ones nobody would think to try.

Restoring clears both panes' `tail`. A tail follows a file on the pane's own
host (TRE-34), a view moves the pane — possibly to another machine — and a mark
carried across is a stream pointed at a file that is very likely not there.

### 3. `⌥1`–`⌥9` are chords but not commands

They are built from the same `Chord`, matched by the same `matches` and spelled
by the same `writeChord`, and they are deliberately **not** in `KEYS`. That
table maps a fixed operation to a chord; these reach whatever the account has
decided, and on a fresh install they reach nothing. Putting them in it would
mean inventing nine `CommandId`s for operations that do not exist, and
`commandFor` would answer `view3` for a key that runs nothing.

`Chord` gained a `code`, and the ⌥-digit chords are the only ones that carry
one. On a Mac, `⌥1` is not `"1"` — the layout decides, and it is `¡` on a US
keyboard — so a handler matching on `event.key` would work on nobody's machine
but the one it was written on. `Digit1` is the same key everywhere. `matches`
prefers `code` when both the chord and the event have one, and falls back to
`key` otherwise, because a hand-made event has no `code` and a chord that only
a browser can check is a chord nothing can test.

⌥ rather than ⌘ is not decoration: `⌘1`–`⌘9` is how every browser switches
tabs, and the page never sees it. Same reason TRE-69 gave up `⇧⌘N` and TRE-36
gave up `⌘⇧D`.

`verify:keys` grew from 112 assertions to 195: every slot round-trips through a
Mac event and a Linux one, refuses an extra modifier, resolves to no command,
and collides with nothing in the table. Plus the structural half — the explorer
resolves slots through `viewSlotFor` and names no `Digit` itself, the sidebar
reads its `⌥1–9` off the table, and none of the five view components spells a
`⌥` at all.

### 4. A shortcut already in use moves, and says so

Refusing would be correct and useless: the operator wants `⌥3` to be this view,
and the only thing in the way is a decision they are entitled to change. So the
write clears the other view's slot **in the same transaction** — the unique
index is the thing being worked around, and two round trips would leave a
window where neither view holds the chord.

Create and update therefore answer with `{ view, displaced }` rather than the
row. They settle two facts and only one of them is the row, and a bare row
would leave the client diffing two lists to work out what its own write did.

It is said twice, and the first one matters more: the form names the holder
under the picker *before* the write, because moving somebody's shortcut is a
decision and a decision reported afterwards is an apology. The toast then
reports what the server actually did.

### 5. A broken view is reported, not degraded

This is the one place where a saved view and a session restore have to behave
differently, and the difference is who asked.

A cold open nobody requested should quietly fall back to the defaults, which is
what `degradeToKnownHosts` does in TRE-51: the reader did not ask for it and
should not have to acknowledge its failure. Pressing `⌥3` *is* a request for a
specific arrangement. Answering it by silently landing on `/` would be the app
doing something else without saying so, and landing on whatever host happens to
be bound would be worse — the same paths, on the wrong machine.

So a view naming a host the account no longer has opens a dialogue that names
the machine (from `hostLabels`), offers a host per broken pane, and lets the
other pane restore exactly as saved. The path is not carried onto a new host:
`/var/log/nginx` on a different box is how a rebound view lands in an empty
directory and reads as broken rather than as moved.

Whatever is chosen is applied and **not** written back. The view still says what
it said; the layout no longer matches it, so the dot appears — which is true,
and which puts "Update from current" one right-click away.

### 6. Four surfaces, one list

The strip in the top bar, the rows in the sidebar, the palette's VIEWS group
and `⌥1`–`⌥9` all restore the same way. The palette group is what TRE-36 left
room for — it takes its entries as a list, so this was a group rather than a
surface — and it is also the strip's overflow: `+n` opens the palette on the
word `view` rather than growing a second menu nobody would find twice.

`ContextMenu` now takes a `MenuEntry` rather than an `Action`. The views menu is
five rows about a saved layout, belongs to no action registry and has no
`ActionId` to be keyed by, and it wants that panel's keyboard, its disabled
treatment and its paddings. A second menu written beside it would be a second
of each.

"Update from current" is the only row that ever goes dead, and only for the view
actually on screen, and only because there is nothing to write. Any other view
is a perfectly good thing to overwrite with what is showing.

### 7. What the two checkboxes do

Unticking a box **neutralises** the field rather than omitting it, so a stored
layout is always complete. A partial layout restored by leaving whatever was on
screen alone sounds tidier and is not: a view called `log triage` would then
restore differently depending on what the last view left behind, which is the
one thing a *saved* view must never do.

The neutral values are the URL's own defaults, and they have to be — a view
storing `sort: "name"` because the box was unticked must restore a pane to
exactly what an untouched pane looks like. Any other value would make "do not
save the sort order" mean "save this other sort order instead".

They appear only when saving a new view. Editing one cannot change what it
stores; that is "Update from current", a different entry doing a different
thing, and a checkbox here would let a rename do it by accident.

### 8. Two inks, and the mockup contradicting itself

2a draws every quiet line in this feature in `#4d7f99` — the chord beside a
name, the `⌥1–9` in the section header, the small caps in the form. That is this
app's `--color-ink-faint`, and it clears AA on nothing here: **3.82:1** on
`chrome`, **2.92:1** on `raised`, **2.61:1** on `line`. `ink-dim` is the next
step up the same ladder — 2a's own `#6fb2c9` — and clears all three at 7.06,
5.39 and 4.82.

The chip for the restored view is the interesting one, because the mockup's own
two decisions cannot both be drawn. It fills that chip with `#1f7cab` and writes
the name in `#04202f`, which is 3.62:1 — the pair TRE-78 took out of fourteen
other places. It *also* draws the amber unsaved dot inside that chip, where
amber measures **1.59:1**. Lifting the ink would not fix the dot, and darkening
the dot enough to clear the fill takes it to `#503719`, which is not amber any
more.

So the chip takes the treatment this app already has for "this row is the
current one": TRE-36's `line` fill with an accent edge. The name reads 10.03:1,
the chord 4.82:1, and the dot 3.90:1 — which is what 1.4.11 asks of something
that is not text. Every number is in `verify:contrast`, 89 pairs to **102**, with
the mockup's beside ours for the record.

Two shared sidebar primitives were lifted in passing, because the VIEWS section
renders through them: the section counter and the empty line. The other 115
instances of the same pair across 30 files are **TRE-81**, filed rather than
fixed, and it subsumes TRE-80.

## What was left out

**No view id in the URL.** A link is already a layout — that is what TRE-18
built — and carrying a view id would mean a recipient seeing a name for
something that is not theirs. What travels is the arrangement; the name for it
is this session's.

**No restore toast.** 2a raises one because its panes are fake. Here the chip
lights, both panes move and the sidebar row takes its edge; a toast repeating
what just visibly happened is noise.

**The strip does not measure.** 2a measures the viewport and pops the last chip
that would overflow. A fixed four is honest at every width this app declares
itself usable at, and everything past it is one keystroke away rather than
hidden.

**Sharing views between users**, and **views that name a host by name rather
than id**, are the ticket's own out-of-scope.

## Two things found in passing

**A literal NUL in `palette.tsx`.** TRE-36 wrote the palette's row-signature
separator as the character rather than the escape:
`rows.map(…).join("\0")` with an actual `0x00` byte in the source. It compiles
and it works, and it also makes git treat the file as binary — the last commit's
diff for it reads `Bin 16962 -> 17319 bytes`, and `grep` finds nothing in it.
Written as `"\u0000"` now. The same byte was in
`host-key-verification.spec.ts`, inside a deliberately malformed SSH blob, and
is escaped for the same reason.

**The quiet ink.** Filed as TRE-81 rather than fixed: `--color-ink-faint` is
2a's `#4d7f99` and clears AA on none of this app's five grounds, and it appears
117 times across 30 files. Two shared sidebar primitives were lifted here
because the VIEWS section renders through them. TRE-81 subsumes TRE-80.

## Verification

- `pnpm verify:views` — 79 assertions: the serialisation is order-independent
  and its key list is pinned, ten changes that must show the dot and five that
  must not, the two checkboxes, the shortcut suggestion, every sentence the UI
  writes, and a broken view's report and rebinding.
- `pnpm verify:keys` — 195, up from 112: the nine slots both ways, on a Mac
  event and a Linux one, and nothing outside the keymap spelling one.
- `pnpm verify:contrast` — 102 pairs, thirteen of them this feature's, on all
  four grounds it draws on.
- The API's own suites: 902 unit, 18 against a real MariaDB — four of those new,
  pinning `@@unique([userId, slot])` with its distinct NULLs, per-account
  scoping, and the name constraint.
- `ViewsService` driven against the live database from a scratch harness: the
  slot move and its report, `null` clearing a chord, re-saving your own chord
  displacing nobody, a duplicate name as 409, another account's view as 404
  rather than 403, and a hand-edited `hostLabels` row dropping a non-string.

**Not verified locally.** The private page needs a session, and the machine
already had the account's own dev servers on both ports. Unexercised in a
browser: the strip and the sidebar rows, the save form against a real pair of
panes, `⌥1`–`⌥9`, the rebind dialogue, and the palette's VIEWS group.
