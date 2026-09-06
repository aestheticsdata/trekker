import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sleep } from "@e2e/demo/pacing";

import type { Page } from "@playwright/test";

/**
 * Chapter marks, so the finished take needs no editing.
 *
 * The run is one continuous recording — one browser context, one video file —
 * which is the whole point: cutting fourteen separate clips together is the
 * work this is meant to avoid. What replaces the edit is this: every chapter
 * stamps the wall clock against the moment recording started, and the run
 * writes out a description-ready list at the end.
 *
 * Timestamps are approximate to within a frame or two — the video starts when
 * the page is created and there is no callback to say precisely when — which
 * is well inside the tolerance of a chapter mark.
 *
 * `DEMO_TITLES=on` also burns a small caption into the picture. Off by
 * default: it costs screen time the 90-second budget does not have, and a
 * portfolio video usually wants its own typography rather than this one.
 */

const TITLES_ON_SCREEN = process.env.DEMO_TITLES === "on";

/** How long a burnt-in caption stays up. Not awaited — the beats run under it. */
const CAPTION_MS = 2200;

export interface Mark {
  title: string;
  atMs: number;
}

function installCaption(): void {
  const ID = "sp-demo-caption";
  const scope = window as unknown as { __spDemoCaption?: (text: string, hold: number) => void };

  const mount = () => {
    const root = document.body ?? document.documentElement;
    if (!root) return;

    const style = document.createElement("style");
    style.textContent = `
      #${ID} {
        position: fixed; inset: auto auto 26px 28px; z-index: 2147483646;
        margin: 0; border: 0; overflow: visible;
        pointer-events: none; opacity: 0; transform: translateY(6px);
        transition: opacity 320ms ease-out, transform 320ms ease-out;
        padding: 7px 14px; border-radius: 8px;
        background: rgba(16, 16, 18, 0.82); color: #f4f4f5;
        font: 500 15px/1.3 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.01em; backdrop-filter: blur(6px);
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
      }
      #${ID}.is-on { opacity: 1; transform: translateY(0); }
    `;
    root.appendChild(style);

    const el = document.createElement("div");
    el.id = ID;
    root.appendChild(el);

    // Same top-layer problem the cursor has, and the same answer — see the
    // long note in `cursor.ts`. A caption behind a modal is a caption nobody
    // reads.
    try {
      el.setAttribute("popover", "manual");
      el.showPopover();
    } catch {
      // Falls back to the z-index above.
    }

    let timer = 0;
    scope.__spDemoCaption = (text: string, hold: number) => {
      if (!el.isConnected) (document.body ?? document.documentElement).appendChild(el);
      clearTimeout(timer);
      el.textContent = text;
      el.classList.add("is-on");
      timer = window.setTimeout(() => el.classList.remove("is-on"), hold);
    };
  };

  if (document.body ?? document.documentElement) mount();
  else addEventListener("DOMContentLoaded", mount, { once: true });
}

export class Chapters {
  private readonly marks: Mark[] = [];

  private constructor(
    private readonly page: Page,
    private startedAt: number,
  ) {}

  /** Move the clock's zero. `Demo.open` does it once, when the film starts — see `CdpRecorder.rebase`. */
  rebase(startedAt: number): void {
    this.startedAt = startedAt;
  }

  /** Milliseconds since the clock's zero. */
  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  static async install(page: Page, startedAt: number): Promise<Chapters> {
    if (TITLES_ON_SCREEN) await page.addInitScript(installCaption);
    return new Chapters(page, startedAt);
  }

  /**
   * Opens a chapter. Call it at the moment the viewer arrives at the thing the
   * chapter is about, not before the navigation that gets there — a mark
   * pointing at the tail of the previous chapter is a mark nobody can use.
   */
  async open(title: string): Promise<void> {
    this.marks.push({ title, atMs: Date.now() - this.startedAt });
    if (TITLES_ON_SCREEN) {
      await this.page
        .evaluate(
          ([text, hold]) => {
            (window as unknown as { __spDemoCaption?: (t: string, h: number) => void }).__spDemoCaption?.(
              text as string,
              hold as number,
            );
          },
          [title, CAPTION_MS] as const,
        )
        .catch(() => {
          // A caption that failed to draw — mid-navigation, most likely — is
          // never worth failing a take over. The mark itself is already taken.
        });
      await sleep(180);
    }
  }

  /** `1:04` — and `1:04:22` only if a take ever ran past the hour. */
  private static stamp(atMs: number): string {
    const total = Math.max(0, Math.round(atMs / 1000));
    const seconds = String(total % 60).padStart(2, "0");
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
  }

  /** `00:01:04.000` — WebVTT wants the hour, and milliseconds, always. */
  private static vttStamp(atMs: number): string {
    const ms = Math.max(0, Math.round(atMs));
    const hours = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
    const minutes = String(Math.floor(ms / 60_000) % 60).padStart(2, "0");
    const seconds = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}.${String(ms % 1000).padStart(3, "0")}`;
  }

  /**
   * Writes the list beside the video.
   *
   * The first mark is forced to 0:00 whatever the clock said: the opening
   * second of the take belongs to that chapter regardless, and a list that
   * starts a beat late reads as a mistake in every player that shows one.
   */
  write(to: string, totalMs: number): Mark[] {
    mkdirSync(dirname(to), { recursive: true });

    const marks = this.marks.map((mark, index) => (index === 0 ? { ...mark, atMs: 0 } : mark));
    const lines = marks.map((mark) => `${Chapters.stamp(mark.atMs)} ${mark.title}`);

    writeFileSync(to, [...lines, ""].join("\n"), "utf8");
    writeFileSync(to.replace(/\.txt$/, ".json"), `${JSON.stringify({ totalMs, marks }, null, 2)}\n`, "utf8");

    // Neither of the two files above is a standard: the `.txt` is a plain
    // `0:00 Title` list for a human to read or paste somewhere, and the `.json`
    // is this harness's own shape. The two below are actual formats, and they
    // are the ones a video on your own page needs — a `0:00 Title` line means
    // nothing to a <video>.
    writeFileSync(to.replace(/\.txt$/, ".vtt"), Chapters.vtt(marks, totalMs), "utf8");
    writeFileSync(to.replace(/\.txt$/, ".ffmeta"), Chapters.ffmeta(marks, totalMs), "utf8");
    return marks;
  }

  /**
   * WebVTT chapters, for `<track kind="chapters" src="chapters.vtt">` on a
   * `<video>`. Cues must not overlap, so each one ends where the next begins.
   */
  private static vtt(marks: Mark[], totalMs: number): string {
    const cues = marks.map((mark, index) => {
      const end = marks[index + 1]?.atMs ?? totalMs;
      return `${index + 1}\n${Chapters.vttStamp(mark.atMs)} --> ${Chapters.vttStamp(end)}\n${mark.title}\n`;
    });
    return `WEBVTT\n\n${cues.join("\n")}`;
  }

  /**
   * ffmpeg metadata, to write the chapters into the file itself:
   *
   *     ffmpeg -i demo.mp4 -i chapters.ffmeta -map_metadata 1 -codec copy out.mp4
   *
   * Timebase 1/1000 so the offsets below are plain milliseconds.
   */
  private static ffmeta(marks: Mark[], totalMs: number): string {
    const chapters = marks.map((mark, index) => {
      const end = marks[index + 1]?.atMs ?? totalMs;
      return `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(mark.atMs)}\nEND=${Math.round(end)}\ntitle=${mark.title}`;
    });
    return `;FFMETADATA1\n${chapters.join("\n")}\n`;
  }

  static path(dir: string): string {
    return join(dir, "chapters.txt");
  }
}
