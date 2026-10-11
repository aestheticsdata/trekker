/**
 * The directory-size stream opens once per visit, not once per keypress
 * (TRE-152).
 *
 * The defect was one dependency: the cursor's index in the stream effect's
 * list, so every arrow key closed the stream — killing every `du` on the host —
 * and opened another. Nothing throws when it comes back, so this counts the
 * opens across every gesture the ticket names, against the real hook:
 *
 *   node scripts/verify-dir-sizes.ts        (or: pnpm verify:dir-sizes)
 *
 * `react` is swapped for `fake-react.ts`, whose one job is React's re-run rule
 * for effects; `EventSource` is a recorder; `@lib/api/fs` is a stub that puts
 * the arguments in the URL, so the seed each stream opened with can be read
 * back. There is still no test runner in `front/` (TRE-39).
 */

import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { DirSizes } from "../src/components/explorer/use-dir-sizes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const STUB_FS = `data:text/javascript,${encodeURIComponent(
  "export const dirSizesStreamUrl = (hostId, path, firstVisible) => JSON.stringify({ hostId, path, firstVisible });",
)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "react")
      return { url: pathToFileURL(resolvePath(here, "fake-react.ts")).href, shortCircuit: true };
    if (specifier === "@lib/api/fs") return { url: STUB_FS, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

interface Opened {
  hostId: string;
  path: string;
  firstVisible: number;
}

class RecordingSource {
  static all: RecordingSource[] = [];
  readonly opened: Opened;
  closed = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.opened = JSON.parse(url) as Opened;
    RecordingSource.all.push(this);
  }

  close(): void {
    this.closed = true;
  }
}
(globalThis as { EventSource?: unknown }).EventSource = RecordingSource;

const { render, unmount } = await import("./fake-react.ts");
const { useDirSizes } = await import("../src/components/explorer/use-dir-sizes.ts");

interface Pane {
  hostId: string | null;
  path: string;
  ready: boolean;
  elevated: boolean;
  firstVisible: number;
}

let pane: Pane = { hostId: "h1", path: "/srv", ready: false, elevated: false, firstVisible: 0 };
let sizes: DirSizes = { known: new Map(), walking: false };

function commit(change: Partial<Pane>): void {
  pane = { ...pane, ...change };
  sizes = render(() => useDirSizes(pane));
}

const opens = (): number => RecordingSource.all.length;
const latest = (): RecordingSource => RecordingSource.all[opens() - 1] as RecordingSource;
const live = (): number => RecordingSource.all.filter((source) => !source.closed).length;

let checked = 0;
let failures = 0;

function check(label: string, got: unknown, want: unknown): void {
  checked += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`,
  );
}

// --- arrival: listing lands, then the cursor is seeded onto the first sorted row
commit({});
check("nothing opens while the listing is in flight", opens(), 0);
commit({ ready: true, firstVisible: 0 });
commit({ firstVisible: 7 });
check("arriving opens one stream, not two", opens(), 1);
check("it opened at the top of the listing", latest().opened.firstVisible, 0);

// --- figures arrive, then the cursor walks
latest().onmessage?.({ data: JSON.stringify({ name: "logs", bytes: 4_200_000, partial: false }) });
commit({});
for (let step = 1; step <= 10; step += 1) commit({ firstVisible: 7 + step });
check("ten arrow keys open nothing", opens(), 1);
check("and close nothing", live(), 1);
check("a figure already shown survives the cursor", sizes.known.get("logs")?.bytes, 4_200_000);
check("the walk is still running", sizes.walking, true);

// --- a held key: two hundred rows at key-repeat rate
for (let row = 0; row < 200; row += 1) commit({ firstVisible: row });
check("a held arrow key across 200 rows opens nothing", opens(), 1);

// --- the sudo window (TRE-111 §4)
commit({ elevated: true, firstVisible: 12 });
check("opening a sudo window restarts the walk", opens(), 2);
check("closing the one before it", live(), 1);
check("from where the cursor is now", latest().opened.firstVisible, 12);
check("with nothing carried over", sizes.known.size, 0);
commit({ elevated: false });
check("the window expiring restarts nothing", opens(), 2);

// --- leaving, and Back onto a restored cursor
commit({ path: "/srv/www", ready: false, firstVisible: -1 });
check("leaving closes the stream", live(), 0);
commit({ ready: true, firstVisible: 0 });
commit({ path: "/srv", firstVisible: 42 });
check("Back opens at the restored cursor", latest().opened.firstVisible, 42);
check("one stream per visit across the trip", opens(), 4);
check("and only the current one alive", live(), 1);

unmount();
check("unmounting closes it", live(), 0);

console.log(`\n${checked - failures}/${checked} checks passed`);
if (failures > 0) process.exit(1);
