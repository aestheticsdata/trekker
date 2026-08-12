import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The check that makes TRE-30 a mechanism instead of a habit.
 *
 * M2 adds seven modules that change things on other people's machines. The
 * audit log is worth exactly as much as its worst gap, so "remember to add
 * `@Audited`" cannot be the control — a rule enforced by memory is a rule that
 * holds until the day someone is in a hurry, which is also the day worth
 * having a record of.
 *
 * This is deliberately a source scan rather than a runtime scan of Nest's
 * route table. Booting `AppModule` needs MySQL and Redis; this has to run in
 * `pnpm test`, which runs inside the pre-deploy gate on a laptop with neither.
 * A check that only runs where the infrastructure happens to be up is a check
 * that does not run. It follows `di-metadata.audit.spec.ts`, which is already
 * the house pattern for exactly this trade.
 *
 * **This spec is only worth its runtime if it fails when it should.** It was
 * verified by adding an undecorated `@Post` to a controller and confirming it
 * went red, naming the route — see the ticket. TRE-5 shipped a guard that
 * passed its own tests and missed the leak it was written for (`a3e2b22`);
 * a test that has never been seen to fail is a claim, not a check.
 */

const SRC = join(__dirname, "..");

/** Methods that change something. GET and HEAD are not audited by design. */
const MUTATING = /^@(Post|Put|Patch|Delete)\b/;

/** Long enough that "n/a" and "not needed" do not pass for an explanation. */
const MIN_REASON = 25;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".controller.ts") ? [full] : [];
  });
}

/** Every shipped `.ts` under src, tests excluded — a spec cannot satisfy a rule. */
function shippedFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return shippedFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".spec.ts") ? [full] : [];
  });
}

interface RouteSite {
  file: string;
  line: number;
  handler: string;
  decorators: string;
}

/**
 * Collects each decorator stack and the handler beneath it.
 *
 * Brackets are counted rather than matched with a regex because the
 * decorators here span lines — `@Audited({ kind: ..., describe: ... })` is
 * several — and a line-wise regex would read the stack as ending at the first
 * newline and miss every multi-line `@Audited` in the codebase. Which would
 * make this spec fail loudly on correct code, and that is the good direction
 * for a bug in a guard to point, but it would still be wrong.
 */
function routeSites(file: string): RouteSite[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const sites: RouteSite[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trimStart().startsWith("@")) {
      index += 1;
      continue;
    }

    const startLine = index;
    const collected: string[] = [];

    // Consume the whole stack: one decorator at a time, each possibly spanning
    // lines, stopping at the first line that is neither blank nor a decorator.
    while (index < lines.length) {
      const trimmed = lines[index].trimStart();
      if (trimmed === "") {
        index += 1;
        continue;
      }
      if (!trimmed.startsWith("@")) break;

      let depth = 0;
      do {
        const line = lines[index];
        collected.push(line);
        for (const char of line) {
          if (char === "(" || char === "{" || char === "[") depth += 1;
          if (char === ")" || char === "}" || char === "]") depth -= 1;
        }
        index += 1;
      } while (index < lines.length && depth > 0);
    }

    const handler = (lines[index] ?? "").trim();
    sites.push({
      file: file.replace(`${SRC}/`, ""),
      line: startLine + 1,
      handler: handler.slice(0, 60),
      decorators: collected.join("\n"),
    });
  }

  return sites;
}

/**
 * One decorator's full text, pulled out of the stack by balancing its
 * parentheses. A regex cannot do this: a reason long enough to be worth
 * reading is written as concatenated string literals across several lines, and
 * `@NotAudited\(\s*"(.*?)"\s*\)` matches none of them — it would report every
 * carefully-written exemption as having no reason at all.
 */
function decoratorText(decorators: string, name: string): string | null {
  const start = decorators.indexOf(`@${name}(`);
  if (start === -1) return null;

  let depth = 0;
  for (let index = start; index < decorators.length; index += 1) {
    const char = decorators[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return decorators.slice(start, index + 1);
    }
  }
  return null;
}

/** The concatenated contents of every string literal in a decorator call. */
function literals(text: string): string {
  return [...text.matchAll(/["'`]([\s\S]*?)["'`]/g)].map((match) => match[1]).join("");
}

function mutatingSites(): RouteSite[] {
  return sourceFiles(SRC).flatMap((file) =>
    routeSites(file).filter((site) => site.decorators.split("\n").some((line) => MUTATING.test(line.trimStart()))),
  );
}

describe("audit coverage", () => {
  it("finds the mutating routes at all", () => {
    // Guards the guard. Every assertion below is "no offenders", which is also
    // what a broken parser returns — a regex that silently matched nothing
    // would turn this whole file green and mean nothing. The count is asserted
    // as a floor, not a fixed number, so adding routes does not fail it.
    expect(mutatingSites().length).toBeGreaterThanOrEqual(10);
  });

  it("audits every mutating route, or says in writing why not", () => {
    const offenders = mutatingSites()
      .filter((site) => !/@(Not)?Audited\s*\(/.test(site.decorators))
      .map((site) => `${site.file}:${site.line} — ${site.handler}`);

    expect(offenders).toEqual([]);
  });

  it("never carries both @Audited and @NotAudited", () => {
    const offenders = mutatingSites()
      .filter((site) => /@Audited\s*\(/.test(site.decorators) && /@NotAudited\s*\(/.test(site.decorators))
      .map((site) => `${site.file}:${site.line} — ${site.handler}`);

    expect(offenders).toEqual([]);
  });

  it("gives every exemption a real reason", () => {
    const offenders = mutatingSites()
      .filter((site) => /@NotAudited\s*\(/.test(site.decorators))
      .filter((site) => {
        const text = decoratorText(site.decorators, "NotAudited");
        return literals(text ?? "").trim().length < MIN_REASON;
      })
      .map((site) => `${site.file}:${site.line} — ${site.handler}`);

    expect(offenders).toEqual([]);
  });

  it("gives every audited route a kind that fits the column and the vocabulary", () => {
    const offenders: string[] = [];

    for (const site of mutatingSites()) {
      if (!/@Audited\s*\(/.test(site.decorators)) continue;

      const kind = site.decorators.match(/kind:\s*["'`]([^"'`]+)["'`]/)?.[1];
      if (!kind) {
        offenders.push(`${site.file}:${site.line} — @Audited with no kind`);
        continue;
      }
      // `subject.verb`, lowercase. Shared with the activity strip, so a rename
      // silently reclassifies history — worth pinning the shape.
      if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(kind)) {
        offenders.push(`${site.file}:${site.line} — kind "${kind}" is not subject.verb`);
      }
      // ActivityLog.kind is VarChar(32). Truncation at the boundary would split
      // one kind into two and neither would match a filter.
      if (kind.length > 32) {
        offenders.push(`${site.file}:${site.line} — kind "${kind}" exceeds 32 chars`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("requires a rate limit on every destructive route", () => {
    // TRE-30 §3. Attached to the same decorator as the audit row so a
    // destructive route cannot be limited "later" — there is one place both
    // decisions are made and neither is optional.
    const offenders = mutatingSites()
      .filter((site) => /destructive:\s*true/.test(site.decorators))
      .filter((site) => !/limit:\s*LIMITS\./.test(site.decorators))
      .map((site) => `${site.file}:${site.line} — ${site.handler}`);

    expect(offenders).toEqual([]);
  });

  it("leaves no limit in LIMITS that nothing spends from", () => {
    // The mirror of the destructive-needs-a-limit rule, and the one that
    // catches the more comfortable mistake: declaring a limit, describing it
    // convincingly, and never wiring it. An unenforced limit in the live table
    // reads exactly like an enforced one to anyone auditing this file, which
    // makes it worse than not having written it. Unattached limits belong in
    // `TO_ATTACH`, where the name says so.
    const source = readFileSync(join(SRC, "audit", "limits.ts"), "utf8");
    const live = source.slice(source.indexOf("export const LIMITS"), source.indexOf("export const TO_ATTACH"));
    const declared = [...live.matchAll(/^\s{2}(\w+):\s*rule\(/gm)].map((match) => match[1]);

    // Two ways a counter is ever incremented, and only two: a route declaring
    // `limit:` — the interceptor spends it — or a service calling `consume`
    // itself, which is what a refusal decided below the routing layer has to
    // do (`PathGuardService`). Matching on the call rather than on any mention
    // of `LIMITS.x` matters: a limit named in a comment or passed to a
    // `describe()` is documented, not enforced, and this rule exists precisely
    // to tell those two apart. The consequence is that a service must name the
    // limit at the call site — `consume(LIMITS.x, ...)`, not `consume(rule)` —
    // which is the fix when this fails on a limit that is genuinely wired.
    const byRoute = mutatingSites()
      .flatMap((site) => [...site.decorators.matchAll(/limit:\s*LIMITS\.(\w+)/g)])
      .map((match) => match[1]);

    const byService = shippedFiles()
      .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\bconsume\(\s*LIMITS\.(\w+)/g)])
      .map((match) => match[1]);

    const spent = [...byRoute, ...byService];
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((name) => !spent.includes(name))).toEqual([]);
  });

  it("keeps every declared-but-unattached limit tied to a ticket", () => {
    // `TO_ATTACH` in limits.ts names the limits whose operations do not exist
    // yet. Each must name the ticket that will attach it, or it is not a plan,
    // it is a note nobody will action.
    const source = readFileSync(join(SRC, "audit", "limits.ts"), "utf8");
    const block = source.slice(source.indexOf("export const TO_ATTACH"));

    const entries = [...block.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((match) => match[1]);
    const tickets = [...block.matchAll(/ticket:\s*"(TRE-\d+)"/g)].map((match) => match[1]);

    expect(entries.length).toBeGreaterThan(0);
    expect(tickets).toHaveLength(entries.length);
  });

  it("keeps the log append-only outside the audit module", () => {
    // Two writes per row and no more, both in AuditService. RetentionService
    // is the only deleter. Anything else touching these rows means the trail
    // can be edited by the code it is a trail of.
    //
    // Named files, not the `audit/` directory: this module now holds a
    // controller and a read service too, and exempting the whole folder would
    // mean the one place most likely to grow a tampering route is the one
    // place this rule does not look.
    const WRITERS = ["audit/audit.service.ts", "audit/retention.service.ts"];
    const offenders: string[] = [];

    for (const file of shippedFiles()) {
      const relative = file.replace(`${SRC}/`, "");
      if (WRITERS.includes(relative)) continue;

      const source = readFileSync(file, "utf8");
      if (/activityLog\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/.test(source)) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });
});
