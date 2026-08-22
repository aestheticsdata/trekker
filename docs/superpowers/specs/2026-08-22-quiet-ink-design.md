# The quiet ink, and the check that could not see it (TRE-81, TRE-80)

## The problem

`--color-ink-faint` was `#4d7f99`, which is mockup 2a's own colour for every
quiet second line, and it cleared WCAG AA on none of the five grounds this app
draws it on:

| ground | | ratio |
| --- | --- | --- |
| `chrome` | `#08202f` | 3.82 |
| `strip` | `#0a2438` | 3.64 |
| `app` | `#0c2a44` | 3.36 |
| `raised` | `#0d3552` | 2.92 |
| `line` | `#0f3d5c` | 2.61 |

`text-ink-faint` appeared 114 times across 30 files. That is not a colour used
once in the wrong place — it is how the app wrote anything quietly. Beside it,
2a's accent ink `#3e8fae` cleared one ground of the five, and it appeared under
three names: `accent-soft` used as text, `ink-link`, and the palette's
`on-strip-label`.

None of it was reported, and the reason is the interesting half. `verify:contrast`
had 102 pairs in it and every one of them passed, because it only measured what
somebody had first written into a table in `src/helpers`. A class name typed
straight into a component was a pair no check could see. Five surfaces had been
corrected exactly because their tickets forced a table into existence
(`tail.ts`, `terminal.ts`, `palette.ts`, `press.ts`, `views.ts`); everything else
was invisible.

## Decisions

### 1. Lift the ladder, not the surfaces

TRE-33, TRE-34, TRE-35, TRE-36 and TRE-37 each hit this on one surface and each
settled it the same way: keep the hue, keep the ground, lift the ink until it
clears, and say so in the token's comment. Five surfaces in, the correction is
not local. So it moved into the ink ladder itself rather than becoming a sixth
ground-named token.

### 2. Cut the lift for the three grounds a quiet line *rests* on

The five grounds are not equally hard, and an ink lifted far enough for `line`
lands within a hair of `ink-dim` — the ladder loses a step to gain a ratio. So
`ink-faint` is cut for `chrome`, `strip` and `app`:

    --color-ink-faint: #5e99b1;   chrome 5.30   strip 5.04   app 4.66

`raised` and `line` are what a row turns when it is hovered, selected or
floating, and there the quiet step goes up to `ink-dim` (5.39 and 4.82). That is
not a new rule — TRE-36's palette already switches its second line with the row,
for this exact reason.

### 3. `accent-soft` is a fill, a border and a bar. It is not an ink

The same finding TRE-78 made about `--color-accent`, one step along. Every text
use of `#3e8fae` became one token:

    --color-ink-label: #439abc;   chrome 5.24   strip 4.98   app 4.61

which absorbed `--color-ink-link` and `--color-on-strip-label` as well. Three
names for one hex is how the app got here.

### 4. Two ground-named tokens went away

`--color-on-strip-label` and `--color-on-strip-dim` were introduced by TRE-36
because at the time only the sunk ground had been measured. Measuring the rest
showed the same two of 2a's values failing everywhere, so the pair moved up into
the ladder and the local names went. Both numbers improved on the way (4.98
against 4.76, 5.04 against 4.87). A ground-named token whose ground turns out to
be every ground is a general ink wearing a local name.

`--color-on-terminal-dim` stayed. Its comment says why it is deliberately modest,
and that reason is still true.

### 5. Amber moved by a hair

`--color-warning` is the one meaning ink that lands on `raised` — a toast, a
hovered sidebar row, the note above a saved view — and there it was 4.36. Now
`#cc9048`, which clears every dark ground at 4.64 or better and takes the filled
amber chip from 5.74 to 6.11. Two "for the record" numbers elsewhere moved with
it and were rewritten rather than left asserting a stale figure.

### 6. The check reads the components

The manifest in `verify-contrast.ts` is a table of **boxes**: a file, a ground
or grounds, and the inks drawn on them. The scan finds every `text-*` that
resolves to a token; the table says what each sits on; and a file whose inks and
the table disagree fails in either direction. 406 inline pairs over 43 files.

Two things the scan cannot know, so both are declared:

- **The ground.** A row's colour comes from a parent, often in another file. A
  box may name several grounds, and then every ink in it is checked against all
  of them — over-checking rather than under-checking, so a box that is too coarse
  fails loudly instead of passing quietly.
- **The exemptions.** `disabled:` is stripped before the scan: WCAG 1.4.3 asks
  no ratio of an inactive control. `aria-disabled` controls and pure decoration
  are listed per file with the reason in writing beside the ink.

The last part is the point of the ticket. The next inline colour somebody adds
is not measured against a guess — it stops the check until a human says what it
is drawn on.

## What was found in passing

- **`ink-ghost` was carrying text.** A placeholder in the compare modal at
  1.79:1 and the `—` that means "this side has no such file" at 1.57:1. Both are
  `ink-faint` now. The token survives for what its comment always described: the
  `aria-hidden` `·` on a rename row that changes nothing, and a control that is
  off.
- **A refusal was written in two reds.** `rename-modal` put the problem message
  in `danger-mid` inside a `danger-soft` sentence — 2.26:1 on the panel. One
  message, one red.
- **The context menu's hint** is the one ink on that panel that does not survive
  the `line` fill a row takes under the cursor, so it steps up with the row.
- **The type tag's twenty one-off fills** are now measured too, against
  `on-pane-bright`. All pass, between 6.92 and 10.89.

## What was left out

The light panes. The check found twelve failing pairs there and they are one
finding rather than twelve: on `bg-pane` the ladder already reads 4.74, 4.55 and
5.68, so an `on-pane-faint` lifted to 4.5 lands on top of the two steps above
it. The pane cannot carry four quiet steps at AA, and choosing between three
steps and darker bars is a design decision about the app's most distinctive
surface — TRE-82, not a ticket about `--color-ink-faint`.

They are not tolerated silently. `KNOWN_DEFICIT` prints all twelve with their
numbers on every run and is compared exactly: fixing one without removing its
line fails, and adding a thirteenth fails.

## Verification

- `pnpm verify:contrast` — 564 pairs, up from 102. 406 of them are the new
  component sweep.
- `pnpm verify:views` — the rule that the views feature writes no bare
  `ink-faint` still holds, and its reason was rewritten: the quiet step does not
  survive `line` or `raised`, which is what that feature is drawn on.
- The other nine `verify:*` scripts, `pnpm lint`, `pnpm typecheck`,
  `pnpm build`.
- Not verified: how any of it looks. Nothing here was seen in a browser — the
  numbers are arithmetic on hexes, and whether a lifted quiet line still reads as
  quiet is a judgement only a screen can make.
