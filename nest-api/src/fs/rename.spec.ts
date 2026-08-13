import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpException } from "@nestjs/common";
import { RateLimitService } from "@audit/rate-limit.service";
import { LocalDriver } from "@hosts/drivers/local.driver";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { MAX_NAME_BYTES, judge, planRename, type RenameInput } from "@fs/rename-plan";
import { RenameService } from "@fs/rename.service";

import type { AuditService } from "@audit/audit.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "@redis/redis.service";

/**
 * TRE-22, against the real LocalDriver on a real tree — the same trade
 * `permissions.spec.ts` makes and for the same reason. What is worth proving
 * here is that a swap cycle survives contact with a filesystem that refuses to
 * rename onto an existing name, and no mock refuses convincingly.
 *
 * The property test at the bottom is the one the ticket asks for by name: the
 * preview and the apply agree. It is written as "the plan the apply consumes is
 * the plan the preview returned", because that is the only version of the claim
 * that stays true when someone later adds a rule to one of them.
 */

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

function serviceFor(roots: { path: string; access: "READ" | "WRITE" }[], denylist: string[] = []): RenameService {
  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? { id: HOST_ID, userId: USER_ID, transport: "LOCAL", roots, user: { role: "MEMBER" } }
            : null,
        ),
    },
  } as unknown as PrismaService;

  const guard = new PathGuardService(prisma, denylist, memoryLimits(), silentAudit);
  const factory = { forHost: () => Promise.resolve(new LocalDriver(HOST_ID)) } as unknown as HostDriverFactory;
  return new RenameService(factory, guard);
}

const writeRoot = () => [{ path: base, access: "WRITE" as const }];

/** A directory of its own per test, so one test's leftovers are never another's collision. */
async function fixture(name: string, entries: readonly string[]): Promise<string> {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  for (const entry of entries) await writeFile(join(dir, entry), entry);
  return dir;
}

async function namesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

/**
 * Which file is which, after a rename that leaves the *set* of names unchanged.
 *
 * `fixture` writes each entry's original name as its content, so this maps
 * "what it is called now" to "what it was called before" — the only way to see
 * a swap, where the directory listing before and after are identical.
 */
async function contentsIn(dir: string): Promise<Record<string, string>> {
  const names = await namesIn(dir);
  const pairs = await Promise.all(names.map(async (name) => [name, await readFile(join(dir, name), "utf8")] as const));
  return Object.fromEntries(pairs);
}

function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 0;
}

function bodyOf(error: unknown): { code?: string; message?: string } {
  return error instanceof HttpException ? (error.getResponse() as { code?: string; message?: string }) : {};
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "trekker-rename-")));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the plan

describe("planRename", () => {
  const plan = (over: Partial<RenameInput>) =>
    planRename({
      names: [],
      existing: [],
      pattern: "",
      replacement: "",
      global: false,
      ignoreCase: false,
      ...over,
    });

  it("produces the mockup's own example, exactly", async () => {
    // 2a's rename modal is drawn with this pattern over these names. It is the
    // ticket's acceptance example and the reason the feature exists.
    const names = ["dump-2026-08-08.sql.gz", "dump-2026-08-07.sql.gz", "dump-2026-08-06.sql.gz"];
    const result = await plan({
      names,
      existing: names,
      pattern: "^dump-(\\d{4})-(\\d{2})-(\\d{2})",
      replacement: "atlas_$1$2$3",
    });

    expect(result.error).toBeNull();
    expect(result.mappings.map((mapping) => mapping.next)).toEqual([
      "atlas_20260808.sql.gz",
      "atlas_20260807.sql.gz",
      "atlas_20260806.sql.gz",
    ]);
    expect(result.changed).toBe(3);
    expect(result.mappings.every((mapping) => mapping.problem === null)).toBe(true);
  });

  it("marks the matched span for the highlight", async () => {
    const result = await plan({
      names: ["log-2026.txt"],
      existing: ["log-2026.txt"],
      pattern: "\\d{4}",
      replacement: "Y",
    });
    expect(result.mappings[0].match).toEqual({ index: 4, length: 4 });
  });

  it("does not carry lastIndex between names", async () => {
    // A single global regex reused across a batch reports the *previous* name's
    // offset for the next one, and the highlight lands on the wrong characters.
    const result = await plan({
      names: ["aaa", "aaa", "aaa"],
      existing: ["aaa"],
      pattern: "a",
      replacement: "b",
      global: true,
    });
    expect(result.mappings.map((mapping) => mapping.match)).toEqual([
      { index: 0, length: 1 },
      { index: 0, length: 1 },
      { index: 0, length: 1 },
    ]);
  });

  it("names both sides when two entries collide", async () => {
    const names = ["a-1.txt", "a-2.txt"];
    const result = await plan({ names, existing: names, pattern: "-\\d", replacement: "" });

    expect(result.mappings.map((mapping) => mapping.next)).toEqual(["a.txt", "a.txt"]);
    expect(result.mappings[0].problem?.code).toBe("duplicate");
    expect(result.mappings[0].problem?.collidesWith).toBe("a-2.txt");
    expect(result.mappings[1].problem?.collidesWith).toBe("a-1.txt");
  });

  it("refuses a target that already exists and is not being renamed", async () => {
    const result = await plan({
      names: ["draft.txt"],
      existing: ["draft.txt", "final.txt"],
      pattern: "draft",
      replacement: "final",
    });
    expect(result.mappings[0].problem?.code).toBe("exists");
  });

  it("blocks on a target the batch leaves standing, and not on one it moves away", async () => {
    // a→b where `b` is in the selection but the pattern does not touch it: `b`
    // is still there when the rename runs, so this must refuse.
    const standing = await plan({ names: ["a", "b"], existing: ["a", "b"], pattern: "^a$", replacement: "b" });
    expect(standing.mappings[0].problem?.code).toBe("exists");

    // The chain a→aa, aa→aaa. `aa` is occupied when the plan is made and free
    // by the time the rename that wants it runs, so treating the listing as the
    // whole truth would refuse a legal batch.
    const chain = await plan({ names: ["a", "aa"], existing: ["a", "aa"], pattern: "^(a+)$", replacement: "$1a" });
    expect(chain.mappings.map((mapping) => mapping.next)).toEqual(["aa", "aaa"]);
    expect(chain.mappings.every((mapping) => mapping.problem === null)).toBe(true);
  });

  it("refuses a replacement that leaves the directory or the name", async () => {
    const escape = await plan({ names: ["x"], existing: ["x"], pattern: "^x$", replacement: "../evil" });
    expect(escape.mappings[0].problem?.code).toBe("separator");

    const empty = await plan({ names: ["x"], existing: ["x"], pattern: "^x$", replacement: "" });
    expect(empty.mappings[0].problem?.code).toBe("empty");

    const dots = await plan({ names: ["x"], existing: ["x"], pattern: "^x$", replacement: ".." });
    expect(dots.mappings[0].problem?.code).toBe("relative");
  });

  it("refuses a name longer than a filename may be, counted in bytes", async () => {
    // 200 three-byte characters is 600 bytes and only 200 characters: a check
    // written against `.length` would let this through and the filesystem
    // would refuse it halfway into the batch.
    const long = await plan({ names: ["x"], existing: ["x"], pattern: "^x$", replacement: "☃".repeat(200) });
    expect(long.mappings[0].problem?.code).toBe("toolong");

    const atLimit = await plan({
      names: ["x"],
      existing: ["x"],
      pattern: "^x$",
      replacement: "a".repeat(MAX_NAME_BYTES),
    });
    expect(atLimit.mappings[0].problem).toBeNull();
  });

  it("returns the engine's message for a pattern that will not compile", async () => {
    const result = await plan({ names: ["x"], existing: ["x"], pattern: "([a-", replacement: "y" });
    expect(result.error).toMatch(/character class|group|Invalid/i);
    expect(result.changed).toBe(0);
  });

  it("gives up on a pattern that backtracks instead of hanging", async () => {
    // The classic: nested quantifiers over a string that cannot match. Node
    // cannot interrupt this, so the thread running it is killed — which is the
    // only real timeout available and the reason the worker exists at all.
    const started = Date.now();
    const result = await planRename(
      {
        names: [`${"a".repeat(40)}!`],
        existing: [],
        pattern: "^(a+)+$",
        replacement: "x",
        global: false,
        ignoreCase: false,
      },
      750,
    );

    expect(result.error).toMatch(/backtracking/);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);
});

// -------------------------------------------------------------- on a real tree

describe("RenameService.renameOne", () => {
  it("renames one entry", async () => {
    const dir = await fixture("single", ["notes.txt"]);
    const result = await serviceFor(writeRoot()).renameOne(USER_ID, HOST_ID, join(dir, "notes.txt"), "journal.txt");

    expect(result.renamed).toBe(1);
    expect(await namesIn(dir)).toEqual(["journal.txt"]);
  });

  it("refuses to overwrite an existing entry", async () => {
    // POSIX rename replaces the target without a word, so the check here is the
    // only thing between F2 and a file that silently stopped existing.
    const dir = await fixture("clobber", ["keep.txt", "other.txt"]);
    await expect(
      serviceFor(writeRoot()).renameOne(USER_ID, HOST_ID, join(dir, "other.txt"), "keep.txt"),
    ).rejects.toThrow(/already exists/);

    expect(await namesIn(dir)).toEqual(["keep.txt", "other.txt"]);
  });

  it("refuses a new name that is a path", async () => {
    const dir = await fixture("escape-one", ["x.txt"]);
    await expect(serviceFor(writeRoot()).renameOne(USER_ID, HOST_ID, join(dir, "x.txt"), "../x.txt")).rejects.toThrow(
      /one segment/,
    );
    expect(await namesIn(dir)).toEqual(["x.txt"]);
  });

  it("refuses a path outside the roots", async () => {
    const dir = await fixture("outside", ["x.txt"]);
    const readOnly = serviceFor([{ path: join(base, "elsewhere"), access: "WRITE" }]);
    await expect(readOnly.renameOne(USER_ID, HOST_ID, join(dir, "x.txt"), "y.txt")).rejects.toThrow();
    expect(await namesIn(dir)).toEqual(["x.txt"]);
  });

  it("refuses inside a READ root", async () => {
    const dir = await fixture("readonly", ["x.txt"]);
    const service = serviceFor([{ path: base, access: "READ" }]);
    await expect(service.renameOne(USER_ID, HOST_ID, join(dir, "x.txt"), "y.txt")).rejects.toThrow();
    expect(await namesIn(dir)).toEqual(["x.txt"]);
  });
});

describe("RenameService.batch", () => {
  const run = (dir: string, names: readonly string[], pattern: string, replacement: string, global = false) =>
    serviceFor(writeRoot()).batch(
      USER_ID,
      HOST_ID,
      names.map((name) => join(dir, name)),
      pattern,
      replacement,
      global,
      false,
    );

  it("applies the mockup's pattern to a real directory", async () => {
    const names = ["dump-2026-08-08.sql.gz", "dump-2026-08-07.sql.gz"];
    const dir = await fixture("mockup", names);

    const result = await run(dir, names, "^dump-(\\d{4})-(\\d{2})-(\\d{2})", "atlas_$1$2$3");

    expect(result.renamed).toBe(2);
    expect(await namesIn(dir)).toEqual(["atlas_20260807.sql.gz", "atlas_20260808.sql.gz"]);
  });

  it("survives a swap cycle", async () => {
    // ab→ba and ba→ab. Applied in the order given, the first rename destroys
    // the second file; refused on a plain "target exists" rule, the batch never
    // runs at all. Parking one of the two is the only way both survive.
    //
    // The listing is identical before and after, which is exactly why the
    // assertion is on the contents: each file holds the name it started under.
    const dir = await fixture("swap", ["ab", "ba"]);

    const result = await run(dir, ["ab", "ba"], "^(.)(.)$", "$2$1");

    expect(result.renamed).toBe(2);
    expect(await contentsIn(dir)).toEqual({ ab: "ba", ba: "ab" });
  });

  it("survives a three-way cycle and leaves no parking name behind", async () => {
    // abc→bca→cab→abc. Two parks would be a bug — one break is enough, and the
    // rest of the cycle unwinds behind it.
    const dir = await fixture("cycle3", ["abc", "bca", "cab"]);

    const result = await run(dir, ["abc", "bca", "cab"], "^(.)(.*)$", "$2$1");

    expect(result.renamed).toBe(3);
    expect(await namesIn(dir)).toEqual(["abc", "bca", "cab"]);
    expect(await contentsIn(dir)).toEqual({ bca: "abc", cab: "bca", abc: "cab" });
  });

  it("runs a chain in the order that makes it possible", async () => {
    // a→aa and aa→aaa. `aa` has to move before `a` can take its name, and
    // nothing in the input says so — the order is derived, not given.
    const dir = await fixture("chain", ["a", "aa"]);

    const result = await run(dir, ["a", "aa"], "^(a+)$", "$1a");

    expect(result.renamed).toBe(2);
    expect(await contentsIn(dir)).toEqual({ aa: "a", aaa: "aa" });
  });

  it("refuses the whole batch when two names collide, and touches nothing", async () => {
    const names = ["report-1.txt", "report-2.txt", "untouched.txt"];
    const dir = await fixture("collide", names);

    await expect(run(dir, names.slice(0, 2), "-\\d", "")).rejects.toThrow(/collide|Also the new name/);
    expect(await namesIn(dir)).toEqual([...names].sort());
  });

  it("refuses when a target already exists, and touches nothing", async () => {
    const dir = await fixture("taken", ["draft.txt", "final.txt"]);

    await expect(run(dir, ["draft.txt"], "draft", "final")).rejects.toThrow(/Already in this directory/);
    expect(await namesIn(dir)).toEqual(["draft.txt", "final.txt"]);
  });

  it("refuses a replacement that would leave the directory, and touches nothing", async () => {
    const dir = await fixture("escape-batch", ["x.txt"]);

    const error = await run(dir, ["x.txt"], "^x", "../evil").catch((thrown: unknown) => thrown);
    expect(statusOf(error)).toBe(422);
    expect(bodyOf(error).code).toBe("ECOLLISION");
    expect(await namesIn(dir)).toEqual(["x.txt"]);
  });

  it("answers 422 with the engine's message for an uncompilable pattern", async () => {
    const dir = await fixture("bad-pattern", ["x.txt"]);

    const error = await run(dir, ["x.txt"], "([a-", "y").catch((thrown: unknown) => thrown);
    expect(statusOf(error)).toBe(422);
    expect(bodyOf(error).code).toBe("EPATTERN");
    expect(await namesIn(dir)).toEqual(["x.txt"]);
  });

  it("refuses a selection that spans two directories", async () => {
    const left = await fixture("span-a", ["x.txt"]);
    const right = await fixture("span-b", ["y.txt"]);

    await expect(
      serviceFor(writeRoot()).batch(
        USER_ID,
        HOST_ID,
        [join(left, "x.txt"), join(right, "y.txt")],
        "\\.txt$",
        ".md",
        false,
        false,
      ),
    ).rejects.toThrow(/one directory/);

    expect(await namesIn(left)).toEqual(["x.txt"]);
    expect(await namesIn(right)).toEqual(["y.txt"]);
  });

  it("renames a symlink rather than what it points at", async () => {
    // `realpath` on the link resolves to its target, so a service that
    // validated the entry instead of its parent would rename the file three
    // directories away — possibly outside the roots entirely.
    const dir = await fixture("links", ["real.txt"]);
    await symlink(join(dir, "real.txt"), join(dir, "alias"));

    const result = await run(dir, ["alias"], "^alias$", "pointer");

    expect(result.renamed).toBe(1);
    expect(await namesIn(dir)).toEqual(["pointer", "real.txt"]);
  });

  it("leaves a directory alone when the pattern matches nothing", async () => {
    const dir = await fixture("nomatch", ["a.txt", "b.txt"]);
    const result = await run(dir, ["a.txt", "b.txt"], "^zzz", "y");

    expect(result.renamed).toBe(0);
    expect(await namesIn(dir)).toEqual(["a.txt", "b.txt"]);
  });

  it("refuses an entry the local denylist covers", async () => {
    const dir = await fixture("denied", ["id_rsa"]);
    const service = serviceFor(writeRoot(), [dir]);

    await expect(
      service.batch(USER_ID, HOST_ID, [join(dir, "id_rsa")], "^id_", "old_", false, false),
    ).rejects.toThrow();
    expect(await namesIn(dir)).toEqual(["id_rsa"]);
  });
});

// ------------------------------------------------------- preview equals apply

describe("the preview and the apply agree", () => {
  /**
   * The property the ticket asks for, over generated names and patterns.
   *
   * Both endpoints call `planRename` on the same input, so what is actually at
   * risk is that the *apply* adds a judgment of its own — a rule it enforces
   * that the preview never showed, which is exactly how a user comes to click a
   * green CTA and get a 422. So: whenever the preview reports a clean plan, the
   * batch must run it; whenever the preview reports a problem, the batch must
   * refuse; and the resulting directory must hold precisely the names the
   * preview drew.
   */
  const PATTERNS: readonly { pattern: string; replacement: string; global: boolean }[] = [
    { pattern: "^dump-(\\d{4})-(\\d{2})-(\\d{2})", replacement: "atlas_$1$2$3", global: false },
    { pattern: "\\.txt$", replacement: ".md", global: false },
    { pattern: "-\\d+", replacement: "", global: true },
    { pattern: "[aeiou]", replacement: "_", global: true },
    { pattern: "^(.*)$", replacement: "$1", global: false },
    { pattern: "^(.*)$", replacement: "same", global: false },
    { pattern: "^", replacement: "../", global: false },
    { pattern: "^.*$", replacement: "", global: false },
    { pattern: "(\\w)(\\w)", replacement: "$2$1", global: true },
    { pattern: "e", replacement: "☃".repeat(90), global: true },
  ];

  const NAMES: readonly string[][] = [
    ["dump-2026-08-08.sql.gz", "dump-2026-08-07.sql.gz"],
    ["a-1.txt", "a-2.txt", "b.txt"],
    ["one", "two", "three"],
    ["report.txt", "report.md"],
    ["file", "file2"],
  ];

  it.each(
    PATTERNS.flatMap((spec, patternIndex) =>
      NAMES.map((names, nameIndex) => [`p${patternIndex}·n${nameIndex}`, spec, names] as const),
    ),
  )("%s", async (label, spec, names) => {
    const dir = await fixture(`prop-${label.replace("·", "-")}`, names);
    const service = serviceFor(writeRoot());
    const paths = names.map((name) => join(dir, name));

    const preview = await service.preview(USER_ID, HOST_ID, paths, spec.pattern, spec.replacement, spec.global, false);

    const refused = preview.error !== null || preview.mappings.some((mapping) => mapping.problem !== null);
    const applied = await service
      .batch(USER_ID, HOST_ID, paths, spec.pattern, spec.replacement, spec.global, false)
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(applied.ok).toBe(!refused);

    if (refused) {
      // Nothing moved: the directory is exactly what it was.
      expect(await namesIn(dir)).toEqual([...names].sort());
      return;
    }

    // The directory now holds what the preview said it would, and nothing else.
    const expected = preview.mappings.map((mapping) => mapping.next).sort();
    expect(await namesIn(dir)).toEqual(expected);
  });
});

// ------------------------------------------------------------------- the judge

describe("judge", () => {
  it("is the same computation whether it is asked once or twice", async () => {
    // The preview endpoint and the batch endpoint each call `planRename`
    // separately. If judging were not a pure function of its input, the two
    // calls could disagree while looking identical at every call site.
    const input: RenameInput = {
      names: ["a-1", "a-2", "b"],
      existing: ["a-1", "a-2", "b", "a"],
      pattern: "-\\d",
      replacement: "",
      global: false,
      ignoreCase: false,
    };

    const first = await planRename(input);
    const second = await planRename(input);
    expect(second).toEqual(first);

    const applied = first.mappings.map((mapping) => ({
      next: mapping.next,
      index: mapping.match?.index ?? -1,
      length: mapping.match?.length ?? 0,
    }));
    expect(judge(input, applied)).toEqual(first);
  });
});
