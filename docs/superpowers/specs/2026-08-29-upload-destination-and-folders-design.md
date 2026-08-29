# Uploading into a named destination, and uploading a folder (TRE-125, TRE-126)

## The problem

Two complaints, and the second one hides a bug.

**Nothing says where an upload is going.** The toolbar button opens the native
file dialogue directly (`explorer.tsx:1263`). The dialogue is the operating
system's, it covers the window, and it names the source — never the
destination. The registry does carry a destination cue, `upload here`, but the
toolbar renders `short` rather than `label` (`actions.ts:443`), so the bar reads
`upload ↑` and the one word that answered the question survives only in the
context menu and the palette. The destination is the active pane's directory,
and "active" is a 2px coloured edge and a slightly lighter background: a cue
that works while you are looking at the panes and not while a system dialogue is
covering them.

The drop path never asks at all. `pane.tsx:250` starts the upload on `drop`.

**A folder cannot be uploaded, and neither can thirty-one files.**
`uploadFile` sends one HTTP request per file (`upload.ts:44`) — a deliberate
choice, because `fetch` cannot report upload progress and per-file progress is
what the tray is built on. But the interceptor spends one rate-limit unit per
request, per user, before the handler runs (`audit.interceptor.ts:202`), and
`LIMITS.upload` is 30 per 60s (`limits.ts:183`).

So selecting forty files fails today. The thirty-first gets a 429, and
`uploads.tsx:110` treats it as a verdict on the whole batch: it pushes one toast
and returns, abandoning every file after it. The toast is honest and the
behaviour is not — nine files that would have succeeded never left.

Folder upload sits on top of that ceiling and adds one of its own:
`safeFilename` keeps only the last segment of whatever name arrives
(`upload-name.ts`), so `photos/2019/a.jpg` lands as `a.jpg`. That is correct
today and is the single line that has to change for a tree to survive the trip.

## What is already there

- **`Overlay` and a family of modals to copy.** `create-modal.tsx` is the
  closest: one component, a destination it does not construct, a check before
  the send and a second check on the server. `transfer-modal.tsx` already solves
  "name two places so nobody has to guess which is which".
- **The route already accepts a batch.** `receiveMultipart` takes up to 200
  parts and, because busboy cannot advance past a part until its stream is
  consumed, writes them strictly one at a time with backpressure
  (`upload-multipart.ts:30`). Nothing about the server needs to change for
  several files to share a request.
- **`safeFilename` already anticipates this feature.** Its comment names
  `webkitRelativePath` as the reason separators are stripped rather than assumed
  absent. The narrowing is deliberate and stays; what is missing is a second
  function for the case where the path is the point.
- **`mkdir` is on the driver, with `recursive`** (`host-driver.ts:234`). It goes
  over SFTP, not through a shell, so creating a tree costs nothing on
  `ALLOWED_PROGRAMS` — which must stay a list of things that cannot write.
- **The tray already outlives its opener** (`uploads.tsx`), keeps a row per
  file, and already reads a per-file `results[]` off the response.

## Design

### 1. The modal

`front/src/components/explorer/upload-modal.tsx`, on `Overlay`, shaped like
`create-modal.tsx`.

It opens *before* the picker. That ordering is the whole ticket: a modal that
appears after the dialogue would confirm a choice already made, and the question
being asked here is "where am I about to put these", which is only useful while
the answer can still change.

The panel carries, in order:

- the destination — the host badge in the host's colour, then the absolute
  path. Same two facts the pane's `PathRow` shows, in the same order, because
  this modal is claiming to describe that pane
- `choose files…` and `choose a folder…`, which click the hidden inputs. This
  works because the click is inside a user gesture; nothing about the native
  dialogue can be skinned, and this design does not try
- what was picked: a row per entry with its size, a total, and a count
- the conflict policy, today hard-coded to `keepBoth` (`uploads.tsx:66`) and
  never once shown to anybody
- confirm, which hands the list to `uploads.start()` and closes

A drop raises the same modal with the list already filled in. Both ways in
confirm the same way, and the drop stops being the one path that acts without
asking.

The copy stays inline in the component. `src/text/` does not exist yet — that is
TRE-116, still Todo — and inventing half of it here would leave the codebase
with one file following a convention nothing else follows.

### 2. Picking a folder

Two sources, because the browser gives two.

The **picker** gets `webkitdirectory` on a second hidden input. Every `File` it
returns carries `webkitRelativePath`, the path from the chosen folder down.

The **drop** uses `webkitGetAsEntry()` on `dataTransfer.items` and walks the
tree. The entries must be collected synchronously, inside the drop handler,
before the first `await`: `dataTransfer` is emptied when the event handler
returns, and a walk that begins with an await finds nothing. This is the one
place in the feature where the ordering is not a preference.

An empty subdirectory has no `File` to report, so the picker path cannot see one
and cannot recreate it. The drop path can, and does. The asymmetry is real,
belongs in the ticket, and is not worth a workaround.

### 3. Relative paths on the wire

The part's `filename` carries the relative path. Nothing else changes on the
wire: the destination directory stays in the query string, where it is validated
before busboy sees a byte, and the body stays free of fields for the reason
`upload-multipart.ts` already gives.

`safeRelativePath()` joins `safeFilename()` in `upload-name.ts`:

- split on both separators, drop empty segments
- run every segment through the existing allowlist, so a path cannot smuggle
  through a character a name could not
- refuse the whole path if any segment reduces to nothing, or to dots alone —
  `..` never becomes a segment here, so traversal is not a case to handle but a
  case that cannot be constructed
- cap the depth at 32 segments and the joined length at 4096

One function serves both cases. A bare `report.txt` has one segment and
comes back out of `safeRelativePath` exactly as `safeFilename` would have
returned it, so the route does not branch on whether this upload is a tree.

The service then `mkdir`s the parent with `recursive: true` and writes into it.
The path guard still validates the joined directory per part: sanitising means
the guard is never asked to adjudicate a path that should not have been built,
and it does not mean the guard stops being the authority.

Directories are created under the destination, so a dropped `photos/` becomes
`<dest>/photos/…` rather than its contents scattered into `<dest>`.

### 4. Batching the requests

The client packs files into requests:

- a file of 8 MiB or more travels alone, and keeps the per-file progress bar it
  has today
- everything smaller is packed until the batch reaches 100 files or 32 MiB,
  whichever comes first — both under the route's own 200-part ceiling, with
  headroom left deliberately

Progress degrades honestly rather than being invented. `upload.onprogress` is
per request, so a packed batch drives one bar computed against the batch's total
bytes; the individual rows stay in the tray and flip to done from the
`results[]` the route already returns. Nothing apportions a number the browser
did not give us.

The arithmetic that matters: 5,000 small files become roughly 50 requests
instead of 5,000. That is under the existing limit with pacing to spare, and it
writes 50 audit rows for one folder instead of 5,000.

### 5. The 429 becomes a pause

`audit.interceptor.ts:207` throws with a prose message, and
`RateLimitService.describe` puts the reset inside that prose, where a client
cannot use it. Add `Retry-After` to the response, from the same
`verdict.resetSeconds` the message is already built from.

`uploads.start()` then honours it: the queue pauses, the rows say so, and it
resumes when the window opens. The current behaviour — abandon everything
remaining behind one toast — goes away, which fixes the flat forty-file case
that is broken today and not only the folder case this ticket is about.

### 6. Dot-files

A folder picked on a Mac carries a `.DS_Store` in every directory. The modal
skips dot-files by default and says how many it is skipping, with a checkbox to
include them. Default on, because that is what somebody uploading a folder
wants; stated in the panel, because a default that silently drops files the user
selected is a default that lies.

## Testing

Server, alongside `upload.spec.ts`:

- `safeRelativePath` — separators of both kinds, `..` in any position, dots-only
  segments, over-deep and over-long paths, and a segment that sanitises to
  nothing. Exhaustive and filesystem-free, the way `upload-name.ts` already is
- a multipart request whose parts carry relative paths creates the tree and
  lands each file in it
- the path guard still refuses a destination outside the roots when the relative
  path is the thing pointing out of them
- the 429 carries `Retry-After`

Front:

- the modal names the host and path it was handed, and sends nothing before
  confirm
- a drop raises the modal rather than starting an upload
- batching packs by both bounds, and a large file is never packed
- a 429 mid-queue pauses and resumes instead of dropping the remainder

## Out of scope

**Resumable uploads.** The pieces exist — `WriteOptions.append` on the driver,
`stat` for the offset, and a `.part` the server already writes — but resume
needs a stable partial name where today's is random per attempt, an offset
endpoint, expiry for abandoned parts, and the byte budget charged per byte
rather than per attempt. Its own ticket, and worth one.

**The transfer engine.** `upload-multipart.ts` argues a directory belongs to
TRE-23 rather than to one HTTP request. That argument is about the second leg —
moving a tree that is already on a host — and batching answers the first leg
without it.
