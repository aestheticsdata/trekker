# Undo for recursive chmod and chown (TRE-75) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a chmod or chown be undone — restore the mode/uid/gid every entry it changed had before — surfaced from the toast right after the change and from the sidebar's activity strip.

**Architecture:** The recursive walk (and, newly, a single `stat` for a non-recursive change) already produces the pre-change mode/uid/gid for every entry a chmod/chown touches; `PermissionsService.apply()` is extended to persist those values — only for entries that actually changed — into a new `PermissionSnapshots` table keyed by the operation's `ActivityLog` row. A new `PermissionsUndoService` restores from that table: per-entry values (not one shared value), full path-guard validation per entry, skip-and-report (not stop-at-first-failure) for a path that has since vanished or changed, and — critically — only the field(s) the original operation actually touched (chmod-undo writes `mode` only, chown-undo writes `uid`+`gid` only), so undoing an old chmod can never clobber a chown that happened afterward. Two new routes (`POST /fs/chmod/undo`, `POST /fs/chown/undo`) expose it, audited and rate-limited exactly like the operations they reverse. Snapshot rows are pruned after 30 days by their own `RetentionService` pass, independent of the audit row's own 90/365-day retention.

**Tech Stack:** NestJS + Prisma (MySQL) on the backend (`nest-api/`), Next.js + React Query on the frontend (`front/`). Jest for backend tests; the frontend has no automated test runner — its tasks end in typecheck/lint/build plus a manual check instead.

## Global Constraints

- Migrations are never generated with `prisma migrate dev` on this repo (it demands a destructive reset because migrations are hand-annotated after being applied) — always `migrate diff` → hand-write `migration.sql` → `db execute` → `migrate resolve --applied`. See Task 1.
- Every `@Audited` `kind` must match `subject.verb` (dot-separated, lowercase, `[a-z][a-z0-9]*`) and be ≤32 characters (`audit-coverage.spec.ts`). This plan uses `file.chmod.undo` and `file.chown.undo`.
- Every route decorated `destructive: true` must carry `limit: LIMITS.<name>` on the same decorator, or the build fails (`audit-coverage.spec.ts`). This plan reuses `LIMITS.permissionChange` for both undo routes — no new limit is declared.
- `ActivityLog` rows are written and closed only by `audit/audit.service.ts`, and deleted only by `audit/retention.service.ts` (`audit-coverage.spec.ts`, "keeps the log append-only outside the audit module"). Nothing in this plan calls `.activityLog.update`/`.delete`/`.upsert` from outside those two files; `PermissionsUndoService` only *reads* `activityLog.findUnique`, which that rule does not restrict (`ActivityService` already does the same for the `/activity` GET route).
- No hand-written `useMemo`/`useCallback`/`React.memo` in `front/` — the React Compiler handles it, and correctness must never depend on it stabilising an identity.
- No arbitrary Tailwind values (`text-[#fff]` etc.) — use the existing token scale. Every class used in this plan's frontend tasks is one already confirmed present elsewhere in this codebase.
- Every clickable element gets an explicit `cursor-pointer` class — Tailwind v4 preflight removes the default pointer cursor.
- Snapshot retention is 30 days (`TREKKER_PERMISSION_SNAPSHOT_RETENTION_DAYS`, overridable), independent of `ActivityLog`'s own 90-day ordinary / 365-day destructive windows.
- Undo restores only what the operation it reverses actually touched: `chmod/undo` writes `mode` only; `chown/undo` writes `uid` and `gid` only. Never both from one undo call, even though every snapshot row carries all three values.

---

### Task 1: `PermissionSnapshots` table

**Files:**
- Modify: `nest-api/prisma/schema.prisma`
- Create: `nest-api/prisma/migrations/<timestamp>_permission_snapshots/migration.sql`

**Interfaces:**
- Produces: Prisma model `PermissionSnapshots` → client accessor `prisma.permissionSnapshots` with fields `id: string`, `activityLogId: string`, `path: string`, `mode: number`, `uid: number`, `gid: number`, `createdAt: Date`. Every later task that touches the table uses this exact accessor name (Prisma lowercases only the model name's first letter — it does not depluralize).

- [ ] **Step 1: Add the model to the schema**

In `nest-api/prisma/schema.prisma`, find the `ActivityLog` model (currently starts around line 694, ends with its `@@index` list). Add one new relation field to it, next to the existing `user`/`host` relation fields:

```prisma
  user                Users                 @relation(fields: [userId], references: [id], onDelete: Cascade)
  host                Hosts?                @relation(fields: [hostId], references: [id], onDelete: SetNull)
  permissionSnapshots PermissionSnapshots[]
```

Then add the new model immediately after the `ActivityLog` model's closing `}`:

```prisma
/// Old mode/uid/gid for one entry, before a chmod or chown changed it
/// (TRE-75). Written only for entries the operation actually changed — the
/// walk (or a single `stat` for a non-recursive change) already has these
/// values in hand, so this is never a second fetch.
///
/// `path` is `Text`, unindexed: every lookup is by `activityLogId`, never by
/// path, matching `DiskScanEntries.path`.
///
/// Pruned on its own 30-day schedule by `RetentionService`, independent of
/// `ActivityLog`'s own 90/365-day retention — the audit summary line should
/// outlive the ability to undo it. `onDelete: Cascade` is a referential
/// backstop only, for the (normally never reached) case an `ActivityLog`
/// row is deleted before its own snapshots have aged out; it is not the
/// prune mechanism.
model PermissionSnapshots {
  id            String   @id @default(uuid(7)) @db.Char(36)
  activityLogId String   @db.Char(36)
  path          String   @db.Text
  mode          Int
  uid           Int
  gid           Int
  createdAt     DateTime @default(now())

  activityLog ActivityLog @relation(fields: [activityLogId], references: [id], onDelete: Cascade)

  @@index([activityLogId])
  @@index([createdAt])
}
```

- [ ] **Step 2: Generate the diff**

Run from `nest-api/`:

```bash
cd nest-api && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

This prints the raw `CREATE TABLE`/`ALTER TABLE`/`AddForeignKey` SQL to stdout. It will closely match (backtick identifiers, `CHAR(36)`/`TEXT`/`INTEGER`/`DATETIME(3)`, index names `PermissionSnapshots_activityLogId_idx` / `PermissionSnapshots_createdAt_idx`, FK name `PermissionSnapshots_activityLogId_fkey`) the shape other `CREATE TABLE` migrations in this repo use — see `nest-api/prisma/migrations/20260815111947_disk_scans_carry_their_facts/migration.sql` for the `AddForeignKey` style and `20260821203000_views_store_one_layout/migration.sql` for the general annotation convention. If the tool's actual output differs from that shape in any detail, use the tool's output verbatim for the SQL body — only the comment header below is fixed by this plan.

- [ ] **Step 3: Write the annotated migration by hand**

Create `nest-api/prisma/migrations/<YYYYMMDDHHMMSS>_permission_snapshots/migration.sql` (timestamp = now, in the same `YYYYMMDDHHMMSS` shape as the sibling directories), with a comment header followed by the diff output from Step 2:

```sql
-- The old mode/uid/gid of every entry a chmod or chown actually changed,
-- saved so an undo has something to restore (TRE-75).
--
-- One row per entry — the walk (or a single `stat` for a non-recursive
-- change) already has these values in hand, so writing them is never a
-- second fetch. `path` is `TEXT` and unindexed, matching `DiskScanEntries`:
-- every lookup here is by `activityLogId`, never by path.
--
-- Pruned on its own 30-day schedule by `RetentionService`, independent of
-- `ActivityLog`'s own 90/365-day retention — the audit summary line should
-- outlive the ability to undo it. `ON DELETE CASCADE` is a referential
-- backstop for the case an `ActivityLog` row is ever deleted before its own
-- snapshots have aged out; the independent 30-day pass is what actually
-- removes these rows in the ordinary case.

-- CreateTable
CREATE TABLE `PermissionSnapshots` (
    `id` CHAR(36) NOT NULL,
    `activityLogId` CHAR(36) NOT NULL,
    `path` TEXT NOT NULL,
    `mode` INTEGER NOT NULL,
    `uid` INTEGER NOT NULL,
    `gid` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PermissionSnapshots_activityLogId_idx`(`activityLogId`),
    INDEX `PermissionSnapshots_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- AddForeignKey
ALTER TABLE `PermissionSnapshots` ADD CONSTRAINT `PermissionSnapshots_activityLogId_fkey` FOREIGN KEY (`activityLogId`) REFERENCES `ActivityLog`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
```

(Replace the `CreateTable`/`AddForeignKey` bodies with Step 2's actual output if it differs from the above in any column type, index name, or clause.)

- [ ] **Step 4: Apply it non-destructively**

From `nest-api/`:

```bash
npx prisma db execute --file prisma/migrations/<the new dir>/migration.sql
npx prisma migrate resolve --applied <the new dir name>
npx prisma generate
```

- [ ] **Step 5: Confirm the schema and the database agree**

```bash
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

Expected: prints `-- This is an empty migration.` (or equivalent no-op output). If it prints more SQL, the hand-written file in Step 3 diverged from Step 2's real output — fix the file to match and re-run Steps 4–5.

- [ ] **Step 6: Commit**

```bash
git add nest-api/prisma/schema.prisma nest-api/prisma/migrations
git commit -m "TRE-75: add PermissionSnapshots table"
```

---

### Task 2: `gid` on `WalkedEntry`

**Files:**
- Modify: `nest-api/src/fs/tree-walk.ts`
- Test: `nest-api/src/fs/permissions.spec.ts` (existing `describe("walkTree", ...)` block)

**Interfaces:**
- Produces: `WalkedEntry` gains a required `gid: number` field, populated at both sites that construct one (`walkTree`'s per-entry push, and `describeRoot`). Task 5 depends on this.

- [ ] **Step 1: Write the failing test**

In `nest-api/src/fs/permissions.spec.ts`, inside the existing `describe("walkTree", ...)` block (starts at line 166), add a new test after the last existing one in that block (`"names a directory it could not read rather than counting it as empty"`, which ends around line 230):

```ts
  it("carries gid alongside uid on every entry, including the root's own", async () => {
    const root = join(base, "walk-gid");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "f.txt"), "x");

    const walked = await walkTree(new LocalDriver(HOST_ID), root, 100);

    const expectedGid = process.getgid?.() ?? 0;
    const file = walked.details.find((entry) => entry.path === join(root, "f.txt"));
    const rootEntry = walked.details.find((entry) => entry.path === root);
    expect(file?.gid).toBe(expectedGid);
    expect(rootEntry?.gid).toBe(expectedGid);
  });
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd nest-api && npx jest src/fs/permissions.spec.ts -t "carries gid alongside uid"
```

Expected: FAIL — `file?.gid`/`rootEntry?.gid` is `undefined`, not the expected number (`WalkedEntry` has no `gid` field yet).

- [ ] **Step 3: Add `gid` to the interface and both construction sites**

In `nest-api/src/fs/tree-walk.ts`, change the interface (currently lines 49–57):

```ts
export interface WalkedEntry {
  path: string;
  kind: FileKind;
  size: number;
  uid: number;
  gid: number;
  /** Permission bits, already masked. TRE-26 writes them into zip entries. */
  mode: number;
  mtimeMs: number;
}
```

Then the per-entry push inside `descend` (currently lines 144–151):

```ts
      paths.push(full);
      details.push({
        path: full,
        kind: entry.kind,
        size: entry.size,
        uid: entry.uid,
        gid: entry.gid,
        mode: entry.mode,
        mtimeMs: entry.mtimeMs,
      });
```

Then `describeRoot` (currently lines 173–184):

```ts
async function describeRoot(driver: HostDriver, root: string): Promise<WalkedEntry> {
  try {
    const stat = await driver.stat(root);
    return {
      path: root,
      kind: stat.kind,
      size: stat.size,
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return { path: root, kind: "unknown", size: 0, uid: -1, gid: -1, mode: 0, mtimeMs: 0 };
  }
}
```

- [ ] **Step 4: Run it to confirm it passes**

```bash
npx jest src/fs/permissions.spec.ts
```

Expected: PASS, including the whole `permissions.spec.ts` file (this is an additive field — nothing existing reads `WalkedEntry` positionally, so no other test should be affected; if one is, it is asserting a full-object shape somewhere and needs `gid` added to its expected value too).

- [ ] **Step 5: Commit**

```bash
git add nest-api/src/fs/tree-walk.ts nest-api/src/fs/permissions.spec.ts
git commit -m "TRE-75: carry gid on WalkedEntry, alongside uid"
```

---

### Task 3: `PermissionSnapshotService`

**Files:**
- Create: `nest-api/src/fs/permission-snapshot.service.ts`
- Test: `nest-api/src/fs/permission-snapshot.spec.ts`

**Interfaces:**
- Consumes: `prisma.permissionSnapshots.createMany`/`.findMany` (Task 1).
- Produces: `PermissionSnapshotService` with `record(entries: readonly SnapshotEntry[]): Promise<void>` and `listFor(activityLogId: string): Promise<RestoreEntry[]>`; exported types `SnapshotEntry { activityLogId: string; path: string; mode: number; uid: number; gid: number }` and `RestoreEntry { path: string; mode: number; uid: number; gid: number }`. Task 5 uses `record` and `SnapshotEntry`; Task 7 uses `listFor` and `RestoreEntry`.

- [ ] **Step 1: Write the failing test**

Create `nest-api/src/fs/permission-snapshot.spec.ts`:

```ts
import { PermissionSnapshotService } from "@fs/permission-snapshot.service";

import type { PrismaService } from "../prisma/prisma.service";

function fakePrisma(): { prisma: PrismaService; rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    permissionSnapshots: {
      createMany: ({ data }: { data: Array<Record<string, unknown>> }) => {
        rows.push(...data);
        return Promise.resolve({ count: data.length });
      },
      findMany: ({ where }: { where: { activityLogId: string } }) =>
        Promise.resolve(
          rows
            .filter((row) => row.activityLogId === where.activityLogId)
            .map((row) => ({ path: row.path, mode: row.mode, uid: row.uid, gid: row.gid })),
        ),
    },
  } as unknown as PrismaService;
  return { prisma, rows };
}

describe("PermissionSnapshotService", () => {
  it("records nothing for an empty batch", async () => {
    const { prisma, rows } = fakePrisma();
    const service = new PermissionSnapshotService(prisma);

    await service.record([]);

    expect(rows).toEqual([]);
  });

  it("round-trips what it records, scoped to one activity row", async () => {
    const { prisma } = fakePrisma();
    const service = new PermissionSnapshotService(prisma);

    await service.record([
      { activityLogId: "a1", path: "/tmp/one", mode: 0o644, uid: 1000, gid: 1000 },
      { activityLogId: "a1", path: "/tmp/two", mode: 0o600, uid: 1000, gid: 1000 },
      { activityLogId: "a2", path: "/tmp/other", mode: 0o755, uid: 0, gid: 0 },
    ]);

    const restored = await service.listFor("a1");

    expect(restored).toEqual([
      { path: "/tmp/one", mode: 0o644, uid: 1000, gid: 1000 },
      { path: "/tmp/two", mode: 0o600, uid: 1000, gid: 1000 },
    ]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd nest-api && npx jest src/fs/permission-snapshot.spec.ts
```

Expected: FAIL — `Cannot find module '@fs/permission-snapshot.service'`.

- [ ] **Step 3: Write the service**

Create `nest-api/src/fs/permission-snapshot.service.ts`:

```ts
import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

/**
 * Old mode/uid/gid, one row per entry a chmod or chown actually changed
 * (TRE-75). Written from data the walk or a single `stat` already had in
 * hand; read back only when somebody undoes the operation that wrote them.
 */
export interface SnapshotEntry {
  activityLogId: string;
  path: string;
  mode: number;
  uid: number;
  gid: number;
}

export interface RestoreEntry {
  path: string;
  mode: number;
  uid: number;
  gid: number;
}

@Injectable()
export class PermissionSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entries: readonly SnapshotEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.prisma.permissionSnapshots.createMany({ data: entries as SnapshotEntry[] });
  }

  async listFor(activityLogId: string): Promise<RestoreEntry[]> {
    return this.prisma.permissionSnapshots.findMany({
      where: { activityLogId },
      select: { path: true, mode: true, uid: true, gid: true },
    });
  }
}
```

- [ ] **Step 4: Run it to confirm it passes**

```bash
npx jest src/fs/permission-snapshot.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Register it with Nest**

Confirmed: the module is `nest-api/src/fs/fs.module.ts`, and it lists every service in both its `providers` and `exports` arrays (e.g. `PermissionsService` appears in both). Add the import:

```ts
import { PermissionSnapshotService } from "@fs/permission-snapshot.service";
```

And add `PermissionSnapshotService` to both arrays, next to `PermissionsService`:

```ts
  providers: [
    FsService,
    IdResolverService,
    PermissionsService,
    PermissionSnapshotService,
    RenameService,
    CreateService,
    DeleteService,
    DownloadService,
    UploadService,
    LinkService,
    TailService,
    TailRegistryService,
  ],
  exports: [
    FsService,
    IdResolverService,
    PermissionsService,
    PermissionSnapshotService,
    RenameService,
    CreateService,
    DeleteService,
    DownloadService,
    UploadService,
    LinkService,
    TailService,
    TailRegistryService,
  ],
```

This has to land now rather than later: Task 5 makes `PermissionSnapshotService` a required constructor dependency of `PermissionsService`, and Task 6's manual check starts the real API — without this step, the app fails to boot ("Nest can't resolve dependencies of PermissionsService") from Task 5 onward.

- [ ] **Step 6: Confirm the app still boots**

Start the API however it is normally run locally (e.g. `pnpm start:dev` from `nest-api/`) and confirm it comes up with no `Nest can't resolve dependencies` error.

- [ ] **Step 7: Commit**

```bash
git add nest-api/src/fs/permission-snapshot.service.ts nest-api/src/fs/permission-snapshot.spec.ts nest-api/src/fs/fs.module.ts
git commit -m "TRE-75: add PermissionSnapshotService"
```

---

### Task 4: `AuditService.rowIdOf`

**Files:**
- Modify: `nest-api/src/audit/audit.service.ts`
- Test: `nest-api/src/audit/audit.spec.ts`

**Interfaces:**
- Produces: `AuditService.rowIdOf(request: Request): string | null` — the id `bindRow` gave this request, or `null` before any row is bound. Task 6 uses this.

- [ ] **Step 1: Write the failing test**

Append to `nest-api/src/audit/audit.spec.ts` (add these two imports at the top if not already present: `import { AuditService } from "./audit.service";` and `import type { PrismaService } from "../prisma/prisma.service";` and `import type { Request } from "express";` — skip any of the three that is already imported):

```ts
describe("AuditService.rowIdOf", () => {
  it("returns the id bindRow gave it", () => {
    const service = new AuditService({} as PrismaService);
    const request = {} as Request;

    service.bindRow(request, "row-123");

    expect(service.rowIdOf(request)).toBe("row-123");
  });

  it("returns null before any row is bound", () => {
    const service = new AuditService({} as PrismaService);
    const request = {} as Request;

    expect(service.rowIdOf(request)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd nest-api && npx jest src/audit/audit.spec.ts -t "rowIdOf"
```

Expected: FAIL — `service.rowIdOf is not a function`.

- [ ] **Step 3: Add the method**

In `nest-api/src/audit/audit.service.ts`, immediately after the existing `annotationOf` method (currently lines 185–188):

```ts
  /** @internal */
  annotationOf(request: Request): AuditAnnotation {
    return stateOf(request).annotation;
  }

  /** @internal — the id `bindRow` gave this request, or null before one is bound. */
  rowIdOf(request: Request): string | null {
    return stateOf(request).rowId;
  }
}
```

(That closing `}` is the existing end of the class — only the new method is inserted above it.)

- [ ] **Step 4: Run it to confirm it passes**

```bash
npx jest src/audit/audit.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add nest-api/src/audit/audit.service.ts nest-api/src/audit/audit.spec.ts
git commit -m "TRE-75: add AuditService.rowIdOf"
```

---

### Task 5: Capture snapshots in `PermissionsService`

**Files:**
- Modify: `nest-api/src/fs/permissions.service.ts`
- Modify: `nest-api/src/fs/permissions.spec.ts`

**Interfaces:**
- Consumes: `PermissionSnapshotService.record` (Task 3), `WalkedEntry.gid` (Task 2).
- Produces: `PermissionsService.chmod`/`.chown` gain an optional trailing `activityLogId?: string` parameter. `failure()` becomes exported (Task 7 reuses it). Task 6 calls `chmod`/`chown` with the new parameter.

- [ ] **Step 1: Write the failing tests**

In `nest-api/src/fs/permissions.spec.ts`, add this helper after the existing `elevatedServiceFor` function (which ends around line 143, just before `const SESSION_ID = ...`):

```ts
function serviceForWithSnapshots(
  roots: { path: string; access: "READ" | "WRITE" }[],
): { service: PermissionsService; recorded: SnapshotEntry[] } {
  const recorded: SnapshotEntry[] = [];
  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? { id: HOST_ID, userId: USER_ID, transport: "LOCAL", roots, user: { role: "MEMBER" } }
            : null,
        ),
    },
    permissionSnapshots: {
      createMany: ({ data }: { data: SnapshotEntry[] }) => {
        recorded.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
  } as unknown as PrismaService;

  const guard = new PathGuardService(prisma, [join(base, "install")], memoryLimits(), silentAudit);
  const factory = { forHost: () => Promise.resolve(new LocalDriver(HOST_ID)) } as unknown as HostDriverFactory;
  const service = new PermissionsService(
    factory,
    guard,
    ids,
    new SudoRunnerService(new SudoService()),
    new PermissionSnapshotService(prisma),
  );
  return { service, recorded };
}
```

Add the import it needs, alongside the other `@fs/...` imports near the top of the file:

```ts
import { PermissionSnapshotService, type SnapshotEntry } from "@fs/permission-snapshot.service";
```

Then add a new `describe` block, after the existing top-level test blocks (anywhere at the top level of the file is fine — e.g. right before the final closing of the file, or after the `describe("walkTree", ...)` block):

```ts
describe("chmod — undo snapshots (TRE-75)", () => {
  it("records the previous mode for every entry actually changed, when given an activityLogId", async () => {
    const root = join(base, "snap-recursive");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "x");
    await writeFile(join(root, "b.txt"), "y");
    await chmod(join(root, "a.txt"), 0o644);
    await chmod(join(root, "b.txt"), 0o600);

    const { service, recorded } = serviceForWithSnapshots(writeRoot());

    await service.chmod(USER_ID, HOST_ID, [root], 0o755, true, undefined, "activity-1");

    const a = recorded.find((row) => row.path === join(root, "a.txt"));
    const b = recorded.find((row) => row.path === join(root, "b.txt"));
    expect(a?.mode).toBe(0o644);
    expect(b?.mode).toBe(0o600);
    expect(recorded.every((row) => row.activityLogId === "activity-1")).toBe(true);
  });

  it("records nothing when no activityLogId is given", async () => {
    const root = join(base, "snap-none");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "x");

    const { service, recorded } = serviceForWithSnapshots(writeRoot());

    await service.chmod(USER_ID, HOST_ID, [root], 0o755, true);

    expect(recorded).toEqual([]);
  });

  it("pays one stat for a non-recursive change, and records only that path", async () => {
    const file = join(base, "snap-single.txt");
    await writeFile(file, "x");
    await chmod(file, 0o644);

    const { service, recorded } = serviceForWithSnapshots(writeRoot());

    await service.chmod(USER_ID, HOST_ID, [file], 0o600, false, undefined, "activity-2");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ activityLogId: "activity-2", path: file, mode: 0o644 });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd nest-api && npx jest src/fs/permissions.spec.ts -t "undo snapshots"
```

Expected: FAIL to even compile/run — `serviceForWithSnapshots` references a 5-argument `PermissionsService` constructor and a 7th `chmod` argument that do not exist yet, and `serviceFor`/`elevatedServiceFor` (used by every other test in the file) now also fail to compile once `PermissionSnapshotService` becomes a required constructor parameter in Step 3 below. That is expected at this point — Step 3 fixes all of it together.

- [ ] **Step 3: Wire capture into `apply()`/`applyTo()`, and fix the existing fixtures**

In `nest-api/src/fs/permissions.service.ts`:

Add the import, alongside the other `@fs/...` imports:

```ts
import { PermissionSnapshotService, type SnapshotEntry } from "@fs/permission-snapshot.service";
```

Add the 5th constructor dependency (currently lines 118–123):

```ts
  constructor(
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly ids: IdResolverService,
    private readonly sudoRunner: SudoRunnerService,
    private readonly snapshots: PermissionSnapshotService,
  ) {}
```

Add a trailing `activityLogId?: string` parameter to `chmod` (currently lines 156–173), passed through to `apply`:

```ts
  async chmod(
    userId: string,
    hostId: string,
    paths: readonly string[],
    mode: number,
    recursive: boolean,
    sessionId?: string,
    activityLogId?: string,
  ): Promise<ChangeResult> {
    return this.apply(
      userId,
      hostId,
      paths,
      recursive,
      (driver, target) => driver.chmod(target, mode),
      { program: "chmod", argv: (target) => chmodArgv(mode, target) },
      sessionId,
      undefined,
      activityLogId,
    );
  }
```

Same for `chown` (currently lines 180–209):

```ts
  async chown(
    userId: string,
    hostId: string,
    paths: readonly string[],
    owner: string | undefined,
    group: string | undefined,
    recursive: boolean,
    sessionId?: string,
    activityLogId?: string,
  ): Promise<ChangeResult> {
    if (owner === undefined && group === undefined) {
      throw new BadRequestException("Give an owner, a group, or both.");
    }

    const driver = await this.driverFor(hostId, userId);
    const { uid, gid } = await this.resolveIds(driver, owner, group);

    return this.apply(
      userId,
      hostId,
      paths,
      recursive,
      (host, path) => host.chown(path, uid, gid),
      { program: "chown", argv: (target) => chownArgv(uid, gid, target) },
      sessionId,
      driver,
      activityLogId,
    );
  }
```

Replace the whole `apply` method (currently lines 219–307) with:

```ts
  private async apply(
    userId: string,
    hostId: string,
    paths: readonly string[],
    recursive: boolean,
    change: (driver: HostDriver, path: string) => Promise<void>,
    elevated: ElevatedForm,
    sessionId?: string,
    existing?: HostDriver,
    activityLogId?: string,
  ): Promise<ChangeResult> {
    if (paths.length === 0) throw new BadRequestException("No paths given.");
    if (paths.length > MAX_PATHS) {
      throw new BadRequestException(`At most ${MAX_PATHS} paths per request; this one names ${paths.length}.`);
    }

    const driver = existing ?? (await this.driverFor(hostId, userId));
    const denied = await this.guard.localDenial(driver, userId);
    const results: PathOutcome[] = [];
    const unreadable: string[] = [];
    const refused: string[] = [];
    let skippedLinks = 0;
    let changed = 0;
    let elevatedEntries = 0;
    const snapshots: SnapshotEntry[] = [];

    for (const path of paths) {
      let realPath: string;
      try {
        const validated = await this.guard.validate({ driver, userId, path, intent: "write" });
        realPath = validated.realPath;
      } catch (error) {
        results.push(failure(path, error));
        continue;
      }

      let targets = [realPath];
      // Before-values for this one top-level path, keyed by target — built
      // only when there is an activityLogId to attach them to (TRE-75).
      const before = new Map<string, { mode: number; uid: number; gid: number }>();

      if (recursive) {
        const ceiling = entryCeiling();
        const walked = await walkTree(driver, realPath, ceiling);
        if (walked.exceeded) {
          throw new HttpException(
            {
              statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
              code: "ETOOMANY",
              message: `${path} holds more than ${ceiling.toLocaleString("en-GB")} entries. Narrow the selection, or raise the ceiling on the server.`,
              ceiling,
            },
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        targets = walked.paths;
        skippedLinks += walked.skippedLinks;
        unreadable.push(...walked.unreadable);
        if (activityLogId) {
          for (const entry of walked.details) {
            before.set(entry.path, { mode: entry.mode, uid: entry.uid, gid: entry.gid });
          }
        }
      } else if (activityLogId) {
        // One stat to capture what this single path was before the change —
        // affordable precisely because there is only one (TRE-75).
        const stat = await driver.stat(realPath);
        before.set(realPath, { mode: stat.mode, uid: stat.uid, gid: stat.gid });
      }

      const permitted = targets.filter((target) => {
        if (!denied(target)) return true;
        refused.push(target);
        return false;
      });

      const onChanged = activityLogId
        ? (target: string) => {
            const value = before.get(target);
            if (value) snapshots.push({ activityLogId, path: target, ...value });
          }
        : undefined;

      const outcome = await this.applyTo(driver, path, permitted, change, elevated, sessionId, hostId, onChanged);
      results.push(outcome);
      changed += outcome.entries;
      if (outcome.elevated) elevatedEntries += outcome.elevated;
    }

    const failed = results.filter((result) => !result.ok).length;

    // Recorded before the all-failed check below: an entry can have
    // genuinely changed even on a request that is overall classified as
    // failed (one path's targets partially succeeded before that path hit
    // its own failure), and that change is exactly as undoable as any other.
    if (activityLogId) await this.snapshots.record(snapshots);

    if (failed === results.length) throw allFailed(results);

    return { results, changed, failed, skippedLinks, unreadable, refused, elevated: elevatedEntries };
  }
```

Replace the whole `applyTo` method (currently lines 310–361) with:

```ts
  /** One path and everything the walk found under it. */
  private async applyTo(
    driver: HostDriver,
    reported: string,
    targets: readonly string[],
    change: (driver: HostDriver, path: string) => Promise<void>,
    elevated: ElevatedForm,
    sessionId: string | undefined,
    hostId: string,
    onChanged?: (target: string) => void,
  ): Promise<PathOutcome> {
    let entries = 0;
    let viaSudo = 0;
    for (const target of targets) {
      try {
        await change(driver, target);
        entries += 1;
        onChanged?.(target);
      } catch (error) {
        if (isPermissionRefusal(error) && this.sudoRunner.isOpen(sessionId, hostId)) {
          try {
            await this.sudoRunner.run(driver, sessionId, hostId, elevated.program, elevated.argv(target));
            entries += 1;
            viaSudo += 1;
            onChanged?.(target);
            continue;
          } catch (elevatedError) {
            const outcome = failure(reported, elevatedError);
            outcome.entries = entries;
            outcome.elevated = viaSudo;
            return outcome;
          }
        }

        const outcome = failure(reported, error);
        outcome.entries = entries;
        outcome.elevated = viaSudo;
        return outcome;
      }
    }
    return { path: reported, ok: true, entries, elevated: viaSudo };
  }
```

Finally, export `failure` so Task 7 can reuse its error-shaping (currently, near the bottom of the file):

```ts
export function failure(path: string, error: unknown): PathOutcome {
```

(Only the `export` keyword is added — the body is unchanged.)

Now fix the two existing test fixtures in `nest-api/src/fs/permissions.spec.ts` so the file compiles again. Add the import (if Step 1 above did not already add it to this same file — it did, so this is already done) and pass a 5th constructor argument in both `serviceFor` (currently ends at line 96) and `elevatedServiceFor` (currently ends at line 143):

In `serviceFor`, change:

```ts
  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? { id: HOST_ID, userId: USER_ID, transport: "LOCAL", roots, user: { role } }
            : null,
        ),
    },
    permissionSnapshots: {
      createMany: ({ data }: { data: unknown[] }) => Promise.resolve({ count: data.length }),
    },
  } as unknown as PrismaService;

  const guard = new PathGuardService(prisma, denylist, memoryLimits(), silentAudit);
  const factory = { forHost: () => Promise.resolve(new LocalDriver(HOST_ID)) } as unknown as HostDriverFactory;
  return new PermissionsService(
    factory,
    guard,
    ids,
    new SudoRunnerService(new SudoService()),
    new PermissionSnapshotService(prisma),
  );
}
```

In `elevatedServiceFor`, change:

```ts
  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? { id: HOST_ID, userId: USER_ID, transport: "LOCAL", roots, user: { role: "MEMBER" } }
            : null,
        ),
    },
    permissionSnapshots: {
      createMany: ({ data }: { data: unknown[] }) => Promise.resolve({ count: data.length }),
    },
  } as unknown as PrismaService;

  const guard = new PathGuardService(prisma, denylist, memoryLimits(), silentAudit);
  const factory = { forHost: () => Promise.resolve(driver) } as unknown as HostDriverFactory;

  const sudo = new SudoService();
  sudo.open(SESSION_ID, HOST_ID, "hunter2");

  return {
    service: new PermissionsService(
      factory,
      guard,
      ids,
      new SudoRunnerService(sudo),
      new PermissionSnapshotService(prisma),
    ),
    elevatedCalls,
  };
}
```

- [ ] **Step 4: Run the whole file to confirm everything passes**

```bash
npx jest src/fs/permissions.spec.ts
```

Expected: PASS — every pre-existing test in the file (none of which pass an `activityLogId`, so none of them are affected by the new capture logic) plus the three new ones from Step 1.

- [ ] **Step 5: Commit**

```bash
git add nest-api/src/fs/permissions.service.ts nest-api/src/fs/permissions.spec.ts
git commit -m "TRE-75: capture undo snapshots in PermissionsService.apply"
```

---

### Task 6: Thread `activityLogId` through the chmod/chown routes

**Files:**
- Modify: `nest-api/src/fs/fs.controller.ts`

**Interfaces:**
- Consumes: `AuditService.rowIdOf` (Task 4), `PermissionsService.chmod`/`.chown`'s new parameter (Task 5).
- Produces: the `POST /fs/chmod` and `POST /fs/chown` responses gain an `activityLogId: string | null` field. Task 11 (frontend) depends on this exact field name.

There is no backend unit test for this step in isolation — `fs.controller.ts` is not covered by a dedicated `.spec.ts` in this codebase (its constituent services are). Verification is `pnpm build`/`pnpm typecheck` plus the manual check in Step 3.

- [ ] **Step 1: Read the row id and pass it into the service calls**

In `nest-api/src/fs/fs.controller.ts`, change the `chmod` handler (currently lines 381–408):

```ts
  async chmod(@Req() req: Request, @Body() dto: ChangeModeDto): Promise<ChangeResult & { activityLogId: string | null }> {
    const mode = parseMode(dto.mode);
    const activityLogId = this.audit.rowIdOf(req);
    const result = await this.permissions.chmod(
      userIdOf(req),
      dto.hostId,
      dto.paths,
      mode,
      dto.recursive === true,
      req.sessionID,
      activityLogId ?? undefined,
    );

    this.audit.annotate(req, {
      hostId: dto.hostId,
      summary:
        `chmod ${describeMode(mode)} on ${count(result.changed, "entry", "entries")}` +
        (result.elevated > 0 ? `, ${count(result.elevated, "as root", "as root")}` : ""),
      payload: {
        changed: result.changed,
        failed: result.failed,
        skippedLinks: result.skippedLinks,
        elevated: result.elevated,
      },
    });
    return { ...result, activityLogId };
  }
```

And the `chown` handler (currently lines 427–451):

```ts
  async chown(@Req() req: Request, @Body() dto: ChangeOwnerDto): Promise<ChangeResult & { activityLogId: string | null }> {
    const activityLogId = this.audit.rowIdOf(req);
    const result = await this.permissions.chown(
      userIdOf(req),
      dto.hostId,
      dto.paths,
      dto.owner,
      dto.group,
      dto.recursive === true,
      req.sessionID,
      activityLogId ?? undefined,
    );

    this.audit.annotate(req, {
      hostId: dto.hostId,
      summary:
        `chown on ${count(result.changed, "entry", "entries")}` +
        (result.elevated > 0 ? `, ${count(result.elevated, "as root", "as root")}` : ""),
      payload: {
        changed: result.changed,
        failed: result.failed,
        skippedLinks: result.skippedLinks,
        elevated: result.elevated,
      },
    });
    return { ...result, activityLogId };
  }
```

(Only the return type and the two new lines — reading `activityLogId` and passing/returning it — change in each handler; everything else is unchanged.)

- [ ] **Step 2: Typecheck and build**

```bash
cd nest-api && pnpm typecheck && pnpm build
```

Expected: both succeed.

- [ ] **Step 3: Manual check**

Start the API (`pnpm start:dev` or however it is normally run locally), sign in from the front end, chmod a file, and inspect the network response body for `POST /fs/chmod` — confirm it now includes `"activityLogId": "<some uuid>"` alongside the existing fields.

- [ ] **Step 4: Commit**

```bash
git add nest-api/src/fs/fs.controller.ts
git commit -m "TRE-75: return activityLogId from chmod/chown"
```

---

### Task 7: `PermissionsUndoService`

**Files:**
- Create: `nest-api/src/fs/dto/undo-permissions.dto.ts`
- Create: `nest-api/src/fs/permissions-undo.service.ts`
- Test: `nest-api/src/fs/permissions-undo.spec.ts`

**Interfaces:**
- Consumes: `PermissionSnapshotService.listFor` (Task 3), exported `failure` (Task 5).
- Produces: `PermissionsUndoService.undoChmod(userId, activityLogId, sessionId?)` and `.undoChown(...)`, both returning `UndoResult { results: UndoOutcome[]; restored: number; failed: number; elevated: number; hostId: string }`, where `UndoOutcome { path: string; ok: boolean; code?: string; message?: string }`. Task 8 calls these.

- [ ] **Step 1: Write the DTO**

Create `nest-api/src/fs/dto/undo-permissions.dto.ts`:

```ts
import { IsString } from "class-validator";

export class UndoPermissionsDto {
  @IsString()
  activityLogId!: string;
}
```

- [ ] **Step 2: Write the failing tests**

Create `nest-api/src/fs/permissions-undo.spec.ts`:

```ts
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { RateLimitService } from "@audit/rate-limit.service";
import { LocalDriver } from "@hosts/drivers/local.driver";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { SudoRunnerService } from "@hosts/sudo/sudo-runner.service";
import { SudoService } from "@hosts/sudo/sudo.service";
import { PermissionSnapshotService } from "@fs/permission-snapshot.service";
import { PermissionsUndoService } from "@fs/permissions-undo.service";

import type { AuditService } from "@audit/audit.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "@redis/redis.service";

const HOST_ID = "host-under-test";
const USER_ID = "user-1";

let base: string;

function memoryLimits(): RateLimitService {
  const counts = new Map<string, number>();
  return new RateLimitService({
    getClient: () => ({
      incrBy: (key: string, amount: number) => {
        const next = (counts.get(key) ?? 0) + amount;
        counts.set(key, next);
        return Promise.resolve(next);
      },
      expire: () => Promise.resolve(true),
      ttl: () => Promise.resolve(30),
    }),
  } as unknown as RedisService);
}

const silentAudit = { refused: () => Promise.resolve() } as unknown as AuditService;
const writeRoot = () => [{ path: base, access: "WRITE" as const }];

interface FakeRow {
  id: string;
  userId: string;
  kind: string;
  hostId: string | null;
}

interface FakeSnapshotRow {
  activityLogId: string;
  path: string;
  mode: number;
  uid: number;
  gid: number;
}

function serviceFor(
  roots: { path: string; access: "READ" | "WRITE" }[],
  rows: FakeRow[],
): { service: PermissionsUndoService; snapshotRows: FakeSnapshotRow[] } {
  const snapshotRows: FakeSnapshotRow[] = [];

  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? { id: HOST_ID, userId: USER_ID, transport: "LOCAL", roots, user: { role: "MEMBER" } }
            : null,
        ),
    },
    activityLog: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
    },
    permissionSnapshots: {
      findMany: ({ where }: { where: { activityLogId: string } }) =>
        Promise.resolve(
          snapshotRows
            .filter((row) => row.activityLogId === where.activityLogId)
            .map((row) => ({ path: row.path, mode: row.mode, uid: row.uid, gid: row.gid })),
        ),
    },
  } as unknown as PrismaService;

  const guard = new PathGuardService(prisma, [join(base, "install")], memoryLimits(), silentAudit);
  const factory = { forHost: () => Promise.resolve(new LocalDriver(HOST_ID)) } as unknown as HostDriverFactory;
  const snapshots = new PermissionSnapshotService(prisma);
  const service = new PermissionsUndoService(prisma, factory, guard, new SudoRunnerService(new SudoService()), snapshots);

  return { service, snapshotRows };
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o7777;
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "trekker-permissions-undo-")));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("PermissionsUndoService.undoChmod", () => {
  it("restores each entry's own previous mode, not one shared value", async () => {
    const a = join(base, "undo-a.txt");
    const b = join(base, "undo-b.txt");
    await writeFile(a, "x");
    await writeFile(b, "y");
    await chmod(a, 0o755);
    await chmod(b, 0o755);

    const { service, snapshotRows } = serviceFor(writeRoot(), [
      { id: "activity-1", userId: USER_ID, kind: "file.chmod", hostId: HOST_ID },
    ]);
    snapshotRows.push(
      { activityLogId: "activity-1", path: a, mode: 0o644, uid: -1, gid: -1 },
      { activityLogId: "activity-1", path: b, mode: 0o600, uid: -1, gid: -1 },
    );

    const result = await service.undoChmod(USER_ID, "activity-1");

    expect(result.restored).toBe(2);
    expect(await modeOf(a)).toBe(0o644);
    expect(await modeOf(b)).toBe(0o600);
  });

  it("skips a path that has since been removed, and reports it rather than stopping", async () => {
    const gone = join(base, "undo-gone.txt");
    const still = join(base, "undo-still.txt");
    await writeFile(still, "x");
    await chmod(still, 0o755);

    const { service, snapshotRows } = serviceFor(writeRoot(), [
      { id: "activity-2", userId: USER_ID, kind: "file.chmod", hostId: HOST_ID },
    ]);
    snapshotRows.push(
      { activityLogId: "activity-2", path: gone, mode: 0o644, uid: -1, gid: -1 },
      { activityLogId: "activity-2", path: still, mode: 0o600, uid: -1, gid: -1 },
    );

    const result = await service.undoChmod(USER_ID, "activity-2");

    expect(result.restored).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results.find((row) => row.path === gone)?.ok).toBe(false);
    expect(await modeOf(still)).toBe(0o600);
  });

  it("refuses an id that belongs to a different user, the same way as one that does not exist", async () => {
    const { service } = serviceFor(writeRoot(), [
      { id: "activity-3", userId: "someone-else", kind: "file.chmod", hostId: HOST_ID },
    ]);

    await expect(service.undoChmod(USER_ID, "activity-3")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.undoChmod(USER_ID, "does-not-exist")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses to undo a chown as though it were a chmod", async () => {
    const { service } = serviceFor(writeRoot(), [
      { id: "activity-4", userId: USER_ID, kind: "file.chown", hostId: HOST_ID },
    ]);

    await expect(service.undoChmod(USER_ID, "activity-4")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("PermissionsUndoService.undoChown", () => {
  it("restores uid and gid, and leaves mode alone", async () => {
    const file = join(base, "undo-chown.txt");
    await writeFile(file, "x");
    await chmod(file, 0o640);
    const before = await modeOf(file);

    const { service, snapshotRows } = serviceFor(writeRoot(), [
      { id: "activity-5", userId: USER_ID, kind: "file.chown", hostId: HOST_ID },
    ]);
    const currentUid = process.getuid?.() ?? 0;
    const currentGid = process.getgid?.() ?? 0;
    snapshotRows.push({ activityLogId: "activity-5", path: file, mode: 0o600, uid: currentUid, gid: currentGid });

    const result = await service.undoChown(USER_ID, "activity-5");

    expect(result.restored).toBe(1);
    expect(await modeOf(file)).toBe(before);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
cd nest-api && npx jest src/fs/permissions-undo.spec.ts
```

Expected: FAIL — `Cannot find module '@fs/permissions-undo.service'`.

- [ ] **Step 4: Write the service**

Create `nest-api/src/fs/permissions-undo.service.ts`:

```ts
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { isDriverError } from "@hosts/drivers/driver-error";
import type { HostDriver } from "@hosts/drivers/host-driver";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { chmodArgv, chownArgv } from "@hosts/sudo/sudo-argv";
import { isPermissionRefusal, SudoRunnerService } from "@hosts/sudo/sudo-runner.service";
import { toHttp } from "@fs/driver-http";
import { failure } from "@fs/permissions.service";
import { PermissionSnapshotService, type RestoreEntry } from "@fs/permission-snapshot.service";

import { PrismaService } from "../prisma/prisma.service";

/**
 * Undoing a chmod or chown (TRE-75) — restoring exactly what a previous
 * operation changed, from the snapshot it left behind.
 *
 * Deliberately not a call into `PermissionsService.apply()`: an undo never
 * re-walks (the paths are exactly the snapshot's, not rediscovered), each
 * entry can restore a *different* value (a mass chmod's undo puts back
 * whatever each file individually had, not one shared mode), and a path
 * that has vanished or changed is skipped and the rest continue — where the
 * original operation deliberately stops at the first failure on a path.
 */

export interface UndoOutcome {
  path: string;
  ok: boolean;
  code?: string;
  message?: string;
}

export interface UndoResult {
  results: UndoOutcome[];
  restored: number;
  failed: number;
  elevated: number;
  hostId: string;
}

type Elevated = { program: "chmod" | "chown"; argv: (target: string) => string[] };

@Injectable()
export class PermissionsUndoService {
  private readonly logger = new Logger(PermissionsUndoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly sudoRunner: SudoRunnerService,
    private readonly snapshots: PermissionSnapshotService,
  ) {}

  async undoChmod(userId: string, activityLogId: string, sessionId?: string): Promise<UndoResult> {
    const { hostId } = await this.rowFor(userId, activityLogId, "file.chmod");
    const entries = await this.snapshots.listFor(activityLogId);
    const driver = await this.driverFor(hostId, userId);

    const result = await this.restore(
      driver,
      userId,
      entries,
      (target, entry) => driver.chmod(target, entry.mode),
      (entry) => ({ program: "chmod", argv: (target: string) => chmodArgv(entry.mode, target) }),
      sessionId,
      hostId,
    );
    return { ...result, hostId };
  }

  async undoChown(userId: string, activityLogId: string, sessionId?: string): Promise<UndoResult> {
    const { hostId } = await this.rowFor(userId, activityLogId, "file.chown");
    const entries = await this.snapshots.listFor(activityLogId);
    const driver = await this.driverFor(hostId, userId);

    const result = await this.restore(
      driver,
      userId,
      entries,
      (target, entry) => driver.chown(target, entry.uid, entry.gid),
      (entry) => ({ program: "chown", argv: (target: string) => chownArgv(entry.uid, entry.gid, target) }),
      sessionId,
      hostId,
    );
    return { ...result, hostId };
  }

  /**
   * One field set restored per entry — never both, even though every
   * snapshot row carries mode, uid and gid (free, from the same walk): the
   * caller passes exactly the `change`/`elevatedFor` pair for the operation
   * being undone, and nothing else is touched.
   */
  private async restore(
    driver: HostDriver,
    userId: string,
    entries: readonly RestoreEntry[],
    change: (target: string, entry: RestoreEntry) => Promise<void>,
    elevatedFor: (entry: RestoreEntry) => Elevated,
    sessionId: string | undefined,
    hostId: string,
  ): Promise<Omit<UndoResult, "hostId">> {
    const results: UndoOutcome[] = [];
    let restored = 0;
    let elevatedCount = 0;

    for (const entry of entries) {
      let realPath: string;
      try {
        const validated = await this.guard.validate({ driver, userId, path: entry.path, intent: "write" });
        realPath = validated.realPath;
      } catch (error) {
        results.push(toUndoOutcome(entry.path, error));
        continue;
      }

      try {
        await change(realPath, entry);
        results.push({ path: entry.path, ok: true });
        restored += 1;
      } catch (error) {
        if (isPermissionRefusal(error) && this.sudoRunner.isOpen(sessionId, hostId)) {
          const elevated = elevatedFor(entry);
          try {
            await this.sudoRunner.run(driver, sessionId, hostId, elevated.program, elevated.argv(realPath));
            results.push({ path: entry.path, ok: true });
            restored += 1;
            elevatedCount += 1;
            continue;
          } catch (elevatedError) {
            results.push(toUndoOutcome(entry.path, elevatedError));
            continue;
          }
        }
        results.push(toUndoOutcome(entry.path, error));
      }
    }

    return { results, restored, failed: results.length - restored, elevated: elevatedCount };
  }

  private async rowFor(
    userId: string,
    activityLogId: string,
    kind: "file.chmod" | "file.chown",
  ): Promise<{ hostId: string }> {
    const row = await this.prisma.activityLog.findUnique({
      where: { id: activityLogId },
      select: { userId: true, kind: true, hostId: true },
    });
    if (!row || row.userId !== userId || row.kind !== kind || row.hostId === null) {
      // The same answer either way: an id that does not exist, one that
      // belongs to someone else, and one of the wrong kind are all "there is
      // nothing here for you to undo" — never distinguished, so a guess
      // teaches an attacker nothing about ids that are not theirs.
      throw new NotFoundException("Nothing to undo.");
    }
    return { hostId: row.hostId };
  }

  private async driverFor(hostId: string, userId: string): Promise<HostDriver> {
    try {
      return await this.factory.forHost(hostId, userId);
    } catch (error) {
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }
}

function toUndoOutcome(path: string, error: unknown): UndoOutcome {
  const outcome = failure(path, error);
  return { path: outcome.path, ok: false, code: outcome.code, message: outcome.message };
}
```

- [ ] **Step 5: Run it to confirm it passes**

```bash
npx jest src/fs/permissions-undo.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add nest-api/src/fs/dto/undo-permissions.dto.ts nest-api/src/fs/permissions-undo.service.ts nest-api/src/fs/permissions-undo.spec.ts
git commit -m "TRE-75: add PermissionsUndoService"
```

---

### Task 8: The undo routes

**Files:**
- Modify: `nest-api/src/fs/fs.controller.ts`

**Interfaces:**
- Consumes: `PermissionsUndoService` (Task 7).
- Produces: `POST /fs/chmod/undo`, `POST /fs/chown/undo`, both taking `{ activityLogId: string }` and returning `UndoResult`. Task 11 (frontend) depends on these two paths and this response shape.

No dedicated unit test — this is decorator wiring plus a pass-through to an already-tested service, the same shape as every other route in this controller (verified today only via `audit-coverage.spec.ts`, which Step 2 below runs). Verification is that spec, `pnpm build`, and a manual check.

- [ ] **Step 1: Add the routes**

In `nest-api/src/fs/fs.controller.ts`:

Add the imports:

```ts
import { UndoPermissionsDto } from "@fs/dto/undo-permissions.dto";
import { PermissionsUndoService, type UndoResult } from "@fs/permissions-undo.service";
```

Add the constructor dependency, alongside the existing ones:

```ts
  constructor(
    private readonly fs: FsService,
    private readonly permissions: PermissionsService,
    private readonly permissionsUndo: PermissionsUndoService,
    private readonly rename: RenameService,
    private readonly create: CreateService,
    private readonly remove: DeleteService,
    private readonly download: DownloadService,
    private readonly upload: UploadService,
    private readonly tail: TailService,
    private readonly audit: AuditService,
  ) {}
```

Add the two routes, immediately after the existing `chown` handler and before the `renameOne` handler (i.e., right after the closing `}` that currently ends at line 451):

```ts
  @Post("chmod/undo")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.chmod.undo",
    destructive: true,
    limit: LIMITS.permissionChange,
    describe: (request) => {
      const body = request.body as { activityLogId?: string };
      return { summary: "undo chmod", payload: { undoes: body.activityLogId } };
    },
  })
  async undoChmod(@Req() req: Request, @Body() dto: UndoPermissionsDto): Promise<UndoResult> {
    const result = await this.permissionsUndo.undoChmod(userIdOf(req), dto.activityLogId, req.sessionID);
    this.audit.annotate(req, {
      hostId: result.hostId,
      summary: `undo chmod on ${count(result.restored, "entry", "entries")}`,
      payload: { restored: result.restored, failed: result.failed, elevated: result.elevated, undoes: dto.activityLogId },
    });
    return result;
  }

  @Post("chown/undo")
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Audited({
    kind: "file.chown.undo",
    destructive: true,
    limit: LIMITS.permissionChange,
    describe: (request) => {
      const body = request.body as { activityLogId?: string };
      return { summary: "undo chown", payload: { undoes: body.activityLogId } };
    },
  })
  async undoChown(@Req() req: Request, @Body() dto: UndoPermissionsDto): Promise<UndoResult> {
    const result = await this.permissionsUndo.undoChown(userIdOf(req), dto.activityLogId, req.sessionID);
    this.audit.annotate(req, {
      hostId: result.hostId,
      summary: `undo chown on ${count(result.restored, "entry", "entries")}`,
      payload: { restored: result.restored, failed: result.failed, elevated: result.elevated, undoes: dto.activityLogId },
    });
    return result;
  }
```

- [ ] **Step 2: Run the coverage spec, typecheck and build**

```bash
cd nest-api && npx jest src/audit/audit-coverage.spec.ts && pnpm typecheck && pnpm build
```

Expected: all pass — both new routes carry `@Audited` with a `subject.verb` kind ≤32 chars and a `limit: LIMITS.permissionChange`, so every rule in that spec is satisfied without adding a new entry to `LIMITS`.

- [ ] **Step 3: Wire the module**

In `nest-api/src/fs/fs.module.ts`, add the import:

```ts
import { PermissionsUndoService } from "@fs/permissions-undo.service";
```

And add `PermissionsUndoService` to both `providers` and `exports`, next to `PermissionsService` (`PermissionSnapshotService` is already there from Task 3, Step 5):

```ts
  providers: [
    FsService,
    IdResolverService,
    PermissionsService,
    PermissionSnapshotService,
    PermissionsUndoService,
    RenameService,
    CreateService,
    DeleteService,
    DownloadService,
    UploadService,
    LinkService,
    TailService,
    TailRegistryService,
  ],
  exports: [
    FsService,
    IdResolverService,
    PermissionsService,
    PermissionSnapshotService,
    PermissionsUndoService,
    RenameService,
    CreateService,
    DeleteService,
    DownloadService,
    UploadService,
    LinkService,
    TailService,
    TailRegistryService,
  ],
```

- [ ] **Step 4: Manual check**

With the API running, use `curl` (or the browser network tab) to confirm the route exists and behaves:

```bash
curl -i -X POST http://localhost:<port>/fs/chmod/undo \
  -H "Content-Type: application/json" \
  --cookie "<a valid session cookie>" \
  -d '{"activityLogId":"<an activityLogId from a chmod you just made>"}'
```

Expected: `200 OK` with a body like `{"results":[...],"restored":1,"failed":0,"elevated":0,"hostId":"..."}`, and the file's mode is back to what it was before that chmod.

- [ ] **Step 5: Commit**

```bash
git add nest-api/src/fs/fs.controller.ts nest-api/src/fs/fs.module.ts
git commit -m "TRE-75: add chmod/undo and chown/undo routes"
```

---

### Task 9: Prune snapshots on their own 30-day schedule

**Files:**
- Modify: `nest-api/src/audit/retention.service.ts`
- Create: `nest-api/src/audit/retention.spec.ts`

**Interfaces:**
- Consumes: `prisma.permissionSnapshots` (Task 1).
- Produces: `RetentionService.prune()`'s return type gains a `snapshots: number` field.

- [ ] **Step 1: Write the failing test**

Create `nest-api/src/audit/retention.spec.ts`:

```ts
import { RetentionService } from "@audit/retention.service";

import type { PrismaService } from "../prisma/prisma.service";

interface FakeSnapshotRow {
  id: string;
  createdAt: Date;
}

function fakePrisma(rows: FakeSnapshotRow[]): PrismaService {
  return {
    activityLog: {
      findMany: () => Promise.resolve([]),
      deleteMany: () => Promise.resolve({ count: 0 }),
    },
    permissionSnapshots: {
      findMany: ({ where, take }: { where: { createdAt: { lt: Date } }; take: number }) =>
        Promise.resolve(
          rows
            .filter((row) => row.createdAt < where.createdAt.lt)
            .slice(0, take)
            .map((row) => ({ id: row.id })),
        ),
      deleteMany: ({ where }: { where: { id: { in: string[] } } }) => {
        const before = rows.length;
        const doomed = new Set(where.id.in);
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (doomed.has(rows[index].id)) rows.splice(index, 1);
        }
        return Promise.resolve({ count: before - rows.length });
      },
    },
  } as unknown as PrismaService;
}

describe("RetentionService — permission snapshots (TRE-75)", () => {
  it("removes a snapshot older than 30 days and keeps a recent one", async () => {
    const now = new Date("2026-08-24T00:00:00.000Z");
    const old = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    const rows: FakeSnapshotRow[] = [
      { id: "old-1", createdAt: old },
      { id: "recent-1", createdAt: recent },
    ];

    const service = new RetentionService(fakePrisma(rows));
    const result = await service.prune(now);

    expect(result.snapshots).toBe(1);
    expect(rows.map((row) => row.id)).toEqual(["recent-1"]);
  });

  it("removes nothing when every snapshot is within the window", async () => {
    const now = new Date("2026-08-24T00:00:00.000Z");
    const rows: FakeSnapshotRow[] = [{ id: "recent-1", createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) }];

    const service = new RetentionService(fakePrisma(rows));
    const result = await service.prune(now);

    expect(result.snapshots).toBe(0);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd nest-api && npx jest src/audit/retention.spec.ts
```

Expected: FAIL — `result.snapshots` is `undefined`, not `1`/`0`.

- [ ] **Step 3: Add the pass**

In `nest-api/src/audit/retention.service.ts`, add the new constant near the top, alongside `ORDINARY_DAYS`/`DESTRUCTIVE_DAYS` (currently lines 5–13):

```ts
/**
 * `PermissionSnapshots` rows (TRE-75), pruned on their own window —
 * independent of the two above. The audit row they hang off keeps its
 * normal retention; only the ability to undo it expires, and sooner,
 * because a multi-megabyte snapshot from a large recursive change has no
 * reason to live as long as a one-line summary.
 */
const SNAPSHOT_DAYS = Number.parseInt(process.env.TREKKER_PERMISSION_SNAPSHOT_RETENTION_DAYS ?? "", 10) || 30;
```

Change the `prune` method's signature and body (currently lines 66–74):

```ts
  async prune(now: Date = new Date()): Promise<{ ordinary: number; destructive: number; snapshots: number }> {
    const ordinary = await this.pruneClass(false, new Date(now.getTime() - ORDINARY_DAYS * DAY_MS));
    const destructive = await this.pruneClass(true, new Date(now.getTime() - DESTRUCTIVE_DAYS * DAY_MS));
    const snapshots = await this.pruneSnapshots(new Date(now.getTime() - SNAPSHOT_DAYS * DAY_MS));

    if (ordinary + destructive > 0) {
      this.logger.log(`Audit prune removed ${ordinary} ordinary and ${destructive} destructive rows`);
    }
    if (snapshots > 0) {
      this.logger.log(`Permission snapshot prune removed ${snapshots} rows`);
    }
    return { ordinary, destructive, snapshots };
  }
```

Add a new private method, after the existing `pruneClass` (currently ends at line 106, just before the class's closing `}`):

```ts
  private async pruneSnapshots(before: Date): Promise<number> {
    let removed = 0;

    try {
      for (;;) {
        const doomed = await this.prisma.permissionSnapshots.findMany({
          where: { createdAt: { lt: before } },
          select: { id: true },
          take: BATCH,
        });
        if (doomed.length === 0) break;

        const { count } = await this.prisma.permissionSnapshots.deleteMany({
          where: { id: { in: doomed.map((row) => row.id) } },
        });
        removed += count;

        if (doomed.length < BATCH) break;
      }
    } catch (error) {
      this.logger.error(`Permission snapshot prune failed: ${(error as Error).message}`);
    }

    return removed;
  }
```

- [ ] **Step 4: Run it to confirm it passes**

```bash
npx jest src/audit/retention.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add nest-api/src/audit/retention.service.ts nest-api/src/audit/retention.spec.ts
git commit -m "TRE-75: prune permission snapshots on their own 30-day window"
```

---

### Task 10: `Toast` action slot

**Files:**
- Modify: `front/src/components/ui/toast.tsx`

**Interfaces:**
- Produces: `Toast` gains an optional `action?: { label: string; onClick: () => void }`. Tasks 12 and 13 use it.

`front/` has no automated test runner (see `docs/superpowers/specs/2026-08-13-recursive-delete-design.md`'s own Verification section, which lists only `pnpm typecheck`/`pnpm lint`/`pnpm build` for it). This task's verification is those three commands plus a manual look.

- [ ] **Step 1: Add the field and render it**

In `front/src/components/ui/toast.tsx`, change the `Toast` interface (currently lines 15–21):

```ts
export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /** Optional second line: the path, the count, the reason. */
  detail?: string;
  /** A button rendered under the detail line — "Undo", and nothing else yet. */
  action?: { label: string; onClick: () => void; title?: string };
}
```

Change `ToastRow` (currently lines 94–113):

```ts
function ToastRow({ toast }: { toast: Toast }) {
  const { dismiss } = useToast();

  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [toast.id, dismiss]);

  return (
    <output
      className={`bg-raised animate-toast-in pointer-events-auto flex flex-col gap-0.5 rounded-sm border px-2.5 py-1.5 shadow-lg ${TONE_CLASS[toast.tone]}`}
    >
      <span className="text-xs">{toast.message}</span>
      {toast.detail && <span className="text-ink-dim font-mono text-2xs break-all">{toast.detail}</span>}
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            dismiss(toast.id);
          }}
          title={toast.action.title}
          className="text-ink hover:text-ink-muted mt-0.5 w-fit cursor-pointer font-mono text-2xs underline underline-offset-2"
        >
          {toast.action.label}
        </button>
      )}
    </output>
  );
}
```

- [ ] **Step 2: Typecheck, lint, build**

```bash
cd front && pnpm typecheck && pnpm lint && pnpm build
```

Expected: all succeed. (`toast.action?.onClick()` inside the button's own `onClick` is safe under strict null checks — `toast.action` was just checked truthy by the surrounding `{toast.action && (...)}`, but TypeScript does not narrow a property read inside a later-defined closure, hence the `?.` rather than a non-null assertion.)

- [ ] **Step 3: Manual check**

No caller passes `action` yet (Tasks 12–13 add the first two), so there is nothing new to see in the browser after this task alone — confirm only that the app still builds and every existing toast (e.g. delete a file) still renders exactly as before.

- [ ] **Step 4: Commit**

```bash
git add front/src/components/ui/toast.tsx
git commit -m "TRE-75: add an action slot to Toast"
```

---

### Task 11: Frontend API client for undo

**Files:**
- Modify: `front/src/lib/api/permissions.ts`

**Interfaces:**
- Consumes: the `activityLogId` field on the chmod/chown response (Task 6), the `/fs/chmod/undo` and `/fs/chown/undo` routes (Task 8).
- Produces: `undoChmod(activityLogId, csrfToken)` and `undoChown(activityLogId, csrfToken)`, both `Promise<UndoResult>`; `ChangeResult` gains `activityLogId: string | null`. Tasks 12 and 13 use all of this.

- [ ] **Step 1: Add the field and the two functions**

In `front/src/lib/api/permissions.ts`, change the `ChangeResult` interface (currently lines 21–29):

```ts
export interface ChangeResult {
  results: PathOutcome[];
  changed: number;
  failed: number;
  skippedLinks: number;
  unreadable: string[];
  /** Entries left untouched because they are denylisted on the host (TRE-52). */
  refused: string[];
  /** The audit row this change wrote, for undo (TRE-75). */
  activityLogId: string | null;
}
```

Add these new types and functions after `fetchEntryCount` (currently ends at line 74, the file's last line):

```ts
export interface UndoOutcome {
  path: string;
  ok: boolean;
  code?: string;
  message?: string;
}

export interface UndoResult {
  results: UndoOutcome[];
  restored: number;
  failed: number;
  elevated: number;
  hostId: string;
}

export async function undoChmod(activityLogId: string, csrfToken: string | null): Promise<UndoResult> {
  return (await apiRequest("/fs/chmod/undo", { method: "POST", body: { activityLogId }, csrfToken })) as UndoResult;
}

export async function undoChown(activityLogId: string, csrfToken: string | null): Promise<UndoResult> {
  return (await apiRequest("/fs/chown/undo", { method: "POST", body: { activityLogId }, csrfToken })) as UndoResult;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd front && pnpm typecheck
```

Expected: fails here, at exactly one call site — `permissions-modal.tsx`'s use of `ChangeResult` — because `activityLogId` is now a required field on a type that component constructs indirectly through the API and does not yet supply it in every branch. That is expected; Task 12 fixes it. If typecheck reports errors anywhere else, stop and investigate before continuing — this task should only ever surface the one expected error.

- [ ] **Step 3: Commit**

```bash
git add front/src/lib/api/permissions.ts
git commit -m "TRE-75: add undo API client and activityLogId on ChangeResult"
```

---

### Task 12: Wire undo into the permissions modal's toast

**Files:**
- Modify: `front/src/components/explorer/permissions-modal.tsx`

**Interfaces:**
- Consumes: `Toast.action` (Task 10), `undoChmod`/`undoChown` (Task 11).

- [ ] **Step 1: Add the imports**

In `front/src/components/explorer/permissions-modal.tsx`, change the existing import (currently line 12):

```ts
import { changeMode, changeOwner, fetchEntryCount, undoChmod, undoChown } from "@lib/api/permissions";
```

- [ ] **Step 2: Track which single operation ran, and offer undo for it**

Replace the `apply` mutation (currently lines 165–211) with:

```tsx
  const apply = useMutation({
    mutationFn: async (): Promise<ChangeResult & { undo?: { kind: "chmod" | "chown"; activityLogId: string } }> => {
      setFailure(null);
      setOutcome(null);

      const mode = await changeMode({ hostId, paths, mode: octal, recursive }, csrfToken, origin);

      // Ownership is a separate call and a separate privilege, so it only runs
      // when the field was actually typed in. Sending the unchanged owner back
      // would turn every chmod into a chown that fails with EPERM for anyone
      // who is not root — a refusal for something nobody asked for.
      const wanted = owner.trim();
      if (wanted === "" || wanted === startingOwner) {
        return { ...mode, undo: mode.activityLogId ? { kind: "chmod", activityLogId: mode.activityLogId } : undefined };
      }

      const [nextOwner, nextGroup] = wanted.split(":");
      const ownership = await changeOwner(
        {
          hostId,
          paths,
          owner: nextOwner || undefined,
          group: nextGroup || undefined,
          recursive,
        },
        csrfToken,
      );
      // Both a chmod and a chown just ran, as two separately audited
      // operations — "undo the change" is ambiguous between them, so neither
      // is offered from this toast. Undo from the activity strip still
      // reaches each one individually, by its own row (TRE-75).
      return { ...merge(mode, ownership), undo: undefined };
    },
    onSuccess: (result) => {
      setOutcome(result);
      onApplied();
      // A clean run has nothing left to say, and leaving the panel open over
      // the listing it just changed hides the evidence. A run with refusals in
      // it stays open — the list of what would not change is the whole answer.
      if (result.failed > 0) return;

      const changedOwner = owner.trim();
      const undo = result.undo;
      push({
        tone: "success",
        message: `${octal} · ${result.changed} ${result.changed === 1 ? "entry" : "entries"}`,
        detail: changedOwner && changedOwner !== startingOwner ? `owner ${changedOwner}` : undefined,
        action: undo
          ? {
              label: "Undo",
              title: "Restores only what this change touched — anything altered since is not affected.",
              onClick: () => {
                const call = undo.kind === "chmod" ? undoChmod : undoChown;
                call(undo.activityLogId, csrfToken)
                  .then(() => {
                    onApplied();
                    push({ tone: "info", message: "Reverted." });
                  })
                  .catch(() => {
                    push({ tone: "danger", message: "Could not undo — it may have expired." });
                  });
              },
            }
          : undefined,
      });
      close();
    },
    onError: (error: unknown) => {
      setFailure(error instanceof ApiError ? error.message : "The change could not be applied.");
    },
  });
```

- [ ] **Step 3: Typecheck, lint, build**

```bash
cd front && pnpm typecheck && pnpm lint && pnpm build
```

Expected: all succeed, and the one expected error from Task 11 Step 2 is now gone.

- [ ] **Step 4: Manual check**

Run the app, open a file's permissions modal, change only the mode (leave owner untouched), apply. Confirm the success toast now carries an "Undo" link; click it before the toast auto-dismisses (6 seconds) and confirm the file's mode reverts and a second "Reverted." toast appears. Then repeat changing **both** mode and owner in one submission, and confirm that toast carries no "Undo" link (the documented ambiguous case).

- [ ] **Step 5: Commit**

```bash
git add front/src/components/explorer/permissions-modal.tsx
git commit -m "TRE-75: offer undo from the chmod/chown toast"
```

---

### Task 13: Undo button on the activity strip

**Files:**
- Modify: `front/src/components/sidebar/activity-strip.tsx`

**Interfaces:**
- Consumes: `undoChmod`/`undoChown` (Task 11).

- [ ] **Step 1: Add the imports**

In `front/src/components/sidebar/activity-strip.tsx`, change the top of the file (currently lines 1–8):

```tsx
"use client";

import { useAuth } from "@auth/context/AuthContext";
import { Tooltip, TooltipBlock } from "@components/ui/tooltip";
import { useToast } from "@components/ui/toast";
import { fetchActivity } from "@lib/api/activity";
import { undoChmod, undoChown } from "@lib/api/permissions";
import { QUERY_KEYS } from "@lib/query/keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ActivityOutcome, ActivityView } from "@lib/api/activity";
```

- [ ] **Step 2: Add the button to `Row`, and a small component that wires it**

Replace the `Row` function (currently lines 50–84):

```tsx
function Row({ item }: { item: ActivityView }) {
  const undoable = (item.kind === "file.chmod" || item.kind === "file.chown") && item.outcome === "success";

  return (
    // The row is 176px wide and its summary is a sentence, so the tooltip is not
    // a second copy of this row — it is the only place the row can be read. The
    // failure reason goes under it rather than beside it: "Removed a host" tells
    // you nothing you did not already know if it did not happen.
    <Tooltip
      content={
        <TooltipBlock
          note={item.detail}
          // Where it came from goes in the tooltip rather than as a badge on
          // the row: the row is 176px and its summary already truncates, so a
          // chip would be bought with the only words that say what happened.
          // Only shown when there is something to say — a button is the default
          // and a row marked "from: ui" on every entry marks nothing (TRE-35).
          rows={[
            { label: "when", value: stamp(item.createdAt) },
            ...(item.origin === null ? [] : [{ label: "from", value: item.origin }]),
          ]}
          subject={item.summary}
        />
      }
    >
      <li className="flex items-baseline gap-1.5 px-2.5 py-0.5">
        <Dot outcome={item.outcome} />
        <span className={`truncate font-sans text-xs ${item.outcome === "success" ? "text-ink-muted" : "text-ink"}`}>
          {item.summary}
        </span>
        {undoable && <UndoButton item={item} />}
        <span className="text-ink-faint ml-auto flex-none font-mono text-caps tabular-nums">
          {since(item.createdAt)}
        </span>
      </li>
    </Tooltip>
  );
}

/**
 * The durable fallback for undo (TRE-75): a toast is where it is usually
 * caught, but a dismissed one must not be the only way back, and this row
 * survives as long as its `PermissionSnapshots` rows do (30 days).
 */
function UndoButton({ item }: { item: ActivityView }) {
  const { csrfToken } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();

  const undo = () => {
    const call = item.kind === "file.chmod" ? undoChmod : undoChown;
    call(item.id, csrfToken)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.DIRECTORY] });
        push({ tone: "info", message: "Reverted." });
      })
      .catch(() => {
        push({ tone: "danger", message: "Could not undo — it may have expired." });
      });
  };

  return (
    <button
      type="button"
      onClick={undo}
      aria-label="Undo"
      title="Undo — restores only what this change touched, not anything altered since."
      className="text-ink-faint hover:text-ink-muted flex-none cursor-pointer font-mono text-2xs"
    >
      ↺
    </button>
  );
}
```

- [ ] **Step 3: Typecheck, lint, build**

```bash
cd front && pnpm typecheck && pnpm lint && pnpm build
```

Expected: all succeed.

- [ ] **Step 4: Manual check**

Run the app, chmod or chown something so a row lands in the sidebar's activity strip, and confirm the ↺ button appears on that row (and not on unrelated rows), that it does not visibly break the `Tooltip` that wraps the whole row (hover the row away from the button to confirm the tooltip still opens normally; hover/click the button itself to confirm the click registers rather than only opening the tooltip), and that clicking it reverts the change and shows a "Reverted." toast.

- [ ] **Step 5: Commit**

```bash
git add front/src/components/sidebar/activity-strip.tsx
git commit -m "TRE-75: add an undo button to chmod/chown rows in the activity strip"
```

---

## After all tasks

Run the full gate once, end to end:

```bash
cd nest-api && pnpm test && pnpm typecheck && pnpm lint && pnpm build
cd ../front && pnpm typecheck && pnpm lint && pnpm build
```

Then walk the ticket's own "Done" checklist (TRE-75) against what was actually built, and update it. Do not commit or push beyond what each task above already committed locally — this repo's standing rule is that the user validates before every push.
