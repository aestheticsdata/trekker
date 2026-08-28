# A terminal that is not a shell (TRE-35)

## The problem

The ticket names twelve commands and a panel, which makes it look like a UI
ticket. It is not. It is the ticket that decides whether this application ever
runs a string somebody typed, and it says so itself:

> This is the ticket most likely to be quietly widened later into "just let me
> run anything". So, explicitly: **there is no passthrough**.

Every design decision below is downstream of that sentence, including the ones
that look like styling.

The value is not "run arbitrary things" — it is that `cd /srv/www` moves the
pane and `ssh db-02` rebinds it. The terminal is a keyboard interface to the
explorer. That framing is what makes the restriction cheap rather than
frustrating: there is nothing to escape *to*, because everything the terminal
can do is something the explorer could already do with a mouse.

## The decision

**A parser, not a sanitiser.** `helpers/terminal.ts` takes a line and returns
one `Intent` — a discriminated union with room for exactly one command:

```ts
export type Intent =
  | { kind: "ls"; path: string }
  | { kind: "cd"; path: string }
  …
  | { kind: "rm"; targets: readonly string[]; recursive: boolean };
```

Everything past that boundary receives typed fields, and puts them into typed
API calls the buttons were already making. **No string the person typed crosses
it.** Not to a shell, not to the API, not into a command built by
concatenation — the API's own `shell-quote.ts` is still the only place in the
codebase that turns an argv into a command string, and the terminal never
reaches it with anything of its own.

This is why the injection cases have no privileged path to close. `ls; rm -rf /`
cannot run a second command because the return type cannot express two. Nothing
substitutes because nothing substitutes. `verify-terminal.ts` covers twenty
injection shapes and they are all refused, but the refusal is belt to the type
system's braces — the type is what makes it true.

### Why the operators are refused rather than taken literally

Every one of `; | & \` $ ( ) < >` is a legal character in a POSIX filename, so
"treat them as ordinary characters" is a defensible reading and it is the wrong
one. Somebody typing `ls | grep secret` believes a pipe is about to happen. A
listing of a file named `|` does not correct that belief — it confirms a
different one. So the line is refused with a sentence that says what this
terminal does and does not do, and quoting reaches a genuine `a;b`.

The same reasoning, inverted, decides the quotes: **neither style expands
anything**, so `"$HOME"` is five characters. There are no variables here, and a
`$` that sometimes expands and sometimes does not is worse than one that never
does. There is no backslash escape either, and that is not a gap: a backslash is
a legal filename character, so literal is the more correct of the two readings.

## What is already there

Almost all of it, which is the point.

| Command | Reuses |
|---|---|
| `ls` | `fetchListing`, through the pane's own query cache and key |
| `cd`, `cd -` | `go` / `backTarget` — the pane's navigation and its back stack |
| `df` | `fetchDisks`, the sidebar's query, same key, same 30s window |
| `du` | `startScan` / `fetchScanState` — prints the level, the strip draws it |
| `chmod` | `PermissionsModal` |
| `rm` | `DeleteModal`, typed confirmation and all |
| `ssh` | `onPaneChange({ host, path })` — the sidebar's own bind |
| `whoami`, `hostname` | `HostSummary`, already fetched for the active host |

Not "an equivalent request" — the same function, through the same cache, under
the same guards. That is what makes the ticket's *"a path argument outside the
roots is refused, identically to the UI"* true by construction rather than by
a second implementation that has to be kept in step: it is refused by the same
endpoint, and the refusal printed is the server's own sentence.

## The shape

### Where the panel lives, and why not the strip slot

`AppShell` has a `strip` slot — a docked, fixed-height region under the panes,
where the disk-usage bar goes. It is the obvious home and it is the wrong one.

`cd`, `cd -`, `ssh` and both modals need `go`, `dispatch`, `onPaneChange` and
`overlayOpen`, and all four are closures inside `Explorer`. A panel in the shell
would need every one of them lifted out and threaded back down, and would *still*
be unable to see `overlayOpen` — which is what stops `⎋` closing a dialogue and
the terminal on one keypress.

So the terminal is mounted inside `Explorer`, in a new column wrapping the pane
row. The cost is one level of nesting; what it buys is that the effects are
handed to the runner as an interface (`TerminalWorld`) rather than reached for,
which is also what keeps the runner readable.

### `chmod` and `rm` stop at the dialogue

The ticket asks for it — *"the confirmation is not optional because the entry
point changed"* — and it is right. A recursive delete typed in a hurry is
exactly the case TRE-25's typed confirmation exists for. A terminal that skipped
it would be a faster way to make the mistake the modal was built to prevent.

Three consequences fell out of that, each a real decision:

**Their own state slots, not `permissionsOpen`/`deleteOpen`.** Those are
booleans whose target is derived from the *active pane's selection*, and there
is an effect that closes them and toasts "Nothing to delete" when the selection
is empty. A typed line names its own targets, so it carries them —
the shape `paste` and `compareCopy` already use, for the same reason.

**One directory per invocation.** `PermissionsTarget` and
`DeleteTargetSelection` each carry a single `directory` and rebuild every path
with `joinPath`, which is the right shape for a selection and the wrong one for
a line of typed paths. `chmod 644 /etc/hosts /var/log/syslog` is refused with a
sentence rather than reshaping three shipped modals for one caller — and it is a
real refusal, not a workaround: two stacked `Overlay`s listen for `⎋` on the
same window, and the second confirmation would appear over the first with no way
to tell which one it was about.

**`-r` means something.** Without it, a directory target is refused exactly as a
shell refuses one — `rm: logs is a directory`. The flag is the person saying
they know the target is a tree, and dropping that distinction would put
`rm logs` and `rm -r logs` one keystroke apart with very different
consequences. `-f`, by contrast, parses and is then *ignored*: it means "do not
ask" in every shell, and here the asking is the feature.

The modal also gained one field, `initialMode`. `chmod 644 notes.txt` has said
which bits it means; a dialogue that opened on the file's current mode would
make the person type the answer they had just typed.

### `hostname` had nowhere to come from, and did not need an allowlist entry

Nothing in this codebase knew what a machine calls itself. `HostView` has a slug
and a label, and both are *this installation's* names for a host, chosen by
whoever added it. Printing one under a command called `hostname` would be a
plausible-looking lie, and the ticket's Done list says every listed command works.

The obvious fix is to add `hostname` to `ALLOWED_PROGRAMS`, which is a security
decision on a security-labelled ticket and would want arguing. It turned out not
to be necessary. `HostSummaryService`'s own header already says how:

> The `/proc` files are read with `tail`, which is on the exec allowlist —
> `cat` is not. The paths are fixed server-side constants, never client input.

So `hostname` is `/proc/sys/kernel/hostname`, read with `tail`, exactly as
uptime, load and memory already are. **The exec allowlist is unchanged.** A host
without `/proc` answers null — as it already does for the other three — and the
command says so rather than substituting the slug.

The prompt is the other half of the same question and takes the other answer:
`user@host:/path$` with the *slug* in the host position, because the prompt is
Trekker's — and the slug is the name the sidebar prints and the name `ssh` was
typed with. The account is `HostSummary.remoteUser`, which is the machine's own
answer; while it is unknown the prompt shows `…` rather than a plausible name. `#` in amber while a sudo
window is open, from `PROMPT_ELEVATED_INK` — TRE-29's rule, unchanged and
reused, now measured against a second surface.

The `$`, though, is **not** `PROMPT_INK`, and that is the mockup's own
distinction rather than drift. A modal's command preview is `$ chmod …` with no
identity in it, so its `$` carries the link blue. Here the identity is present
and takes that blue itself, leaving the `$` a step quieter. The `#` is the
signal, and a signal that changed colour between two places in one app would
not be one.

### `cd -` is the pane's Back, not a shell's toggle

A shell's `cd -` toggles between two directories. The pane has a real back stack
with a real button on it. Mapping `cd -` to `backTarget` means repeated presses
walk the stack down rather than oscillating — which is not what a shell does, and
is the honest choice: a second notion of "the previous directory", kept only for
the terminal, would disagree with the button the first time either was used.

### The audit mark is a column, and it is a label

*"Terminal actions appear in the audit log, marked as coming from the terminal."*

`ActivityLog.origin`, nullable, `VARCHAR(16)`, stamped by the interceptor from an
`x-trekker-origin` header. Its own column rather than a `payload` key, for the
reason `elevated` gives one:

> "what did this session do as root" is a question worth an index, not a JSON
> scan.

"What did this session type rather than click" is the same question one step
along. It is not `tag` either — that is the badge on the strip and already
carries counts, sizes and transports; a column that sometimes means "3 files"
and sometimes means "terminal" cannot be filtered on.

Two properties worth stating, because both are easy to lose later:

- **It is validated against a closed set**, not length-capped. This is a column
  in the audit log, and a client that can write free text into one can write
  something that reads like a different entry. Anything unrecognised is dropped
  silently and the row reads as a button.
- **It is a label and never a permission.** The terminal is granted nothing the
  buttons lack, so a forged header moves a word in a log and no privilege at
  all. `audit.spec.ts` asserts this structurally — it counts the uses of
  `originOf` and fails if a second one appears.

Only three things can carry it: `chmod`, `rm` and `du`. `ls`, `df` and `stat`
are GETs, and GETs are never audited — that is TRE-30's design, not a gap here.

Declared per call (`RequestOptions.origin`) rather than picked up from a
context, deliberately: an audit row should be traceable to the line of code that
claimed it, and an ambient origin is the kind of thing that is right for a year
and then quietly wrong.

### The panel's own two decisions

**Scrollback outlives being put away.** The panel stays mounted and renders null
when closed, rather than being conditionally mounted. `⌥↩` twice is a glance at
the panes and back, and a terminal that forgot its answers would make `clear`
pointless — the buffer would already be empty every time you looked. It holds no
connection and no timer, so a closed panel costs nothing.

**Open/closed is local state; history is `sessionStorage`.** The inspector and
the strip keep their flags in the URL, and this one does not, because of what a
reload should do: a link that reopens somebody's split and their two directories
is the point of the URL, and a link that also reopens a terminal is a link that
types into somebody else's session. The history — which the ticket *does* ask to
persist — is per tab, which is what "per session" means.

**`⎋` closes, and only from inside the input.** Every dialogue in this app
listens for it on the window, and the pane behind reads it as "never mind" to a
held clipboard. A global handler would be two things on one keypress. Focused,
it can only mean one thing — and `useKeyboard` already stands down inside an
input, so nothing else sees it. `⌥↩` needed a listener of its own for the
opposite reason: both existing hooks return early on `altKey`, deliberately.

### Built from the mockup, and the four places it was overruled

2a draws this panel completely — `Trekker - App.dc.html`, the `{{ term }}`
block — so the geometry is ported rather than derived: **198px** overall, a
**22px** header on `chrome` over a body on a ground one step below
(`#04161f`, new as `--color-terminal`), the body at `400 11px/1.55` and the
header at `400 9.5px/1`. The prompt row is four flex children at an 8px gap and
**no literal `:`** — `user@host`, the path, the prompt character, the input —
which is why each is a colour rather than a fragment of one string. The joined
form still exists; it is what an echoed line keeps, where the parts have to
survive being copied out as text.

The seven output inks are the mockup's too, and its distinctions are good ones:
an **echo is dimmer than its own answer**, because scrollback is read for what
came back, and an echo set brighter turns a column of answers into a column of
questions. A table sits one shade under a scalar. A state change is green.

Overruled, in three places — the fourth was overruled here and built later:

1. **`#4d7f99` for the path in the prompt** — that is `--color-ink-faint`, and
   on this ground it measures **4.22:1**. Under AA, for the one thing on the
   panel that says where the next command will run. TRE-33 settled what happens
   then and TRE-34 followed it: hue and ground kept, ink lifted until it clears.
   `--color-on-terminal-dim: #538aa6`, at 4.87:1 — deliberately modest, because
   `ink-link` beside it is 5.04:1 and a path that outshone the account it runs
   as would invert the hierarchy the mockup is drawing.
2. **`bash 5.2` in the header.** It is not bash, and a version string is a
   claim. The header carries the host instead, which is the fact somebody
   actually needs there.
3. **A 60-line scrollback cap.** A prototype number; the ticket says "a few
   hundred" and it is 500.
4. **The collapsed omnibar** — 2a keeps a 28px prompt strip visible when the
   terminal is closed, with a blinking caret and `⌥↩ expand to terminal`. Not
   built *here*: this ticket asked for a panel that toggles, and a permanent
   28px strip is a layout change it does not ask for. It got its own ticket,
   and **TRE-85 built it** — so this entry is history rather than a standing
   deviation. What shipped differs from 2a on one point: the caret is the
   input's own rather than an animated block, because the strip is a real
   prompt and not a picture of one. The strip's placeholder is the terminal's
   last line, which is the answer to what a permanent 28px row is *for*.

One behaviour *is* carried over: **the terminal replaces the disk-usage strip
while it is open.** They are the same kind of object — a fixed-height panel
docked under the panes — and stacking both spends a third of the window on
furniture. It is also why `du` prints its level into scrollback rather than
forcing the strip open, which was the first thing tried and is incoherent with
this: the command would open a panel it had just displaced.

`pnpm verify:contrast` measures all fifteen of the terminal's pairs, including
TRE-29's `#` against its second surface and, since TRE-85, the collapsed strip's
placeholder and hint.

## Out of scope, and staying that way

A real PTY over WebSocket. Pipes, redirection, globbing, environment variables,
`sudo` as a prefix. Tab completion was offered as "if it is cheap" and is not
here — it is not cheap against a remote listing, and the pane is already the
fast way to find a path.

Adding a command means adding a parser and a case in the intent union. **That
friction is the design**, and the day someone wants to remove it is the day this
document is for.

## The one thing this leaves behind

`cd -` walks a stack that records paths but not hosts. A pane that was rebound
between two navigations can therefore go "back" to a path that belonged to a
different machine — where it will resolve, or not, on the current one. That is a
property of the pane's Back button as it already ships, not something the
terminal introduced, and fixing it means recording a host alongside each path in
the reducer. Filed as TRE-79; not worth widening this one.
