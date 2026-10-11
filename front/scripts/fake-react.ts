/**
 * Just enough of React to run one hook in Node, for `verify-dir-sizes.ts`.
 *
 * There is no DOM here and no test runner in `front/` yet (TRE-39), so a hook
 * whose whole contract is "when does this effect re-run" is checked against a
 * stand-in that implements exactly that contract: hooks are slots in call
 * order, an effect re-runs when one of its dependencies fails `Object.is`, and
 * a commit runs every due cleanup and then every due effect, in declaration
 * order, and a `setState` re-renders until nothing changes — during render
 * before the commit, as React does for state adjusted from a prop, and after
 * it for an effect's. Nothing else: no scheduling, no batching across calls.
 */

interface StateSlot {
  value: unknown;
}

interface EffectSlot {
  deps: readonly unknown[] | undefined;
  cleanup: (() => void) | undefined;
}

type Effect = () => (() => void) | undefined;

const slots: unknown[] = [];
let next = 0;
let dirty = false;
let due: Array<{ index: number; effect: Effect; deps: readonly unknown[] | undefined }> = [];

export function useState<T>(initial: T) {
  const index = next++;
  if (!(index in slots)) slots[index] = { value: initial } satisfies StateSlot;
  const slot = slots[index] as StateSlot;
  const set = (value: T | ((current: T) => T)): void => {
    const updated = typeof value === "function" ? (value as (current: T) => T)(slot.value as T) : value;
    if (!Object.is(updated, slot.value)) dirty = true;
    slot.value = updated;
  };
  return [slot.value as T, set] as const;
}

export function useRef<T>(initial: T) {
  const index = next++;
  if (!(index in slots)) slots[index] = { current: initial };
  return slots[index] as { current: T };
}

export function useEffect(effect: Effect, deps?: readonly unknown[]): void {
  const index = next++;
  const previous = slots[index] as EffectSlot | undefined;
  const changed =
    previous === undefined ||
    deps === undefined ||
    previous.deps === undefined ||
    deps.length !== previous.deps.length ||
    deps.some((dep, at) => !Object.is(dep, previous.deps?.[at]));
  if (changed) due.push({ index, effect, deps });
}

/** Renders and commits until the state settles; returns what the last render returned. */
export function render<T>(hook: () => T): T {
  for (let pass = 0; pass < 25; pass += 1) {
    next = 0;
    due = [];
    dirty = false;
    const out = hook();
    if (dirty) continue;
    for (const { index } of due) (slots[index] as EffectSlot | undefined)?.cleanup?.();
    for (const { index, effect, deps } of due) slots[index] = { deps, cleanup: effect() ?? undefined };
    if (!dirty) return out;
  }
  throw new Error("state never settled — a render or an effect sets state on every pass");
}

export function unmount(): void {
  for (const slot of slots) (slot as EffectSlot | undefined)?.cleanup?.();
  slots.length = 0;
}
