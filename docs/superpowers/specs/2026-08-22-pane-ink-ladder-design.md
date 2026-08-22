# The light pane, which had no room left below AA (TRE-82)

## The problem

TRE-81 taught `pnpm verify:contrast` to read class names out of the components.
The first thing it found on the far side of the app was twelve pairs the panes
had been shipping, all of them under 4.5:1, and they were frozen in a
`KNOWN_DEFICIT` list rather than fixed because fixing them was a design
decision about the app's most distinctive surface.

| ink | ground | ratio |
| --- | --- | --- |
| `on-pane-faint` | `pane-bar` | 2.55 |
| `on-pane-faint` | `pane-bar-active` | 2.87 |
| `on-pane-faint` | `pane` | 3.40 |
| `on-pane-faint` | `pane-active` | 3.71 |
| `on-pane-faint` | `pane-hover` | 4.22 |
| `on-pane-faint` | `pane-sel-idle` | 4.35 |
| `on-pane-dim` | `pane-bar` | 3.41 |
| `on-pane-dim` | `pane-bar-active` | 3.84 |
| `on-pane-muted` | `pane-bar` | 3.55 |
| `on-pane-muted` | `pane-bar-active` | 4.00 |
| `on-pane-label` | `pane-bar` | 4.26 |
| `danger` | `pane` | 4.4996 |

Nine of the twelve are 2a's own hexes on 2a's own grounds. The palette was
ported literally and the mockup does not meet AA here.

## What the arithmetic said before any taste got involved

The ticket proposed one lever — "the bars may be the better lever: six of the
twelve are on `pane-bar`/`pane-bar-active`" — and guessed its direction wrong.
A pane is light and its ink is dark, so a *darker* bar is a bar *closer* to the
ink standing on it. The bars had to get lighter, not darker.

They also could not do it alone, and that is provable rather than arguable. For
an ink at luminance `Li` to clear 4.5:1 on a ground at `Lg`, `Lg ≥ 4.5(Li+0.05)
− 0.05`. Feeding the six inks the bars carry through that:

| ink | needs `pane-bar` at |
| --- | --- |
| `on-pane-label` | .369 |
| `on-pane-muted` | .451 |
| `on-pane-dim` | .473 |
| `on-pane-faint` | .650 |

`--color-pane` is .478 and `--color-pane-hover` is .607. So keeping `dim` where
2a put it means a bar that *is* the listing, and keeping `faint` means a bar
lighter than a hovered row. A bar that has to erase itself is not a lever.

The other direction closes just as hard. With the bar where 2a puts it (.346),
every ink on it has to read 6.0:1 or better against the pane. Six inks between
6.0 and 7.4 — `on-pane` is 7.39 and nobody wants pure black on pale blue — is
0.23 of a ratio point per step. That is not a ladder, it is a smear.

Both had to move. Neither could move alone.

## Decisions

### 1. The bars keep their step and lose half of it

`--color-pane-bar` `#7fa3c2` → `#8badcb`, `--color-pane-bar-active` `#8badc9` →
`#96b6d1`. The bar sits .080 of relative luminance under its listing instead of
.132, and the .050 between a bar and its `-active` twin — the same .050 that
separates `pane` from `pane-active` — is preserved exactly, so the family's own
internal logic is untouched.

Three candidates were rendered at the mockup's real geometry and looked at
(`--headless --screenshot`, IBM Plex, 2× scale) before this number was picked.
At .080 the path row, the column header and the footer still read as furniture;
the `pane-line` rule under each of them was always doing most of that work. At
.058 the footer starts dissolving into the listing.

### 2. `pane-bar` was two things, and they wanted opposite directions

The bars are furniture. But `bg-pane-bar` was also the unfilled remainder of a
share bar, and `bg-pane-bar-active` was a skeleton row's cells. Those are mass
standing in for content: they sit *on* the listing and need to stay well under
it, which is the exact opposite of what the bars needed. Lightening one token
was going to quietly flatten the other.

So the old value keeps a name of its own — `--color-pane-block: #7fa3c2` — and
both graphics point at it. Nothing about them changes on screen. This is the
same shape as TRE-78 (`accent` was an edge and a fill) and TRE-81
(`accent-soft` was a fill and an ink): one token, two jobs, and the check only
ever saw one of them.

### 3. `dim` and `muted` were one step wearing two names

On `pane`, 2a's values read `muted` 4.74, `dim` 4.55, `strong` 4.53 and
`danger` 4.50 — four inks inside a quarter of a ratio point. Two of them are a
hue rather than a step (below). The other two are synonyms in the palette and
synonyms in English, and both files that had ever written a sentence about
either of them — `helpers/tail.ts` and `scripts/verify-contrast.ts` — used the
same phrase, "this app's ordinary ink for a quiet line on a pane", about
`muted`.

`--color-on-pane-dim` is deleted. `--color-on-pane-muted` becomes `#17405d`,
dark enough to clear the new bar at 4.64:1 and every row state above it.

### 4. `faint` stops being drawn on the bars, and stops being 2a's value twice over

`--color-on-pane-faint` was `#31607f`, a value 2a never writes anywhere. 2a's
own colour for the job — a symlink's target — is `#255473`, which measures
4.07:1 and does not clear either. It is now `#214865`, 4.85:1 on `pane`.

That works because the ink came off the darkest ground. `faint` was on a bar
for exactly one thing: the `▾` inside the host chip, whose label is `muted`. A
caret quieter than the label it belongs to is a distinction nobody reads at
9.5px, so the caret takes the chip's ink and `faint` is a row-level colour
only. Its floor is `pane` rather than `pane-bar`, which is the whole difference
between 4.85 and impossible.

### 5. `danger` loses four ten-thousandths and gains a margin

`#7f2f2f` on `bg-pane` measured 4.4996:1 — a fail no eye would ever call, on
the marker that says a symlink points outside the root. `#7c2e2e` is 4.62:1.
Everywhere else `danger` is a fill or a border; the one pair it carries as text
on a fill, `text-ink` on the delete button, goes 7.86 → 8.08.

### 6. `strong` stays where 2a put it, and is the thinnest margin left

`--color-on-pane-strong` is 4.53:1, three hundredths over the line, and
`danger` is now 4.62 — nine hundredths apart. For two quiet greys that would be
one step wearing two names again. These are a saturated blue and a red, and
nobody has ever told those apart by their lightness. The directory name is the
pane's signature colour, it is 2a's own, and it passes. `verify:contrast` is
what stands between that margin and the next person who nudges `--color-pane`.

## The ladder, after

On `bg-pane`: `faint` 4.85, `muted` 5.48, `label` 5.68, `data` 6.86, `on-pane`
7.39. Gaps of 0.63, 0.20, 1.18 and 0.53 — every one of them above the tenth of
a point below which two steps are one step. `strong` (4.53) and `danger` (4.62)
stand beside the ladder rather than on it.

## The check

`KNOWN_DEFICIT` and the block that printed it are gone. In their place the same
twelve are printed as a `CORRECTED` table — what the pair was, as a literal hex
pair, beside what it is now as tokens — which is the idiom the rest of the file
already uses for every place the app departs from the mockup. Both ratios are
computed, and the right-hand one is asserted, so the table cannot rot into a
claim.

The `pane.tsx` boxes lost `on-pane-dim` and lost `on-pane-faint` from the bar
box, because neither is drawn there any more. The printed note in
`verify-contrast.ts` about `on-pane-muted` failing on the sunk ground at 4.35:1
was rewritten: the darker `muted` clears it at 5.03:1, so `tail.ts` keeps
`on-pane-label` for its own stated reason — one box, one voice — and no longer
for a number that stopped being true.

## Verified

- All 11 `verify:*` scripts pass. `verify:contrast` is 579/579 at 4.5:1, up
  from 564/564-with-twelve-excused.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` clean (after `rm -rf .next`).
- Before/after rendered side by side at the mockup's geometry in headless
  Chrome and looked at. The logged-in app was not opened — measuring it needs a
  live session, and every pair here is measured from the tokens instead.

## Found on the way, left alone

The activity strip's outcome dot is `bg-danger` on `chrome`, which is 1.82:1 —
1.4.11 asks 3:1 of a graphic that carries meaning, and the strip's own comment
says colour is what carries the outcome. It is in the dark half, it is not a
pane, and it is not this ticket's. Filed separately.
