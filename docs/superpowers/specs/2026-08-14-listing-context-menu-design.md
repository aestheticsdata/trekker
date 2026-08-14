# A context menu on the listing (TRE-70), and the two things behind it

## The problem

Every operation this app performs on a file is reachable from exactly one
place: the toolbar action row, top right. That row is hidden below the `panes:`
breakpoint (`front/src/components/shell/toolbar.tsx:143`), so a narrow window
has a listing it can browse and nothing it can do to it. At full width the
route is merely wrong rather than absent: select a row on the left, travel to
the far right of the screen, come back. A file manager answers where the
pointer already is.

Right-click is that answer, and it is unimplemented — `onContextMenu` appears
nowhere in `front/src`. What comes up over a row today is the browser's own
menu, offering to reload the page and open an image in a new tab.

Three of the operations the menu is expected to carry do not exist either.
`new directory`, `new file` and `duplicate` have no route: `/fs` has `list`,
`stat`, `upload`, `chmod`, `chown`, `rename` and `delete`, and nothing that
creates. So the work splits three ways, and the menu is the last of the three.

## What is already there

- **The action registry.** `M2_ACTIONS` (`toolbar.tsx:37`) is already the exact
  shape a menu item needs — `{ id, label, hint, unavailableReason, danger,
  onSelect }` — and was written with a second surface in mind: *"declared once
  so the toolbar and the palette agree"*.
- **The wiring.** `OPENERS` in `(private)/page.tsx:97` replaces an action's
  `unavailableReason` with a handler. A menu item opens the transfer, rename,
  delete or permissions modal by calling the setter the toolbar button calls.
- **`PaneCallbacks`** (`pane.tsx:50`) is the established way the presentational
  pane reports an interaction up to the explorer, which owns the state.
- **`Overlay`** (`ui/overlay.tsx`) holds the dialog contract and 2a's motion.
- **The drivers already create.** `HostDriver.mkdir` and
  `HostDriver.createWriteStream` (`hosts/drivers/host-driver.ts:92`) are
  implemented on both transports and used by the transfer engine.
- **`numberedName`** — `report.txt` → `report (2).txt` — is already shared
  between the upload path and the transfer engine's `keepBoth`, deliberately,
  so that one situation has one convention (`transfer-plan.ts:147`).
- **The transfer engine** (TRE-23) plans and runs a same-host copy as a job,
  with conflicts resolved per item. `duplicate` and `paste` are that, aimed
  differently.
- **The guards.** PathGuard and the roots allowlist (TRE-11), the audit
  interceptor that writes its row before the handler runs (TRE-30), and
  `consume(rule, scope, amount)` for limits in units of entries.

Three gaps: no create route, no clipboard, no menu.

## Three tickets

| | Title | Epic |
|---|---|---|
| **TRE-69** | Create: new directory, new file and duplicate — API and modal | TRE-2 |
| **TRE-70** | UI: right-click context menu on the listing | TRE-3 |
| **TRE-71** | Clipboard: cut, copy and paste across panes and hosts | TRE-2 |

TRE-70 is the feature that was asked for. The other two are the things it would
otherwise have to invent along the way, and each is a different kind of work:
one is an API with a modal in front of it, one is a stateful interaction model
with its own keyboard shortcuts, and one draws a menu and dispatches what
already exists. Split, each is separately reviewable and separately verifiable,
and the menu ships whether or not the other two have.

Until they land, the menu renders their entries disabled and says which ticket
they are waiting on — the convention the toolbar has followed since TRE-14, and
the one that made `rm` legible for the three milestones before TRE-25 wired it.

---

# TRE-70 — the menu

## 1. Interception

`onContextMenu` with `preventDefault()`, inside the listing region only: the
rows, the `..` row, the empty area below the rows, the path row and the tab
strip.

Everywhere else keeps the browser's menu — the breadcrumb text, the glob field,
the inspector's metadata rows, the status bar, the toasts. Copying a path out of
the inspector by hand is a real thing people do, and an app that swallows
right-click everywhere takes it away to no purpose. The rule is narrow on
purpose: intercept where we have something better to offer, nowhere else.

Firefox forces its own menu on Shift+right-click regardless of
`preventDefault()`. Chrome has no equivalent, and this ticket promises none —
the escape hatch is the part of the page that was never intercepted.

## 2. The target rule

**The target decides which entries exist. The state decides which are enabled.**

- Right-click a row **outside** the selection → the selection becomes that row,
  the cursor moves to it, the menu targets it. Anything else acts on entries the
  operator cannot see, which for `rm` is unforgivable and for the rest is
  merely confusing.
- Right-click a row **inside** the selection → the selection is untouched and
  the menu targets all of it. This is the only way to act on a multi-selection
  without destroying it on the way.
- Right-click **empty space, `..`, the path row or a tab** → the menu targets
  the directory.
- Right-click in the **inactive** pane activates it first, so the menu, the
  status bar and the toolbar cannot describe three different things.

## 3. Two shapes

```
── target: entries ─────────────      ── target: the directory ───────
new directory        F7               new directory        F7
new file                              new file
───────────────────────               ───────────────────────
open                 ↵                paste                ⌘V
open in other pane                    upload here          ↑
───────────────────────               ───────────────────────
cut                  ⌘X               refresh
copy                 ⌘C               copy path
duplicate            ⌘D               add to favourites
copy to other pane   F5
move to other pane   F6
───────────────────────
rename               F2
permissions
download             F3
mint signed link
copy path
copy name
───────────────────────
add to favourites
rm                   ⌦
```

The hint on `new directory` is **F7, not ⇧⌘N** (changed by TRE-69, which
implemented it). Chrome and Firefox both take ⇧⌘N for a private window at the
window manager, so the page never receives the key and a menu advertising it
would be teaching a shortcut that does nothing. F7 is `mkdir` in the two-pane
managers this app already borrows F2, F3, F5 and F6 from.

Both shapes keep `new` at the top. Finder and Explorer put "New Folder" only in
the background menu, and both can afford to: their listings end. This one is
virtualised (TRE-19) — a directory with two thousand entries has no empty space
left to right-click, and a `new directory` reachable only by scrolling to the
bottom of `node_modules` is not reachable.

`cut` / `copy` / `paste` are the clipboard (TRE-71). `copy to other pane` /
`move to other pane` are the two-pane F5 and F6 that already exist. Both belong
in the menu and the labels are what keeps them apart: the moment either is
called plain `copy`, one of the two is lying about where the bytes are going.

`open` means what `↵` means today — `cd` into a directory, and the inspector's
read-only preview for a file (TRE-17). `refresh` invalidates the pane's query;
it earns its row because a listing can go stale from another machine entirely,
and F5 is spent on copy.

Entries that belong to a *different target* are absent, because a menu is about
what was right-clicked. Entries that belong to this target but cannot run *right
now* are present and disabled, carrying the sentence why: `paste` with an empty
clipboard, `permissions` on a host that refused the last chmod, `duplicate`
before TRE-69 lands.

## 4. One registry

`M2_ACTIONS` moves out of `toolbar.tsx` into `components/shell/actions.ts` and
grows the two things a second surface needs:

- the entries the toolbar never had — `new directory`, `new file`, `duplicate`,
  `cut`, `copy`, `paste`, `open`, `open in other pane`, `refresh`, `copy path`,
  `copy name`, `mint signed link`, `add to favourites`;
- `resolveActions(target)`, which returns the list for a target with each
  `unavailableReason` computed from it: how many entries, directory or file,
  which pane, which host, what the clipboard holds.

Today availability is hand-written per action in `OPENERS`
(`(private)/page.tsx:97`) and the reasons are string literals in the toolbar's
default list. That works for one surface. With three — toolbar, menu, and
TRE-36's ⌘K palette — it is the thing that drifts: an action enabled in the
menu and disabled in the palette for the same selection, and nobody notices
until someone tries the other route.

The registry is a description of what exists and what each action needs. Every
surface renders from it and none of them decides anything.

## 5. Placement

`components/ui/context-menu.tsx`, beside `overlay.tsx`. Presentational: it takes
a point, a list of items and a close callback.

The arithmetic lives in `helpers/menu.ts`, as a pure function, because it is
arithmetic pretending to be a layout and its failure mode is a menu half off
the bottom of the screen at one window height:

- opens with its top-left at the pointer;
- flips to the other side of the pointer, per axis, when that side does not fit;
- clamps to the viewport when neither side fits — a menu taller than the window
  is possible on a short window, and it scrolls inside itself rather than
  overflowing;
- never covers the point that opened it, so the row being acted on stays
  visible.

Dismissal: `Escape`, an outside `pointerdown`, a scroll of the listing, window
blur, window resize, or an item chosen. A right-click somewhere else while the
menu is open **moves** it rather than stacking a second one.

The pane reports `{ point, target }` up through `PaneCallbacks`. The explorer
holds one menu state for both panes and renders one menu, so
`explorer.tsx` — already 954 lines — grows a state field and a callback, not a
subsystem.

## 6. Keyboard and reach

- `role="menu"` with `role="menuitem"` children, labelled by the target.
- Focus moves into the menu on open and returns to the pane on close. The pane's
  cursor does not move while the menu is open.
- `↑` / `↓` move, skipping disabled entries; `Home` / `End` jump; `Enter` and
  `Space` activate; `Escape` closes; typing a letter jumps to the next entry
  starting with it.
- **`Shift+F10` and the Menu key open the menu at the cursor row.** Without
  this the whole feature needs a mouse, and the rest of the app does not.
- The explorer's existing key handling stands down while the menu is open: `↓`
  over an open menu belongs to the menu, the way it already belongs to the host
  manager (`explorer.tsx:511`).

## 7. The theme

Mockup 2a, fetched through DesignSync and read off its markup rather than
approximated from tokens.

- Labels are mono and lowercase like the toolbar's: these are commands.
- Hints sit right-aligned in the same type the toolbar's `F5` uses.
- `rm` takes the danger tone and keeps it while disabled — `rm` should never
  look routine.
- Sizes in `rem` off `--ui-base` (TRE-44), from the scale, no arbitrary values.
- `cursor-pointer` on every enabled item, `cursor-not-allowed` on the rest.
- Section rules are the toolbar's `Rule`, turned horizontal.
- Entry animation is 2a's `tkIn`; a menu is a panel above the layout, so the
  fade is honest here in the way TRE-62 explains it is not for a pane.

## 8. Verification

`front/scripts/verify-menu.ts`, following `verify-virtual.ts` — there is no test
runner in `front/` until TRE-39, and this moves into it when there is.

- **Placement, by brute force.** Every pointer position on a grid × menu sizes ×
  viewport sizes: the menu is fully on screen, or scrolling inside itself when
  it cannot be; it never covers the pointer; and it prefers down-right when
  there is room. Non-integer sizes included — `--ui-base` makes fractional the
  normal case, and integer-only arithmetic passes a test that lies.
- **`resolveActions`, by table.** Every target shape — no selection, one file,
  one directory, a mixed multi-selection, the directory itself, an empty
  clipboard, a host that has not been reached — against the entries and reasons
  expected. This is the function three surfaces trust.

Then by hand, over the real API: a row outside the selection takes it, a row
inside it does not, `rm` from the menu opens the same modal `⌦` does, the menu
flips near the bottom of the window, `Shift+F10` opens it with no mouse, and
right-clicking the inspector still gets the browser's menu.

---

# TRE-69 — create and duplicate

## The routes

`POST /fs/mkdir` and `POST /fs/create`, both `{ hostId, path, name }` where
`path` is the containing directory and `name` is a single entry name.

A name is not a path. `/`, `..`, `.`, an empty string, a leading or trailing
space, and anything over `NAME_MAX` are refused at the DTO, before the guard
sees them — the guard's job is which directories may be written to, and it
should not also have to defend against a name that is trying to be a path.

- `mkdir` is **not** recursive. The modal offers one name in the directory the
  pane is showing; `mkdir -p` is a different feature and nobody asked for it.
  An existing name is `409`.
- `create` writes zero bytes **exclusively**. `WriteOptions` today is
  `{ mode, append }` and both drivers resolve it to `flags: append ? "a" : "w"`
  (`local.driver.ts:167`, `ssh.driver.ts:187`) — so a create built on what
  exists would silently truncate the file already there. `exclusive?: boolean`
  joins `WriteOptions`, maps to `"wx"` on both transports, and this route sets
  it. One line per driver, and the failure it removes is unrecoverable.
- Mode is the driver default (`0o644` for a file, the process umask for a
  directory). Setting bits at creation is what TRE-21's modal is for.

`duplicate` gets **no route of its own**. It is a same-host copy of the
selection into the directory it is already in, submitted to `POST /transfers`
with `keepBoth`, which resolves through the `numberedName` that upload and
`keepBoth` already share. `report.txt` duplicates to `report (2).txt` and then
to `report (3).txt`, and it is one convention because it is one function.
`destinationInsideSource` (`transfer-plan.ts:187`) does not fire — the
destination is the selection's parent, not the selection.

That it becomes a job in the queue is right rather than convenient:
duplicating a 40 GB directory is a transfer whatever the menu called it, and it
belongs in the same widget with the same cancel.

## The modal

One component for both, the way `transfer-modal` serves copy and move and
`rename-modal` serves name and pattern: a `CreateMode` of `"dir" | "file"`,
lifted into `(private)/page.tsx` beside `renameMode`.

A name field, the containing directory shown above it, the existing-name check
run against the listing the pane already has — so the collision is named before
the request, and confirmed by the `409` if the directory changed underneath.
Errors sit on the label's line and reserve their space, so nothing shifts
(the auth screens' rule).

On success: invalidate the pane's listing, put the cursor on the new entry, and
select it. Creating something and then having to find it is a missing half of
the feature.

## The guards

Every route goes through PathGuard and the roots allowlist, is `@Audited`
(`file.mkdir`, `file.create` — `ActivityLog.kind` is a shape-checked
`VarChar(32)`, so no migration), and spends the write rate limit. Creation is
not destructive, but it is a write to a filesystem the operator reached over
SSH, and the log that answers *what did this account do* is worth nothing with
holes in it.

---

# TRE-71 — the clipboard

A held selection with a mode, and it is not the two-pane model — it is the
second one, for the case the two-pane model does not serve: take these three
files, navigate somewhere the other pane is not pointing, put them down.

- **The store.** What is held (host, directory, names), and whether it was cut
  or copied. Lives beside the pane state, survives navigation and pane
  switching, and does not survive a reload — a clipboard the app remembers from
  yesterday holds paths that may no longer exist.
- **`⌘X` / `⌘C` / `⌘V`** work with no menu open, through `useShortcut`
  (`explorer.tsx:926`), standing down inside the glob field where they mean
  what they mean everywhere else.
- **Cut rows render dimmed** until the paste completes or the clipboard is
  cleared, because otherwise nothing on screen says the app is holding
  anything.
- **`paste` submits a transfer** — `POST /transfers`, copy or move by the held
  mode, source host and directory from the store, destination the target
  directory. Cross-host paste is the same call, which is the whole reason this
  is cheap: TRE-23 already moves bytes between two machines.
- **The status bar says what is held**, and clicking it clears.
- **`Escape` in a pane clears the clipboard** when one is held and nothing else
  is open.

Paste into the directory the cut came from is a no-op, not an error. Paste of a
directory into its own subtree is refused by `destinationInsideSource`, which
already exists and already says why.

---

## Out of scope

- **Drag and drop between panes.** Still out, as TRE-24 left it. Dropping
  files from the OS onto a pane exists (TRE-65) and is untouched.
- **Submenus.** Two flat shapes, sectioned, are legible; nesting them to save
  four rows costs a hover delay and a keyboard mode.
- **Touch.** Long-press opens nothing. This is a desktop two-pane file manager
  and the toolbar row is already hidden on a phone-width window.
- **A trash.** `rm` remains what TRE-25 made it.
- **`mkdir -p`, and creating a file with content.** A name field creates one
  entry. Editing arrives with a viewer or not at all.
- **Custom menus per file type.** No "open with", no extension-driven entries.
- **The ⌘K palette** (TRE-36). It reads the same registry when it lands; it is
  not built early here.
