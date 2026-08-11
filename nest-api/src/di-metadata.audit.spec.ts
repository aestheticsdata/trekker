import "reflect-metadata";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every Nest provider, checked for erased constructor tokens.
 *
 * `import type` (and an inline `type X` specifier, which is easier to miss)
 * compiles fine, lints fine, and leaves `design:paramtypes` holding `Object` —
 * the container then fails at boot. A formatter did this across the API once.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".spec.ts") ? [full] : [];
  });
}

describe("Nest DI metadata", () => {
  it("never imports an injected class as a type", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(join(__dirname))) {
      const source = readFileSync(file, "utf8");
      if (!/@Injectable\(\)|@Controller\(/.test(source)) continue;

      const constructorBlock = source.match(/constructor\(([\s\S]*?)\)\s*\{/)?.[1] ?? "";
      const injected = [...constructorBlock.matchAll(/private readonly \w+:\s*([A-Z]\w+)/g)].map((m) => m[1]);

      for (const name of injected) {
        const typeOnly =
          new RegExp(`import type \\{[^}]*\\b${name}\\b[^}]*\\}`).test(source) ||
          new RegExp(`[{,]\\s*type ${name}\\b`).test(source);
        if (typeOnly) offenders.push(`${file.replace(`${__dirname}/`, "")}: ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The same erasure on a handler parameter, which is worse: `@Body()` is
   * pipeable, so a metatype of `Function` reaches the global ValidationPipe,
   * `whitelist: true` strips every property it cannot find metadata for, and
   * the handler runs with an empty object. No error, no 400 — a 201 that saved
   * nothing. The constructor check above does not see handler params at all.
   */
  it("never imports a DTO used in a decorated parameter as a type", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(join(__dirname))) {
      const source = readFileSync(file, "utf8");
      if (!/@Controller\(/.test(source)) continue;

      const dtos = [...source.matchAll(/@(?:Body|Query|Param)\([^)]*\)\s*\w+:\s*([A-Z]\w*Dto)\b/g)].map((m) => m[1]);

      for (const name of new Set(dtos)) {
        const typeOnly =
          new RegExp(`import type \\{[^}]*\\b${name}\\b[^}]*\\}`).test(source) ||
          new RegExp(`[{,]\\s*type ${name}\\b`).test(source);
        if (typeOnly) offenders.push(`${file.replace(`${__dirname}/`, "")}: ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
