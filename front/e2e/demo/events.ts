import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Locator } from "@playwright/test";

/**
 * Everything the hand did during the take, on the film's clock — so an edit made
 * afterwards can frame it.
 *
 * The take is one continuous recording and needs no editing to be watched. A cut
 * made from it — the landing page's Remotion films — needs more than its pixels:
 * where the pointer was at every moment, when it pressed, what it typed, and the
 * box of the element each gesture was aimed at. That is what lets the edit zoom
 * onto a click, spotlight a widget and redraw the pointer at any size without
 * anyone placing a keyframe by hand, and what lets it name a beat by the mark it
 * touched (`budget-edit`) rather than by a second that moves on every re-take.
 *
 * Every time is milliseconds since the film's first frame — the zero the recorder
 * and the chapter clock are rebased to in `Demo.open`, so a gesture before it
 * (the pointer parked before the page loads) comes out negative. Every position is
 * in CSS pixels of the viewport; the mp4 carries `captureScale` frame pixels for
 * each of them.
 *
 * Written beside the mp4 as `events.json` on every take. It costs one `evaluate`
 * per gesture, which the pacing does not notice.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The element a gesture was aimed at, as the edit addresses it. */
export interface Target {
  /** The element's `data-testid`, or its nearest ancestor's: the family. */
  testid: string | null;
  /** Its other `data-*` attributes, prefix dropped: the member (`route`, `category`…). */
  data: Record<string, string>;
  /** Playwright's own description of the locator, for a human reading the log. */
  selector: string;
  /** Where it was drawn when the pointer reached it. */
  box: Box;
}

/** The storyboard's verbs, plus `mark`: where an element is, noted for the edit with no pointer and no time. */
export type Verb = "moveTo" | "click" | "fill" | "type" | "press" | "scroll" | "glide" | "dwell" | "mark";

export interface Gesture {
  verb: Verb;
  start: number;
  end: number;
  target?: Target;
  /** What was typed, for `fill` and `type`; the key's name, for `press`. */
  text?: string;
  /** Where a `glide` went: the donut and the bars hit-test a point, not an element. */
  point?: { x: number; y: number };
  /** How far a `scroll` wheeled, in CSS pixels. */
  distance?: number;
}

/** One press of the button: down, then up. */
export interface Press {
  at: number;
  release: number;
  x: number;
  y: number;
}

/** One character typed, or one named key pressed. */
export interface Key {
  at: number;
  key: string;
}

export interface EventLogMeta {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  /** Frame pixels per CSS pixel in the mp4, measured off its frames — see `jpegSize` in `recorder.ts`. */
  captureScale: number;
  durationMs: number;
  chapters: { title: string; atMs: number }[];
}

export interface EventLogFile extends EventLogMeta {
  version: 1;
  /** `[ms, x, y]` per pointer step: ~50 a second while it travels, none while it rests. */
  pointer: [number, number, number][];
  presses: Press[];
  keys: Key[];
  gestures: Gesture[];
}

/** A tenth of a pixel is below anything a frame can show, and it halves the file. */
const tenth = (value: number) => Math.round(value * 10) / 10;

export class EventLog {
  private readonly pointerSteps: [number, number, number][] = [];
  private readonly pressList: Press[] = [];
  private readonly keyList: Key[] = [];
  private readonly gestureList: Gesture[] = [];
  private pressed: { at: number; x: number; y: number } | null = null;

  constructor(private startedAt: number) {}

  /** Move the clock's zero. `Demo.open` does it once, with the recorder and the chapters. */
  rebase(startedAt: number): void {
    this.startedAt = startedAt;
  }

  /** Milliseconds on the film's clock. */
  now(): number {
    return Date.now() - this.startedAt;
  }

  pointer(x: number, y: number): void {
    this.pointerSteps.push([this.now(), tenth(x), tenth(y)]);
  }

  down(x: number, y: number): void {
    this.pressed = { at: this.now(), x: tenth(x), y: tenth(y) };
  }

  up(): void {
    if (!this.pressed) return;
    this.pressList.push({ ...this.pressed, release: this.now() });
    this.pressed = null;
  }

  key(key: string): void {
    this.keyList.push({ at: this.now(), key });
  }

  gesture(gesture: Gesture): void {
    this.gestureList.push(gesture);
  }

  write(to: string, meta: EventLogMeta): void {
    mkdirSync(dirname(to), { recursive: true });
    const file: EventLogFile = {
      version: 1,
      ...meta,
      pointer: this.pointerSteps,
      presses: this.pressList,
      keys: this.keyList,
      gestures: this.gestureList,
    };
    writeFileSync(to, `${JSON.stringify(file)}\n`, "utf8");
  }
}

/**
 * The target as the log files it: family, member and box, read in the same breath as
 * the box so the element is known to be there. Never called after a press — a submit
 * button is gone by then, and a locator waiting for it would hold the take.
 */
export async function describe(target: Locator, box: Box): Promise<Target> {
  const { testid, data } = await target.evaluate((node) => {
    const family = node.closest("[data-testid]") ?? node;
    const members: Record<string, string> = {};
    for (const attribute of Array.from(family.attributes)) {
      if (attribute.name.startsWith("data-") && attribute.name !== "data-testid") {
        members[attribute.name.slice(5)] = attribute.value;
      }
    }
    return { testid: family.getAttribute("data-testid"), data: members };
  });
  return {
    testid,
    data,
    selector: String(target),
    box: { x: tenth(box.x), y: tenth(box.y), width: tenth(box.width), height: tenth(box.height) },
  };
}
