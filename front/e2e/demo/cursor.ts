import { ease, glideMs, jitter, ms, PACE, sleep } from "@e2e/demo/pacing";

import type { Locator, Page } from "@playwright/test";

/**
 * A pointer the camera can see.
 *
 * Playwright can draw one — `recordVideo.showActions` renders an arrow — but it
 * only blinks in around each action and hops to the next action point, never
 * showing the travel, which on a demo is most of what there is to see. And
 * `locator.click()` teleports the real mouse, so there is no continuous motion
 * to film in the first place.
 *
 * Both halves are fixed here. An init script draws an arrow that follows the
 * *real* mouse events, and every gesture below drives the real mouse along an
 * eased, slightly curved path — so hover states, menus and focus rings all fire
 * exactly as they would under a hand, and the arrow is simply along for the
 * ride.
 *
 * The arrow is drawn from a `mousemove` listener inside the page rather than
 * from Node, which matters more than it looks: it means one CDP call per
 * frame instead of two, and a 70ms CSS transition smooths the gap between
 * frames, so the path stays fluid even when the app is busy rendering.
 *
 * Set `DEMO_CURSOR=off` to skip the overlay entirely — the right setting when
 * filming a headed browser with a screen recorder, where the OS already draws
 * a real one.
 */

export const CURSOR_ENABLED = process.env.DEMO_CURSOR !== "off";

/** Where the pointer starts a take: off to one side, out of the way. */
const HOME = { x: 120, y: 620 };

interface CursorOptions {
  /** Hide the OS pointer, so a headed recording does not show two of them. */
  hideNative: boolean;
}

/**
 * Runs inside the page, on every document — a navigation re-runs it, which is
 * why the last position is parked in `sessionStorage`: the arrow comes back on
 * the new page already in the right place, instead of blinking in at 0,0 or
 * waiting for the next mouse event.
 */
function installOverlay(options: CursorOptions): void {
  const ID = "sp-demo-cursor";
  const KEY = "sp-demo-cursor-pos";
  const scope = window as unknown as { __spDemoCursor?: boolean };
  if (scope.__spDemoCursor) return;
  scope.__spDemoCursor = true;

  const mount = () => {
    const root = document.body ?? document.documentElement;
    if (!root) return;

    const style = document.createElement("style");
    style.textContent = `
      #${ID} {
        position: fixed; inset: 0 auto auto 0; width: 24px; height: 26px;
        margin: 0; border: 0; padding: 0; background: none; overflow: visible;
        z-index: 2147483647; pointer-events: none; opacity: 0;
        transition: transform 70ms linear, opacity 140ms ease-out;
        will-change: transform;
      }
      #${ID}.is-live { opacity: 1; }
      #${ID} svg {
        display: block; overflow: visible;
        filter: drop-shadow(0 1px 2.5px rgba(0, 0, 0, 0.5));
        transition: transform 90ms ease-out;
      }
      #${ID}.is-press svg { transform: scale(0.86); }
      #${ID} i {
        position: absolute; left: -11px; top: -11px; width: 30px; height: 30px;
        border-radius: 999px; border: 2px solid rgba(255, 255, 255, 0.92);
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
        opacity: 0; transform: scale(0.3);
      }
      #${ID}.is-press i { animation: sp-demo-ping 460ms ease-out; }
      @keyframes sp-demo-ping {
        0% { opacity: 0.95; transform: scale(0.25); }
        100% { opacity: 0; transform: scale(1.2); }
      }
      ${options.hideNative ? "html, html * { cursor: none !important; }" : ""}
    `;
    root.appendChild(style);

    const el = document.createElement("div");
    el.id = ID;
    el.innerHTML =
      '<i></i><svg width="24" height="26" viewBox="0 0 24 26" fill="none">' +
      '<path d="M2 1.6 L2 19.2 L6.6 14.8 L9.6 21.4 L12.7 20 L9.7 13.6 L16 13.4 Z"' +
      ' fill="#ffffff" stroke="#111111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    root.appendChild(el);

    /**
     * A modal `<dialog>` or an open popover is painted in the top layer, which
     * sits above every z-index there is — the arrow simply vanishes behind the
     * first modal the demo opens. The only way back on top is to join the top
     * layer, so the arrow is a manual popover, re-promoted whenever something
     * else enters the layer (promotion order is what decides who is above).
     *
     * Radix builds its dialogs out of portalled divs, so Spira never trips
     * this; a project using the native element or the popover API would.
     */
    let layer = "";
    const promote = () => {
      try {
        el.hidePopover();
        el.showPopover();
      } catch {
        // No popover support, or the element is not connected. The z-index
        // above is still in force — only the top layer is out of reach.
      }
    };

    try {
      el.setAttribute("popover", "manual");
      promote();
      setInterval(() => {
        const signature = `${document.querySelectorAll("dialog[open]").length}/${
          document.querySelectorAll(":popover-open").length
        }`;
        if (signature === layer) return;
        layer = signature;
        promote();
      }, 200);
    } catch {
      // As above: a browser without the popover API keeps the z-index arrow.
    }

    const place = (x: number, y: number) => {
      // React never touches this node — it lives beside the root, not in it —
      // but a full document replacement would, so it re-seats itself.
      if (!el.isConnected) (document.body ?? document.documentElement).appendChild(el);
      el.style.transform = `translate3d(${x - 2}px, ${y - 1}px, 0)`;
      el.classList.add("is-live");
      try {
        sessionStorage.setItem(KEY, `${x},${y}`);
      } catch {
        // Private mode, or a document with no storage. The arrow simply waits
        // for the next mouse event instead of restoring — never a failure.
      }
    };

    try {
      const [x, y] = (sessionStorage.getItem(KEY) ?? "").split(",").map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) place(x, y);
    } catch {
      // Same as above.
    }

    addEventListener("mousemove", (event) => place(event.clientX, event.clientY), {
      capture: true,
      passive: true,
    });
    addEventListener(
      "mousedown",
      () => {
        el.classList.remove("is-press");
        el.getBoundingClientRect();
        el.classList.add("is-press");
      },
      { capture: true, passive: true },
    );
    addEventListener("mouseup", () => el.classList.remove("is-press"), { capture: true, passive: true });
  };

  if (document.body ?? document.documentElement) mount();
  else addEventListener("DOMContentLoaded", mount, { once: true });
}

/** Where on a target the pointer should land. */
export type Aim = "center" | "text";

export interface GestureOptions {
  /** `text` aims near the leading edge — a full-width row is not clicked in the middle. */
  aim?: Aim;
  /** Extra reading time after the gesture, on top of the standard settle. */
  dwell?: number;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Where on a box the pointer lands. `text` aims a short way in from the leading
 * edge, because a full-width row is not clicked in the middle by a hand — the
 * eye goes to the title, and the middle of a 1660px row is empty space.
 */
function aimAt(box: { x: number; y: number; width: number; height: number } | null, aim: Aim): Point | null {
  if (!box) return null;
  const x = aim === "text" ? box.x + Math.min(box.width * 0.5, 26) : box.x + box.width / 2;
  return { x, y: box.y + box.height / 2 };
}

/** Comfortably inside, not merely on screen: a point 2px from the edge is not aimable. */
function inside(point: Point, view: { width: number; height: number }): boolean {
  return point.x > 8 && point.y > 8 && point.x < view.width - 8 && point.y < view.height - 8;
}

export class Cursor {
  private x = HOME.x;
  private y = HOME.y;
  /** Flipped per move so consecutive glides do not all bow the same way. */
  private bow = 1;

  private constructor(private readonly page: Page) {}

  /** Must be called before the first navigation — init scripts are per-context. */
  static async install(page: Page): Promise<Cursor> {
    if (CURSOR_ENABLED) {
      await page.addInitScript(installOverlay, { hideNative: true } satisfies CursorOptions);
    }
    return new Cursor(page);
  }

  /** Put the pointer somewhere with no animation, before the take really starts. */
  async park(x: number = HOME.x, y: number = HOME.y): Promise<void> {
    this.x = x;
    this.y = y;
    await this.page.mouse.move(x, y);
  }

  /**
   * The real mouse, walked to a point along a gently curved, eased path.
   *
   * The curve is the tell. A straight line between two points is the one thing
   * a hand never draws, and at 50fps the difference is plainly visible.
   */
  async glideTo(x: number, y: number): Promise<void> {
    const dx = x - this.x;
    const dy = y - this.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return;

    const duration = ms(glideMs(distance));
    const frames = Math.max(2, Math.round(duration / ms(PACE.frame)));

    // A control point pushed off the midpoint, perpendicular to the travel.
    const lift = Math.min(60, distance * 0.12) * this.bow;
    const cx = this.x + dx / 2 - (dy / distance) * lift;
    const cy = this.y + dy / 2 + (dx / distance) * lift;
    this.bow *= -1;

    const startedAt = Date.now();
    const from = { x: this.x, y: this.y };

    for (let frame = 1; frame <= frames; frame++) {
      const t = ease(frame / frames);
      const inv = 1 - t;
      const px = inv * inv * from.x + 2 * inv * t * cx + t * t * x;
      const py = inv * inv * from.y + 2 * inv * t * cy + t * t * y;
      await this.page.mouse.move(px, py);

      // Held to the wall clock rather than to a fixed sleep: a slow CDP round
      // trip must eat into the next frame's wait, not stretch the whole glide.
      const behind = Date.now() - startedAt - (duration * frame) / frames;
      if (behind < 0) await new Promise((resolve) => setTimeout(resolve, -behind));
    }

    this.x = x;
    this.y = y;
  }

  /** The point on a locator the pointer should travel to. */
  private async pointOn(target: Locator, aim: Aim): Promise<{ x: number; y: number }> {
    let point = aimAt(await target.boundingBox(), aim);
    const view = this.page.viewportSize();

    // The test is on the POINT, never on the box. A scroll container is taller
    // than the window by definition, so a box-overflow test would decide the
    // list needs scrolling into view every time the pointer is sent to it.
    //
    // And when a scroll really is needed, it is eased rather than jumped:
    // `scrollIntoViewIfNeeded()` teleports, so on camera the rows are simply
    // somewhere else in the next frame — the one cut this harness exists to
    // avoid. The jump stays as a fallback for when the smooth scroll got
    // nowhere, because a take that stops is worse than a take with a cut.
    if (!point || !view || !inside(point, view)) {
      await target.evaluate((node) => node.scrollIntoView({ behavior: "smooth", block: "center" }));
      await sleep(PACE.navigate);
      point = aimAt(await target.boundingBox(), aim);
    }
    if (!point) {
      await target.scrollIntoViewIfNeeded();
      point = aimAt(await target.boundingBox(), aim);
    }
    if (!point) throw new Error(`demo: ${target} has no box to point at — is it visible?`);
    return point;
  }

  async moveTo(target: Locator, options: GestureOptions = {}): Promise<void> {
    // Bounded, deliberately. Under the test runner `waitFor` inherits the TEST timeout — eight
    // minutes here — so a hover aimed at an element that is not there (a tooltip trigger the
    // corpus did not fill, a chart mark the chart did not draw) held a take frozen for eight
    // minutes and then failed with a line number. Fifteen seconds is longer than any screen in
    // these consoles takes to draw, and short enough that the failure says what it is.
    await target.waitFor({ state: "visible", timeout: 15_000 });
    const point = await this.pointOn(target, options.aim ?? "center");
    await this.glideTo(point.x, point.y);
    if (options.dwell) await sleep(options.dwell);
  }

  /**
   * Is the target the thing actually painted at this point?
   *
   * `inside()` above only asks whether the point is in the window, and that is
   * not the same question. A row scrolled out of a PANEL's own scroller is
   * still in the window: its layout box has not moved, the container merely
   * clips it. So the box test passes, the pointer is sent to a coordinate the
   * row is not drawn at, and the press lands on whatever is drawn there — the
   * panel header, a neighbouring row, nothing at all. No error, no failed
   * click, just a beat that silently did not happen and an assertion failing
   * four lines later about something that looks unrelated.
   *
   * A hit test is the only thing that catches that, and it catches the other
   * case too: a tooltip or a sticky header sitting over the target.
   *
   * ⚠️ The topmost element must be the target or INSIDE it. `top.contains(node)`
   * would also be true when `top` is the clipping scroller — the exact case
   * this exists to reject.
   */
  private paintedAt(target: Locator, point: Point): Promise<boolean> {
    return target.evaluate((node, at) => {
      const top = document.elementFromPoint(at.x, at.y);
      return top !== null && (top === node || node.contains(top));
    }, point);
  }

  /**
   * Aim, hesitate, press.
   *
   * Deliberately not `locator.click()`: that would jump the mouse to the
   * element and undo the whole point. The actionability the click helper
   * normally provides is bought back by the `waitFor` and the scroll in
   * `pointOn` above, plus the hit test here.
   */
  async click(target: Locator, options: GestureOptions = {}): Promise<void> {
    await this.moveTo(target, options);

    // Only on a press, never on a hover. A hover that lands a few pixels off
    // shows the wrong tooltip for a moment; a press that lands on the wrong
    // element changes the take. And some chart marks are `pointer-events: none`
    // by design — they resolve their bubble from one handler on the container —
    // so hovering them would fail this test forever with nothing wrong.
    if (!(await this.paintedAt(target, { x: this.x, y: this.y }))) {
      await target.evaluate((node) => node.scrollIntoView({ behavior: "smooth", block: "center" }));
      await sleep(PACE.navigate);
      await this.moveTo(target, { aim: options.aim });
    }

    await sleep(PACE.aim);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
    await sleep(PACE.settle + (options.dwell ?? 0));
  }

  /**
   * Human-rate typing: jittered, and slower after the punctuation a hand pauses on.
   *
   * `rate` stretches the gaps for one call. The film's usual rate is right for a path nobody
   * reads letter by letter and wrong for a short command the beat exists to show being written,
   * and `DEMO_SPEED` cannot serve both — it retimes all 333 seconds at once.
   */
  async type(text: string, rate = 1): Promise<void> {
    for (const character of text) {
      await this.page.keyboard.type(character);
      const pause = PACE.keystroke * rate * (0.55 + jitter() * 0.9) + (/[ .,:—]/.test(character) ? 45 : 0);
      await sleep(pause);
    }
  }

  async press(key: string, options: GestureOptions = {}): Promise<void> {
    await this.page.keyboard.press(key);
    await sleep(PACE.settle + (options.dwell ?? 0));
  }

  /**
   * A trackpad flick over whatever is under the pointer.
   *
   * Eased, and in many small deltas rather than one big one, because a single
   * `wheel(0, 900)` is a jump cut: the list is simply somewhere else in the
   * next frame. Point the cursor at the list first — the wheel goes to the
   * element under it, not to the focused one.
   */
  async wheel(distance: number, duration: number = PACE.scroll): Promise<void> {
    const total = ms(duration);
    const frames = Math.max(4, Math.round(total / ms(PACE.frame)));
    const startedAt = Date.now();
    let sent = 0;

    for (let frame = 1; frame <= frames; frame++) {
      const target = Math.round(distance * ease(frame / frames));
      await this.page.mouse.wheel(0, target - sent);
      sent = target;
      const behind = Date.now() - startedAt - (total * frame) / frames;
      if (behind < 0) await new Promise((resolve) => setTimeout(resolve, -behind));
    }
  }
}
