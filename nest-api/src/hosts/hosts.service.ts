import { homedir } from "node:os";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { HostConnectionSpec, HostProbeResult, SshAuth, SshConnectionPool } from "@hosts/drivers/ssh-connection.pool";
import type { CreateHostDto } from "@hosts/dto/create-host.dto";
import type { HostRootInput, RootAccessInput } from "@hosts/dto/host-root.dto";
import type { TestHostDto } from "@hosts/dto/test-host.dto";
import type { UpdateHostDto } from "@hosts/dto/update-host.dto";
import { HostSummary, HostSummaryService } from "@hosts/host-summary.service";
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { SecretStoreService } from "@secrets/secret-store.service";
import { PrismaService } from "../prisma/prisma.service";

/** A host as the client sees it — never any credential material. */
export interface HostView {
  id: string;
  slug: string;
  label: string;
  transport: "LOCAL" | "SSH";
  address: string | null;
  port: number;
  username: string | null;
  colour: string;
  homePath: string;
  hasCredential: boolean;
  credentialKind: string | null;
  /** The allowlist, so the client can show and edit the boundary it is bound by. */
  roots: Array<{ path: string; access: "READ" | "WRITE" }>;
  fingerprints: Array<{
    algorithm: string;
    fingerprint: string;
    verified: boolean;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class HostsService {
  private readonly logger = new Logger(HostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretStoreService,
    private readonly pool: SshConnectionPool,
    private readonly factory: HostDriverFactory,
    private readonly summaries: HostSummaryService,
  ) {}

  async list(userId: string): Promise<HostView[]> {
    const hosts = await this.prisma.hosts.findMany({
      where: { userId },
      include: { credential: true, knownKeys: true, roots: true },
      orderBy: { createdAt: "asc" },
    });
    return hosts.map(toView);
  }

  async get(userId: string, id: string): Promise<HostView> {
    const host = await this.prisma.hosts.findFirst({
      where: { id, userId },
      include: { credential: true, knownKeys: true, roots: true },
    });
    // A host that is not yours is a 404, never a 403 — the response must not
    // confirm the id exists (TRE-12).
    if (!host) throw new NotFoundException("Host not found");
    return toView(host);
  }

  async create(userId: string, dto: CreateHostDto): Promise<HostView> {
    if (dto.transport === "SSH") {
      this.requireSshFields(dto);
    }

    const slug = await this.uniqueSlug(userId, dto.label);
    // The local host starts at the API user's home, which is TRE-12 §4's
    // bootstrap default. An SSH host has no home we can know before connecting,
    // so it starts at `/` and the client narrows it after a successful test.
    const homePath = dto.homePath ?? (dto.transport === "LOCAL" ? homedir() : "/");

    // Without an explicit list the home is the only root, read-write, which is
    // what every host had before TRE-43 and still the right default: the one
    // directory you named is the one you meant to reach.
    const roots = dto.roots ? normaliseRoots(dto.roots) : [{ path: cleanRootPath(homePath), access: "WRITE" as const }];
    requireUsableRoots(homePath, roots, await this.isOwner(userId));

    const created = await this.prisma
      .$transaction(async (tx) => {
        const host = await tx.hosts.create({
          data: {
            userId,
            slug,
            label: dto.label,
            transport: dto.transport,
            address: dto.transport === "SSH" ? (dto.address ?? null) : null,
            port: dto.port ?? 22,
            username: dto.transport === "SSH" ? (dto.username ?? null) : null,
            colour: dto.colour ?? "#7fa8c9",
            homePath,
            // Only LOCAL rows occupy the unique (userId, localSlot) slot; SSH
            // rows leave it NULL, which a unique index counts as always distinct.
            localSlot: dto.transport === "LOCAL" ? true : null,
          },
        });

        // An owner may save none at all, and `createMany` with an empty list is
        // a round trip to insert nothing.
        if (roots.length > 0) {
          await tx.hostRoots.createMany({
            data: roots.map((root) => ({
              hostId: host.id,
              path: root.path,
              access: root.access,
            })),
          });
        }

        if (dto.transport === "SSH" && dto.credentialKind && dto.credentialSecret) {
          await this.storeCredential(tx, host.id, dto.credentialKind, dto.credentialSecret);
        }

        // The algorithm is required alongside the fingerprint: a pin is a pair,
        // and one recorded under the wrong algorithm never matches the key the
        // host actually offers. Without both, no pin is written and the first
        // real connection records what it sees (TRE-10 §1, §4).
        if (dto.fingerprint && dto.fingerprintAlgorithm) {
          await tx.hostKnownKeys.create({
            data: {
              hostId: host.id,
              algorithm: dto.fingerprintAlgorithm,
              fingerprint: dto.fingerprint,
              // Confirmed on the create form against what the probe showed.
              verifiedAt: new Date(),
            },
          });
        }

        return tx.hosts.findFirstOrThrow({
          where: { id: host.id },
          include: { credential: true, knownKeys: true, roots: true },
        });
        // A second LOCAL host trips the unique (userId, localSlot) index. That is
        // the constraint doing its job — surfaced as a 409, not a 500.
      })
      .catch((error: unknown) => {
        // Two different unique indexes can fail here and they mean opposite
        // things: localSlot is a real conflict the user must be told about,
        // while slug is a lost race between two creates that simply needs a
        // different suffix. Telling someone adding a web server that they
        // "already have a local host" would be a lie.
        if (isUniqueViolation(error)) {
          if (violatedTarget(error).includes("localSlot")) {
            throw new ConflictException("This account already has a local host");
          }
          throw new ConflictException("That name was just taken. Try again.");
        }
        throw error;
      });

    this.logger.log(`Host created: ${created.slug} (${created.transport}) for user ${userId}`);
    return toView(created);
  }

  async update(userId: string, id: string, dto: UpdateHostDto): Promise<HostView> {
    const host = await this.prisma.hosts.findFirst({ where: { id, userId } });
    if (!host) throw new NotFoundException("Host not found");

    // Checked against whichever home the host ends the request with, so moving
    // the home and narrowing the roots in one PATCH is judged as one change
    // rather than as two that each look fine on their own.
    const roots = dto.roots ? normaliseRoots(dto.roots) : null;
    if (roots) requireUsableRoots(dto.homePath ?? host.homePath, roots, await this.isOwner(userId));

    // Half a credential is never "no credential change" — silently keeping the
    // old secret while answering 200 would tell an operator rotating a leaked
    // key that the rotation happened. The kind may be omitted when the host
    // already has one, since that is a genuine "same kind, new secret".
    if (dto.credentialSecret === undefined && dto.credentialKind !== undefined) {
      throw new BadRequestException("credentialKind was given without credentialSecret");
    }
    let credentialKind = dto.credentialKind;
    if (dto.credentialSecret !== undefined && credentialKind === undefined) {
      const existing = await this.prisma.hostCredentials.findUnique({
        where: { hostId: id },
        select: { kind: true },
      });
      if (!existing) {
        throw new BadRequestException("credentialKind is required: this host has no credential to replace");
      }
      credentialKind = existing.kind;
    }

    const credentialChanged = dto.credentialSecret !== undefined;
    const connectionChanged =
      credentialChanged ||
      dto.address !== undefined ||
      dto.port !== undefined ||
      dto.username !== undefined ||
      // A new pin must be enforced on the next connection, and the pooled one
      // was verified against the old one.
      dto.fingerprint !== undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.hosts.update({
        where: { id },
        data: {
          label: dto.label ?? undefined,
          colour: dto.colour ?? undefined,
          homePath: dto.homePath ?? undefined,
          address: host.transport === "SSH" ? (dto.address ?? undefined) : undefined,
          port: dto.port ?? undefined,
          username: host.transport === "SSH" ? (dto.username ?? undefined) : undefined,
        },
      });

      if (credentialChanged) {
        if (host.transport !== "SSH") {
          throw new BadRequestException("A LOCAL host has no credential");
        }
        // biome-ignore lint/style/noNonNullAssertion: both are resolved above.
        await this.storeCredential(tx, id, credentialKind!, dto.credentialSecret!);
      }

      if (roots) {
        // Replaced wholesale rather than diffed. `@@unique([hostId, path])`
        // means an incremental merge is a sequence of deletes and inserts that
        // reaches exactly this state anyway, and the guard reads the table
        // fresh on every request, so there is no cache to keep in step.
        await tx.hostRoots.deleteMany({ where: { hostId: id } });
        if (roots.length > 0) {
          await tx.hostRoots.createMany({
            data: roots.map((root) => ({
              hostId: id,
              path: root.path,
              access: root.access,
            })),
          });
        }
      }
      // The home is also the host's default root, seeded at creation. Moving
      // one without the other either leaves the pane pointing outside every
      // root (nothing is browsable) or leaves the old root granted — so the
      // root that still matches the previous home moves with it. Skipped when
      // the request names its roots: it has already said where the boundary is.
      else if (dto.homePath !== undefined && dto.homePath !== host.homePath) {
        const previous = await tx.hostRoots.findFirst({
          where: { hostId: id, path: host.homePath },
        });
        if (previous) {
          const clash = await tx.hostRoots.findFirst({
            where: { hostId: id, path: dto.homePath },
          });
          if (clash) {
            // The destination is already a root; drop the now-duplicate old
            // one rather than trip @@unique([hostId, path]).
            await tx.hostRoots.delete({ where: { id: previous.id } });
          } else {
            await tx.hostRoots.update({
              where: { id: previous.id },
              data: { path: dto.homePath },
            });
          }
        }
      }

      // A fingerprint on PATCH used to replace the pin outright, which made a
      // host key change resolvable by pressing Save on the form the warning
      // links to — the one careless click TRE-10 §3 exists to prevent. Pinning
      // a host that has none is still fine, since there is nothing to override;
      // replacing one goes through POST :id/known-keys and is audited.
      //
      // `skipDuplicates` alone was not enough: the unique key is
      // (hostId, algorithm), so a save naming an algorithm the host has never
      // been pinned under inserts happily and adds a second trusted key. That
      // is a trust change riding along on a save by another name. A host with
      // any pin at all is therefore off limits here.
      if (dto.fingerprint && dto.fingerprintAlgorithm) {
        const alreadyPinned = await tx.hostKnownKeys.count({ where: { hostId: id } });
        if (alreadyPinned === 0) {
          await tx.hostKnownKeys.create({
            data: {
              hostId: id,
              algorithm: dto.fingerprintAlgorithm,
              fingerprint: dto.fingerprint,
              verifiedAt: new Date(),
            },
          });
        }
      }

      return tx.hosts.findFirstOrThrow({
        where: { id },
        include: { credential: true, knownKeys: true, roots: true },
      });
    });

    if (connectionChanged) {
      // The pooled connection still holds the old credential or address.
      this.factory.invalidate(id, "host updated");
      this.summaries.forget(id);
    }

    return toView(updated);
  }

  async remove(userId: string, id: string): Promise<void> {
    // deleteMany scoped by user: a foreign id deletes nothing and reads as 404,
    // the same answer as an id that never existed.
    const result = await this.prisma.hosts.deleteMany({
      where: { id, userId },
    });
    if (result.count === 0) throw new NotFoundException("Host not found");

    // The row and its credential, roots and keys are gone (cascade, TRE-6);
    // now drop the live connection that was still authenticating as it.
    this.factory.invalidate(id, "host deleted");
    this.summaries.forget(id);
    this.logger.log(`Host deleted: ${id} for user ${userId}`);
  }

  /** Dry-run connect to a candidate SSH host. Persists nothing (TRE-12 §2). */
  async test(dto: TestHostDto, userId?: string): Promise<HostProbeResult> {
    const secret = Buffer.from(dto.credentialSecret, "utf8");
    const passphrase = dto.credentialPassphrase ? Buffer.from(dto.credentialPassphrase, "utf8") : undefined;

    // Scoped by user, so a host id from another account contributes no pins
    // rather than revealing that it exists.
    const known =
      dto.hostId && userId
        ? await this.prisma.hostKnownKeys.findMany({
            where: { hostId: dto.hostId, host: { userId } },
            select: { algorithm: true, fingerprint: true },
          })
        : [];

    const spec: HostConnectionSpec = {
      // No persisted id — the probe never touches the pool map.
      hostId: "probe",
      address: dto.address,
      port: dto.port ?? 22,
      username: dto.username,
      auth: authFromInput(dto.credentialKind, secret, passphrase),
      // An existing host is held to its pins here too: the credential must not
      // be offered to something that fails the check (TRE-10 §2).
      pins: known,
    };

    try {
      return await this.pool.probe(spec);
    } finally {
      secret.fill(0);
      passphrase?.fill(0);
    }
  }

  async summary(userId: string, id: string): Promise<HostSummary> {
    // get() enforces ownership and 404s a foreign id before we open a channel.
    await this.get(userId, id);
    const driver = await this.factory.forHost(id, userId);
    return this.summaries.forHost(driver);
  }

  // ---- internals ----------------------------------------------------------

  private requireSshFields(dto: CreateHostDto): void {
    const missing: string[] = [];
    if (!dto.address) missing.push("address");
    if (!dto.username) missing.push("username");
    if (!dto.credentialKind) missing.push("credentialKind");
    if (!dto.credentialSecret) missing.push("credentialSecret");
    if (missing.length > 0) {
      throw new BadRequestException(`An SSH host needs: ${missing.join(", ")}`);
    }
  }

  private async storeCredential(tx: TxClient, hostId: string, kind: string, secret: string): Promise<void> {
    const material = Buffer.from(secret, "utf8");
    try {
      const sealed = this.secrets.encrypt(material, hostId);
      // Prisma's Bytes wants Uint8Array<ArrayBuffer>; a Node Buffer is
      // Uint8Array<ArrayBufferLike>, which TS will not narrow — same
      // conversion as scripts/rotate-master-key.ts.
      const record = {
        ciphertext: new Uint8Array(sealed.ciphertext),
        iv: new Uint8Array(sealed.iv),
        authTag: new Uint8Array(sealed.authTag),
        keyVersion: sealed.keyVersion,
      };
      await tx.hostCredentials.upsert({
        where: { hostId },
        create: { hostId, kind: kind as CredentialKind, ...record },
        update: { kind: kind as CredentialKind, ...record },
      });
    } finally {
      material.fill(0);
    }
  }

  /** A URL-safe, per-user-unique handle derived from the label. */
  /**
   * Whether this account owns the install (TRE-48).
   *
   * Read per request rather than carried on the session, so a role that changes
   * binds the next call instead of the next sign-in. An account the query
   * cannot find reads as a MEMBER — unreachable behind the session guard, and
   * the restrictive answer is the one to be wrong in.
   */
  private async isOwner(userId: string): Promise<boolean> {
    const user = await this.prisma.users.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role === "OWNER";
  }

  private async uniqueSlug(userId: string, label: string): Promise<string> {
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 56) || "host";

    const taken = new Set(
      (
        await this.prisma.hosts.findMany({
          where: { userId, slug: { startsWith: base } },
          select: { slug: true },
        })
      ).map((row) => row.slug),
    );

    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}

// Prisma's generated types are heavy; these two aliases keep the signatures
// readable without importing the whole client namespace.
type TxClient = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];
type CredentialKind = "PRIVATE_KEY" | "PASSWORD" | "AGENT";

/** A normalised root row, ready for the database. */
interface NormalisedRoot {
  path: string;
  access: RootAccessInput;
}

/**
 * Collapse duplicate separators and drop the trailing slash, so a root stored
 * here compares equal to what the guard computes from a request path.
 */
function cleanRootPath(path: string): string {
  return `/${path.trim().split("/").filter(Boolean).join("/")}`;
}

/**
 * Two rows naming the same directory is an edited form, not an attack, so the
 * wider access wins rather than the request failing — the guard stops at the
 * first root that admits the path, so keeping both would mean the same thing
 * with an extra row.
 */
function normaliseRoots(rows: readonly HostRootInput[]): NormalisedRoot[] {
  const byPath = new Map<string, RootAccessInput>();
  for (const row of rows) {
    const path = cleanRootPath(row.path);
    if (byPath.get(path) !== "WRITE") byPath.set(path, row.access);
  }
  return [...byPath].map(([path, access]) => ({ path, access }));
}

/**
 * Both rules a roots list has to satisfy before it is saved, and the one
 * account they do not apply to.
 *
 * Each is a prediction about what the guard would do to the *next* listing: a
 * host with nothing granted serves nothing, and a home outside every root opens
 * its pane on a refusal. Neither prediction holds for the install's owner, who
 * resolves against `/` whatever this list says (TRE-48) — so enforcing them
 * there would refuse a save on the strength of a failure that cannot happen.
 * For a MEMBER the reasoning is untouched, and so are the messages.
 *
 * The rows are still stored and still editable for an owner: the role lives in
 * a column, so an account can stop being one, and a boundary nobody can write
 * down before it binds is a boundary nobody can prepare.
 *
 * String containment, deliberately: the real check happens in the guard, after
 * both sides are resolved on the host, and reaching out to the machine to
 * validate a form field would make saving a host depend on it being up.
 */
function requireUsableRoots(homePath: string, roots: readonly NormalisedRoot[], owner: boolean): void {
  if (owner) return;

  // Said the way the DTO used to say it, because it is the same refusal — it
  // simply cannot be decided until the role is known, and a decorator never
  // sees one.
  if (roots.length === 0) {
    throw new BadRequestException("a host with no roots can serve nothing");
  }

  const home = cleanRootPath(homePath);
  const inside = roots.some((root) => home === root.path || home.startsWith(root.path === "/" ? "/" : `${root.path}/`));
  if (!inside) {
    throw new BadRequestException(
      `The home ${home} sits outside every root, so this host would open on a refusal. Add a root that contains it.`,
    );
  }
}

/** Prisma's unique-constraint failure, without importing its error classes. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/**
 * Which index a P2002 names. Prisma reports it as `meta.target`, an array on
 * some connectors and a string on others; MySQL sometimes only names it in the
 * message, so that is the last resort.
 */
function violatedTarget(error: unknown): string {
  const meta = (error as { meta?: { target?: unknown } }).meta;
  const target = meta?.target;
  if (Array.isArray(target)) return target.join(",");
  if (typeof target === "string") return target;
  return String((error as { message?: string }).message ?? "");
}

function authFromInput(kind: string, secret: Buffer, passphrase?: Buffer): SshAuth {
  switch (kind) {
    case "PRIVATE_KEY":
      return { kind: "PRIVATE_KEY", privateKey: secret, passphrase };
    case "PASSWORD":
      return { kind: "PASSWORD", password: secret };
    case "AGENT":
      return { kind: "AGENT", agentSocket: secret.toString("utf8") };
    default:
      throw new BadRequestException(`Unsupported credential kind: ${kind}`);
  }
}

function toView(host: {
  id: string;
  slug: string;
  label: string;
  transport: string;
  address: string | null;
  port: number;
  username: string | null;
  colour: string;
  homePath: string;
  createdAt: Date;
  updatedAt: Date;
  credential: { kind: string } | null;
  knownKeys: Array<{
    algorithm: string;
    fingerprint: string;
    verifiedAt: Date | null;
  }>;
  roots: Array<{ path: string; access: string }>;
}): HostView {
  return {
    id: host.id,
    slug: host.slug,
    label: host.label,
    transport: host.transport as "LOCAL" | "SSH",
    address: host.address,
    port: host.port,
    username: host.username,
    colour: host.colour,
    homePath: host.homePath,
    hasCredential: host.credential !== null,
    credentialKind: host.credential?.kind ?? null,
    // Sorted by path so the editor lists them the same way twice running;
    // the table has no order of its own.
    roots: [...host.roots]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((root) => ({
        path: root.path,
        access: root.access as "READ" | "WRITE",
      })),
    fingerprints: host.knownKeys.map((key) => ({
      algorithm: key.algorithm,
      fingerprint: key.fingerprint,
      verified: key.verifiedAt !== null,
    })),
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
  };
}
