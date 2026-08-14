import "reflect-metadata";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Global, type INestApplication, Module, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { hashSync } from "bcryptjs";
import session from "express-session";
import request from "supertest";
import { AuditModule } from "@audit/audit.module";
import { BookmarksModule } from "@bookmarks/bookmarks.module";
import { FsModule } from "@fs/fs.module";
import { HostsModule } from "@hosts/hosts.module";
import { RedisService } from "@redis/redis.service";
import { SecretStoreModule } from "@secrets/secret-store.module";
import { TransfersModule } from "@transfers/transfers.module";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "@users/session.constants";
import { UsersModule } from "@users/users.module";
import { PrismaService } from "./prisma/prisma.service";

/**
 * The guards, over HTTP (TRE-56).
 *
 * Everything the app knew about route protection before this file was decorator
 * metadata: `permissions.spec.ts` and `audit-coverage.spec.ts` read
 * `__guards__` off the controller and check the right class is listed. That
 * proves a decorator is *present*. It cannot prove a request is *refused*, and
 * a guard that is wired and broken passes both of them.
 *
 * So this boots the real Nest app — real controllers, real guards, the real
 * global audit interceptor, the real session middleware — over doubles for the
 * two things that need a server, and asks it questions with a socket.
 *
 * Two of the sweeps below are written as exact set comparisons rather than as
 * a list of routes to check. `expect(open).toEqual(PUBLIC)` fails both ways: a
 * guard that stops working shows up, and so does a *new* route that quietly
 * arrives without one. A list of paths to assert on would only ever have caught
 * the first, and the second is the one nobody notices.
 */

// ---------------------------------------------------------------------------
// The doubles
// ---------------------------------------------------------------------------

/**
 * A query shape the double does not implement must fail the test, never return
 * undefined. A permissive fake answers "no rows" to a question it did not
 * understand, and an isolation test whose whole claim is "the other account
 * sees nothing" then passes for the wrong reason.
 */
function unsupported(call: string, args: unknown): never {
  throw new Error(
    `FakePrisma.${call} got a shape it does not implement: ${JSON.stringify(args)}. ` +
      "Teach the double, or the test that reached it is passing for the wrong reason.",
  );
}

interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  recoveryPassphraseHash: string | null;
  role: "OWNER" | "MEMBER";
  ownerSlot: true | null;
  lastLayout: unknown;
  createdAt: Date;
  updatedAt: Date;
}

interface HostRow {
  id: string;
  userId: string;
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
  knownKeys: Array<{ algorithm: string; fingerprint: string; verifiedAt: Date | null }>;
  roots: Array<{ path: string; access: string }>;
}

interface BookmarkRow {
  id: string;
  hostId: string;
  path: string;
  label: string;
  hint: string | null;
  position: number;
}

interface ActivityRow {
  id: string;
  userId: string;
  sessionId: string | null;
  hostId: string | null;
  kind: string;
  summary: string;
  tag: string | null;
  outcome: string;
  detail: string | null;
  elevated: boolean;
  destructive: boolean;
  bytes: bigint | null;
  durationMs: number | null;
  payload: unknown;
  createdAt: Date;
}

class FakePrisma {
  userRows: UserRow[] = [];
  hostRows: HostRow[] = [];
  bookmarkRows: BookmarkRow[] = [];
  activityRows: ActivityRow[] = [];
  private sequence = 0;

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  readonly users = {
    findUnique: ({ where, select }: { where: { id?: string; email?: string }; select?: { lastLayout?: true } }) => {
      const row = this.findUser(where, "users.findUnique");
      if (!row) return Promise.resolve(null);
      return Promise.resolve(select?.lastLayout ? { lastLayout: row.lastLayout } : row);
    },

    findUniqueOrThrow: ({ where }: { where: { id?: string; email?: string } }) => {
      const row = this.findUser(where, "users.findUniqueOrThrow");
      if (!row) return Promise.reject(new Error("No Users found"));
      return Promise.resolve(row);
    },

    count: ({ where }: { where: { ownerSlot?: true } }) => {
      if (where?.ownerSlot !== true) return unsupported("users.count", where);
      return Promise.resolve(this.userRows.filter((row) => row.ownerSlot === true).length);
    },

    create: ({ data }: { data: Partial<UserRow> & { email: string; passwordHash: string } }) => {
      const row: UserRow = {
        id: this.nextId("user"),
        email: data.email,
        passwordHash: data.passwordHash,
        recoveryPassphraseHash: data.recoveryPassphraseHash ?? null,
        role: data.role ?? "MEMBER",
        ownerSlot: data.ownerSlot ?? null,
        lastLayout: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.userRows.push(row);
      return Promise.resolve(row);
    },

    update: ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
      const row = this.userRows.find((candidate) => candidate.id === where.id);
      if (!row) return Promise.reject(new Error("No Users found"));
      Object.assign(row, data, { updatedAt: new Date() });
      return Promise.resolve(row);
    },
  };

  readonly hosts = {
    findMany: ({ where }: { where: { userId: string } }) => {
      if (typeof where?.userId !== "string") return unsupported("hosts.findMany", where);
      return Promise.resolve(this.hostRows.filter((row) => row.userId === where.userId));
    },

    findFirst: ({
      where,
      include,
    }: {
      where: { id?: string; userId?: string };
      include?: { roots?: boolean; user?: unknown };
    }) => {
      if (typeof where?.userId !== "string") return unsupported("hosts.findFirst", where);
      const row = this.hostRows.find(
        (candidate) => candidate.userId === where.userId && (where.id === undefined || candidate.id === where.id),
      );
      if (!row) return Promise.resolve(null);

      // `PathGuardService` reads the owning account's role off the same query
      // it makes for the roots (TRE-48), so anything that reaches the guard's
      // own lookup needs it answered. Attached only when it was asked for:
      // `HostsService` uses this method too, and a `user` key nobody requested
      // would ride out in a host response.
      if (!include?.user) return Promise.resolve(row);
      const owner = this.userRows.find((candidate) => candidate.id === row.userId);
      return Promise.resolve({ ...row, user: { role: owner?.role ?? "MEMBER" } });
    },
  };

  readonly bookmarks = {
    findMany: ({ where }: { where: { host?: { userId?: string }; hostId?: string } }) => {
      if (typeof where?.host?.userId === "string") {
        const owned = new Set(this.hostsOwnedBy(where.host.userId));
        return Promise.resolve(this.bookmarkRows.filter((row) => owned.has(row.hostId)));
      }
      if (typeof where?.hostId === "string") {
        return Promise.resolve(this.bookmarkRows.filter((row) => row.hostId === where.hostId));
      }
      return unsupported("bookmarks.findMany", where);
    },

    findFirst: ({ where }: { where: { id?: string; host?: { userId?: string } } }) => {
      if (typeof where?.id !== "string") return unsupported("bookmarks.findFirst", where);
      // An unscoped lookup is modelled rather than refused, and faithfully: it
      // is what Prisma does when the ownership join is dropped. Refusing it
      // would mean the isolation tests below caught that mistake as a crash in
      // the double instead of as the access it actually is.
      const row = this.bookmarkRows.find((candidate) => {
        if (candidate.id !== where.id) return false;
        if (typeof where.host?.userId !== "string") return true;
        return this.hostsOwnedBy(where.host.userId).includes(candidate.hostId);
      });
      return Promise.resolve(row ?? null);
    },

    delete: ({ where }: { where: { id: string } }) => {
      const index = this.bookmarkRows.findIndex((row) => row.id === where.id);
      if (index === -1) return Promise.reject(new Error("No Bookmarks found"));
      const [row] = this.bookmarkRows.splice(index, 1);
      return Promise.resolve(row);
    },
  };

  /**
   * Only the one query the transfer queue makes at boot (TRE-23).
   *
   * `TransferQueueService.onApplicationBootstrap` looks for jobs a restart
   * interrupted, and `app.init()` below runs it. Nothing in these sweeps
   * reaches a transfer handler — the guards refuse first, which is the whole
   * claim — so this is the only shape that is implemented, and any other one
   * fails loudly rather than answering "no rows" to a question it did not
   * understand.
   */
  readonly transferJobs = {
    findMany: ({ where }: { where?: { status?: { in?: string[] } } }) => {
      if (!Array.isArray(where?.status?.in)) return unsupported("transferJobs.findMany", where);
      return Promise.resolve([]);
    },
  };

  readonly activityLog = {
    create: ({ data, select }: { data: Record<string, unknown>; select?: { id?: true } }) => {
      const row: ActivityRow = {
        id: this.nextId("activity"),
        userId: data.userId as string,
        sessionId: (data.sessionId as string | null) ?? null,
        hostId: (data.hostId as string | null) ?? null,
        kind: data.kind as string,
        summary: data.summary as string,
        tag: (data.tag as string | null) ?? null,
        outcome: data.outcome as string,
        detail: (data.detail as string | null) ?? null,
        elevated: Boolean(data.elevated),
        destructive: Boolean(data.destructive),
        bytes: null,
        durationMs: (data.durationMs as number | null) ?? null,
        payload: data.payload ?? null,
        createdAt: new Date(),
      };
      this.activityRows.push(row);
      return Promise.resolve(select?.id ? { id: row.id } : row);
    },

    update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.activityRows.find((candidate) => candidate.id === where.id);
      if (!row) return Promise.reject(new Error("No ActivityLog found"));
      Object.assign(row, data);
      return Promise.resolve(row);
    },

    findMany: ({ where, take }: { where: { userId: string }; take?: number }) => {
      if (typeof where?.userId !== "string") return unsupported("activityLog.findMany", where);
      const rows = this.activityRows
        .filter((row) => row.userId === where.userId)
        .sort((left, right) => right.id.localeCompare(left.id));
      return Promise.resolve(take === undefined ? rows : rows.slice(0, take));
    },
  };

  private findUser(where: { id?: string; email?: string }, call: string): UserRow | undefined {
    if (typeof where?.id === "string") return this.userRows.find((row) => row.id === where.id);
    if (typeof where?.email === "string") return this.userRows.find((row) => row.email === where.email);
    return unsupported(call, where);
  }

  private hostsOwnedBy(userId: string): string[] {
    return this.hostRows.filter((row) => row.userId === userId).map((row) => row.id);
  }

  reset(): void {
    this.userRows = [];
    this.hostRows = [];
    this.bookmarkRows = [];
    this.activityRows = [];
    this.sequence = 0;
  }
}

/**
 * Redis, as far as this app uses it: the session store and two counters.
 *
 * `clearSessionsForUser` walks the same store express-session writes to and
 * deletes the entries belonging to one account, which is what the real one does
 * over a SCAN. That makes "signing in again kills the old session" an assertion
 * about the *controller* — that it clears before adopting — rather than about
 * Redis, and the old cookie really does stop working.
 */
class FakeRedis {
  readonly cleared: string[] = [];
  private readonly counters = new Map<string, number>();

  constructor(private readonly store: session.MemoryStore) {}

  clearSessionsForUser(userId: string): Promise<void> {
    this.cleared.push(userId);
    return new Promise((resolve) => {
      this.store.all((error, sessions) => {
        if (error || !sessions) return resolve();
        const entries = Object.entries(sessions as Record<string, { userId?: string }>);
        const doomed = entries.filter(([, value]) => value?.userId === userId).map(([sid]) => sid);
        let left = doomed.length;
        if (left === 0) return resolve();
        for (const sid of doomed) {
          this.store.destroy(sid, () => {
            left -= 1;
            if (left === 0) resolve();
          });
        }
      });
    });
  }

  countAttempt(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }

  resetAttempts(key: string): Promise<void> {
    this.counters.delete(key);
    return Promise.resolve();
  }

  getClient(): never {
    throw new Error("FakeRedis: nothing in these tests should reach the raw client.");
  }

  reset(): void {
    this.cleared.length = 0;
    this.counters.clear();
  }
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

const PASSWORD = "a-long-enough-password";
const NEW_PASSWORD = "an-even-longer-password";
const PASSPHRASE = "recover me please";
// Hashed once: bcrypt at the app's cost factor is ~80ms, and every sign-in in
// this file pays for one compare already.
const PASSWORD_HASH = hashSync(PASSWORD, 10);
const PASSPHRASE_HASH = hashSync(PASSPHRASE, 10);

const ALICE = "alice@example.test";
const BOB = "bob@example.test";

const sessionStore = new session.MemoryStore();
const prisma = new FakePrisma();
const redis = new FakeRedis(sessionStore);

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: RedisService, useValue: redis },
  ],
  exports: [PrismaService, RedisService],
})
class FakeInfrastructureModule {}

let app: INestApplication;
let server: unknown;

beforeAll(async () => {
  // SecretStoreService reads this in onModuleInit, and HostsModule pulls it in.
  process.env.TREKKER_MASTER_KEY ??= `1:${Buffer.alloc(32, 7).toString("base64")}`;
  delete process.env.TREKKER_MASTER_KEY_PREVIOUS;
  // LinkKeyService reads this in its own onModuleInit (TRE-66). A different
  // fill byte than the master key above, deliberately: these two must never be
  // the same value, and a test that set them equal would be describing the
  // arrangement this ticket exists to prevent.
  process.env.TREKKER_DOWNLOAD_LINK_KEY ??= `1:${Buffer.alloc(32, 9).toString("base64")}`;

  const moduleRef = await Test.createTestingModule({
    // AppModule itself is deliberately not imported: it calls loadEnv(), which
    // requires the gitignored ecosystem.config.js to exist, and it boots
    // ConfigModule, PrismaModule, RedisModule and the health check — none of
    // which any guard consults. What is imported is every module that owns a
    // route, plus the global audit interceptor that wraps them.
    imports: [
      FakeInfrastructureModule,
      AuditModule,
      SecretStoreModule,
      HostsModule,
      BookmarksModule,
      FsModule,
      TransfersModule,
      UsersModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();

  // The same middleware main.ts installs, in the same order. The store is
  // in-memory rather than Redis-backed; everything above it is production's.
  app.use(
    session({
      name: SESSION_COOKIE_NAME,
      store: sessionStore,
      secret: "test-session-secret-that-is-long-enough",
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, secure: false, sameSite: "lax", maxAge: SESSION_TTL_SECONDS * 1000 },
    }),
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.setGlobalPrefix("api");

  await app.init();
  server = app.getHttpServer();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  prisma.reset();
  redis.reset();
  process.env.SIGNUPS_ENABLED = "false";

  prisma.userRows.push(
    {
      id: "user-alice",
      email: ALICE,
      passwordHash: PASSWORD_HASH,
      recoveryPassphraseHash: PASSPHRASE_HASH,
      role: "OWNER",
      ownerSlot: true,
      lastLayout: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "user-bob",
      email: BOB,
      passwordHash: PASSWORD_HASH,
      recoveryPassphraseHash: null,
      role: "MEMBER",
      ownerSlot: null,
      lastLayout: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  );

  prisma.hostRows.push({
    id: "host-alice",
    userId: "user-alice",
    slug: "alices-box",
    label: "Alice's box",
    transport: "LOCAL",
    address: null,
    port: 22,
    username: null,
    colour: "#876730",
    homePath: "/home/example-user",
    createdAt: new Date(),
    updatedAt: new Date(),
    credential: null,
    knownKeys: [],
    roots: [{ path: "/home/example-user", access: "WRITE" }],
  });

  prisma.bookmarkRows.push({
    id: "bookmark-alice",
    hostId: "host-alice",
    path: "/home/example-user/notes",
    label: "Notes",
    hint: null,
    position: 0,
  });

  prisma.activityRows.push({
    id: "activity-alice",
    userId: "user-alice",
    sessionId: null,
    hostId: "host-alice",
    kind: "bookmark.create",
    summary: "Bookmarked /home/example-user/notes",
    tag: null,
    outcome: "success",
    detail: null,
    elevated: false,
    destructive: false,
    bytes: null,
    durationMs: 4,
    payload: null,
    createdAt: new Date(),
  });
});

// ---------------------------------------------------------------------------
// Talking to it
// ---------------------------------------------------------------------------

interface Route {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
}

const DRIVEABLE = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * Every route Express will actually dispatch, read off the router it built.
 *
 * Off the router rather than off a hand-written list, because the point of the
 * sweeps below is to cover routes nobody remembered to add here — a new
 * endpoint is in this table the moment it exists.
 */
function routeTable(): Route[] {
  const instance = app.getHttpAdapter().getInstance() as {
    router?: { stack?: unknown[] };
    _router?: { stack?: unknown[] };
  };
  const stack = instance.router?.stack ?? instance._router?.stack ?? [];

  const routes: Route[] = [];
  for (const layer of stack as Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>) {
    const path = layer.route?.path;
    if (typeof path !== "string") continue;
    for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
      if (enabled && DRIVEABLE.has(method)) routes.push({ method: method as Route["method"], path });
    }
  }
  return routes;
}

/** `/api/hosts/:id` is not a URL. Params get a value no fixture uses. */
function concrete(path: string): string {
  return path.replace(/:[^/]+/g, "probe-id");
}

function label(route: Route): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

function fire(route: Route, options: { cookie?: string; csrfToken?: string } = {}) {
  let call = request(server as never)[route.method](concrete(route.path));
  if (options.cookie) call = call.set("Cookie", options.cookie);
  if (options.csrfToken) call = call.set("x-csrf-token", options.csrfToken);
  // Every mutating route here takes a JSON body; an empty one is enough to get
  // past body parsing and reach the guard, which is all these sweeps ask about.
  return route.method === "get" ? call : call.send({});
}

/**
 * Supertest types a response body as `any`, which spreads through every
 * assertion that touches one. Narrowed here, once, so the rest of the file
 * reads under the same rules as the app.
 */
function body(response: { body: unknown }): Record<string, unknown> {
  return (response.body ?? {}) as Record<string, unknown>;
}

/**
 * Supertest types `headers` as a flat string map, so the one header that is
 * genuinely a list needs saying so — in one place rather than at each use.
 */
function setCookies(response: { headers: Record<string, unknown> }): string[] {
  return (response.headers["set-cookie"] as string[] | undefined) ?? [];
}

function sessionCookieIn(response: { headers: Record<string, unknown> }): string | undefined {
  return setCookies(response).find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const cookie = sessionCookieIn(response);
  if (!cookie) throw new Error("No session cookie was set — the sign-in under test did not establish a session.");
  return cookie.split(";")[0];
}

async function signIn(email: string): Promise<{ cookie: string; csrfToken: string }> {
  const response = await request(server as never)
    .post("/api/users")
    .send({ email, password: PASSWORD })
    .expect(200);
  return { cookie: cookieOf(response), csrfToken: body(response).csrfToken as string };
}

/**
 * The routes that answer an anonymous caller with something other than 401, and
 * the reason each one is allowed to.
 */
const PUBLIC_ROUTES = [
  "GET /api/users/signup-status", // the registration screen has to know which form to render
  "POST /api/users", // signing in is how a session begins
  "POST /api/users/add", // registration, gated by SignupGuard instead
  "POST /api/users/logout", // ending a session you do not have is a no-op, not an error
  "POST /api/users/recover", // whoever needs this cannot sign in by definition
  // TRE-66. The only route here that serves a file to a stranger, and the only
  // one whose openness is the feature rather than a consequence of there being
  // no session yet. What stands in for the guard is the token: an HMAC over the
  // host, the path, the expiry and the issuing account, checked before anything
  // else happens, rate limited by IP, and granting read of exactly one file for
  // fifteen minutes. Adding a second route to this controller without that
  // check would be the mistake this line exists to make visible.
  "GET /api/link/:token",
];

/** Mutating routes that do not demand a CSRF token, and why. */
const CSRF_EXEMPT_ROUTES = [
  "POST /api/users", // no session yet, so there is no cookie for a third party to ride
  "POST /api/users/add", // same
  "POST /api/users/recover", // same
];

// ---------------------------------------------------------------------------

describe("the route table", () => {
  it("is read from the router Express actually built", () => {
    const routes = routeTable();
    // A sweep that finds no routes passes every assertion below it while
    // testing nothing, and that is the failure most worth catching here.
    expect(routes.length).toBeGreaterThan(15);
    expect(routes.map(label)).toContain("GET /api/users/me");
    expect(routes.map(label)).toContain("POST /api/fs/chmod");
    expect(routes.map(label)).toContain("DELETE /api/hosts/:id");
  });
});

describe("without a session", () => {
  it("refuses every route except the ones public by design", async () => {
    const open: string[] = [];

    for (const route of routeTable()) {
      const response = await fire(route);
      if (response.status !== 401) open.push(label(route));
    }

    // An exact comparison, both directions. A guard that stops working shows up
    // here, and so does a new route that arrives without one.
    expect(open.sort()).toEqual([...PUBLIC_ROUTES].sort());
  });

  it("refuses reads as firmly as writes", async () => {
    // Worth stating separately: the tempting shape is to guard the writes and
    // leave listing "harmless", and a directory listing of someone's fleet is
    // not harmless.
    for (const path of ["/api/hosts", "/api/bookmarks", "/api/activity", "/api/fs/list", "/api/users/me"]) {
      await request(server as never)
        .get(path)
        .expect(401);
    }
  });

  it("says only that a session is required", async () => {
    const response = await request(server as never)
      .get("/api/users/me")
      .expect(401);
    expect(body(response).message).toBe("Session required");
  });

  it("treats a forged session cookie as no session at all", async () => {
    // Not signed by the session secret, so express-session discards it.
    await request(server as never)
      .get("/api/users/me")
      .set("Cookie", `${SESSION_COOKIE_NAME}=s%3Amade-up-session-id.made-up-signature`)
      .expect(401);
  });

  it("does not accept a user id supplied by the caller", async () => {
    // The guard reads the session and nothing else. A header or a body field
    // that could name a user would be an authentication bypass in one line.
    await request(server as never)
      .get("/api/users/me")
      .set("x-user-id", "user-alice")
      .expect(401);
    await request(server as never)
      .get("/api/users/me")
      .query({ userId: "user-alice" })
      .expect(401);
  });
});

describe("with a session but no CSRF token", () => {
  it("refuses every mutating route except the ones exempt by design", async () => {
    // Registration open for this sweep only. SignupGuard also answers 403, and
    // a 403 from it would read here as a CSRF refusal that never happened —
    // the route would look protected while carrying no CSRF guard at all.
    process.env.SIGNUPS_ENABLED = "true";

    const { cookie } = await signIn(ALICE);
    const allowed: string[] = [];

    for (const route of routeTable()) {
      if (route.method === "get") continue;
      const response = await fire(route, { cookie });
      if (response.status !== 403) allowed.push(label(route));
    }

    expect(allowed.sort()).toEqual([...CSRF_EXEMPT_ROUTES].sort());
  });

  it("leaves reads alone, which is what makes a cold load work", async () => {
    const { cookie } = await signIn(ALICE);
    // A GET that demanded the token would break every first paint, since the
    // token is fetched with one.
    await request(server as never)
      .get("/api/users/me")
      .set("Cookie", cookie)
      .expect(200);
    await request(server as never)
      .get("/api/bookmarks")
      .set("Cookie", cookie)
      .expect(200);
  });

  it("names what was wrong without naming the token", async () => {
    const { cookie } = await signIn(ALICE);
    const response = await request(server as never)
      .delete("/api/bookmarks/bookmark-alice")
      .set("Cookie", cookie)
      .expect(403);
    expect(body(response).message).toBe("Invalid CSRF token");
  });
});

describe("with a session and a CSRF token", () => {
  it("lets the right token through", async () => {
    const { cookie, csrfToken } = await signIn(ALICE);
    // 200, and specifically not 403: the bookmark is Alice's and the guard let
    // the request reach the handler.
    await request(server as never)
      .delete("/api/bookmarks/bookmark-alice")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .expect(200);
  });

  it("accepts the x-xsrf-token spelling too", async () => {
    const { cookie, csrfToken } = await signIn(ALICE);
    await request(server as never)
      .delete("/api/bookmarks/bookmark-alice")
      .set("Cookie", cookie)
      .set("x-xsrf-token", csrfToken)
      .expect(200);
  });

  it("refuses a token belonging to another session", async () => {
    // The attack the token exists for, in its most direct form: a real,
    // currently-valid token that was not minted for this session.
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);

    await request(server as never)
      .delete("/api/bookmarks/bookmark-alice")
      .set("Cookie", alice.cookie)
      .set("x-csrf-token", bob.csrfToken)
      .expect(403);
  });

  it("refuses a token of the right shape but the wrong value", async () => {
    const { cookie, csrfToken } = await signIn(ALICE);
    const forged = csrfToken.slice(0, -1) + (csrfToken.endsWith("0") ? "1" : "0");

    expect(forged).toHaveLength(csrfToken.length);
    await request(server as never)
      .delete("/api/bookmarks/bookmark-alice")
      .set("Cookie", cookie)
      .set("x-csrf-token", forged)
      .expect(403);
  });

  it("refuses an empty token", async () => {
    const { cookie } = await signIn(ALICE);
    await request(server as never)
      .delete("/api/bookmarks/bookmark-alice")
      .set("Cookie", cookie)
      .set("x-csrf-token", "")
      .expect(403);
  });
});

/**
 * TRE-69, over a socket rather than through the service.
 *
 * `create.spec.ts` drives `CreateService` directly and proves what lands on
 * disk. What it cannot reach is the layer these two routes actually meet: the
 * validation pipe that has to refuse a name before the guard is asked, the
 * status a create answers with, and the audit row the interceptor writes on the
 * way in. Those are properties of the *route*, and TRE-56's point is that a
 * property of a route is checked by asking the route.
 *
 * Bob, not Alice: Alice is the install's owner and browses without the roots
 * binding her (TRE-48), so a create of hers would prove nothing about them.
 */
describe("creating an entry", () => {
  let directory: string;

  beforeEach(async () => {
    // Resolved, because the guard compares resolved paths and macOS hands out
    // a `/var` temp directory that is really `/private/var`.
    directory = await realpath(await mkdtemp(join(tmpdir(), "trekker-http-")));
    prisma.hostRows.push({
      id: "host-bob",
      userId: "user-bob",
      slug: "bobs-box",
      label: "Bob's box",
      transport: "LOCAL",
      address: null,
      port: 22,
      username: null,
      colour: "#876730",
      homePath: directory,
      createdAt: new Date(),
      updatedAt: new Date(),
      credential: null,
      knownKeys: [],
      roots: [{ path: directory, access: "WRITE" }],
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** One create, as Bob, with a fresh session and its token. */
  async function post(path: string, name: string, at = directory) {
    const { cookie, csrfToken } = await signIn(BOB);
    return request(server as never)
      .post(path)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ hostId: "host-bob", path: at, name });
  }

  it("answers 201 with the entry it made", async () => {
    const response = await post("/api/fs/mkdir", "reports");

    expect(response.status).toBe(201);
    expect(body(response).name).toBe("reports");
    expect(body(response).type).toBe("dir");
    expect((await stat(join(directory, "reports"))).isDirectory()).toBe(true);
  });

  it("answers 409 on a name that is taken", async () => {
    expect((await post("/api/fs/mkdir", "reports")).status).toBe(201);
    expect((await post("/api/fs/mkdir", "reports")).status).toBe(409);
  });

  it("refuses a name that is trying to be a path, before the guard is asked", async () => {
    // 400 from the pipe, not 403 from the guard: the distinction is the point.
    // A name is not a path, and the layer that says so is the DTO.
    for (const name of ["../escape", "a/b", "..", ".", "", " x", "x "]) {
      expect((await post("/api/fs/mkdir", name)).status).toBe(400);
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses a directory outside the roots", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "trekker-outside-")));
    try {
      expect((await post("/api/fs/mkdir", "x", outside)).status).toBe(403);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("cannot empty a file that is already there", async () => {
    // The ticket, at the outermost layer it can be asked at.
    await writeFile(join(directory, "config.yml"), "port: 6800\n");

    expect((await post("/api/fs/create", "config.yml")).status).toBe(409);
    expect(await readFile(join(directory, "config.yml"), "utf8")).toBe("port: 6800\n");
  });

  it("writes a row saying what was made", async () => {
    expect((await post("/api/fs/mkdir", "reports")).status).toBe(201);

    const row = prisma.activityRows.find((activity) => activity.kind === "file.mkdir");
    expect(row?.summary).toContain("reports");
    expect(row?.outcome).toBe("success");
  });

  it("writes a row even when the name was already taken", async () => {
    // The interceptor writes before the handler, which is what makes a refused
    // attempt leave a trace. A log that only records what succeeded answers the
    // wrong question.
    expect((await post("/api/fs/mkdir", "reports")).status).toBe(201);
    expect((await post("/api/fs/mkdir", "reports")).status).toBe(409);

    const rows = prisma.activityRows.filter((activity) => activity.kind === "file.mkdir");
    expect(rows).toHaveLength(2);
    // `refused`, not `failure`: a taken name is an answer the interceptor
    // classifies with every other 4xx, and nothing on this route went wrong.
    expect(rows.map((activity) => activity.outcome).sort()).toEqual(["refused", "success"]);
  });
});

describe("the token itself", () => {
  it("is handed out on sign-in and read back identically", async () => {
    const { cookie, csrfToken } = await signIn(ALICE);
    expect(csrfToken).toMatch(/^[0-9a-f]{64}$/);

    const fetched = await request(server as never)
      .get("/api/users/csrf")
      .set("Cookie", cookie)
      .expect(200);
    expect(body(fetched).csrfToken).toBe(csrfToken);
    const me = await request(server as never)
      .get("/api/users/me")
      .set("Cookie", cookie)
      .expect(200);
    expect(body(me).csrfToken).toBe(csrfToken);
  });

  it("is different for every session", async () => {
    const first = await signIn(ALICE);
    const second = await signIn(BOB);
    expect(first.csrfToken).not.toBe(second.csrfToken);
  });

  it("is rotated by signing in, so one captured beforehand is dead after", async () => {
    const agent = request.agent(server as never);
    // A token read while anonymous — the shape of a session-fixation attempt,
    // where the token is planted before the victim authenticates.
    await agent.get("/api/users/csrf").expect(401);

    const first = await signIn(ALICE);
    const second = await request(server as never)
      .post("/api/users")
      .set("Cookie", first.cookie)
      .send({ email: ALICE, password: PASSWORD })
      .expect(200);

    expect(body(second).csrfToken).not.toBe(first.csrfToken);
  });
});

describe("logout", () => {
  it("destroys the stored session, not just the cookie", async () => {
    const { cookie, csrfToken } = await signIn(ALICE);
    await request(server as never)
      .post("/api/users/logout")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .expect(200);

    // The same cookie, replayed. Clearing it browser-side would leave this
    // working for anyone who copied it first.
    await request(server as never)
      .get("/api/users/me")
      .set("Cookie", cookie)
      .expect(401);
  });

  it("clears the cookie as well, so the browser stops sending it", async () => {
    const { cookie, csrfToken } = await signIn(ALICE);
    const response = await request(server as never)
      .post("/api/users/logout")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .expect(200);

    const cleared = sessionCookieIn(response);
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/^trekker\.sid=;/);
  });

  it("needs the token, or a cross-site form could sign people out", async () => {
    const { cookie } = await signIn(ALICE);
    await request(server as never)
      .post("/api/users/logout")
      .set("Cookie", cookie)
      .expect(403);
    await request(server as never)
      .get("/api/users/me")
      .set("Cookie", cookie)
      .expect(200);
  });
});

describe("one live session per account", () => {
  it("drops the previous session when the same account signs in again", async () => {
    const first = await signIn(ALICE);
    await request(server as never)
      .get("/api/users/me")
      .set("Cookie", first.cookie)
      .expect(200);

    const second = await signIn(ALICE);

    // A stolen cookie stops working the moment the owner signs in again.
    await request(server as never)
      .get("/api/users/me")
      .set("Cookie", first.cookie)
      .expect(401);
    await request(server as never)
      .get("/api/users/me")
      .set("Cookie", second.cookie)
      .expect(200);
  });

  it("clears before adopting, never after", async () => {
    // Order is the whole trick: clearing after would delete the session just
    // established and sign the user straight back out.
    await signIn(ALICE);
    expect(redis.cleared).toEqual(["user-alice"]);
  });

  it("leaves other accounts alone", async () => {
    const bob = await signIn(BOB);
    await signIn(ALICE);
    await request(server as never)
      .get("/api/users/me")
      .set("Cookie", bob.cookie)
      .expect(200);
  });
});

describe("sign-in", () => {
  it("refuses a wrong password without saying which half was wrong", async () => {
    const wrongPassword = await request(server as never)
      .post("/api/users")
      .send({ email: ALICE, password: "not-the-password" })
      .expect(401);
    const noSuchAccount = await request(server as never)
      .post("/api/users")
      .send({ email: "nobody@example.test", password: PASSWORD })
      .expect(401);

    expect(body(wrongPassword).message).toBe("Invalid email or password");
    expect(body(noSuchAccount).message).toBe(body(wrongPassword).message);
  });

  it("establishes no session when it refuses", async () => {
    const response = await request(server as never)
      .post("/api/users")
      .send({ email: ALICE, password: "not-the-password" })
      .expect(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("never returns the password hash", async () => {
    const response = await request(server as never)
      .post("/api/users")
      .send({ email: ALICE, password: PASSWORD })
      .expect(200);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain(PASSWORD_HASH);
    expect(serialised).not.toContain("passwordHash");
    expect(serialised).not.toContain("recoveryPassphraseHash");
    expect(body(response).user).toEqual({
      id: "user-alice",
      email: ALICE,
      hasRecoveryPassphrase: true,
      role: "OWNER",
    });
  });

  it("survives a session that outlived its account", async () => {
    const { cookie } = await signIn(ALICE);
    prisma.userRows = prisma.userRows.filter((row) => row.id !== "user-alice");
    await request(server as never)
      .get("/api/users/me")
      .set("Cookie", cookie)
      .expect(401);
  });
});

describe("registration", () => {
  it("is closed unless the flag says exactly true", async () => {
    for (const flag of ["false", "TRUE", "yes", "1", ""]) {
      process.env.SIGNUPS_ENABLED = flag;
      await request(server as never)
        .post("/api/users/add")
        .send({ email: "new@example.test", password: PASSWORD })
        .expect(403);
    }
  });

  it("is closed when the flag is missing entirely", async () => {
    // The failure this defaults against: a deploy that forgets the variable and
    // silently opens registration on a public host.
    delete process.env.SIGNUPS_ENABLED;
    await request(server as never)
      .post("/api/users/add")
      .send({ email: "new@example.test", password: PASSWORD })
      .expect(403);
  });

  it("opens when it is set", async () => {
    process.env.SIGNUPS_ENABLED = "true";
    const response = await request(server as never)
      .post("/api/users/add")
      .send({ email: "new@example.test", password: PASSWORD })
      .expect(201);
    // A member, not an owner: the slot is already held by the fixture's first
    // account, and registration must not hand the install away to whoever
    // signs up second (TRE-48).
    expect(body(response).user).toMatchObject({ role: "MEMBER" });
  });

  it("never lets the screen and the guard disagree", async () => {
    // Two readings of one flag is how a screen ends up offering a form the
    // server will refuse.
    for (const flag of ["true", "false", "nonsense"]) {
      process.env.SIGNUPS_ENABLED = flag;
      const status = await request(server as never)
        .get("/api/users/signup-status")
        .expect(200);
      const attempt = await request(server as never)
        .post("/api/users/add")
        .send({ email: `probe-${flag}@example.test`, password: PASSWORD });

      expect(body(status).open).toBe(attempt.status !== 403);
    }
  });

  it("hands the recovery passphrase back exactly once", async () => {
    process.env.SIGNUPS_ENABLED = "true";
    const created = await request(server as never)
      .post("/api/users/add")
      .send({ email: "new@example.test", password: PASSWORD })
      .expect(201);

    expect(typeof body(created).recoveryPassphrase).toBe("string");
    const cookie = cookieOf(created);
    const me = await request(server as never)
      .get("/api/users/me")
      .set("Cookie", cookie)
      .expect(200);
    // There is no endpoint that reads it back — only the hash is kept.
    expect(JSON.stringify(body(me))).not.toContain(body(created).recoveryPassphrase);
  });
});

describe("recovery", () => {
  it("refuses without saying which of the three things was wrong", async () => {
    const wrongPassphrase = await request(server as never)
      .post("/api/users/recover")
      .send({ email: ALICE, passphrase: "not it", newPassword: NEW_PASSWORD })
      .expect(401);
    const noPassphraseSet = await request(server as never)
      .post("/api/users/recover")
      .send({ email: BOB, passphrase: PASSPHRASE, newPassword: NEW_PASSWORD })
      .expect(401);
    const noSuchAccount = await request(server as never)
      .post("/api/users/recover")
      .send({ email: "nobody@example.test", passphrase: PASSPHRASE, newPassword: NEW_PASSWORD })
      .expect(401);

    expect(body(wrongPassphrase).message).toBe("Invalid email or recovery passphrase");
    expect(body(noPassphraseSet).message).toBe(body(wrongPassphrase).message);
    expect(body(noSuchAccount).message).toBe(body(wrongPassphrase).message);
  });

  it("revokes every live session on success", async () => {
    const { cookie } = await signIn(ALICE);
    await request(server as never)
      .post("/api/users/recover")
      .send({ email: ALICE, passphrase: PASSPHRASE, newPassword: NEW_PASSWORD })
      .expect(200);

    // If the passphrase leaked, whoever used it must not keep a live session.
    await request(server as never)
      .get("/api/users/me")
      .set("Cookie", cookie)
      .expect(401);
  });
});

describe("one account cannot reach another's", () => {
  it("answers 404 for another account's host, never 403", async () => {
    const bob = await signIn(BOB);
    // 403 would confirm the id exists, which is the reconnaissance a 404 denies.
    await request(server as never)
      .get("/api/hosts/host-alice")
      .set("Cookie", bob.cookie)
      .expect(404);
  });

  it("shows the owner the same host, so the refusal is about the account", async () => {
    const alice = await signIn(ALICE);
    const response = await request(server as never)
      .get("/api/hosts/host-alice")
      .set("Cookie", alice.cookie)
      .expect(200);
    expect(body(response).label).toBe("Alice's box");
  });

  it("keeps the lists disjoint", async () => {
    const bob = await signIn(BOB);
    const hosts = await request(server as never)
      .get("/api/hosts")
      .set("Cookie", bob.cookie)
      .expect(200);
    const bookmarks = await request(server as never)
      .get("/api/bookmarks")
      .set("Cookie", bob.cookie)
      .expect(200);
    const activity = await request(server as never)
      .get("/api/activity")
      .set("Cookie", bob.cookie)
      .expect(200);

    expect(hosts.body).toEqual([]);
    expect(bookmarks.body).toEqual([]);
    expect(body(activity).items).toEqual([]);
  });

  it("shows the owner their own rows, so the lists are not empty for everyone", async () => {
    const alice = await signIn(ALICE);
    const hosts = await request(server as never)
      .get("/api/hosts")
      .set("Cookie", alice.cookie)
      .expect(200);
    const bookmarks = await request(server as never)
      .get("/api/bookmarks")
      .set("Cookie", alice.cookie)
      .expect(200);
    const activity = await request(server as never)
      .get("/api/activity")
      .set("Cookie", alice.cookie)
      .expect(200);

    expect(hosts.body).toHaveLength(1);
    expect(bookmarks.body).toHaveLength(1);
    expect(body(activity).items).toHaveLength(1);
  });

  it("refuses to delete another account's bookmark, with a token that is valid", async () => {
    const bob = await signIn(BOB);
    // Everything about this request is well-formed. Only the ownership is not.
    await request(server as never)
      .delete("/api/bookmarks/bookmark-alice")
      .set("Cookie", bob.cookie)
      .set("x-csrf-token", bob.csrfToken)
      .expect(404);

    expect(prisma.bookmarkRows.map((row) => row.id)).toContain("bookmark-alice");
  });
});
