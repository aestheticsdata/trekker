import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@e2e/demo/fixture";

import type { Locator, Page } from "@playwright/test";

/**
 * Trekker, end to end — one continuous take, thirteen chapters, one screen.
 *
 * This file is the storyboard and nothing else: no pointer paths, no video, no timing arithmetic.
 * Those live in `cursor.ts`, `fixture.ts` and `pacing.ts`, so what is left here reads as a shot
 * list and can be reordered by moving blocks around.
 *
 * Trekker has ONE private route. Every "screen" is a panel, a strip, a modal or a menu inside `/`,
 * and the whole layout lives in the query string — so the one URL this take types is a complete
 * layout, and every chapter after it is a thing a hand would do to that layout.
 *
 * Four rules it never breaks.
 *
 * IT WRITES, AND ONLY INTO THE FAKE TREES. The first cut of this take was read-only, and a film
 * of a file manager that never makes, copies, renames or uploads anything is a film of a viewer.
 * So chapter 7 makes a directory on Marlow, copies three of Kestrel's files into it and renames
 * them with a pattern, and chapter 8 uploads three files to Tundra — six writes, every one of
 * them inside `TREKKER_MOCK_HOME`, where the four trees live and the only place any of the four
 * machines can reach. `pnpm mock` puts the trees back; the take refuses to start on a tree that
 * still carries the previous take's writes, because `mkdir reports-2026` would say "already
 * exists" two minutes in. Nothing is ever deleted, downloaded or chmod'ed: `rm` is the LAST row
 * of every entries menu, directly under `add to favourites`; `scan ⟳` sits beside `hide ▾` at
 * the right end of the disk-usage title (chapter 7 clicks the second, chapter 13 the "scan now"
 * of an empty strip, on Marlow); a favourite's `✕` appears on hover of the very row you click.
 * So every click near a row is aimed with `aim: "text"` — near the leading edge, where the name
 * is — and F2/F5/F7 are pressed only with the pane that should answer them already active.
 *
 * NOTHING IS ASSERTED THAT MOVES. Every age chip, every `N ago` and the pings read the wall clock.
 * Waits are on names and sizes, which the manifest fixes — and since TRE-148 that includes the
 * VOLUMES rail and the path-row badge, which read the fake `df` the mock puts first on the API's
 * PATH rather than the film machine's own disks. A take on a real `df` is refused below.
 *
 * NO URL IS TYPED, except the first — and the first is explicit on purpose. Every URL change is
 * written back to the account's last layout a second later, and a bare `/` restores whatever the
 * previous take left; a full query string is what makes the opening frame the same every time.
 *
 * THE OTHER MACHINES ANSWER. Marlow, Sable and Tundra are SSH rows under `example.com`, and behind
 * each name is a server the mock runs itself (`nest-api/mock/sshd.ts`), started with the API by
 * the same wrapper that puts the fake `df` on its PATH. A pane bound to one lists it, a copy lands
 * on it, a scan walks it, the terminal's prompt reads `deploy@marlow`. Chapter 4 binds all three
 * into pane B, chapter 7 makes, copies and renames on Marlow, chapter 8 uploads to Tundra, and
 * chapter 13 scans Marlow live and opens the shell on it.
 *
 * The corpus is TRE-140's fake server tree, in the repository's own `.mock/` folder with the
 * three remote machines' trees beside it — `MOCK_HOME` below. Its absolute path is printed as
 * breadcrumb crumbs in both panes, so the film shows the path of this checkout.
 */

/**
 * Where `pnpm mock` put the trees: the repository's own `.mock/` folder, unless `TREKKER_MOCK_HOME`
 * moved it — the same default the mock uses. Its absolute path is printed as breadcrumbs in both
 * panes, so what the film shows is wherever this checkout lives.
 */
const MOCK_HOME = process.env.TREKKER_MOCK_HOME ?? resolve(__dirname, "..", "..", "..", ".mock");
const TREE = `${MOCK_HOME}/tree`;

/** The dev LOCAL host's id is pinned in `nest-api/mock/manifest.ts`, because saved views reference it. */
const HOST = "01990000-c0de-7000-8000-000000000001";

/**
 * The through-line: the nightly dump. It is a FAVOURITE, the subject of a saved view, the target of
 * the transfer history, holder of one of the 21 fixture sha256s, the second band of the root
 * treemap, and it sits in the one directory that shows the whole age ramp.
 */
const DUMP = "db-2026-08-31.sql.gz";

/** The live release (`current` points here) and the one before it — the compare pair. */
const RELEASE_NOW = "2026-08-30-1730";
const RELEASE_BEFORE = "2026-08-21-0940";

const RELEASES = `${TREE}/var/www/app/releases`;
const NGINX_LOGS = `${TREE}/var/log/nginx`;

/** The remote machines' trees: what their servers serve as `/`, written by `pnpm mock` beside Kestrel's. */
const MARLOW_TREE = `${MOCK_HOME}/hosts/marlow/tree`;

/** What chapter 7 makes on Marlow, under `/srv/backups`, and what it copies there from `home/alice/projects`. */
const NEW_FOLDER = "reports-2026";
const COPIED = ["sales-2026-06.csv", "sales-2026-07.csv", "sales-2026-08.csv"] as const;
/** The rename pattern, and the names it produces. */
const PATTERN = "^sales-(\\d{4})-(\\d{2})";
const REPLACEMENT = "$1-$2-sales";
const RENAMED = ["2026-06-sales.csv", "2026-07-sales.csv", "2026-08-sales.csv"] as const;

/**
 * What chapter 8 uploads, to Tundra's drop zone: three files written here, beside the film, at
 * the sizes a viewer can watch land. Zero-filled — nothing about their bytes is on screen, only
 * their names and sizes — and gitignored with the rest of `out/`.
 */
const UPLOAD_SOURCES = join(__dirname, "out", "upload");
const UPLOADS: ReadonlyArray<readonly [name: string, bytes: number]> = [
  ["catalogue-2026-autumn.pdf", 3_276_800],
  ["press-kit.zip", 6_963_200],
  ["launch-teaser.mp4", 25_165_824],
];

/** The opening layout, in full: two panes, detail view, heat on, inspector on, root treemap pinned. */
const OPENING = `/?${new URLSearchParams({
  aHost: HOST,
  aPath: RELEASES,
  aSort: "age",
  aDir: "-1",
  bHost: HOST,
  bPath: NGINX_LOGS,
  split: "split",
  view: "detail",
  heat: "1",
  insp: "1",
  du: "1",
  duRoot: TREE,
}).toString()}`;

test("trekker, end to end", async ({ demo }) => {
  const page = demo.page;

  // A tree that still holds the previous take's writes would fail two minutes in, on
  // `mkdir reports-2026: already exists` — on Marlow, whose tree `pnpm mock` rewrites with the
  // rest. Refused here, before a frame is kept.
  if (existsSync(`${MARLOW_TREE}/srv/backups/${NEW_FOLDER}`)) {
    throw new Error(
      `demo: Marlow's tree at ${MARLOW_TREE} still carries the previous take's writes (srv/backups/${NEW_FOLDER}).\n` +
        `    Put it back first:  cd nest-api && pnpm mock` +
        (process.env.TREKKER_MOCK_HOME ? ` (with TREKKER_MOCK_HOME=${MOCK_HOME})` : ""),
    );
  }
  mkdirSync(UPLOAD_SOURCES, { recursive: true });
  for (const [name, bytes] of UPLOADS) writeFileSync(join(UPLOAD_SOURCES, name), Buffer.alloc(bytes));
  const uploadPaths = UPLOADS.map(([name]) => join(UPLOAD_SOURCES, name));

  /** A pane by position. Both can show the same file names, so nothing in a pane is addressed bare. */
  const pane = (index: 0 | 1) => page.locator(`[data-testid="pane"][data-pane="${index}"]`);
  const rowIn = (index: 0 | 1, name: string) => pane(index).locator(`[data-testid="row"][data-row="${name}"]`);
  const crumbIn = (index: 0 | 1, tail: string) =>
    pane(index).locator(`[data-testid="path-crumb"][data-crumb$="/${tail}"]`);
  const lastCrumb = (index: 0 | 1) => pane(index).locator('[data-testid="path-crumb"]').last();
  /** The top row of a pane, whatever it is — for making a pane active without naming a file. */
  const firstRow = (index: 0 | 1) => pane(index).locator('[data-testid="row"]').first();
  const header = (index: 0 | 1, column: string) =>
    pane(index).locator(`[data-testid="column-header"][data-column="${column}"]`);
  const favourite = (label: string) =>
    page.locator(`[data-testid="favourite-row"][data-label="${label}"] [data-testid="favourite-open"]`);
  const viewChip = (name: string) => page.locator(`[data-testid="view-chip"][data-view="${name}"]`);
  const bind = (host: string, index: 0 | 1) =>
    page.locator(`[data-testid="server-row"][data-host="${host}"] [data-testid="server-bind"][data-pane="${index}"]`);
  const scroller = (index: 0 | 1) => pane(index).getByTestId("pane-scroll");
  /** A VOLUMES block, by the directory it is mounted on — inside the tree since TRE-148. */
  const volume = (rel: string) => page.locator(`[data-testid="volume-block"][data-mount="${TREE}/${rel}"]`);

  /**
   * Select a run of rows: the first plainly, the last with ⇧ held, the way a hand extends a
   * selection. What ended up selected is read back and compared by NAME, not by count: a run is
   * whatever sits between its two ends in the pane's current order, and a pane sorted by size
   * puts a different neighbour there than one sorted by name — which is how the first dry run
   * copied `sales-2026-05` instead of `-07`. Done again if a re-list between the two clicks — a
   * finished transfer re-reads its destination twice — dropped the anchor.
   */
  const selectRun = async (index: 0 | 1, names: readonly string[]) => {
    const selected = pane(index).locator('[data-testid="row"].bg-pane-sel, [data-testid="row"].bg-pane-sel-idle');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await demo.click(rowIn(index, names[0]), { aim: "text" });
      await page.keyboard.down("Shift");
      await demo.click(rowIn(index, names[names.length - 1]), { aim: "text" });
      await page.keyboard.up("Shift");
      await demo.dwell(400);
      const picked = await selected.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row")));
      if (picked.length === names.length && names.every((name) => picked.includes(name))) return;
    }
    throw new Error(`demo: could not select ${names.join(", ")} in pane ${index} — check the pane's sort order`);
  };

  /** Into a directory: select its row, then ↩ — the keyboard's "open", which the harness can draw. */
  const enter = async (index: 0 | 1, name: string) => {
    await demo.click(rowIn(index, name), { aim: "text" });
    await demo.press("Enter");
    await expect(lastCrumb(index)).toHaveText(name);
  };

  /**
   * A right-click, which the harness has no verb for. The pointer is walked there first so the
   * drawn arrow arrives before the menu does; the press itself is the real mouse's.
   */
  const rightClick = async (target: Locator) => {
    await demo.moveTo(target, { aim: "text" });
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    await demo.dwell(500);
  };

  /** Walk the pointer along a family of marks, pausing on each. Positional: the count is structural. */
  const sweep = async (marks: Locator, positions: number[], hold: number) => {
    for (const index of positions) {
      await demo.moveTo(marks.nth(index), { dwell: hold });
    }
  };

  /** Down a long listing and back up, so a viewer sees there is more than a screen of it. */
  const leaf = async (index: 0 | 1, distance: number) => {
    await demo.scroll(scroller(index), distance, 1_400);
    await demo.dwell(900);
    await demo.scroll(scroller(index), -distance, 1_100);
    await demo.dwell(600);
  };

  /**
   * The upload, as the stills re-create it: pane B made active, the toolbar's `upload ↑`, and the
   * three files handed to the picker the modal opens. A script cannot answer the system dialogue,
   * so Playwright answers the `filechooser` event the click raises — the click is real, the
   * dialogue is the one thing that never draws.
   */
  const prepareUpload = async (target: Page, then?: (modal: Locator) => Promise<void>) => {
    await target.locator('[data-testid="pane"][data-pane="1"] [data-testid="row"]').first().click();
    await target.locator('[data-testid="toolbar-action"][data-action="upload"]').click();
    const modal = target.getByTestId("upload-modal");
    await expect(modal).toBeVisible();
    const chooser = target.waitForEvent("filechooser");
    await modal.getByTestId("upload-pick-files").click();
    await (await chooser).setFiles(uploadPaths);
    await expect(modal.getByTestId("upload-row")).toHaveCount(UPLOADS.length);
    await then?.(modal);
  };

  // ── 1 ── Two panes ───────────────────────────────────────────────────────
  await demo.open(OPENING);
  await demo.chapter("Two panes");

  const releaseRow = rowIn(0, RELEASE_NOW);
  await expect(releaseRow).toBeVisible();

  // The mock's `df`, not the laptop's: a VOLUMES rail reading the film machine is a leak and a
  // dull picture both (TRE-148). Refused here, before a frame that shows it is kept.
  await expect(
    volume("var/lib/mysql"),
    "the VOLUMES rail is the film machine's, not the mock's — start the API through `tsx mock/df-on-path.ts` (nest-api/mock/README.md)",
  ).toBeVisible();
  demo.shot("two-panes");
  await demo.dwell(1800);

  // The top bar, read left to right: the host, the saved views, the account.
  await demo.moveTo(page.getByTestId("host-chip"), { dwell: 800 });
  await demo.dwell(700);
  await demo.moveTo(viewChip("Releases ↔ logs"), { dwell: 700 });
  await demo.dwell(600);
  await demo.moveTo(viewChip("Media"), { dwell: 700 });
  await demo.dwell(600);

  // The rail, read top to bottom: the four machines, then the volumes of the one the pane is on.
  await sweep(page.getByTestId("server-row"), [0, 1, 2, 3], 500);
  await demo.dwell(400);
  await sweep(page.getByTestId("volume-block"), [0, 2, 4], 600);
  await demo.dwell(700);

  // A row: selected, then read. The AGE chip carries the exact instant; the share bar has no bubble.
  await demo.click(releaseRow, { aim: "text" });
  await demo.dwell(900);
  await demo.moveTo(releaseRow.getByTestId("row-age"), { dwell: 700 });
  await demo.dwell(800);

  // Into it with ↩, and back out through the breadcrumb, which is what a hand does.
  await demo.press("Enter");
  await expect(lastCrumb(0)).toHaveText(RELEASE_NOW);
  await demo.dwell(1500);
  await demo.click(crumbIn(0, "releases"), { aim: "text" });
  await expect(releaseRow).toBeVisible();
  await demo.dwell(800);

  // ── 2 ── Sort, heat, glob ────────────────────────────────────────────────
  await demo.chapter("Sort, heat, glob");

  await demo.click(header(0, "size"));
  await demo.dwell(1200);
  await demo.click(header(0, "name"));
  await demo.dwell(1000);

  await demo.click(page.getByTestId("heat-toggle"));
  await demo.dwell(1200);
  await demo.click(page.getByTestId("heat-toggle"));
  await demo.dwell(800);

  // The glob filters the ACTIVE pane. A click on a row in pane B makes it so — a row, never a cell
  // that opens something: the far end of a row is nothing here, the danger is the menu.
  await demo.click(rowIn(1, "access.log"), { aim: "text" });
  await demo.fill(page.getByTestId("glob-input"), "*.gz");
  await expect(page.getByTestId("glob-hits")).toBeVisible();
  await demo.dwell(1600);
  // Select-all and delete, inside the input, where the global hotkeys stand down.
  await demo.press("Meta+A");
  await demo.press("Backspace");
  await demo.dwell(800);

  // ── 3 ── Panes go places ─────────────────────────────────────────────────
  await demo.chapter("Panes go places");

  // A VOLUMES block opens that partition in the active pane. Pane A first, by selecting a row in
  // it. The MySQL volume is at 79%, and the path row says so with a badge the moment the pane
  // lands there.
  await demo.click(releaseRow, { aim: "text" });
  await demo.click(volume("var/lib/mysql"));
  await expect(rowIn(0, "ibdata1")).toBeVisible();
  await demo.dwell(800);
  const badge = pane(0).getByTestId("path-badge");
  if (await badge.isVisible()) {
    await demo.moveTo(badge, { dwell: 900 });
    await demo.dwell(500);
  }
  await demo.click(header(0, "size"));
  await demo.dwell(1000);
  await enter(0, "app");
  await expect(rowIn(0, "orders.ibd")).toBeVisible();
  await demo.dwell(1400);

  // Pane B to the media volume, and down into the crowd: the catalogue is a hundred and twenty
  // renders, and a listing that long is what the wheel is for.
  await demo.click(rowIn(1, "access.log"), { aim: "text" });
  await demo.click(volume("srv/media"));
  await expect(rowIn(1, "images")).toBeVisible();
  await demo.dwell(900);
  await enter(1, "images");
  await expect(rowIn(1, "hero-01.jpg")).toBeVisible();
  await demo.dwell(900);
  await leaf(1, 700);
  await enter(1, "products");
  const firstProduct = pane(1).locator('[data-testid="row"][data-row^="sku-10021."]');
  await expect(firstProduct).toBeVisible();
  // The inspector reads the directory: a hundred and twenty items, and their size.
  await expect(page.locator('[data-testid="inspector"][data-panel="directory"]')).toBeVisible();
  await sweep(page.getByTestId("inspector").getByTestId("inspector-stat"), [0, 1], 700);
  await demo.dwell(500);
  // One render clicked: the inspector fetches its bytes and shows the picture. The mock's images
  // are real PNGs since TRE-148's second pass — a sparse file showed a hatched box here.
  await demo.click(firstProduct, { aim: "text" });
  const preview = page.locator('[data-testid="inspector-preview"] img');
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.evaluate((image) => (image as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await demo.moveTo(preview, { dwell: 1_400 });
  await demo.dwell(600);
  await leaf(1, 1_500);
  demo.shot("catalogue", async (target) => {
    await target.locator('[data-testid="pane"][data-pane="1"] [data-testid="row"][data-row^="sku-10021."]').click();
    const image = target.locator('[data-testid="inspector-preview"] img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  });

  // One pane or two: the split control, drawn as the boxes it is.
  await demo.click(page.locator('[data-testid="split-control"][data-split="right"]'));
  await demo.dwell(1600);
  await demo.click(page.locator('[data-testid="split-control"][data-split="split"]'));
  await demo.dwell(1000);

  // A second tab in pane B, sent somewhere else by a favourite — ⚠️ aimed at its label: the
  // row's `✕`, delete the bookmark, appears on hover of this very row, at its far end — and the
  // first tab brought back.
  await demo.click(pane(1).getByTestId("tab-new"));
  await expect(pane(1).getByTestId("tab")).toHaveCount(2);
  await demo.dwell(700);
  await demo.click(favourite("Media"), { aim: "text" });
  await expect(rowIn(1, "videos")).toBeVisible();
  await demo.dwell(1100);
  await demo.click(pane(1).locator('[data-testid="tab"][data-tab="0"] [data-testid="tab-select"]'), { aim: "text" });
  await expect(pane(1).locator('[data-testid="row"][data-row^="sku-10021."]')).toBeVisible();
  await demo.dwell(1100);

  // A third partition: the NFS archive, two years of what the backups job swept off, on pane A —
  // and a listing longer than the screen.
  await demo.click(rowIn(0, "orders.ibd"), { aim: "text" });
  await demo.click(volume("mnt/archive"));
  // The crumb, not a name: pane A is sorted by size here, and the listing is virtualised — the
  // one small file in the archive is below the window and not in the DOM.
  await expect(lastCrumb(0)).toHaveText("archive");
  await expect(firstRow(0)).toBeVisible();
  await demo.dwell(900);
  await leaf(0, 700);

  // ── 4 ── Servers ─────────────────────────────────────────────────────────
  await demo.chapter("Servers");

  // The rail's A/B buttons bind a machine to a pane. Marlow, Sable and Tundra answer — a server
  // each, run by the mock — so pane B lists them in turn.
  // ⚠️ Pane A is made active FIRST and stays so. The DISK USAGE strip follows the active pane's
  // host, and a pin on a root that host has never scanned lets go (`disk-usage.tsx`): a click in
  // pane B here would unpin Kestrel's root treemap for the rest of the film. Rows in B are
  // hovered, never clicked, until chapter 7 hides the strip.
  await demo.click(firstRow(0), { aim: "text" });
  await demo.click(bind("marlow", 1));
  await expect(rowIn(1, DUMP)).toBeVisible({ timeout: 20_000 });
  await demo.dwell(1200);
  await demo.moveTo(pane(1).getByTestId("path-host-chip"), { dwell: 900 });
  await demo.dwell(400);
  await demo.moveTo(rowIn(1, "logs"), { aim: "text", dwell: 600 });
  await demo.moveTo(rowIn(1, DUMP), { aim: "text", dwell: 700 });
  await demo.moveTo(rowIn(1, DUMP).getByTestId("row-owner"), { dwell: 800 });
  await demo.dwell(600);

  await demo.click(bind("sable", 1));
  await expect(rowIn(1, "exports")).toBeVisible({ timeout: 20_000 });
  await demo.dwell(1400);

  await demo.click(bind("tundra", 1));
  await expect(rowIn(1, "incoming")).toBeVisible({ timeout: 20_000 });
  await demo.dwell(1400);

  // The host manager, from the chip in pane A's own path row: the fleet, and one machine's form.
  await demo.click(pane(0).getByTestId("path-host-chip"), { aim: "text" });
  const hosts = page.getByTestId("host-manager");
  await expect(hosts).toBeVisible();
  await demo.dwell(900);
  await sweep(hosts.getByTestId("hosts-row"), [0, 1, 2, 3], 550);
  await demo.click(hosts.locator('[data-testid="hosts-row"][data-host="marlow"] [data-testid="hosts-edit"]'));
  const form = hosts.getByTestId("host-form");
  await expect(form).toBeVisible();
  await demo.dwell(700);
  for (const field of ["label", "address", "port", "username", "home"]) {
    await demo.moveTo(form.getByTestId(`host-form-${field}`), { dwell: 550 });
  }
  await demo.dwell(700);
  // ⚠️ `delete this host` is in the same footer as `cancel`. Aimed by name, then the ✕ up top.
  await demo.click(form.getByTestId("host-form-cancel"));
  await demo.dwell(500);
  demo.shot("hosts", async (target) => {
    await target.locator('[data-testid="pane"][data-pane="0"] [data-testid="path-host-chip"]').click();
    await expect(target.getByTestId("host-manager")).toBeVisible();
  });
  await demo.click(hosts.getByTestId("host-manager-close"));
  await expect(hosts).toHaveCount(0);
  await demo.dwell(500);

  // And Kestrel back into pane B, at its home: the root of the machine.
  await demo.click(bind("kestrel", 1));
  await expect(rowIn(1, "var")).toBeVisible();
  await demo.dwell(1100);

  // ── 5 ── Disk usage ──────────────────────────────────────────────────────
  await demo.chapter("Disk usage");

  // Pane A active again — the band is a door into the active pane.
  await demo.click(firstRow(0), { aim: "text" });
  const du = page.getByTestId("disk-usage");
  await expect(du.getByTestId("du-band").first()).toBeVisible();
  // ⚠️ `scan ⟳` / `cancel ✕` / `hide ▾` are at the right end of the title line. Nothing here goes
  // near it: the bands are below, the facts are below.
  await sweep(du.getByTestId("du-band"), [0, 1, 2, 3, 4, 5], 600);
  await demo.dwell(600);
  await sweep(du.getByTestId("du-fact"), [0, 1, 2], 800);
  await demo.dwell(600);

  await demo.click(du.locator(`[data-testid="du-band"][data-path="${TREE}/opt"]`));
  await expect(lastCrumb(0)).toHaveText("opt");
  demo.shot("disk-usage");
  await demo.dwell(1400);

  // ── 6 ── Live tail ───────────────────────────────────────────────────────
  await demo.chapter("Live tail");

  // Pane B, from the machine's root down to the nginx logs by the Logs favourite and one ↩.
  await demo.click(rowIn(1, "var"), { aim: "text" });
  await demo.click(favourite("Logs"), { aim: "text" });
  await expect(rowIn(1, "syslog")).toBeVisible();
  await demo.dwell(1000);
  await enter(1, "nginx");
  await expect(rowIn(1, "access.log")).toBeVisible();
  await demo.dwell(700);

  const tail = pane(1).getByTestId("tail-strip");
  await demo.click(tail.locator('[data-testid="tail-picker-chip"][data-file="access.log"]'), { aim: "text" });
  const tailBody = pane(1).getByTestId("tail-body");
  await expect(tailBody).toBeVisible();
  demo.shot("live-tail");
  await demo.dwell(2000);

  // The body fills as the stream lands; only a body that overflows can be scrolled away from,
  // and only then does `↓ follow` appear. So: wait until there is a body to read, then the
  // gesture — and the follow button is a beat, not an assertion, because on a fast machine the
  // last lines may still be arriving under the pointer.
  await expect(tailBody).not.toBeEmpty();
  await demo.dwell(1000);
  await demo.scroll(tailBody, -90, 900);
  const follow = pane(1).getByTestId("tail-follow");
  await follow.waitFor({ state: "visible", timeout: 4_000 }).catch(() => undefined);
  if (await follow.isVisible()) {
    await demo.dwell(800);
    await demo.click(follow);
    await demo.dwell(1100);
  }
  await demo.click(pane(1).getByTestId("tail-stop"));
  await expect(tailBody).toHaveCount(0);
  await demo.dwell(600);

  // ── 7 ── Make, copy, rename ──────────────────────────────────────────────
  await demo.chapter("Make, copy, rename");

  // The DISK USAGE strip goes away first — `hide ▾`, the one control at the right end of its
  // title that is safe — and comes back in chapter 13, on Marlow. Two reasons: the panes get the
  // room, and a strip that is not mounted cannot let go of Kestrel's pin when pane B, on Marlow,
  // becomes the active pane below.
  await demo.click(page.getByTestId("du-hide"));
  await expect(page.getByTestId("disk-usage")).toHaveCount(0);
  await demo.dwell(700);

  // Pane A to alice's exports: the deploy favourite, up one, and two ↩.
  await demo.click(rowIn(0, "backups"), { aim: "text" });
  await demo.click(favourite("deploy"), { aim: "text" });
  await expect(rowIn(0, "scripts")).toBeVisible();
  await demo.click(crumbIn(0, "home"), { aim: "text" });
  await enter(0, "alice");
  await enter(0, "projects");
  await expect(rowIn(0, "report.md")).toBeVisible();
  // By name: pane A has been sorted by size since chapter 3, and a ⇧-run is a run of neighbours
  // in the pane's current order — the three exports are neighbours by name, not by size.
  await demo.click(header(0, "name"));
  await demo.dwell(900);

  // Pane B to Marlow, and active: what gets made and copied lands on the other machine.
  await demo.click(bind("marlow", 1));
  await expect(rowIn(1, DUMP)).toBeVisible({ timeout: 20_000 });
  await demo.click(rowIn(1, DUMP), { aim: "text" });
  await demo.dwell(700);

  // F7 in pane B: a directory, on Marlow. The toast in the corner is the explorer reporting the write.
  await demo.press("F7");
  const create = page.getByTestId("create-modal");
  await expect(create).toBeVisible();
  await demo.fill(create.getByTestId("create-name"), NEW_FOLDER);
  await demo.dwell(700);
  await demo.click(create.getByTestId("create-submit"));
  await expect(create).toHaveCount(0);
  await expect(rowIn(1, NEW_FOLDER)).toBeVisible({ timeout: 15_000 });
  await demo.dwell(1400);
  await enter(1, NEW_FOLDER);
  await demo.dwell(900);

  // Three exports selected in pane A, ⇧ extending, and F5 — pane A is the source, pane B the
  // destination, which is what a two-pane manager is for: Kestrel to Marlow, over SFTP. The plan
  // is the server's walk of both sides.
  await selectRun(0, COPIED);
  await demo.dwell(700);
  demo.shot("copy", async (target) => {
    const row = (name: string) =>
      target.locator(`[data-testid="pane"][data-pane="0"] [data-testid="row"][data-row="${name}"]`);
    await row(COPIED[0]).click();
    await row(COPIED[2]).click({ modifiers: ["Shift"] });
    await target.keyboard.press("F5");
    await expect(target.getByTestId("transfer-modal").getByTestId("transfer-row")).toHaveCount(COPIED.length);
  });
  await demo.press("F5");
  const transfer = page.getByTestId("transfer-modal");
  await expect(transfer).toBeVisible();
  await expect(transfer.getByTestId("transfer-submit")).toBeEnabled({ timeout: 15_000 });
  await sweep(transfer.getByTestId("transfer-row"), [0, 1, 2], 600);
  await demo.dwell(900);
  await demo.click(transfer.getByTestId("transfer-submit"));
  await expect(transfer).toHaveCount(0);
  // The queue in the rail, and then the toast: `Copied 3 entries`. Hovered, so a viewer reads it.
  await expect(rowIn(1, COPIED[2])).toBeVisible({ timeout: 30_000 });
  await demo.moveTo(page.getByTestId("toast").first(), { dwell: 1400 });
  await demo.dwell(900);

  // F2 on the three copies: a selection opens on the pattern, and the pattern is watched, not
  // applied — every row shows its match and its result while it is still being typed.
  await selectRun(1, COPIED);
  await demo.press("F2");
  const rename = page.getByTestId("rename-modal");
  await expect(rename).toBeVisible();
  await demo.fill(rename.getByTestId("rename-pattern"), PATTERN);
  await demo.fill(rename.getByTestId("rename-replacement"), REPLACEMENT);
  await expect(rename.getByTestId("rename-row")).toHaveCount(COPIED.length);
  await demo.dwell(2200);
  demo.shot("rename", async (target) => {
    // The stills run after the take, when the copies already carry their new names: the same
    // form, shown on the pattern that would put them back. Previewed, never applied.
    const row = (name: string) =>
      target.locator(`[data-testid="pane"][data-pane="1"] [data-testid="row"][data-row="${name}"]`);
    await row(RENAMED[0]).click();
    await row(RENAMED[2]).click({ modifiers: ["Shift"] });
    await target.keyboard.press("F2");
    const modal = target.getByTestId("rename-modal");
    await modal.getByTestId("rename-pattern").fill("^(\\d{4})-(\\d{2})-sales");
    await modal.getByTestId("rename-replacement").fill("sales-$1-$2");
    await expect(modal.getByTestId("rename-row")).toHaveCount(RENAMED.length);
  });
  await demo.click(rename.getByTestId("rename-apply-pattern"));
  await expect(rename).toHaveCount(0);
  await expect(rowIn(1, RENAMED[2])).toBeVisible({ timeout: 15_000 });
  await demo.moveTo(page.getByTestId("toast").first(), { dwell: 1200 });
  await demo.dwell(900);

  // ── 8 ── Upload ──────────────────────────────────────────────────────────
  await demo.chapter("Upload");

  // Tundra's drop zone into pane B, sorted by age so what lands lands on top.
  await demo.click(bind("tundra", 1));
  await expect(rowIn(1, "incoming")).toBeVisible({ timeout: 20_000 });
  await enter(1, "incoming");
  await expect(rowIn(1, "README")).toBeVisible();
  await demo.click(header(1, "age"));
  if ((await firstRow(1).getAttribute("data-row")) !== "2026-08-summit") {
    await demo.click(header(1, "age"));
  }
  await demo.dwell(900);

  // The toolbar's `upload ↑` opens on the destination — the other machine — and the picker
  // opens from inside it.
  await demo.click(page.locator('[data-testid="toolbar-action"][data-action="upload"]'));
  const upload = page.getByTestId("upload-modal");
  await expect(upload).toBeVisible();
  await demo.dwell(1100);
  const chooser = page.waitForEvent("filechooser");
  await demo.click(upload.getByTestId("upload-pick-files"));
  await (await chooser).setFiles(uploadPaths);
  await expect(upload.getByTestId("upload-row")).toHaveCount(UPLOADS.length);
  await demo.dwell(600);
  await sweep(upload.getByTestId("upload-row"), [0, 1, 2], 600);
  // `overwrite`, so a second take lands the same three names rather than `press-kit (2).zip`.
  await demo.click(upload.locator('[data-testid="upload-policy"][data-policy="overwrite"]'));
  await demo.dwell(900);
  demo.shot("upload", (target) => prepareUpload(target));
  await demo.click(upload.getByTestId("upload-submit"));
  await expect(upload).toHaveCount(0);

  // The tray, bottom left, one bar per file — and the listing, re-read once the batch is in.
  const tray = page.getByTestId("upload-tray");
  await expect(tray).toBeVisible();
  await expect(tray.getByText(/finished/)).toBeVisible({ timeout: 60_000 });
  await expect(rowIn(1, UPLOADS[2][0])).toBeVisible({ timeout: 15_000 });
  await demo.moveTo(tray.getByTestId("upload-row").first(), { dwell: 900 });
  await demo.dwell(600);
  await demo.moveTo(rowIn(1, UPLOADS[2][0]).getByTestId("row-size"), { dwell: 900 });
  await demo.dwell(700);
  demo.shot("uploaded", (target) =>
    prepareUpload(target, async (modal) => {
      await modal.locator('[data-testid="upload-policy"][data-policy="overwrite"]').click();
      await modal.getByTestId("upload-submit").click();
      await expect(target.getByTestId("upload-tray").getByText(/finished/)).toBeVisible({ timeout: 60_000 });
      await expect(
        target.locator(`[data-testid="pane"][data-pane="1"] [data-testid="row"][data-row="${UPLOADS[2][0]}"]`),
      ).toBeVisible({ timeout: 15_000 });
    }),
  );
  await demo.click(tray.getByTestId("upload-tray-clear"));
  await expect(tray).toHaveCount(0);
  await demo.dwell(700);

  // ── 9 ── Saved views ─────────────────────────────────────────────────────
  await demo.chapter("Saved views");

  // ⚠️ Chips are clicked, never right-clicked: the view menu's last row is `Delete view`.
  // `Backups → Marlow`: the nightly dumps on the left, their off-site copies on the right, the
  // same names an hour apart — and pane A is more than a screen.
  await demo.click(rowIn(0, "report.md"), { aim: "text" });
  await demo.click(viewChip("Backups → Marlow"));
  await expect(rowIn(0, DUMP)).toBeVisible();
  await expect(rowIn(1, DUMP)).toBeVisible({ timeout: 20_000 });
  demo.shot("backups");
  await demo.dwell(1600);
  await demo.click(rowIn(0, DUMP), { aim: "text" });
  await leaf(0, 800);

  await demo.click(viewChip("Log triage"));
  await expect(lastCrumb(0)).toHaveText("app");
  demo.shot("log-triage");
  await demo.dwell(2000);

  await demo.click(viewChip("Media"));
  await expect(rowIn(1, "launch.mp4")).toBeVisible();
  // The biggest picture selected: the inspector shows it.
  await demo.click(rowIn(0, "hero-01.jpg"), { aim: "text" });
  const hero = page.locator('[data-testid="inspector-preview"] img');
  await expect(hero).toBeVisible();
  await expect
    .poll(() => hero.evaluate((image) => (image as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0);
  demo.shot("media", async (target) => {
    await target.locator('[data-testid="pane"][data-pane="0"] [data-testid="row"][data-row="hero-01.jpg"]').click();
    const image = target.locator('[data-testid="inspector-preview"] img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  });
  await demo.dwell(2000);

  await demo.click(viewChip("Releases ↔ logs"));
  await expect(releaseRow).toBeVisible();
  await demo.dwell(1100);

  // ── 10 ── The context menu ───────────────────────────────────────────────
  await demo.chapter("The context menu");

  await rightClick(rowIn(1, "error.log"));
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await demo.dwell(1100);
  // ⚠️ `rm` is the LAST row, directly under `add to favourites`. The pointer visits the top half
  // only, and leaves by the keyboard.
  await demo.moveTo(menu.locator('[data-testid="menu-item"][data-action="open"]'), { dwell: 650 });
  await demo.moveTo(menu.locator('[data-testid="menu-item"][data-action="tail"]'), { dwell: 650 });
  await demo.moveTo(menu.locator('[data-testid="menu-item"][data-action="copyPath"]'), { dwell: 650 });
  await demo.dwell(500);
  await demo.press("Escape");
  await expect(menu).toHaveCount(0);
  await demo.dwell(600);

  // ── 11 ── The palette ────────────────────────────────────────────────────
  await demo.chapter("The palette");

  // Pane B is still the active one (the right-click activated it); what the palette opens, it
  // opens there — which is exactly where chapter 12 needs the live release.
  await demo.press("Control+K");
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await demo.dwell(800);

  await demo.type("back");
  await expect(palette.getByTestId("palette-row").first()).toBeVisible();
  await demo.dwell(1400);
  demo.shot("palette", async (target) => {
    await target.keyboard.press("Control+K");
    const opened = target.getByTestId("palette");
    await expect(opened).toBeVisible();
    await target.keyboard.type("back");
    await expect(opened.getByTestId("palette-row").first()).toBeVisible();
  });
  await demo.press("ArrowDown");
  await demo.press("ArrowDown");
  await demo.dwell(1000);

  // Path mode: a directory, completed, then opened. ⚠️ Never ↩ on an ACTIONS row.
  await demo.press("Meta+A");
  await demo.type(`${RELEASES}/${RELEASE_NOW}`);
  await demo.dwell(1200);
  await demo.press("Enter");
  await expect(rowIn(1, "package.json")).toBeVisible();
  await demo.dwell(1100);

  // ── 12 ── Compare ────────────────────────────────────────────────────────
  await demo.chapter("Compare");

  // Pane A into the previous release: select, then ↩.
  await enter(0, RELEASE_BEFORE);
  await expect(rowIn(0, "package.json")).toBeVisible();
  await demo.dwell(900);

  // ⚠️ The toolbar's action row: `compare` sits between `duplicate` and `permissions`, and
  // `download` two cells further — all of them fire on the pane's selection. Aimed by name.
  await demo.click(page.locator('[data-testid="toolbar-action"][data-action="compare"]'));
  const compare = page.getByTestId("compare-modal");
  await expect(compare).toBeVisible();
  await expect(compare.getByTestId("compare-summary")).toBeVisible();
  await demo.dwell(2000);

  // Only the verdicts this pair actually produced get a chip — `all` first, then whatever the
  // two release directories disagree on. Walked in order rather than named, because which
  // buckets a rebuilt tree yields is the tree's business, not the film's.
  const chips = compare.getByTestId("compare-filter");
  const chipCount = await chips.count();
  for (const index of [1, 2].filter((i) => i < chipCount)) {
    await demo.click(chips.nth(index));
    await demo.dwell(1300);
  }
  await demo.click(compare.locator('[data-testid="compare-filter"][data-filter="all"]'));
  await demo.dwell(700);
  await demo.fill(compare.getByTestId("compare-name-filter"), "dist");
  await demo.dwell(1200);
  // ⚠️ The arrows copy. Hovered for the bubble, never pressed; `resolve by hash` in the footer
  // starts two hash jobs and is not approached at all.
  await demo.moveTo(compare.getByTestId("compare-arrow").first(), { dwell: 900 });
  await demo.dwell(700);
  await demo.press("Escape");
  await expect(compare).toHaveCount(0);
  await demo.dwell(700);

  // ── 13 ── Marlow: a scan, and the shell ──────────────────────────────────
  await demo.chapter("Marlow: a scan, and the shell");

  // Marlow into pane B and active. The rail now shows Marlow's disks; the strip comes back with
  // `show disk usage`, on a machine nobody has scanned — so it is scanned, live, over SSH: the
  // server walks `/srv/backups` with `du` and the treemap fills as the records land.
  await demo.click(bind("marlow", 1));
  await expect(rowIn(1, DUMP)).toBeVisible({ timeout: 20_000 });
  await demo.click(rowIn(1, DUMP), { aim: "text" });
  await demo.dwell(800);
  await sweep(page.getByTestId("volume-block"), [0, 1], 700);
  await demo.dwell(500);
  await demo.click(page.getByTestId("du-show"));
  const strip = page.getByTestId("disk-usage");
  await expect(strip).toBeVisible();
  await expect(strip.getByTestId("du-blank-scan")).toBeVisible();
  await demo.dwell(900);
  await demo.click(strip.getByTestId("du-blank-scan"));
  await expect(strip.getByTestId("du-band").first()).toBeVisible({ timeout: 60_000 });
  await demo.dwell(1200);
  await sweep(strip.getByTestId("du-band"), [0, 1, 2, 3], 600);
  await demo.dwell(500);
  await sweep(strip.getByTestId("du-fact"), [0, 1, 2], 700);
  await demo.dwell(800);
  demo.shot("marlow-scan");

  // The foot strip is a prompt, and it runs on the active pane's machine: a click in it is what
  // expands it, and the prompt reads `deploy@marlow`. ⚠️ Read-only intents only. `rm` and
  // `chmod` open real dialogs from here.
  //
  // Paced as its own scene rather than as a step, because the first cut lost it: six characters at
  // the film's usual rate are over in 350ms, and `press` fires the key before its own pause, so
  // the finished `ls -al` stood for a single frame. What a viewer saw was a panel opening and a
  // listing appearing, with no command ever written. Every hold below is there to be read.
  await demo.click(page.getByTestId("terminal-input"), { aim: "text" });
  const terminal = page.getByTestId("terminal");
  await expect(terminal.getByTestId("terminal-output")).toBeVisible();
  // The empty scrollback carries the panel's own thesis — "a restricted set, not a shell" — and
  // this is the one moment in the film it is on screen.
  await demo.dwell(1500);
  // In two parts and at two and a half times the rate, the flag held apart from the verb the way
  // a hand holds it, and then the whole line held still before it is sent.
  await demo.type("ls", 2.5);
  await demo.dwell(520);
  await demo.type(" -al", 2.5);
  await demo.dwell(1600);
  await demo.press("Enter");
  // `data-kind="output"`, not `.first()`: the echo is written synchronously and carries the same
  // testid, so the first line is visible the instant Enter lands. Waiting on that would let the
  // hold below spend itself on an echo and cut away before the listing came back over SSH.
  await expect(terminal.locator('[data-testid="terminal-line"][data-kind="output"]').first()).toBeVisible({
    timeout: 15_000,
  });
  await demo.dwell(3400);
  // ⎋ is handled on the panel itself rather than on the window, so it only lands while the caret
  // is still in the prompt: nothing may click elsewhere between the listing and this.
  await demo.press("Escape");
  await expect(terminal.getByTestId("terminal-output")).toHaveCount(0);
  // Off-frame on the same beat the panel drops, so the pointer's teleport hides under the one
  // change the eye is already following. Its home is (120, 620) — on the `Logs` favourite, which
  // answers a hover with a tooltip and a delete `✕` over the closing frames of the film.
  await demo.park(-40, -40);
  await demo.dwell(1400);

  // ── 14 ── At rest ────────────────────────────────────────────────────────
  // Two machines side by side, the treemap back under them — ⎋ remounts the strip the terminal
  // had taken the slot of — and no pointer at all: the closing frames.
  await demo.dwell(2200);
  // One last pointer move, which nobody sees. The screencast emits a frame only when something is
  // drawn and the recorder holds its final frame for a single sixtieth of a second, so on a still
  // closing shot the hold above is what would be lost.
  await demo.park(-41, -41);
});
