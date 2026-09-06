import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { FlatTree } from "./corpus";
import { stableUuid } from "./ids";
import {
  ACTIVITY,
  type ActivitySpec,
  BOOKMARKS,
  type HostRef,
  SCANS,
  TRANSFERS,
  TREE,
  type TransferItemSpec,
  type TransferSpec,
  VIEWS,
} from "./manifest";

/**
 * What the manifest implies, worked out without a database (TRE-140): the
 * activity rows the scans, transfers, views and bookmarks would have written
 * had somebody really done them, the transfer items a directory of the tree
 * expands to, and the `$TREE` placeholder resolved against a real root.
 *
 * Pure, like `corpus.ts`, and for the same reason: `corpus.spec.ts` asserts
 * that every path the fixtures name is a path the tree materialises, and that
 * every activity row is inside the retention window with a kind the audit
 * spec would accept. Neither needs a disk.
 */

// ---------------------------------------------------------------- $TREE

/** `$TREE/var/log` → `/wherever/the/tree/is/var/log`. */
export function resolveTree(value: string, root: string): string {
  return value.split(TREE).join(root);
}

/** The same, through a payload or any other plain value. */
export function resolveTreeDeep<T>(value: T, root: string): T {
  if (typeof value === "string") return resolveTree(value, root) as unknown as T;
  if (Array.isArray(value)) return (value as unknown[]).map((entry) => resolveTreeDeep(entry, root)) as unknown as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveTreeDeep(entry, root)]),
    ) as T;
  }
  return value;
}

/** Every `$TREE/...` reference inside a value, as tree-relative paths. For the spec. */
export function treeReferences(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    const pattern = new RegExp(`\\${TREE}(?:/([^\\s"'\`]*))?`, "g");
    for (const match of value.matchAll(pattern)) found.add(match[1] ?? "");
  } else if (Array.isArray(value)) {
    for (const entry of value) treeReferences(entry, found);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) treeReferences(entry, found);
  }
  return found;
}

// ---------------------------------------------------------------- kinds

/**
 * The kinds whose routes are marked `destructive: true`, copied from the
 * `@Audited` specs in `src/`. A fixture row is classed the way the
 * interceptor would class it, because the class decides which retention
 * window prunes it — and `transfer.run`, which the runner opens by hand, is
 * destructive there too.
 */
export const DESTRUCTIVE_KINDS: ReadonlySet<string> = new Set([
  "transfer.queue",
  "transfer.retry",
  "transfer.run",
  "user.password",
  "host.create",
  "host.update",
  "host.acceptkey",
  "host.delete",
  "host.sudo.open",
  "link.minted",
  "file.upload",
  "file.chmod",
  "file.chown",
  "file.chmod.undo",
  "file.chown.undo",
  "file.rename",
  "file.delete",
]);

// ---------------------------------------------------------------- ids

export function jobIdFor(transfer: Pick<TransferSpec, "key">): string {
  return stableUuid(`job:${transfer.key}`);
}

/** Three fake browser sessions, so the log has more than one to tell apart. */
export function sessionIdFor(index: 0 | 1 | 2): string {
  return createHash("sha256").update(`session:${index}`).digest("base64url").slice(0, 32);
}

// ---------------------------------------------------------------- transfers

/**
 * The items a job carries, either as written or enumerated from the tree.
 *
 * Enumerated the way the walk names them: relative to the selection, so the
 * selected directory is the first segment of every name and is itself an
 * item. Directories carry no bytes — `itemFrom` zeroes them too — and
 * everything is DONE, since a job whose items are worth spelling out is
 * written out in the manifest instead.
 */
export function transferItems(transfer: TransferSpec, flat: FlatTree): TransferItemSpec[] {
  if (Array.isArray(transfer.items)) {
    // A hand-written item that names a file the tree makes — at the source
    // or at the destination — takes that file's size: the detail panel must
    // not show a byte count the listing beside it contradicts.
    const sizes = new Map(flat.entries.map((entry) => [entry.rel, entry.spec.kind === "symlink" ? 0 : entry.size]));
    const relOf = (path: string): string | null => (path.startsWith(`${TREE}/`) ? path.slice(TREE.length + 1) : null);
    const ends = [relOf(transfer.srcPath), relOf(transfer.dstPath)].filter((rel): rel is string => rel !== null);
    return transfer.items.map((item) => {
      if (item.kind !== "file") return item;
      for (const end of ends) {
        const size = sizes.get(`${end}/${item.name}`);
        if (size !== undefined) return { ...item, bytes: size };
      }
      return item;
    });
  }

  const top = transfer.items.fromTree.split("/").filter(Boolean).join("/");
  const parent = posix.dirname(top) === "." ? "" : posix.dirname(top);
  const nameOf = (rel: string): string => (parent === "" ? rel : rel.slice(parent.length + 1));

  const items: TransferItemSpec[] = [];
  for (const directory of flat.dirs) {
    if (directory.rel === top || directory.rel.startsWith(`${top}/`)) {
      items.push({
        name: nameOf(directory.rel),
        kind: "directory",
        bytes: 0,
        status: "DONE",
      });
    }
  }
  for (const entry of flat.entries) {
    if (entry.rel !== top && !entry.rel.startsWith(`${top}/`)) continue;
    items.push({
      name: nameOf(entry.rel),
      kind: entry.spec.kind === "symlink" ? "symlink" : "file",
      bytes: entry.spec.kind === "symlink" ? 0 : entry.size,
      status: "DONE",
    });
  }
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

/** The counters the job row carries, from its items. */
export function transferTotals(items: readonly TransferItemSpec[]): {
  bytesTotal: number;
  bytesDone: number;
  itemsTotal: number;
  itemsDone: number;
  moved: number;
  failed: number;
} {
  let bytesTotal = 0;
  let bytesDone = 0;
  let itemsDone = 0;
  let moved = 0;
  let failed = 0;
  for (const item of items) {
    if (item.conflict !== "SKIP") bytesTotal += item.bytes;
    if (item.status === "DONE") {
      bytesDone += item.bytes;
      moved += 1;
    }
    if (item.status === "DONE" || item.status === "SKIPPED") itemsDone += 1;
    if (item.status === "FAILED") failed += 1;
  }
  return {
    bytesTotal,
    bytesDone,
    itemsTotal: items.length,
    itemsDone,
    moved,
    failed,
  };
}

// ---------------------------------------------------------------- activity

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * The whole log, oldest first: the manifest's own rows plus one for
 * everything else the manifest says happened.
 *
 * Bookmarks have no timestamp of their own, so their rows are spread over the
 * hours after the host was added. Everything else keeps the time its spec
 * gives it, and the queue/run pair of a transfer is placed the way the runner
 * places it — the run row opens when the job starts, not when it was queued.
 */
export function allActivity(flat: FlatTree): ActivitySpec[] {
  const rows: ActivitySpec[] = [...ACTIVITY];

  BOOKMARKS.forEach((bookmark, index) => {
    rows.push({
      key: `bookmark-create:${bookmark.label}`,
      at: -(79 * DAY) + index * 7 * MINUTE,
      kind: "bookmark.create",
      summary: `Bookmarked ${bookmark.path}`,
      tag: bookmark.label,
      host: "local",
      durationMs: 5 + index,
    });
  });

  for (const view of VIEWS) {
    rows.push({
      key: `view-create:${view.name}`,
      at: view.createdAt,
      kind: "view.create",
      summary: `Saved the view ${view.name}`,
      tag: view.slot === null ? undefined : `alt+${view.slot}`,
      durationMs: 9,
      payload: { slot: view.slot },
    });
  }

  for (const scan of SCANS) {
    const root = scan.root === "" ? TREE : `${TREE}/${scan.root}`;
    rows.push({
      key: `scan:${scan.key}`,
      at: scan.startedAt,
      kind: "host.scan",
      summary: `Scanned disk usage under ${root}`,
      tag: root,
      host: "local",
      durationMs: 24,
      payload: { root, depth: scan.depth },
    });
    if (scan.status === "CANCELLED") {
      rows.push({
        key: `scan-cancel:${scan.key}`,
        at: scan.startedAt + scan.durationMs,
        kind: "host.scan.cancel",
        summary: "Stopped a disk scan",
        host: "local",
        durationMs: 3,
      });
    }
  }

  for (const transfer of TRANSFERS) {
    const items = transferItems(transfer, flat);
    const totals = transferTotals(items);
    const verb = transfer.operation === "COPY" ? "copy" : "move";
    const tops = items.filter((item) => !item.name.includes("/")).length;
    const jobId = jobIdFor(transfer);

    rows.push({
      key: `transfer-queue:${transfer.key}`,
      at: transfer.createdAt,
      kind: "transfer.queue",
      summary: `${verb} ${count(tops, "entry", "entries")} → ${transfer.dstPath}`,
      tag: count(tops, "entry", "entries"),
      host: transfer.dst,
      destructive: true,
      durationMs: 60 + tops * 4,
      payload: {
        jobId,
        srcPath: transfer.srcPath,
        dstPath: transfer.dstPath,
        operation: transfer.operation,
      },
    });

    // The FAILED job that never ran has no run row: the runner refuses it
    // before opening one. Everything else ran, and wrote how it ended.
    if (transfer.status === "FAILED" && totals.itemsDone === 0 && totals.failed === 0) continue;

    rows.push({
      key: `transfer-run:${transfer.key}`,
      at: transfer.createdAt + transfer.queuedMs,
      kind: "transfer.run",
      summary: `${verb} ${totals.moved} of ${totals.itemsTotal} into ${transfer.dstPath}`,
      tag: `${totals.moved} entries`,
      host: transfer.dst,
      destructive: true,
      outcome: transfer.status === "DONE" ? "success" : transfer.status === "CANCELLED" ? "refused" : "failure",
      detail: transfer.error,
      bytes: totals.bytesDone,
      durationMs: transfer.durationMs,
      payload: {
        jobId,
        moved: totals.moved,
        failed: totals.failed,
        processed: totals.itemsDone,
        outcome: transfer.status,
      },
    });

    if (transfer.status === "CANCELLED") {
      rows.push({
        key: `transfer-cancel:${transfer.key}`,
        at: transfer.createdAt + transfer.queuedMs + transfer.durationMs - 400,
        kind: "transfer.cancel",
        summary: `cancel transfer ${jobId}`,
        host: transfer.dst,
        durationMs: 5,
      });
    }
  }

  return rows.sort((left, right) => left.at - right.at || left.key.localeCompare(right.key));
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

/** The ids the loader resolved, by `HostRef`. Null for an SSH placeholder that is not there. */
export type HostIds = Readonly<Record<HostRef, string | null>>;

/** The host a `HostRef` names, for callers that hold the ids. */
export function hostIdFor(ref: HostRef | null | undefined, ids: HostIds): string | null {
  return ref ? ids[ref] : null;
}
