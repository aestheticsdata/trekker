# A live tail (TRE-34), and the process it must not leave behind

## The problem

The ticket is two sentences long where it matters: `tail -F` on a remote file,
streamed to the browser, **without leaking a process per abandoned tab**. The
streaming half is a solved shape in this codebase — three SSE feeds already run
on the same per-user fan-out. The other half is the whole ticket, and the
codebase already knows why.

`SshDriver`'s abort path says it out loud
(`nest-api/src/hosts/drivers/ssh.driver.ts:519`):

> The signal is best effort — OpenSSH's sshd does not implement the RFC 4254
> request at all — and the actual kill is `close()`: the remote process takes
> SIGPIPE the next time it writes to a channel that is gone.

*The next time it writes.* A `tail -F` on a log that is not being written to
sits in `inotify` and writes nothing, so it takes no SIGPIPE, so it does not
die. It is an orphan on somebody's server until the file next moves or the
machine reboots.

Four of the ticket's ten acceptance criteria are about exactly this:

- Closing the tab ends the remote process — verified with `ps` on the host.
- Killing the browser ends it too.
- 50 tails opened and closed leave no process and no listener behind.
- Two tabs on the same file share one process.

Over SSH, `tail -F` cannot satisfy the first three. Not "usually does not" —
cannot, because nothing in the SSH protocol as OpenSSH implements it will kill
that process, and the two mechanisms that look like they would (`channel.signal`
and `channel.close`) are the two the driver already documents as insufficient.

There is a second cost, and it is worse than an orphan. `execStream` borrows a
**background** lease (`ssh.driver.ts:468`), and the pool gives background work
`maxConcurrency` minus `RESERVED_INTERACTIVE` — six minus two, so **four** slots
per (host, user) (`ssh-connection.pool.ts:97,156,270`). Four abandoned tails is
the ceiling. The fifth borrower queues, and the queue is the known gap that
`ssh-connection.pool.ts:192` names and deliberately left:

> **A known gap, found by TRE-32 and deliberately left.** The waiting queue has
> no timeout […]

So four quiet logs, tailed and abandoned over an afternoon, permanently wedge
every disk scan on that host behind a queue with no way out. The leak is not the
process; the leak is the host.

## The decision

**Over SSH there is no remote process at all.** Poll `stat`, read the byte
delta. Over LOCAL, run the real `tail -n N -F`, where `spawn` kills it properly.

This inverts what §1 of the ticket asks for — it names `tail` first and
stat-polling as the fallback "when `tail` is unavailable" — and the inversion is
the point. The Done checklist and §1 want different things, and the checklist is
the one describing what the feature has to be true of. With no remote process:

- closing the tab ends it, because there is nothing to end;
- killing the browser ends it, for the same reason;
- fifty opened and closed leave nothing, for the same reason;
- and the pool sees only brief *interactive* leases — `stat` and a ranged read,
  milliseconds each — instead of a background lease held for an afternoon.

What it costs is latency: one poll interval instead of instantaneous. At 700 ms
that is a line on screen well inside the ticket's own bar of two seconds through
nginx, with room for a slow link. What it buys is that the four criteria above
are true by construction rather than true on a busy log and false on a quiet one.

Both paths sit behind one `TailSource` interface, so the registry, the framer,
the ring buffer, the fan-out and the SSE handler are written once.
`TREKKER_TAIL_FORCE_POLL=1` runs the poller against a local host, so the path
that serves every real deployment is the path a laptop can exercise.

### Why not bound it with `timeout`

`timeout -s KILL 1800 tail -F …` would cap an orphan's life, and it would be
rendered the way `nice` already is — a literal prefix written by
`buildRemoteCommand`, never a program a caller can name, so it opens no hole in
the allowlist (`shell-quote.ts:120`). It was the third option and it loses on
two counts. It does not remove the leak, it puts a clock on it, and four
simultaneous quiet tails still exhaust the background pool for the length of
that clock. And `timeout` is absent on macOS and on a stripped container, so it
needs the probe-and-demote ladder `du` already carries — real work, to make a
worse answer survive more hosts.

## What is already there

- **`tail` is on the allowlist** (`shell-quote.ts:28`), so the LOCAL path needs
  no security decision at all.
- **Three SSE precedents.** `ScanEventsService`, `HashEventsService` and
  `TransferEventsService` are one shape, and `ScansController.stream` is the
  route idiom: raw `res.writeHead`, `X-Accel-Buffering: no`, `": connected"`
  immediately, a 20 s `": ping"` on an `unref()`'d interval, and unsubscribe on
  `req.on("close")`.
- **`ReadOptions { start?, end? }`** — an inclusive byte window implemented
  natively on both drivers (`host-driver.ts:206`), so a ranged read over SFTP
  transfers the window and not the file. This is the whole poll path.
- **`PathGuardService.validate`** returns a `realPath` that has been through
  `realpath` on the host — which is what makes two tabs share one process
  correctly, rather than approximately.
- **The limits table habit** — `scan-limits.ts` puts every bound one file
  can answer, and says why each number is that number.

## The shape

### The registry, and what "share one process" means

Keyed `` `${hostId}:${realPath}` ``. The resolved path, not the requested one:
`/var/log/nginx/access.log`, `/var/log/nginx/../nginx/access.log` and a symlink
to either are one file, and keying on the string the client sent would run two
pollers over it and fail the criterion while appearing to pass it.

The key is deliberately **not** scoped by user. Two accounts tailing the same
file share one source, because the guard has already independently authorised
each of them for that `realPath` — sharing leaks nothing, and the alternative
doubles what the host pays for no gain. Admission counting is per session.

Ref-counting has two clocks, and the split is what makes two requirements true
at once:

- The **source** stops the instant the last subscriber leaves. No grace period.
  `ps` on the host is clean while the tab is still animating shut.
- The **entry** lingers ten seconds after that, holding only its ring buffer,
  byte offset and sequence number — no process, no connection, no timer but the
  reaper. An `EventSource` that reconnects three seconds later resumes from the
  offset instead of re-reading the tail of the file and showing the reader the
  same forty lines twice.

### Backpressure belongs at the subscriber

The ticket's rule is that a backgrounded tab must never slow the reader down.
So the source is drained at full speed into the entry's ring, and the fan-out
never awaits and never queues on our side. Before each write:

```
if (res.writableLength > TAIL_SUBSCRIBER_BUFFER_BYTES) { drop; mark; continue }
```

`res.writableLength` is Node's own count of bytes sitting in that socket's write
queue. It is the honest measure of "this client is not keeping up", it costs
nothing to read, and it needs no queue of ours to grow. `res.write()` never
blocks — it buffers — so checking the length *before* writing is the entire
difference between bounded and unbounded.

The `gap` frame is emitted lazily, on the next write that succeeds, rather than
at the moment of dropping. Writing a gap marker to a socket that is already over
its cap is the one thing certain not to arrive; and emitting on recovery gives
one marker per burst instead of one per dropped batch.

### Rotation

`-F` is in the ticket because a log that rotates at midnight and silently stops
updating is the classic bug. The poll path gets the same property from the
numbers:

| `stat` says | Meaning |
|---|---|
| `size > offset` | Ordinary append. Read `[offset, size-1]`. |
| `size < offset` | Rotated or truncated. Announce, reset to 0, read the new head in the same tick. |
| `ENOENT` | Rotated away, replacement not yet created. Announce once, keep ticking. |

`copytruncate` — the common `logrotate` mode — shrinks to zero and is caught
exactly. `create` mode is caught as long as the replacement is smaller than the
old offset when we next look, which at 700 ms is true unless the log takes more
than its entire accumulated size in traffic within one tick.

This is size-based and therefore heuristic, because **SFTP v3 carries no inode**
— `host-driver.ts:44` already says a remote host simply does not report one.
`LocalDriver` does, so the poller compares inodes when the stat carries one and
falls back to the size rule when it does not.

### The strip

The mockup draws it inside the pane, docked between the row list and the footer
(`Trekker - App.dc.html:257`), on a ground one step darker than the pane, with a
2px accent edge on the left. Not a floating panel: it takes its space from the
listing, the way the disk-usage strip takes its from the panes.

**When it appears.** The mockup gates it on a hardcoded regex of three specific
paths, which is a prototype's way of saying "when you are in a log directory".
The real rule is three mechanisms, in order of authority:

1. **The URL is the mark.** The tailed file is a per-pane URL parameter, so it
   survives a reload, a cold open and a shared link. That persistence *is* "the
   user marked this", expressed in the state this project already keeps, and it
   costs no schema. The principle is already the project's: pane state lives in
   the URL (§7 of the design).
2. **A path heuristic decides whether the strip offers itself** — `/var/log` or
   under it, or any segment named `log`/`logs`. When it matches and nothing is
   being tailed, the strip renders an idle picker of the log-looking files in
   that directory. It renders; it does not stream.
3. **Nothing auto-streams.** Opening a connection to somebody's server because
   they navigated into a directory is the kind of helpfulness people uninstall
   software over — and guessing which of eleven files in `/var/log` was meant
   would be wrong most of the time. Pre-aimed with a one-click start is the
   whole benefit and none of the surprise.

A marks table was the alternative. `Bookmarks` is the closest existing fit and
its `@@unique([hostId, path])` is already the right grain, but it costs a
migration, a route, and the consequence that every logs directory must also be a
sidebar bookmark. Worth doing when somebody asks; not worth doing first.

### The status colours are not the mockup's

The mockup colours an access-log status by class: `#2f7a4a` for 2xx and 3xx,
`#1c4a68` for 4xx, `#a33` for 5xx, on the strip's `#93b4d1` ground. Measured
against that ground, all three fail WCAG AA:

| Class | Mockup | Contrast on `#93b4d1` |
|---|---|---|
| 2xx / 3xx | `#2f7a4a` | 2.42:1 |
| 4xx | `#1c4a68` | 4.35:1 |
| 5xx | `#a33` | 3.00:1 |

TRE-33 settled what happens next, and its commit message is the rule: *a colour
that carries meaning has to be legible, and three of ours were not*. These are
three more, and they carry more meaning than the heat ramp did — the whole point
of colouring a status code is that a 502 is findable without reading digits.

So the hues stay, the ground stays, and each ink is darkened until it clears
4.5:1, with `verify:contrast` extended to measure this table the way it already
measures the age ramp and the treemap bands. The mockup's pixels are the
reference; they have never been the thing that ships unexamined.

Note also `4.35:1` on 4xx: the same `--color-on-pane-muted` clears AA
comfortably on the pane itself (`#9bbcd7`, 4.74:1) and fails on the strip. The
sunk ground is what breaks it, which is worth knowing before anyone reuses a
pane ink on a darker surface again.

## Out of scope, and staying that way

Search within the tail, filters, multi-file tail. Log parsing and alerting —
that belongs to another app on the fleet. The line framer scrubs ANSI escapes
and control characters, and that is not parsing: it is making bytes safe to put
in a DOM node.

## The one thing this leaves behind

`main.ts` never calls `app.enableShutdownHooks()`, so no `OnModuleDestroy` in
this application runs on a `pm2 reload` — the tail registry's would be dead code
alongside the transfer queue's. For the poller that costs nothing: the process
dies and takes its SFTP leases with it. For a LOCAL `tail` child it means the
child can outlive a redeploy.

The registry therefore listens for `SIGTERM` itself rather than relying on a
hook that does not fire. Calling `enableShutdownHooks()` is the correct fix and
changes the behaviour of fourteen classes at once, including two queues whose
recovery paths deliberately leave rows `RUNNING` for the boot sweep. That is its
own ticket, and this file is the pointer to it.
