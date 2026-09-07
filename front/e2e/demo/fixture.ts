import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Chapters } from "@e2e/demo/chapters";
import { Cursor } from "@e2e/demo/cursor";
import { PACE, resetJitter, sleep } from "@e2e/demo/pacing";
import { CdpRecorder } from "@e2e/demo/recorder";
import { test as base } from "@playwright/test";

import type { GestureOptions } from "@e2e/demo/cursor";
import type { Locator, Page } from "@playwright/test";

/**
 * The demo fixture: one continuous take, from a signed-in shell to a written
 * chapter list.
 *
 * Everything a scenario needs is on `demo`, and nothing else should be: a
 * scenario file is meant to read as a storyboard — click this, dwell here,
 * open that chapter — with the mechanics of pointer paths, caption overlays
 * and video files kept out of it entirely.
 */

/** Beside the scenario rather than in Playwright's output dir, which is wiped per run. */
export const OUT_DIR = join(__dirname, "out");

/**
 * `DEMO_RECORDER=playwright` falls back to Playwright's own recorder — 25fps
 * VP8 at whatever `-speed 8` produces. Kept for comparison, and as a way out if
 * ffmpeg is missing. See `recorder.ts` for why it is not the default.
 */
const USE_PLAYWRIGHT_RECORDER = process.env.DEMO_RECORDER === "playwright";

/**
 * How long a `networkidle` wait is given before it is abandoned.
 *
 * It has to be stated, and the reason is not obvious. Under the test runner
 * Playwright defaults `navigationTimeout` to `0`, and `0` means *no timeout*
 * (`navigationTimeout: [0]` in `playwright/lib/index.js`, then
 * `setDefaultNavigationTimeout(0)`, and `kNoTimeout` in `timeoutSettings.ts`).
 * So an unqualified `waitForLoadState("networkidle")` never rejects: on an app
 * that holds a socket open — a live layer, SSE, a polling query — it blocks
 * until the whole test times out, eight minutes later, and the `.catch()`
 * wrapped around it never runs. Any app modern enough to be worth filming is a
 * candidate for that.
 */
const SETTLE_TIMEOUT = 5_000;

/** How long a stylesheet the page asked for is given to turn up. */
const STYLESHEET_TIMEOUT = 10_000;

/**
 * Waits for the page to finish dressing itself — and refuses to go on if it
 * never does.
 *
 * Spira, where this harness comes from, shipped a whole take before anyone
 * looked closely. It draws its project icons with a ligature font served from
 * fonts.googleapis.com, so `graph_3` is markup that only becomes a glyph once
 * that stylesheet lands. It did not land. Every icon in the film, and in all
 * four stills cut from it, is the literal word `graph_3` spilling out of an
 * 18px box and across the name beside it. Nothing threw, nothing timed out,
 * and the run reported a clean ninety-six seconds.
 *
 * Trekker cannot fail that way today: its fonts come through
 * `next/font`, which self-hosts them at build time, so nothing the document
 * asks for is third-party. The check is here because the two harnesses are
 * copies of each other, and whoever adds the first `<link>` should not have to
 * find this a second time. On a fully self-hosted app it costs a few
 * milliseconds and never fires, which is the point.
 *
 * `document.fonts.ready` earns its place on its own terms: `next/font` swaps,
 * the stills pass navigates afresh for every shot, and paced sleep is not a
 * guarantee that the swap happened before the shutter.
 *
 * `document.fonts.check()` is the obvious guard and it is useless here: with
 * the stylesheet gone the family is never declared, the query matches no face,
 * and it returns true. It answers "is anything blocking on this font", not "is
 * this font going to draw".
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT }).catch(() => {
    // A socket the live layer holds open keeps `networkidle` from ever
    // settling on some pages. The beats that follow wait on real elements.
  });

  const failed = await page
    .waitForFunction(
      () => [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].every((link) => link.sheet),
      undefined,
      { timeout: STYLESHEET_TIMEOUT },
    )
    .then(() => [] as string[])
    .catch(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
          .filter((link) => !link.sheet)
          .map((link) => link.href),
      ),
    );

  if (failed.length > 0) {
    throw new Error(
      "demo: the page never got a stylesheet it asked for, and filming it would " +
        "record the app half-dressed — an icon font that has not arrived draws " +
        "its ligature names as words.\n    Unreachable:\n      " +
        failed.join("\n      ") +
        "\n    Check the machine is online, then run it again.",
    );
  }

  // Declared and fetched is not yet drawn: this is the swap itself.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  await sleep(PACE.navigate);
}

/**
 * Anything a dev build floats over the app and a portfolio video must not show.
 *
 * Next's three, plus the TanStack devtools, which `src/app/providers.tsx` mounts unconditionally —
 * a no-op in a production build, a floating logo in a dev one. The app's own toast viewport is
 * deliberately absent — a toast is the explorer talking, not the toolchain, and the take is
 * read-only anyway.
 */
function hideDevChrome(): void {
  const mount = () => {
    const root = document.body ?? document.documentElement;
    if (!root) return;
    const style = document.createElement("style");
    style.textContent = `
      nextjs-portal,
      #__next-build-watcher,
      [data-nextjs-toast],
      .tsqd-parent-container,
      [aria-label="Open Tanstack query devtools"] { display: none !important; }
    `;
    root.appendChild(style);
  };
  if (document.body ?? document.documentElement) mount();
  else addEventListener("DOMContentLoaded", mount, { once: true });
}

/**
 * What a still may do to the page before the shutter, once the revisit has
 * settled: open a modal, type into the palette, pick files. It drives the real
 * page — `page.mouse`, `page.keyboard`, plain locators — never the drawn
 * pointer, which is painted out of the picture anyway. See `Demo.shot()`.
 */
export type Prepare = (page: Page) => Promise<void>;

/**
 * A screen worth a picture: the name it gets filed under, where it was, and
 * what to do there before the shutter. See `Demo.shot()` for why a URL and not
 * a moment.
 */
interface Still {
  name: string;
  url: string;
  prepare?: Prepare;
}

export class Demo {
  /** Screens the storyboard asked for a picture of. Read by the teardown. */
  readonly stills: Still[] = [];

  constructor(
    readonly page: Page,
    private readonly cursor: Cursor,
    private readonly chapters: Chapters,
    private readonly recorder: CdpRecorder | null,
  ) {}

  /** Opens a chapter at the current moment of the recording. */
  chapter(title: string): Promise<void> {
    return this.chapters.open(title);
  }

  /** The one navigation a take types rather than clicks: its first. */
  private opened = false;

  async open(path: string): Promise<void> {
    await this.page.goto(path);
    // The only navigation of the take, so the only chance to find out whether
    // the app has everything it needs to draw itself. Everything after this is
    // a client-side route change onto a document that already settled here.
    await settle(this.page);

    // The film and the chapter clock both start HERE, on a page that has
    // painted — never on the `about:blank` the screencast was opened over.
    // Once: a second `open` would be a cut, not a new film.
    if (!this.opened) {
      this.opened = true;
      const now = Date.now();
      this.recorder?.rebase(now / 1000);
      this.chapters.rebase(now);
    }
  }

  moveTo(target: Locator, options?: GestureOptions): Promise<void> {
    return this.cursor.moveTo(target, options);
  }

  click(target: Locator, options?: GestureOptions): Promise<void> {
    return this.cursor.click(target, options);
  }

  /** Click a field, then type into it at a human rate. */
  async fill(target: Locator, text: string, options?: GestureOptions): Promise<void> {
    await this.cursor.click(target, options);
    await this.cursor.type(text);
    await sleep(PACE.settle);
  }

  /** `rate` slows one line without retiming the film — see `Cursor.type`. */
  type(text: string, rate?: number): Promise<void> {
    return this.cursor.type(text, rate);
  }

  press(key: string, options?: GestureOptions): Promise<void> {
    return this.cursor.press(key, options);
  }

  /**
   * Scroll a list, with the pointer over it first — the wheel goes to whatever
   * is under the cursor, not to whatever has focus, so scrolling a list from a
   * pointer parked on the sidebar scrolls the sidebar.
   */
  async scroll(over: Locator, distance: number, duration?: number): Promise<void> {
    await this.cursor.moveTo(over);
    await this.cursor.wheel(distance, duration);
    await sleep(PACE.settle);
  }

  /** Time on screen with nothing happening: the beat that lets a viewer read. */
  dwell(base: number = PACE.dwell): Promise<void> {
    return sleep(base);
  }

  park(x?: number, y?: number): Promise<void> {
    return this.cursor.park(x, y);
  }

  /**
   * Marks the screen on show as one to photograph.
   *
   * It takes nothing here. It writes down the URL, and that is all — the
   * pictures are taken further down, once the recorder has stopped, which is
   * the whole point: painting the drawn pointer out for a capture would blink
   * it out of the video for a few frames, and no still is worth costing the
   * take.
   *
   * The price is that only an addressable screen can be shot as it is. An
   * open dialog, a typed query, a chosen set of files: none of those survive a
   * revisit — so a still that wants one says how to get there again.
   * `prepare` runs on the revisited page, after it has settled and before the
   * shutter, and does with plain Playwright what the take did with the drawn
   * pointer. It must be repeatable and must not write: the stills pass runs
   * after the take, on whatever the take left, and again on the next run.
   */
  shot(name: string, prepare?: Prepare): void {
    // The name becomes a filename, so it is checked here rather than in the
    // teardown — a slash in it would write outside `out/shots`, or throw after
    // the whole take is already on disk.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(`demo: shot name must be lower-case kebab, got "${name}"`);
    }
    this.stills.push({ name, url: this.page.url(), prepare });
  }
}

/**
 * The stills pass — same page, same session, after the video is closed.
 *
 * A screenshot comes out at the viewport times `deviceScaleFactor`, so the 2x
 * that supersamples the video gives 3840x2160 here: twice the resolution of the
 * mp4, lossless, and with the harness's own overlays painted out. Pulling the
 * same frames back out of the finished video with ffmpeg cannot do any of
 * that — it is capped at 1080p, it is h264, and the pointer is baked in.
 */
async function captureStills(page: Page, stills: Still[], dir: string): Promise<string[]> {
  if (stills.length === 0) return [];
  // Wiped, not merged: the files are numbered by position, so a renamed or
  // dropped shot would otherwise leave last run's picture sitting in the
  // folder under a number that now belongs to something else.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  for (const [index, still] of stills.entries()) {
    // Every still is a fresh document, so each one gets the same check the
    // take got: these are the frames that end up on a landing page, at twice
    // the resolution, where a font that has not swapped in is unmissable.
    await page.goto(still.url);
    await settle(page);
    // Then whatever the still asked for, and a beat for it to draw: a modal
    // animates in, a palette ranks its rows, a file list lays out.
    if (still.prepare) {
      await still.prepare(page);
      await sleep(PACE.navigate);
    }

    const file = join(dir, `${String(index + 1).padStart(2, "0")}-${still.name}.png`);
    await page.screenshot({
      path: file,
      // Injected for the capture and removed after it. A portfolio still
      // should look like the app, not like a recording of one.
      style: "#sp-demo-cursor, #sp-demo-caption { display: none !important; }",
      animations: "disabled",
      caret: "hide",
    });
    files.push(file);
  }
  return files;
}

export const test = base.extend<{ demo: Demo }>({
  demo: async ({ page }, use) => {
    resetJitter();
    await page.addInitScript(hideDevChrome);
    const cursor = await Cursor.install(page);

    // Opened now, over a blank page, so that nothing the take draws is missed;
    // the film's actual first instant is set by `Demo.open`, once the app has
    // painted, and the chapter clock is moved to the same instant there.
    const recorder = USE_PLAYWRIGHT_RECORDER ? null : await CdpRecorder.start(page, join(OUT_DIR, "frames"));

    const chapters = await Chapters.install(page, Date.now());
    await cursor.park();

    const demo = new Demo(page, cursor, chapters, recorder);
    await use(demo);

    const totalMs = chapters.elapsed();

    // Chapters before the encode, so the encode can write them into the file.
    const marks = chapters.write(Chapters.path(OUT_DIR), totalMs);

    // Ours first, while the page is still open — it is reading a live CDP
    // session. Playwright's own recorder only finalises on close.
    let captured = "";
    if (recorder) {
      const { frames, sourceFps } = await recorder.stop(
        join(OUT_DIR, "trekker-demo.mp4"),
        Chapters.path(OUT_DIR).replace(/\.txt$/, ".ffmeta"),
      );
      captured = `, ${frames} frames at ${sourceFps.toFixed(1)}fps from Chromium`;
    }

    // After the encode, deliberately — see `shot()`. The one exception is
    // `DEMO_RECORDER=playwright`, whose recorder cannot be stopped before the
    // page closes: there, these revisits land in the tail of the webm.
    const shots = await captureStills(page, demo.stills, join(OUT_DIR, "shots"));

    const video = page.video();
    // Closing the page is what finalises Playwright's recording; without it
    // `saveAs` waits for a context teardown that has not been asked for yet.
    await page.close();
    if (video) await video.saveAs(join(OUT_DIR, "trekker-demo.webm"));

    const seconds = (totalMs / 1000).toFixed(1);
    console.log(`\n  demo: ${seconds}s, ${marks.length} chapters${captured} -> ${OUT_DIR}`);
    for (const mark of marks) console.log(`    ${(mark.atMs / 1000).toFixed(1).padStart(6)}s  ${mark.title}`);
    if (shots.length > 0) console.log(`  stills: ${shots.length} -> ${join(OUT_DIR, "shots")}`);
  },
});

export { expect } from "@playwright/test";
