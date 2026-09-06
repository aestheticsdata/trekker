import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { ScanAggregator } from "../src/scans/scan-aggregator";
import { contentKey, duRecords, flatten, type WalkedEntry } from "./corpus";
import { guardDevelopmentDatabase, HOUSE_EMAIL, MockRefusal, openPrisma, treeRoot } from "./env";
import {
  allActivity,
  DESTRUCTIVE_KINDS,
  type HostIds,
  hostIdFor,
  jobIdFor,
  resolveTree,
  resolveTreeDeep,
  sessionIdFor,
  transferItems,
  transferTotals,
} from "./fixtures";
import { SecretStoreService } from "../src/secrets/secret-store.service";
import { hostKeyPin } from "./host-keys";
import { stableUuid, uuidV7 } from "./ids";
import {
  ACTIVITY,
  BOOKMARKS,
  HASHES,
  LOCAL_HOST,
  REFERENCE_MS,
  REMOTE_HOSTS,
  REMOTE_PASSWORD,
  SCANS,
  TRANSFERS,
  TREE_SPEC,
  VIEWS,
} from "./manifest";
import { dfShimPath, materialise, writeFixturesStamp } from "./tree";

/**
 * The loader (TRE-140): the manifest's fixtures, into the development
 * database, against the materialised tree.
 *
 *   pnpm --filter ./nest-api mock
 *
 * One shot. It refuses production and any non-loopback database before it
 * reads a byte; rewrites the tree on disk from the manifest — every time,
 * because this is the reset and the app holds a WRITE root on that tree, so
 * whatever was uploaded, renamed or deleted through it goes too; then, in
 * one transaction, resets what it owns and writes the fixtures. What it
 * owns: the house account's LOCAL host and everything under it — roots,
 * bookmarks, scans, hashes — the three remote machines' coordinates, demo
 * credential and pinned host key (TRE-148), and the account's views,
 * transfers and activity. What it never touches: `Users`, and a credential
 * a developer stored on one of the remote rows themselves.
 *
 * Two runs leave the same rows. Every id is a function of a name — the
 * activity log's of a name and the manifest's fixed reference — and the only
 * thing that moves between runs is the anchor every timestamp is shifted
 * onto, which the tree's mtimes and the cached checksums' `mtimeMs` follow.
 *
 * The API is never told. Once the rows are in MySQL it cannot tell mock from
 * real and does not try — there is no dev flag on any request path.
 */

export interface LoadOptions {
  log?: (line: string) => void;
  /** The anchor every relative time lands on. Defaults to the clock. */
  now?: number;
  /** An open client to reuse; `dev-up` passes its own. Opened and closed here otherwise. */
  prisma?: PrismaClient;
}

export interface LoadResult {
  root: string;
  hostId: string;
  /** The SSH placeholders, by slug — found or made. */
  remoteHostIds: Record<string, string>;
  /** The fake `df` the API has to find first on its PATH — see `VOLUMES` in the manifest. */
  dfShim: string;
  counts: Record<string, number>;
}

const ENTRY_BATCH = 500;

export async function loadFixtures(options: LoadOptions = {}): Promise<LoadResult> {
  const log = options.log ?? (() => undefined);
  const nowMs = options.now ?? Date.now();
  const at = (rel: number): Date => new Date(nowMs + rel);

  // ---- guards, before any write ----------------------------------------
  const connection = guardDevelopmentDatabase();

  // ---- the tree, which the fixtures describe ---------------------------
  // Rewritten on the same anchor the rows are shifted onto, so nothing in the
  // tree is newer than the row that describes it.
  const made = materialise({ force: true, now: nowMs });
  log(`tree rewritten at ${made.root} (${made.files} files)`);
  const root = realpathSync(treeRoot());
  const flat = flatten(TREE_SPEC);
  const contentKeys = new Map(flat.entries.map((entry) => [join(root, entry.rel), contentKey(entry.spec, entry.rel)]));

  // ---- everything computed before the transaction opens -----------------
  const walked = walkDisk(root);
  const digests = await computeHashes(root);

  const prisma = options.prisma ?? openPrisma(connection);
  try {
    const user = await prisma.users.findUnique({
      where: { email: HOUSE_EMAIL },
      select: { id: true },
    });
    if (!user) {
      throw new MockRefusal(`No ${HOUSE_EMAIL} account. Run \`pnpm seed\` first — the account is the seed's business.`);
    }

    const foreign = await prisma.hosts.findFirst({
      where: { id: LOCAL_HOST.id, NOT: { userId: user.id } },
      select: { id: true },
    });
    if (foreign) {
      throw new MockRefusal(`The pinned host id ${LOCAL_HOST.id} belongs to another account. Delete that host first.`);
    }

    const counts: Record<string, number> = {};
    const remoteIds: Record<string, string> = {};
    const labels: Record<string, string> = {
      [LOCAL_HOST.id]: LOCAL_HOST.label,
    };

    await prisma.$transaction(
      async (tx) => {
        // ---- reset what this loader owns --------------------------------
        await tx.activityLog.deleteMany({ where: { userId: user.id } });
        await tx.transferJobs.deleteMany({ where: { userId: user.id } });
        await tx.views.deleteMany({ where: { userId: user.id } });
        // The seed's LOCAL host, or a previous load's: roots, bookmarks, scans
        // and hashes go with it (cascade).
        await tx.hosts.deleteMany({
          where: { userId: user.id, transport: "LOCAL" },
        });

        // ---- the SSH placeholders (TRE-148) -----------------------------
        // Found by slug and left exactly as found — a developer may have stored
        // a credential on one — or made, without a credential, when missing.
        // What goes: an SSH host of this account the manifest no longer names
        // AND that holds no credential (`demo-remote`, from before TRE-148). A
        // host somebody gave a credential to is theirs, whatever its slug.
        const stale = await tx.hosts.deleteMany({
          where: {
            userId: user.id,
            transport: "SSH",
            slug: { notIn: REMOTE_HOSTS.map((host) => host.slug) },
            credential: { is: null },
          },
        });
        counts.staleHostsRemoved = stale.count;
        // The demo password, sealed the way the API seals one — to the row's
        // own id, under TREKKER_MASTER_KEY, which `guardDevelopmentDatabase`
        // already put in the environment.
        const secrets = new SecretStoreService();
        secrets.onModuleInit();
        counts.credentialsSealed = 0;
        counts.keysPinned = 0;

        for (const spec of REMOTE_HOSTS) {
          const found = await tx.hosts.findFirst({
            where: { userId: user.id, slug: spec.slug, transport: "SSH" },
            select: { id: true, label: true, credential: { select: { id: true } } },
          });
          // A found row keeps its id, its bookmarks and any credential a
          // developer stored; its coordinates and roots are the mock's, and
          // are brought to what the manifest says — an older loader wrote
          // port 22 and one root, and the machine now answers elsewhere.
          if (found) {
            await tx.hosts.update({
              where: { id: found.id },
              data: {
                label: spec.label,
                address: spec.address,
                port: spec.port,
                username: spec.username,
                colour: spec.colour,
                homePath: spec.homePath,
              },
            });
            for (const path of spec.roots) {
              await tx.hostRoots.upsert({
                where: { hostId_path: { hostId: found.id, path } },
                create: { id: stableUuid(`root:${spec.slug}:${path}`), hostId: found.id, path, access: "WRITE" },
                update: {},
              });
            }
          }
          const row =
            found ??
            (await tx.hosts.create({
              data: {
                id: stableUuid(`host:${spec.slug}`),
                userId: user.id,
                slug: spec.slug,
                label: spec.label,
                transport: "SSH",
                address: spec.address,
                port: spec.port,
                username: spec.username,
                colour: spec.colour,
                homePath: spec.homePath,
                createdAt: at(ACTIVITY.find((entry) => entry.key === `host-create-${spec.slug}`)?.at ?? 0),
                roots: {
                  create: spec.roots.map((path) => ({
                    id: stableUuid(`root:${spec.slug}:${path}`),
                    path,
                    access: "WRITE" as const,
                  })),
                },
                bookmarks: {
                  create: spec.bookmarks.map((bookmark, position) => ({
                    id: stableUuid(`bookmark:${spec.slug}:${bookmark.label}`),
                    path: bookmark.path,
                    label: bookmark.label,
                    hint: bookmark.hint,
                    position,
                  })),
                },
              },
              select: { id: true, label: true },
            }));
          remoteIds[spec.slug] = row.id;
          labels[row.id] = row.label;

          if (!found?.credential) {
            const sealed = secrets.encrypt(Buffer.from(REMOTE_PASSWORD, "utf8"), row.id);
            await tx.hostCredentials.upsert({
              where: { hostId: row.id },
              create: {
                id: stableUuid(`credential:${spec.slug}`),
                hostId: row.id,
                kind: "PASSWORD",
                ciphertext: new Uint8Array(sealed.ciphertext),
                iv: new Uint8Array(sealed.iv),
                authTag: new Uint8Array(sealed.authTag),
                keyVersion: sealed.keyVersion,
              },
              update: {
                kind: "PASSWORD",
                ciphertext: new Uint8Array(sealed.ciphertext),
                iv: new Uint8Array(sealed.iv),
                authTag: new Uint8Array(sealed.authTag),
                keyVersion: sealed.keyVersion,
              },
            });
            counts.credentialsSealed += 1;
          }

          // The machine's host key, pinned as verified — the key `sshd.ts`
          // presents, made here if it does not exist yet. Pinned rather than
          // left to trust-on-first-use, which would write a `host.key.pinned`
          // row into the activity strip on camera.
          const pin = hostKeyPin(spec.slug);
          await tx.hostKnownKeys.upsert({
            where: { hostId_algorithm: { hostId: row.id, algorithm: pin.algorithm } },
            create: {
              hostId: row.id,
              algorithm: pin.algorithm,
              fingerprint: pin.fingerprint,
              verifiedAt: new Date(),
            },
            update: { fingerprint: pin.fingerprint, verifiedAt: new Date() },
          });
          counts.keysPinned += 1;
        }
        counts.remoteHosts = REMOTE_HOSTS.length;
        // The machines are the mock's, so what the app learned about them is
        // reset with them: a scan of Marlow kept from a previous take would
        // greet the next one with a treemap where the film expects "Never
        // scanned". Their checksum cache goes for the same reason.
        const remoteHostIdList = Object.values(remoteIds);
        await tx.diskScans.deleteMany({ where: { hostId: { in: remoteHostIdList } } });
        await tx.fileHashes.deleteMany({ where: { hostId: { in: remoteHostIdList } } });
        const ids: HostIds = {
          local: LOCAL_HOST.id,
          marlow: remoteIds.marlow ?? null,
          sable: remoteIds.sable ?? null,
          tundra: remoteIds.tundra ?? null,
        };

        // ---- the host, locked inside the tree ---------------------------
        // Dated when the activity log says it was added, not when this ran.
        const hostAddedAt = at(ACTIVITY.find((row) => row.key === "host-create-local")?.at ?? 0);
        await tx.hosts.create({
          data: {
            id: LOCAL_HOST.id,
            userId: user.id,
            slug: LOCAL_HOST.slug,
            label: LOCAL_HOST.label,
            transport: "LOCAL",
            address: null,
            // The corpus's own operator (see `home/deploy` in the tree). `who()` in the front prefers a
            // host's username over the machine's `whoami`, so a film never prints the laptop's login.
            username: "deploy",
            localSlot: true,
            colour: LOCAL_HOST.colour,
            homePath: root,
            createdAt: hostAddedAt,
            updatedAt: hostAddedAt,
            // The allowlist. One root, the tree's, and nothing else: with a
            // MEMBER account the guard refuses every path outside it.
            roots: {
              create: [{ id: stableUuid("root:tree"), path: root, access: "WRITE" }],
            },
            bookmarks: {
              create: BOOKMARKS.map((bookmark, position) => ({
                id: stableUuid(`bookmark:${bookmark.label}`),
                path: resolveTree(bookmark.path, root),
                label: bookmark.label,
                hint: bookmark.hint,
                position,
              })),
            },
          },
        });
        counts.hosts = 1;
        counts.bookmarks = BOOKMARKS.length;

        // ---- views ---------------------------------------------------
        for (const view of VIEWS) {
          const pane = (side: (typeof view)["a"]) => {
            const host = hostIdFor(side.host, ids);
            return {
              host,
              path: resolveTree(side.path, root),
              sort: side.sort,
              dir: side.dir,
              hide: side.hide,
            };
          };
          await tx.views.create({
            data: {
              id: stableUuid(`view:${view.name}`),
              userId: user.id,
              name: view.name,
              slot: view.slot,
              layout: {
                a: pane(view.a),
                b: pane(view.b),
                split: view.split,
                insp: view.insp,
                heat: view.heat,
                glob: view.glob,
              },
              hostLabels: labels,
              createdAt: at(view.createdAt),
            },
          });
        }
        counts.views = VIEWS.length;

        // ---- scans, from the tree through the real aggregator ---------
        counts.scans = 0;
        counts.scanEntries = 0;
        for (const scan of SCANS) {
          const scanRoot = scan.root === "" ? root : join(root, scan.root);
          const startedAt = at(scan.startedAt);
          const finishedAt = at(scan.startedAt + scan.durationMs);
          const id = stableUuid(`scan:${scan.key}`);

          if (scan.status !== "DONE") {
            await tx.diskScans.create({
              data: {
                id,
                hostId: LOCAL_HOST.id,
                root: scanRoot,
                depth: scan.depth,
                status: scan.status,
                startedAt,
                finishedAt,
                runningSlot: null,
                error: scan.error ?? null,
              },
            });
            counts.scans += 1;
            continue;
          }

          const under = walked.filter((entry) => entry.path === scanRoot || entry.path.startsWith(`${scanRoot}/`));
          const aggregator = new ScanAggregator({
            root: scanRoot,
            depth: scan.depth,
            hasTime: true,
            hasFiles: true,
            now: startedAt.getTime(),
          });
          for (const record of duRecords(scanRoot, under)) aggregator.add(record);
          const aggregate = aggregator.finish();
          const total = aggregate.totalBytes ?? 0n;
          const duplicates = confirmFromContent(
            aggregate.duplicateCandidates,
            aggregate.duplicatesDropped,
            contentKeys,
          );

          await tx.diskScans.create({
            data: {
              id,
              hostId: LOCAL_HOST.id,
              root: scanRoot,
              depth: scan.depth,
              status: "DONE",
              startedAt,
              finishedAt,
              runningSlot: null,
              totalBytes: total,
              inodes: aggregate.inodes,
              flavour: "GNU",
              niced: true,
              unreadableCount: 0,
              truncated: aggregate.truncated,
              largestPath: aggregate.largest?.path ?? null,
              largestBytes: aggregate.largest?.bytes ?? null,
              oldFileCount: aggregate.oldFileCount,
              oldFileBytes: aggregate.oldFileBytes,
              oldFileBefore: aggregate.oldFileBefore,
              dupGroupsCandidate: duplicates.candidates,
              dupGroupsConfirmed: duplicates.confirmed,
              dupGroupsSkipped: duplicates.skipped,
              dupReclaimableBytes: duplicates.reclaimableBytes,
            },
          });

          const rows = aggregate.entries.map((entry) => ({
            id: stableUuid(`entry:${scan.key}:${entry.kind}:${entry.path}:${entry.depth}`),
            scanId: id,
            path: entry.path,
            bytes: entry.bytes,
            percent: shareOf(entry.bytes, total),
            parentPath: entry.parentPath,
            depth: entry.depth,
            kind: entry.kind,
          }));
          for (let start = 0; start < rows.length; start += ENTRY_BATCH) {
            await tx.diskScanEntries.createMany({
              data: rows.slice(start, start + ENTRY_BATCH),
            });
          }
          counts.scans += 1;
          counts.scanEntries += rows.length;
        }

        // ---- hashes, keyed on what the file measures right now ----------
        await tx.fileHashes.createMany({
          data: HASHES.map((hash) => {
            const path = join(root, hash.path);
            const digest = digests.get(path);
            if (!digest) throw new Error(`No digest computed for ${path}`);
            return {
              id: stableUuid(`hash:${hash.path}`),
              hostId: LOCAL_HOST.id,
              path,
              digest: digest.digest,
              size: digest.size,
              mtimeMs: digest.mtimeMs,
              method: "STREAMED" as const,
              computedAt: at(hash.computedAt),
            };
          }),
        });
        counts.hashes = HASHES.length;

        // ---- transfers -------------------------------------------------
        counts.transfers = 0;
        counts.transferItems = 0;
        for (const transfer of TRANSFERS) {
          const items = transferItems(transfer, flat);
          const totals = transferTotals(items);
          const createdAt = at(transfer.createdAt);
          const ran = !(transfer.status === "FAILED" && totals.itemsDone === 0 && totals.failed === 0);
          const jobId = jobIdFor(transfer);
          // What the walk saw when it planned the job: a day before, for want
          // of a better guess, and never the moment of the load.
          const walkedAt = BigInt(nowMs + transfer.createdAt - 86_400_000);

          await tx.transferJobs.create({
            data: {
              id: jobId,
              userId: user.id,
              srcHostId: hostIdFor(transfer.src, ids),
              srcPath: resolveTree(transfer.srcPath, root),
              dstHostId: hostIdFor(transfer.dst, ids),
              dstPath: resolveTree(transfer.dstPath, root),
              operation: transfer.operation,
              options: {
                strategy: transfer.strategy,
                landAs: transfer.landAs ?? {},
              },
              status: transfer.status,
              bytesTotal: BigInt(totals.bytesTotal),
              bytesDone: BigInt(totals.bytesDone),
              itemsTotal: totals.itemsTotal,
              itemsDone: totals.itemsDone,
              createdAt,
              startedAt: ran ? at(transfer.createdAt + transfer.queuedMs) : null,
              finishedAt: at(transfer.createdAt + transfer.queuedMs + transfer.durationMs),
              error: transfer.error ?? null,
              items: {
                createMany: {
                  data: items.map((item) => ({
                    id: stableUuid(`item:${transfer.key}:${item.name}`),
                    name: item.name,
                    kind: item.kind,
                    bytes: BigInt(item.bytes),
                    mode: item.kind === "directory" ? 0o755 : 0o644,
                    mtimeMs: walkedAt,
                    conflict: item.conflict ?? "ASK",
                    status: item.status,
                    finalName: item.finalName ?? null,
                    error: item.error ?? null,
                  })),
                },
              },
            },
          });
          counts.transfers += 1;
          counts.transferItems += items.length;
        }

        // ---- activity, oldest first so the ids rise with the clock ------
        //
        // The id's time half is the manifest's *reference* plus the row's
        // offset, not the anchor: the rows then sort among themselves as their
        // timestamps do, every row the app writes later sorts after them (the
        // reference is in the past on every machine that runs this), and two
        // loads produce the same ids.
        const rows = allActivity(flat);
        const snapshots: Array<{
          id: string;
          activityLogId: string;
          path: string;
          mode: number;
          uid: number;
          gid: number;
          createdAt: Date;
        }> = [];
        await tx.activityLog.createMany({
          data: rows.map((row) => {
            const createdAt = at(row.at);
            const id = uuidV7(REFERENCE_MS + row.at, `activity:${row.key}`);
            for (const snapshot of row.snapshots ?? []) {
              snapshots.push({
                id: stableUuid(`snapshot:${row.key}:${snapshot.path}`),
                activityLogId: id,
                path: resolveTree(snapshot.path, root),
                mode: snapshot.mode,
                uid: snapshot.uid,
                gid: snapshot.gid,
                createdAt,
              });
            }
            return {
              id,
              userId: user.id,
              hostId: hostIdFor(row.host, ids),
              kind: row.kind,
              summary: resolveTree(row.summary, root).slice(0, 255),
              tag: row.tag === undefined ? null : resolveTree(row.tag, root).slice(0, 32),
              payload: row.payload === undefined ? undefined : asJson(resolveTreeDeep(row.payload, root)),
              sessionId: sessionIdFor(row.session ?? 0),
              outcome: row.outcome ?? "success",
              detail: row.detail ?? null,
              elevated: row.elevated ?? false,
              origin: row.origin ?? null,
              destructive: row.destructive ?? DESTRUCTIVE_KINDS.has(row.kind),
              bytes: row.bytes === undefined ? null : BigInt(row.bytes),
              durationMs: row.outcome === "pending" ? null : (row.durationMs ?? null),
              createdAt,
            };
          }),
        });
        if (snapshots.length > 0) await tx.permissionSnapshots.createMany({ data: snapshots });
        counts.activity = rows.length;
        counts.permissionSnapshots = snapshots.length;
      },
      { maxWait: 10_000, timeout: 120_000 },
    );

    // Written last, after the rows: a stamp that outlived a failed load would
    // tell `dev-up` the database describes a tree it never saw.
    writeFixturesStamp({
      treeAnchorMs: made.anchorMs,
      loadedAt: new Date(nowMs).toISOString(),
      hostId: LOCAL_HOST.id,
    });

    return {
      root,
      hostId: LOCAL_HOST.id,
      remoteHostIds: remoteIds,
      dfShim: dfShimPath(),
      counts,
    };
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------- the tree on disk

/**
 * The materialised tree as `du` would see it: every directory, file and
 * symlink with its apparent size and mtime. Anything else — a socket left by
 * somebody's experiment — is skipped, which is what `du -x -a` does too.
 */
export function walkDisk(root: string): WalkedEntry[] {
  const out: WalkedEntry[] = [];
  const visit = (path: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      out.push({
        path,
        kind: "symlink",
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
      return;
    }
    if (info.isDirectory()) {
      out.push({ path, kind: "directory", size: 0, mtimeMs: info.mtimeMs });
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (info.isFile()) out.push({ path, kind: "file", size: info.size, mtimeMs: info.mtimeMs });
  };
  if (!existsSync(root)) throw new MockRefusal(`The tree is missing at ${root}. Run \`pnpm mock:tree\`.`);
  visit(root);
  return out;
}

interface Digest {
  digest: string;
  size: bigint;
  mtimeMs: bigint;
}

/**
 * sha256 of each hashed file's real bytes, with the size and mtime the row
 * will be checked against — read back from the file, not taken from the
 * manifest, because equality is the test and the filesystem has the last word.
 */
async function computeHashes(root: string): Promise<Map<string, Digest>> {
  const out = new Map<string, Digest>();
  for (const hash of HASHES) {
    const path = join(root, hash.path);
    const info = lstatSync(path);
    if (!info.isFile()) throw new MockRefusal(`${hash.path} is not a regular file in the tree.`);
    const digest = await sha256(path);
    out.set(path, {
      digest,
      size: BigInt(info.size),
      mtimeMs: BigInt(Math.trunc(info.mtimeMs)),
    });
  }
  return out;
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// ---------------------------------------------------------------- duplicates

/**
 * What the scan's hash pass would have found, decided from the manifest
 * instead of from `sha256sum`: two files are copies when the tree says they
 * hold the same bytes. Every sparse file is zeroes, so two of one size are —
 * and they really are, on disk.
 */
function confirmFromContent(
  candidates: ReadonlyArray<{ bytes: bigint; paths: string[] }>,
  droppedByBounds: number,
  keys: ReadonlyMap<string, string>,
): {
  candidates: number;
  confirmed: number;
  skipped: number;
  reclaimableBytes: bigint;
} {
  let confirmed = 0;
  let reclaimable = 0n;
  for (const group of candidates) {
    const byKey = new Map<string, number>();
    for (const path of group.paths) {
      const key = keys.get(path) ?? `unknown:${path}`;
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
    let confirmedHere = false;
    for (const count of byKey.values()) {
      if (count < 2) continue;
      confirmedHere = true;
      reclaimable += group.bytes * BigInt(count - 1);
    }
    if (confirmedHere) confirmed += 1;
  }
  return {
    candidates: candidates.length,
    confirmed,
    skipped: droppedByBounds,
    reclaimableBytes: reclaimable,
  };
}

/**
 * A plain object on its way into a Json column — the same widening
 * `views.service.ts` writes down, for the same reason: Prisma's input type
 * wants an index signature a `Record<string, unknown>` does not carry.
 */
function asJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** The runner's own rounding, so a loaded scan's labels read like a real one's. */
function shareOf(bytes: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Math.round((Number(bytes) / Number(total)) * 10_000) / 100;
}

// ---------------------------------------------------------------- the command

if (require.main === module) {
  loadFixtures({ log: (line) => console.log(line) })
    .then((result) => {
      console.log(`\nLoaded the fixtures for ${HOUSE_EMAIL} against the tree at\n\n  ${result.root}\n`);
      for (const [table, count] of Object.entries(result.counts)) {
        console.log(`  ${table.padEnd(20)} ${count}`);
      }
      console.log(
        `\nThe VOLUMES rail reads the host's df. Start the API with the mock's own first on its PATH:` +
          `\n\n  PATH="${dirname(result.dfShim)}:$PATH"   (pnpm dev does this itself)\n`,
      );
    })
    .catch((error: unknown) => {
      if (error instanceof MockRefusal) {
        console.error(`\nmock refused: ${error.message}\n`);
        process.exit(1);
      }
      console.error(error);
      process.exit(1);
    });
}
