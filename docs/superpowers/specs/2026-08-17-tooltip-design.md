# A real tooltip (TRE-76), and the end of the native `title`

## The problem

Every hint in this app is a `title` attribute — 43 of them, across 19 files.
The sidebar's activity strip is where that stops being acceptable. Its rows
truncate at `Scanned disk usage und…` and `Blocked: 20 refused pat…`
(`front/src/components/sidebar/activity-strip.tsx:57`), so the only way to
learn what actually happened is to rest the pointer on a row and wait out the
browser's delay for a bubble that appears where the OS decides, in the OS's
font, at a size nothing else in this UI matches. On a 176px sidebar column that
is not an enhancement of the row, it is the row's only readable form.

The strip is only the worst case. The same attribute is carrying the full path
behind every truncated favourite, the reason every disabled action is disabled,
the three numbers behind the `duplicates` fact, and the timestamp behind every
age chip in a listing of hundreds. All of it arrives late, unstyled, and
unreachable by anyone not holding a mouse: a `title` is not exposed to keyboard
focus at all, and screen reader support for it has never been dependable.

## What replaces it

One component, `front/src/components/ui/tooltip.tsx`, ported from the one two
sibling apps already share and adapted to this DS rather than copied. It
follows the pointer, which is the whole point: hints are read sequentially —
the eye moves along a row of them asking *this one? this one?* — and the answer
has to arrive where the eye already is.

```tsx
<Tooltip content={`Open ${host.label} in the active pane`}>
  <button type="button" onClick={onPick}>…</button>
</Tooltip>
```

### The engine

- **Follows the pointer.** `onMouseEnter` *and* `onMouseMove`: move alone loses
  the pointer that lands on a trigger and stops, and the trigger that appears
  under a pointer already at rest.
- **Placed at cursor + 16px, flipped rather than slid.** When the bubble would
  overflow, it moves to the other side of the cursor instead of sliding along
  the viewport edge — a bubble pinned to the right margin while the pointer
  keeps moving reads as stuck. Then clamped to a 12px viewport margin.
- **Both of those gaps stay in px.** Everything else in this app is `rem` so it
  follows `--ui-base` (TRE-44), and these two deliberately do not: one clears
  the mouse cursor and the other clears the edge of the screen, and neither the
  cursor nor the screen changes size when the UI scale does.
- **Measured before paint.** The width is unknown until the bubble is in the
  DOM, so the flip is decided in a layout effect; in a passive effect it would
  be a visible jump at the edge. The effect degrades to `useEffect` on the
  server, where `useLayoutEffect` warns.
- **Portalled to `<body>`**, `pointer-events-none` — a bubble that took the
  pointer would end the hover that summoned it — and `z-60`, above the toast
  stack at 50 and the modal backdrop at 40. That is not hypothetical: a third
  of the call sites are inside modals.
- **Fades at both ends,** `transition-opacity duration-100`, holding the last
  position so it can fade *in place* after the pointer has gone rather than
  vanishing between two frames. The `prefers-reduced-motion` block already in
  `globals.css:474` neutralises it without a line of its own.

### The trigger

Composed with `cloneElement`, chaining onto whatever handlers the child already
has, so the tooltip adds no element to the DOM.

That last part is a requirement, not an economy. The activity row is an `<li>`
inside a `<ul>`; a wrapping `<span>` there is invalid markup, and
`display: contents` hides the box without fixing the tree. Wrapping is also
what a `title` never did, and 43 call sites is too many to be quietly changing
each one's layout.

No new dependency. The sibling implementation reaches for a `Slot` primitive
from a component library this app does not have and has been better off
without; the handler-chaining it provides is about fifteen lines here.

`cloneElement` on every pointer move costs nothing measurable, and the reason
is worth writing down once: the *child element object* is a prop of the
tooltip, so it is referentially stable across the tooltip's own state changes.
Cloning it produces a new element with the same type and the same `children`
reference, so React diffs the trigger's props — new handler identities, which
never touch the DOM — and bails out of the subtree beneath it.

### Reachable without a mouse

Which is the one thing `title` could never offer.

- `:focus-visible` on the trigger anchors the bubble to the trigger's box.
  Focus, not `:focus-visible`, would re-anchor mid-hover every time a button
  was clicked, and the bubble would jump out from under the cursor.
- The test is on the event's `target`, not its `currentTarget`. Focus bubbles,
  and where the trigger is a wrapper around a disabled control the wrapper
  itself never takes focus — asking whether *it* is focus-visible answers no on
  precisely the hints that most need the keyboard.
- Blur and Escape close it. `aria-describedby` points at the bubble, which is
  valid across the portal because it is resolved by id, not by tree position.

### Nullable content

`null`, `undefined` and `""` hand the trigger straight back, untouched — not an
empty bubble, and not a live wrapper either, which would still bind handlers
and still open on focus, so a keyboard user would tab into a tooltip made of
nothing.

This is load-bearing at the call sites rather than defensive. A third of the
current attributes are already conditional — `title={failure ?? undefined}`
(`auth-card.tsx:64`), `title={row.changed ? row.next : undefined}`
(`rename-modal.tsx:399`) — and with `null` meaning *no tooltip* those sites
wrap unconditionally and pass what they have, instead of duplicating their own
markup down both arms of a ternary.

### Disabled controls, and why nine of them change

A `disabled` form control fires no mouse events at all. Not "the handler does not
run" — the events are never dispatched, so nothing on the control and nothing
above it hears the pointer. A native `title` was exempt from that, because the
browser drew it itself.

Nine of the 43 hints are on disabled controls, and they are not an incidental
nine: `title={action.unavailableReason}` (`toolbar.tsx:176`),
`title={action.reason}` (`inspector.tsx:696`), *"A host needs at least one root"*
(`roots-editor.tsx:109`), *"One entry at a time"* (`rename-modal.tsx:247`). These
are the hints that exist **because** the control is unavailable. Losing them is
losing the only explanation the operator gets.

The usual workaround is to wrap the control and add `pointer-events: none` to it
so hit-testing falls through to the wrapper. That is refused here twice over: it
adds a box at nine sites, and at one of them — the treemap band, whose
`flexGrow`/`flexBasis` *is* the geometry of the strip — an extra box between the
button and its flex row would divide the bar by the wrong numbers.

So those controls say `aria-disabled="true"` instead, with the click guarded in
the handler. They are still not activatable and still styled as unavailable
(`disabled:` variants become `aria-disabled:`), but they are hoverable, and for
the first time they are reachable by keyboard — a `disabled` button is not a tab
stop, so the explanation of *why* it is disabled has never been available to
anyone not holding a mouse.

One line of `globals.css:333` moves with them. The base layer grants
`cursor: pointer` to `button:not(:disabled)`, which an `aria-disabled` button
would now match, so it reads as clickable; the rule gains
`:not([aria-disabled="true"])`.

Where the disabling is transient and the hint is a label rather than an
explanation — the strip's `cancel ✕` and `scan ⟳` while a request is in flight,
the UI-scale stepper at the ends of its range — the attribute stays and the hint
pauses for as long as the control does. Nothing is stranded there.

## The surface

`bg-raised` + `border-line-strong` + `rounded-sm` + `shadow-lg`, which is the
combination the toast already wears (`ui/toast.tsx:107`). `raised` is this DS's
token for anything floating above the app surface, and a tooltip is the
smallest such thing.

**Opaque**, and this is the one place the ported design is overruled. The
sibling bubble is translucent over a backdrop blur, because it is drawn over
charts whose bars the reader is working along. Here nothing else is translucent,
the blur would be the only one in the app, and — the deciding reason — an
opaque fill is a colour `verify:contrast` can actually measure, where a
composited one cannot (`scripts/verify-contrast.ts:26`). It also has to read
over the light panes as well as the dark chrome, a case neither sibling has;
a dark bubble on `pane-sel` is unambiguous in a way a 90% one is not.

`font-sans text-xs`, `whitespace-pre-line` so a two-line hint stays two lines,
and `max-w-72` — the toast's own width, so the two overlays agree.

`w-max`, not `w-fit`. Both draw the same box in open space, but `fit-content`
resolves against the room left between the bubble's `left` and the viewport
edge, so a wide hint near the right edge measures as a narrow column, the flip
uses that wrong width, and it lands in the wrong place once it re-expands.

### Ink, and one refusal

Measured against `--color-raised` (`#0d3552`):

| | | |
|---|---|---|
| `text-ink-soft` | 9.9:1 | values, the subject line |
| `text-ink-muted` | 6.5:1 | labels |
| `text-ink-faint` | 2.9:1 | **refused inside the bubble** |

`ink-faint` is the app's ordinary colour for a secondary line, which is exactly
why it would end up in here by habit. `verify:contrast` is extended with these
pairs so that stays checked rather than remembered — the same argument the
script already makes for the age ramp and the treemap bands.

## `TooltipBlock`

A subject line, an optional context line, and right-aligned label/value rows.

It exists because a `title` can only ever be one flat line, and several sites
have been paying for that. The `duplicates` fact currently reads

> 12 candidate groups by size, 4 confirmed by hash, 2 too large to hash

as one run-on sentence (`disk-usage.tsx:585`), where it is three measurements
of the same thing and should be read as a column:

```
duplicates
candidates      12
confirmed        4
too large        2
```

Values are right-aligned in a column of their own and set in mono, so they line
up on the digit and compare downward. One shape for every site that uses it,
and deliberately not a framework: no variants, no `kind`. The moment it grows a
`variant` prop it has stopped being a shape.

Used at the sites that today flatten structured data — the treemap bands, the
three disk-usage facts, the volumes rows, the inspector's stat cells. The other
~37 hints are a phrase or a path and stay plain strings.

## The sweep

All 43, in one pass. A half-migrated app is worse than either end state: some
hints would follow the pointer and others would wait out the browser's delay,
and the difference would read as breakage rather than as staging.

inspector (6) · disk-usage (6) · sidebar (4) · toolbar (4) · rename-modal (4)
· pane (3) · create-modal (2) · host-manager (2) · roots-editor (2) · and one
each in volumes, activity-strip, transfers, auth-field, auth-card, top-bar,
ui-scale, field, transfer-modal, permissions-modal.

Two of those files carry more edits than attributes. `disk-usage.tsx` routes
six of its hints through local `Action` and `Fact` wrappers, and `toolbar.tsx`
through a `Toggle`, so the attribute moves once and the callers that feed it
follow.

Two things the sweep does not touch:

- **`title` props on components.** `AuthCard`, `Section` and `Placeholder` take
  a `title` that is a heading, not a hint. They are named for what they render.
- **Existing `aria-label`s.** They stay exactly as they are. `aria-describedby`
  is additive: the label names the control, the tooltip describes it, and a
  control that had both an `aria-label` and a `title` was already saying two
  different things on purpose.

## Verification

- `pnpm lint` and `pnpm typecheck`.
- `pnpm verify:contrast`, extended with the tooltip's own pairs.
- By hand in the browser: the activity row reads in full, the bubble follows
  the pointer, it flips near the right and bottom edges instead of sticking,
  Tab reaches a hint and Escape dismisses it, and a tooltip inside a modal
  draws above the modal.

## Not shipped

A pre-commit guard refusing a newly staged `title=` on a DOM element. Offered,
and declined — worth recording so the next reader knows the omission was a
decision rather than an oversight.
