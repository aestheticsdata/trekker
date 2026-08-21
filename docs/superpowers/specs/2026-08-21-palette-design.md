# A palette that teaches the keyboard (TRE-36)

## The problem

The ticket reads like a search box over a list of commands. The sentence that
actually decides the design is further down:

> Entries carry their shortcut, and it is read from the same keymap the shortcut
> handler uses. Two sources of truth here means the palette teaches shortcuts
> that no longer work.

A command palette in a dense keyboard application is not primarily a way to run
things. It is the index: it is how somebody finds out the app has an F6, and it
is the only surface that says the operation and the key in the same line. That
only works while the line is true. A palette advertising `F3` for a download the
handler stopped listening for does not read as a stale label — it reads as a
broken application, to somebody who then stops trusting the other fifteen.

So the palette could not be built first. The keymap had to be.

## What was actually there

Before this ticket a chord was written in four unrelated places:

| where | how |
| --- | --- |
| `components/shell/actions.ts` | `hint: "F5"` beside the label |
| the explorer's key handler | `case "F5":` in a switch |
| `useShortcut` | `key: "i"` |
| the top bar | the literal string `⌘K` |

Nothing held them together, and two of them were already wrong. `compare`
carried `hint: "⇄"` and `upload` carried `hint: "↑"`. Neither is a key anybody
can press, and the second is a key that already means "move the cursor up".
Drawn in the toolbar they read as decoration; drawn in a palette beside `F5` and
`⌦` they would have read as instructions.

## The decision

### 1. One table, read from everywhere

`helpers/keys.ts` holds every chord this app answers to, keyed by `CommandId` —
which is `ActionId` plus the four things that open or close a piece of the app
rather than acting on a file (`inspector`, `selectAll`, `terminal`, `palette`).

```ts
export const KEYS = {
  open: { key: "Enter" },
  copyTo: { key: "F5" },
  rm: { key: "Delete" },
  cut: { key: "x", meta: true },
  terminal: { key: "Enter", alt: true },
  …
} as const satisfies Readonly<Partial<Record<CommandId, Chord>>>;
```

Three functions serve it and nothing else spells a chord:

- `writeChord` turns one into what a person reads — `⌥⇧⌘K`, modifiers in
  Apple's order.
- `matches(event, chord)` is what a handler asks. It checks every modifier,
  including the ones the chord does not want, so `⌘X` cannot fire on `⌥⌘X`.
- `commandFor(event)` walks the table backwards, and is what the explorer's key
  handler now switches on instead of `case "F5"`.

`meta` covers ⌘ and Ctrl together rather than distinguishing them, which is the
rule `useShortcut` has followed since TRE-17.

**Absence is meaningful.** `compare`, `chmod` and `hash` have no chord and
therefore advertise none. 2a's palette draws `⌘⇧D` beside "compare both panes";
that one is not implementable, for exactly the reason TRE-69 ruled out `⇧⌘N` —
Chrome and Firefox both take `⌘⇧D` for bookmarking every open tab before the
page sees the key. The glyph 2a draws beside `compare` and `upload` survives as
`mark`, a separate field, and the toolbar renders `hint ?? mark`. The
distinction is the whole point: one of the two is a thing to press.

`pnpm verify:keys` checks the arithmetic (every chord round-trips, no two
commands claim one, an extra modifier is refused) and the structure: the
registry contains exactly one `hintFor(` call and no `hint:` literal, the
explorer switches on `commandFor(event)` and has no bare `case "F5"`, every
`useShortcut` is handed a chord, and the top bar names its own chip from the
table.

### 2. Three surfaces, one registry

`resolveActions` gained a `"palette"` surface and a shape, which is what
`components/shell/actions.ts` said it was for from the day TRE-70 wrote it.
`chooseAction` was split into `performAction(id, pane, entries)` so the context
menu, the palette and the F-keys share one dispatcher rather than three that
drift.

The palette's shape is nearly everything. The two omissions are `open` and `open
in other pane`: both mean "the row the cursor is on", and a palette cannot aim
at that row any better than ↩ already does.

Every action gained a `note` — one line on what it does, which the palette draws
as the second line of the row and the ranking matches against. `verify:palette`
asserts that every row the palette shape produces has one.

**Unavailable entries are drawn, not hidden.** An action that cannot run for
this selection is quiet, carries the sentence why in place of its description,
and the keyboard still walks onto it. Only the *initial* cursor skips them, so
↩ the moment the panel opens always does something. A palette that hides what it
cannot do right now is a palette nobody can learn the application from.

### 3. Ranking

`helpers/palette.ts` is pure and imports nothing but a type, so
`verify:palette` puts it through node.

The query is split on whitespace and **every token has to land somewhere** —
that is what "out of order" means here: `pane copy` and `copy pane` score
identically, because neither is asked to appear as written. A token that lands
nowhere rejects the entry outright rather than scoring it low; an entry that
survives as you type more of what you do not want is an entry the query can
never get rid of.

Grades, best to worst: the start of the label, a word boundary inside it,
anywhere in it, a subsequence of it, the description, the group.

There is deliberately **no loose grade for the description**. A description is a
sentence and four characters are a subsequence of almost any sentence: with one,
typing `pane` returned `rename`, whose description happens to contain a p, an a,
an n and an e in that order. That was found by the table, not by eye.

Ties keep declaration order, which is why the sort runs on a decorated copy: the
sort is specified as stable, the inputs are not, and the palette's order with
nothing typed is somebody's arrangement rather than an accident.

Group headers are drawn **once per run, not once per group**. Ranking
interleaves the groups, so the same word can appear twice in one list — and it
reads correctly, because each header is telling the truth about the rows under
it.

### 4. Typing a path

An input starting with `/` is a path, and nothing else is. The test is the
leading slash and only that: this is a Unix file manager, an absolute path is
unambiguous, and the moment a heuristic is involved it becomes a mode somebody
falls into by accident.

`pathQuery` splits it into the directory to list and what has been typed of the
next segment. The four shapes are different questions and the trailing-slash
pair is where it goes quietly wrong, so they are tabled:

| typed | `dir` | `leaf` | `target` |
| --- | --- | --- | --- |
| `/` | `/` | | `/` |
| `/srv` | `/` | `srv` | `/srv` |
| `/srv/` | `/srv` | | `/srv` |
| `/srv/me` | `/srv` | `me` | `/srv/me` |

The directory is fetched on the same query key every listing in the app uses, so
a directory either pane has walked through completes on the keystroke. `dir`
changes once per `/` typed rather than once per character, so this is at most
one request per path segment.

`⇥` completes to the longest head every candidate shares, the way a shell does —
not to the first match. With `log` and `logrotate.d` under `/var`, the first
match is a guess and the common head is a fact. A single candidate completes
with its `/` attached, because the only reason to complete a directory is to
carry on into it.

The ordinary entries are still ranked against the same string rather than
suppressed. `/srv` is a perfectly good query for a favourite called
`/srv/backups`, and hiding it because the input starts with a slash would make
path mode a trap rather than a shortcut.

### 5. When nothing matches

2a's empty state says `↩ runs it in the shell instead`, and that is implemented
rather than paraphrased: the line goes to TRE-35's terminal, which opens if it
was closed and runs it exactly as if it had been typed there — echoed at the
prompt, kept in the history, through the same parser.

That stays honest against a restricted command set. An unparseable line gets the
refusal that lists what the terminal does take, in the one place that can show
it. A dead keypress on an empty list teaches nothing.

The handover is a `pending` prop rather than a push, because the panel owns the
buffer and may not be open yet. It carries a ref: StrictMode mounts an effect,
tears it down and mounts it again with the same props, and without a record of
what has already been taken the line is echoed and run twice.

### 6. The panel

2a states the geometry outright — a 620px panel 86px from the top, a 42px input
row, 34px rows, a 26px footer, and a list that stops at 330px and scrolls. Two
of those are tokens (`--spacing-palette`, `--spacing-palette-body`) and the rest
come off the spacing scale, which is the split the top bar already uses: a
panel's own size is a design decision, the controls inside it are arithmetic.
Measured in headless Chrome rather than read: 620 × 253.7 at y=86, rows at
exactly 34 with a 27.3px two-line stack inside them.

`Overlay` gained an `align` prop. A dialogue is centred because it is a thing to
read and answer; the palette is pinned to the top because it is a thing to type
into, and a list that grows and shrinks with every keystroke would otherwise
slide up and down under a cursor somebody is aiming at.

Two inks are not 2a's, and it is the fourth time this has happened for the same
reason (TRE-33, TRE-34, TRE-35). 2a draws the group headers and the `›` in
`#3e8fae` — 4.34:1 on this ground — and every quiet line in `#4d7f99`, which is
3.64:1. Both under AA, the second one for the line that says what an entry does.
The hue is the mockup's, the ground is the mockup's, and the ink is lifted until
it clears: `--color-on-strip-label` at 4.76:1 and `--color-on-strip-dim` at
4.87:1.

The row's second line is the awkward one, because it has two grounds — the panel
under an ordinary row, and `--color-line` under the selected one. On that fill
nothing between `ink-faint` and `ink-dim` clears at all; the whole span from 2.61
to 4.82 is a wall. So the second line switches ink with the row, exactly as 2a
already switches the icon and the label.

## What was left out

**VIEWS does not draw.** There are no saved views yet — TRE-37 builds them —
and a group header over nothing is not a feature waiting to happen, it is a
claim about what this app has. The palette takes its entries as a list, so that
ticket adds a group rather than a surface.

**The disk-usage strip keeps 2a's failing pair.** It is drawn on the same
`--color-strip` ground and still carries `text-accent-soft` and `text-ink-faint`
inline, where no check can see them. Filed as TRE-80 rather than fixed here; the
two new tokens are named for the ground rather than for the palette, so that fix
is a class swap.

## Verification

- `pnpm verify:keys` — 112 assertions: the table walks both ways, refuses a
  chord with something extra held, and nothing outside it spells one.
- `pnpm verify:palette` — 121 assertions: ranking, ordering, group runs, the
  path table, completion, and every palette row carrying a note and a glyph.
- `pnpm verify:contrast` — 89 pairs, sixteen of them the palette's, on both of
  its grounds.
- `pnpm verify:menu` — 3691 assertions, unchanged, now through the alias hook.
