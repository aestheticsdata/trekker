import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The app's path aliases, taught to Node.
 *
 * Most of `src/helpers/` imports nothing but types and so needs none of this —
 * a verify script reaches straight in and node strips the type imports on the
 * way. The rest do not: `pane-state.ts` imports `@helpers/listing` for real
 * (TRE-77), and since TRE-36 the action registry imports `@helpers/keys`, which
 * is the price of the chords being written down exactly once.
 *
 * Deliberately dumb: `@x/y` is `src/x/y.ts` and nothing here resolves to a
 * `.tsx`, because a verify script that needed to load a component would be a
 * verify script asking the wrong question.
 *
 * **A caller has to `await import()` whatever it wants afterwards.** ESM
 * resolves the whole graph before it evaluates any of it, so a static import of
 * an aliased module is resolved before the line that installs this can run.
 * That is not a detail worth rediscovering: it fails with `ERR_MODULE_NOT_FOUND`
 * pointing at the alias, which reads exactly like a missing dependency.
 */
export function registerAliases(): void {
  const src = resolvePath(dirname(fileURLToPath(import.meta.url)), "../src");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith("@")) return nextResolve(specifier, context);
      return { url: pathToFileURL(`${resolvePath(src, specifier.slice(1))}.ts`).href, shortCircuit: true };
    },
  });
}
