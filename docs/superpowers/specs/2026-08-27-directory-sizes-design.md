# Real directory sizes in the pane (TRE-107)

## The problem

Every directory in the file table renders as `4.0 kB`. That figure is the
directory inode's own block, copied straight off `stat` by both drivers
(`local.driver.ts:100`, `ssh.driver.ts:125`), passed through unchanged by
`toRow` (`file-row.ts:111`), and formatted by `formatSize`, which special-cases
symlinks and nothing else.

It is a correct syscall result and a worthless column. An empty directory and
one holding 650 GB of `node_modules` print the same six characters. Worse than
blank, because it looks like an answer.

Two neighbours are computed from it and are wrong for the same reason:

- **the SHARE bar** (`pane.tsx:773`) scales `row.size / largest`, so in a
  directory containing only directories every bar is identical and full — the
  column answers "which of these is big" with "all of them, equally"
- **the footer total** (`fs.service.ts:78`, `pane.tsx:173`) sums those 4096s. A
  directory holding fifteen subdirectories reports `60.0 kB total`, which is
  15 × 4096 and describes nothing that exists.

The inspector repeats the figure twice more (`inspector.tsx:324`, `:347`), and
its "on disk" row rounds 4096 up to 4096.

No file manager displays this. Finder shows `--` unless you turn on "calculate
all sizes", Explorer leaves the cell empty, Midnight Commander prints `SUB-DIR`
and computes the real total on demand. All of them refuse the inode size,
because a number that is always the same is not information.

## What is already there

- **`du` is already an allowed program on both drivers**, with a streaming form
  that is already cancellable. `exec-stream.spec.ts:80` tests exactly the case
  this needs — an `AbortSignal` killing a `du` mid-walk.
- **`ExecOptions` already carries `nice`, `timeoutMs` and `maxOutputBytes`**
  (`host-driver.ts:54`). Scans run at `nice 15`; this reuses that.
- **`du-flavour.ts` already negotiates the `du` dialect per host.** A ladder of
  rungs, richest first, demoted on the failures that mean "this host does not
  understand that flag". GNU and BSD `du` disagree about `-B1` and `--max-depth`,
  and this file is where that is already solved. It must be reused, not
  duplicated — it needs one addition, a `-s` variant of each rung.
- **The pane is already virtualised** (`pane.tsx:27`, TRE-19): only on-screen
  rows are in the DOM, roughly forty of them. This is what makes a per-row
  spinner cheap and what gives the work queue its natural priority order.
- **There is an established SSE pattern** — `scans.controller.ts:64`, with the
  headers that matter (`X-Accel-Buffering: no`, or nginx buffers the whole
  stream until the walk ends), a 20-second heartbeat, and teardown on
  `req.on("close")`.
- **The path guard is already the first thing every fs handler touches.**
  `FsService.list` validates before the driver is reached and then operates on
  the resolved path, never the string the client sent. This endpoint is bound by
  the same order.

## Design

### 1. The wire: a directory has no size

`FileRow.size` becomes `number | null`, and `toRow` sets `null` for
`kind === "directory"`.

This is the part that actually fixes the bug rather than papering over it.
Rendering `—` in the pane while leaving 4096 on the wire would leave every
*other* consumer still summing it, and there are six of them. Making the field
nullable makes the compiler name all six:

| site | what it does with a directory's 4096 today |
|---|---|
| `fs.service.ts:78` | adds it to `meta.totalBytes` |
| `pane.tsx:168` | adds it to the selected-bytes readout |
| `pane.tsx:170` | takes it into `largest`, the SHARE scale |
| `pane.tsx:173` | adds it to the footer total |
| `inspector.tsx:246` | adds it to the multi-selection total |
| `inspector.tsx:394` | same, for the selection panel |

In every one of them the rule is the same: a directory whose size is not known
yet is **excluded**, not counted as zero and not counted as 4096. A total over a
listing with unknown directories is a partial total and says so.

`meta.totalBytes` therefore becomes the total of the *files*, and gains a
sibling `unknownDirs: number` so the client can render "…" beside a total it
knows is incomplete.

### 2. The endpoint

`GET /api/fs/dir-sizes/stream?hostId=&path=` — server-sent events, modelled on
`scans.controller.ts:64`.

The handler validates `path` through `PathGuardService.validate` with intent
`"read"` before touching a driver, exactly as `list` does, and then works from
the resolved real path. It re-reads the directory rather than accepting a list
of names from the client: the names on the wire would be a second, unvalidated
path source, and re-reading is one `readdir` against a directory the guard has
already cleared.

Events:

```
data: {"name":"node_modules","bytes":1958505472}
data: {"name":"secret","error":"EACCES"}
data: {"done":true}
```

`name` rather than a path, because the client already keys its rows by name
within the listing it asked about, and a path on the wire invites the client to
resolve it.

### 3. The walker

A new `DirSizeService`, alongside `FsService` rather than inside it — `list`
answers in 260 ms and this does not answer in bounded time at all, and the two
should not share a lifetime.

**One `du -s` per directory, four in flight.**

The obvious alternative — a single `du --max-depth=1` over the parent, or one
`du -s` given every child as an argument — is cheaper by one process and wrong
for the feature. `du` writes through stdio, which is block-buffered at 4 KB when
stdout is a pipe. A result line is about thirty bytes, so a hundred and thirty
of them fit in the buffer and *none* of them flush until the process exits. Every
row would resolve at the same instant, after the slowest walk, which makes a
per-row progress indication meaningless. One process per directory means one
flush per directory, the moment that directory's own walk ends.

Four at a time also parallelises the walk across independent subtrees, which is
where `diskus` gets its roughly 2× over `du` — the win is IO concurrency, not
the language.

**Order: viewport first, then the rest.** The queue is seeded from the rows the
client says are on screen (the SSE request carries the first visible index and
count) and then drains through the remainder of the listing in order. Feedback
arrives where the eye already is; the listing still completes, which it must,
because sorting by size and the footer total both need every row.

**Rungs.** `du-flavour.ts` gains a `-s` variant per rung. The probe and demotion
logic are untouched; only the argument vectors differ. `-x` is deliberately
*not* carried over from the scan rungs: a scan asks "what is on this disk", so
it stops at a mount point, but this column answers "what is inside this
directory", and a tree that happens to span a mount is still inside it.

### 4. Lifetime

No cache, no time limit.

- **No time limit.** A walk runs to completion however long it takes. A cap
  would have to kill the `du`, and a killed walk leaves a permanently blank cell
  that looks like an error and is not one.
- **No cache.** Every navigation recomputes. This is less expensive than it
  sounds because the kernel is already the cache: cost tracks inode count rather
  than bytes, and a tree walked once has its dentries and inodes in RAM, so
  stepping out and back in is cheap. It also means there is no invalidation
  problem and no way to show a stale number as if it were current.
- **Leaving the directory kills the walks.** With no cache, an answer for a
  directory nobody is looking at has nowhere to go. Without this, holding down
  the arrow key through a tree would leave a `du` running per directory passed —
  on somebody's production host. `req.on("close")` aborts every in-flight signal
  and empties the queue.
- **`nice 15`**, as scans do.

### 5. The three states

A directory's cell is in exactly one of three states, and they must be
distinguishable at a glance:

- **working** — a spinner cycling through `-`, `\`, `|` and `/`
- **known** — the formatted size
- **unreadable** — a distinct glyph, never a spinner

The spinner is one shared ticker in the pane advancing a single character in
state, which every pending row reads — not a timer per row. All spinners
therefore turn in step, which in a monospace terminal UI reads as deliberate
rather than as a hundred independent animations. Virtualisation bounds the
count to what is on screen.

The error state matters as much as the other two: a directory the account
cannot read must never present as a spinner that never stops.

### 6. Sorting

Sorting by size (`listing.ts:220`) has to cope with rows whose size is still
arriving.

Rows do not reorder while sizes stream in. A live resort would move rows under
the cursor and under the mouse, repeatedly, for as long as the walk lasts. New
sizes are applied in place; if the listing is sorted by size, the resort runs
once when the stream reports `done`. Directories with no size sort together,
after the files, in name order.

## Testing

- **Driver parity.** The same fixture tree read by `LocalDriver` and
  `SshDriver` yields identical sizes — the property `verify:fs` already asserts
  for listings, extended to this.
- **A size that is actually right.** The reported bytes for a fixture directory
  equal `du -sb` run directly on the host.
- **Cancellation.** Closing the stream mid-walk leaves no `du` process behind;
  asserted by counting processes on the host, not by trusting the abort call.
- **Nullability.** `meta.totalBytes` over a listing of directories is the files'
  total and `unknownDirs` counts the rest — specifically, the case that produces
  today's `60.0 kB` is asserted not to.
- **Unreadable directories** produce an `error` event and a terminal state, not
  a stalled one.
- **`/api/fs/list` is unchanged**: 10,000 entries still under 500 ms, still one
  `readdir` and no per-entry `stat`.

## Out of scope

- **`/api/fs/list` itself.** It keeps the TRE-13 budget. Sizes arrive after the
  listing, over a separate stream, never inside it.
- **Reusing `DiskScanEntries`.** The scan table holds real recursive sizes
  already, and seeding the pane from them was considered and dropped: scan rows
  are only stored to a configured depth, only exist for roots someone has
  scanned, and carry no freshness guarantee. Serving them here would show a
  number from last week beside numbers from this second, indistinguishably.
- **Sizes for remote hosts without `du`.** The error state covers it.
