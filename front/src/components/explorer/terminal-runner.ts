import { formatInstant, formatSize, sortRows } from "@helpers/listing";
import { columns, groupTargets, helpLines, LISTING_LIMIT, prompt } from "@helpers/terminal";
import { ApiError } from "@lib/api/client";
import { fetchDisks } from "@lib/api/disks";
import { fetchListing, fetchStat } from "@lib/api/fs";
import { fetchHostSummary } from "@lib/api/hosts";
import { fetchScanState, startScan } from "@lib/api/scans";
import { QUERY_KEYS } from "@lib/query/keys";

import type { Intent, LineKind } from "@helpers/terminal";
import type { FileRow } from "@lib/api/fs";
import type { HostView } from "@lib/api/hosts";
import type { QueryClient } from "@tanstack/react-query";

/**
 * What each intent actually does (TRE-35 §1).
 *
 * The rule the ticket states and this file keeps: **the terminal reuses the
 * same code as the UI rather than shelling out in parallel.** `ls` is the
 * listing query the pane runs, `df` the one the sidebar runs, `du` the scan the
 * strip starts. Not "an equivalent request" — the same function, through the
 * same cache, under the same guards. A path refused for the pane is refused
 * here identically, because it is refused by the same endpoint.
 *
 * Nothing here parses. Everything it receives has already been through
 * `helpers/terminal.ts`, which is where the security boundary is; what arrives
 * is a typed intent whose fields go into typed calls. There is no string here
 * that came from the person typing, except the ones being printed back to them.
 *
 * It is a module rather than a hook so the panel reads as a panel. The effects
 * it cannot perform itself — moving a pane, opening a modal — are handed in as
 * `TerminalWorld`, because they are the explorer's closures and this file has
 * no business owning a copy of them.
 */

/** A line the runner produced, before the panel gives it a key. */
export interface Written {
  kind: LineKind;
  text: string;
}

/** What `chmod` hands to the permissions modal. */
export interface TerminalPermissions {
  hostId: string;
  directory: string;
  entries: readonly FileRow[];
  /** The octal the person typed, which the modal opens on rather than the file's own. */
  mode: string;
}

/** What `rm` hands to the delete modal. */
export interface TerminalDelete {
  hostId: string;
  directory: string;
  entries: readonly FileRow[];
}

/**
 * Everything the runner needs from the explorer, and nothing more.
 *
 * The five effects are the ticket's actual value — "`cd /srv/www` in the
 * terminal moves the pane" — and every one of them is a closure that lives
 * inside `Explorer`. Passing them in rather than reaching for them is what
 * keeps this file drivable by something that is not a browser.
 */
export interface TerminalWorld {
  host: HostView;
  cwd: string;
  hosts: readonly HostView[];
  queryClient: QueryClient;
  csrfToken: string | null;
  /** Move the active pane. */
  cd: (path: string) => void;
  /** The pane's own back button. False when there is nowhere behind it. */
  back: () => boolean;
  /** Rebind the active pane to another host, at that host's home. */
  bind: (hostId: string) => void;
  openPermissions: (target: TerminalPermissions) => void;
  openDelete: (target: TerminalDelete) => void;
}

/** How long a cached listing is worth reusing, matching the pane's own. */
const STALE_MS = 10_000;

function out(text: string): Written {
  return { kind: "output", text };
}

function table(text: string): Written {
  return { kind: "table", text };
}

function done(text: string): Written {
  return { kind: "done", text };
}

function fail(text: string, hint?: string): Written[] {
  return hint === undefined
    ? [{ kind: "error", text }]
    : [
        { kind: "error", text },
        { kind: "hint", text: hint },
      ];
}

/**
 * What the API said, in one line.
 *
 * The app's habit everywhere else — the uploads widget, the transfer queue — is
 * to show the server's own message rather than a translation of the status, and
 * it is the right one here too: a path outside the roots is refused by
 * `PathGuard` with a sentence about roots, and rewriting that into "403" would
 * make the terminal's refusal *less* identical to the UI's, which is the thing
 * the ticket asks for.
 */
function said(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export async function run(intent: Intent, world: TerminalWorld): Promise<readonly Written[]> {
  switch (intent.kind) {
    case "pwd":
      return [out(world.cwd)];

    case "help":
      return helpLines(intent.topic).map(out);

    case "clear":
      // Handled by the panel, which owns the buffer. Reaching it here would
      // mean the runner had a second opinion about what scrollback is.
      return [];

    case "cd":
      return await changeDirectory(intent.path, world);

    case "cdBack":
      return world.back()
        ? [done("back")]
        : fail("cd: nowhere to go back to", "This pane has not moved yet. `cd ..` goes up instead.");

    case "ls":
      return await list(intent.path, world);

    case "df":
      return await filesystems(world);

    case "du":
      return await usage(intent.path, world);

    case "hostname":
      return await naming(world, "hostname");

    case "whoami":
      return await naming(world, "whoami");

    case "ssh":
      return rebind(intent.host, world);

    case "chmod":
      return await permissions(intent.mode, intent.targets, world);

    case "rm":
      return await remove(intent.targets, intent.recursive, world);
  }
}

// ------------------------------------------------------------- moving a pane

/**
 * `cd`, which asks before it moves.
 *
 * A pane sent to a path that does not exist shows an error state, which is the
 * right thing for a click on a stale row and the wrong thing for a typed line:
 * the terminal has somewhere to put the refusal, and leaving the pane where it
 * was is what a shell does. So the listing is fetched first — through the same
 * cache the pane is about to read, so the move costs nothing extra — and the
 * pane is moved only once the host has agreed there is something there.
 */
async function changeDirectory(path: string, world: TerminalWorld): Promise<readonly Written[]> {
  try {
    await world.queryClient.fetchQuery({
      queryKey: [QUERY_KEYS.DIRECTORY, world.host.id, path],
      queryFn: () => fetchListing(world.host.id, path),
      staleTime: STALE_MS,
      retry: false,
    });
  } catch (error) {
    return fail(`cd: ${path}: ${said(error)}`);
  }

  world.cd(path);
  // The pane moved, which is a thing that happened rather than a thing to
  // report — but silence after a `cd` reads as a command that did nothing when
  // the pane you were watching is the other one.
  return [done(path)];
}

function rebind(name: string, world: TerminalWorld): readonly Written[] {
  const wanted = name.toLowerCase();
  // Slug, label and address, in that order of authority: the slug is the
  // server's own identifier, the label is what the sidebar prints, and the
  // address is what somebody who lives in `~/.ssh/config` would type.
  const matches = world.hosts.filter(
    (host) =>
      host.slug.toLowerCase() === wanted ||
      host.label.toLowerCase() === wanted ||
      (host.address !== null && host.address.toLowerCase() === wanted),
  );

  if (matches.length === 0) {
    return fail(
      `ssh: ${name}: no such host`,
      `Trekker binds panes to hosts it knows. ${world.hosts.length === 0 ? "There are none yet." : `Known: ${world.hosts.map((host) => host.slug).join(", ")}`}`,
    );
  }

  if (matches.length > 1) {
    return fail(
      `ssh: ${name} matches ${matches.length} hosts`,
      `Use the slug, which is unique: ${matches.map((host) => host.slug).join(", ")}`,
    );
  }

  const host = matches[0];
  if (host.id === world.host.id) return [out(`already on ${host.slug}`)];
  // A host with no credential binds and then fails to list, which is a worse
  // answer than not binding: the pane would show an error about a machine the
  // person only asked to move to.
  if (host.transport === "SSH" && !host.hasCredential) {
    return fail(
      `ssh: ${host.slug} has no stored credential`,
      "Add one in the host manager — the pane would bind and then refuse every listing.",
    );
  }

  world.bind(host.id);
  return [done(`the pane is on ${host.label}, at ${host.homePath}`)];
}

// ---------------------------------------------------------------- printing

async function list(path: string, world: TerminalWorld): Promise<readonly Written[]> {
  let rows: readonly FileRow[];
  try {
    const listing = await world.queryClient.fetchQuery({
      queryKey: [QUERY_KEYS.DIRECTORY, world.host.id, path],
      queryFn: () => fetchListing(world.host.id, path),
      staleTime: STALE_MS,
      retry: false,
    });
    rows = listing.entries;
  } catch (error) {
    return fail(`ls: ${path}: ${said(error)}`);
  }

  if (rows.length === 0) return [out(`${path} is empty`)];

  // The pane's own order, so a directory read here and read there is the same
  // directory: `sortRows` puts directories first whatever the key says.
  const sorted = sortRows(rows, "name", 1);
  const shown = sorted.slice(0, LISTING_LIMIT);

  const lines = columns(
    shown.map((row) => [
      row.modeText,
      row.owner,
      row.group,
      formatSize(row.size, row.type),
      formatInstant(row.mtime),
      row.type === "link" && row.linkTarget ? `${row.name} → ${row.linkTarget}` : row.name,
    ]),
    ["left", "left", "left", "right", "left", "left"],
  ).map(out);

  if (sorted.length > shown.length) {
    lines.push({
      kind: "hint",
      text: `${sorted.length - shown.length} more — the pane shows all ${sorted.length}`,
    });
  }

  return lines;
}

async function filesystems(world: TerminalWorld): Promise<readonly Written[]> {
  try {
    const disks = await world.queryClient.fetchQuery({
      queryKey: [QUERY_KEYS.HOST_DISKS, world.host.id],
      queryFn: () => fetchDisks(world.host.id),
      staleTime: 30_000,
      retry: false,
    });

    // `tmpfs` and friends are left out for the same reason the sidebar leaves
    // them out: they are the machine's own furniture, and a `df` that opens
    // with nine of them buries the two mounts anyone asked about.
    const real = disks.filter((disk) => !disk.pseudo);
    if (real.length === 0) return [out("no filesystems reported")];

    return columns(
      [
        ["Filesystem", "Type", "Size", "Used", "Avail", "Use%", "Mounted on"],
        ...real.map((disk) => [
          disk.device,
          disk.type ?? "—",
          formatSize(disk.totalBytes, "file"),
          formatSize(disk.usedBytes, "file"),
          formatSize(disk.availableBytes, "file"),
          `${disk.percent}%`,
          disk.mountPoint,
        ]),
      ],
      ["left", "left", "right", "right", "right", "right", "left"],
    ).map(table);
  } catch (error) {
    return fail(`df: ${said(error)}`);
  }
}

/**
 * `du`, which drives the strip rather than duplicating it.
 *
 * A scan is a walk over somebody's disk that can take minutes, so this is the
 * one command whose answer does not arrive on the line that asked for it. What
 * it does instead is what the ticket asks for — reuse the strip — and say so:
 * the strip opens, pinned to the scanned root, and reports the walk as it goes.
 * Printing a spinner into scrollback would be a second progress display for one
 * job, kept in agreement by hand.
 */
async function usage(path: string, world: TerminalWorld): Promise<readonly Written[]> {
  let state: Awaited<ReturnType<typeof fetchScanState>>;
  try {
    state = await world.queryClient.fetchQuery({
      queryKey: [QUERY_KEYS.SCAN, world.host.id, path],
      queryFn: () => fetchScanState(world.host.id, path),
      staleTime: 30_000,
      retry: false,
    });
  } catch (error) {
    return fail(`du: ${path}: ${said(error)}`);
  }

  if (state.running !== null) {
    return [out(`a scan of ${state.running.root} is already running on this host`)];
  }

  // A fresh result is an answer, and re-walking a disk to reprint it would be
  // rude to the host. `stale` is the server's own judgement, not a local clock.
  if (state.scan !== null && !state.scan.stale && state.scan.status === "DONE") {
    const lines: Written[] = [out(`${state.scan.totalBytes ?? "—"} bytes in ${state.scan.root}`)];
    if (state.level !== null && state.level.entries.length > 0) {
      lines.push(
        ...columns(
          state.level.entries.slice(0, 10).map((entry) => [`${entry.percent}%`, entry.bytes, entry.path]),
          ["right", "right", "left"],
        ).map(out),
      );
    }
    lines.push({ kind: "hint", text: "⌥↩ for the treemap in the strip — `du` again once this goes stale to re-walk" });
    return lines;
  }

  try {
    // The one thing the terminal mutates by itself. `chmod` and `rm` are marked
    // too, but from inside their dialogues — the modal is what makes the call,
    // so the modal is what has to carry the label (TRE-35).
    const scan = await startScan(world.host.id, path, world.csrfToken, "terminal");
    return [
      done(`walking ${scan.root}`),
      { kind: "hint", text: "a scan is minutes, not seconds — ⌥↩ for the strip, which reports as it goes" },
    ];
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      return fail("du: a scan is already running on this host", "One walk at a time. The strip shows which.");
    }
    return fail(`du: ${path}: ${said(error)}`);
  }
}

/**
 * `hostname` and `whoami`, which are one probe.
 *
 * Both come off `HostSummary`, which the top bar already asks for on the active
 * host — so on the host the terminal is standing on this is a cache read rather
 * than a request.
 *
 * Each answers null on a machine that does not report it, and each says so
 * rather than substituting something else. `hostname` in particular could
 * plausibly print the host's slug, and must not: the slug is Trekker's name for
 * a machine, and a command called `hostname` printing it would be an answer to
 * a question nobody asked.
 */
async function naming(world: TerminalWorld, which: "hostname" | "whoami"): Promise<readonly Written[]> {
  try {
    const summary = await world.queryClient.fetchQuery({
      queryKey: [QUERY_KEYS.HOST_SUMMARY, world.host.id],
      queryFn: () => fetchHostSummary(world.host.id),
      staleTime: STALE_MS,
      retry: false,
    });

    if (which === "whoami") {
      return summary.remoteUser !== null
        ? [out(summary.remoteUser)]
        : fail("whoami: this host did not answer", "`id -un` returned nothing usable.");
    }

    return summary.hostname !== null
      ? [out(summary.hostname)]
      : fail(
          "hostname: this host does not report one",
          `Trekker reads it from /proc, which this machine has not got. It is bound here as ${world.host.slug}.`,
        );
  } catch (error) {
    return fail(`${which}: ${said(error)}`);
  }
}

// ------------------------------------------------------------- the two modals

/**
 * `chmod` and `rm` stop at the dialogue, deliberately (TRE-35 §1).
 *
 * "The confirmation is not optional because the entry point changed" — a
 * recursive delete typed in a hurry is exactly the case TRE-25's typed
 * confirmation exists for, and a terminal that skipped it would be a faster way
 * to make the mistake the modal was built to prevent.
 *
 * What both need first is real rows: the modals open on a file's current mode,
 * its owner and whether it is a directory, none of which a path string carries.
 * So each typed path is `stat`ed — the same call the inspector makes — and a
 * path that does not exist is refused here rather than in a dialogue that has
 * already opened.
 */
async function statAll(paths: readonly string[], world: TerminalWorld): Promise<FileRow[] | Written[]> {
  const found: FileRow[] = [];
  for (const path of paths) {
    try {
      found.push(
        await world.queryClient.fetchQuery({
          queryKey: [QUERY_KEYS.ENTRY, world.host.id, path],
          queryFn: () => fetchStat(world.host.id, path),
          staleTime: STALE_MS,
          retry: false,
        }),
      );
    } catch (error) {
      return fail(`${path}: ${said(error)}`);
    }
  }
  return found;
}

function isWritten(value: FileRow[] | Written[]): value is Written[] {
  return value.length > 0 && "kind" in value[0];
}

async function permissions(
  mode: string,
  targets: readonly string[],
  world: TerminalWorld,
): Promise<readonly Written[]> {
  const grouped = groupTargets(targets);
  if (!grouped.ok) return fail(`chmod: ${grouped.error}`, grouped.hint);

  const rows = await statAll(targets, world);
  if (isWritten(rows)) return rows.map((line) => ({ ...line, text: `chmod: ${line.text}` }));

  world.openPermissions({ hostId: world.host.id, directory: grouped.directory, entries: rows, mode });
  return [];
}

async function remove(
  targets: readonly string[],
  recursive: boolean,
  world: TerminalWorld,
): Promise<readonly Written[]> {
  const grouped = groupTargets(targets);
  if (!grouped.ok) return fail(`rm: ${grouped.error}`, grouped.hint);

  const rows = await statAll(targets, world);
  if (isWritten(rows)) return rows.map((line) => ({ ...line, text: `rm: ${line.text}` }));

  // `-r` means something here, which is why it is parsed at all. Without it a
  // directory is refused exactly as a shell refuses one — the flag is the
  // person saying they know the target is a tree, and dropping that distinction
  // would make `rm logs` and `rm -r logs` the same keystroke away from each
  // other with very different consequences.
  if (!recursive) {
    const directory = rows.find((row) => row.type === "dir");
    if (directory !== undefined) {
      return fail(`rm: ${directory.name} is a directory`, "Use `rm -r` to mean it.");
    }
  }

  world.openDelete({ hostId: world.host.id, directory: grouped.directory, entries: rows });
  return [];
}

/**
 * The prompt as one string, for the line an echo keeps above its own output.
 *
 * The input row draws the same three facts as three coloured spans, which is
 * how the mockup writes the live prompt; this is the joined form it uses in
 * scrollback, where the parts have to survive being copied out as text.
 */
export function promptFor(world: { host: HostView; cwd: string }, user: string | null, elevated: boolean): string {
  return prompt(who(world, user), world.host.slug, world.cwd, elevated);
}

/**
 * Who the next line runs as.
 *
 * `remoteUser` is the machine's answer and the right one. `username` is the
 * login this install was configured with, which is the same thing on an SSH
 * host and null on a local one. The ellipsis is neither — it is the honest
 * shape of "not known yet", and it is deliberately not a plausible name.
 */
export function who(world: { host: HostView }, user: string | null): string {
  return user ?? world.host.username ?? "…";
}
