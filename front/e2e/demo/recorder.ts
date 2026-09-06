import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CDPSession, Page } from "@playwright/test";

/**
 * Recording the screencast ourselves, because Playwright throws most of it away.
 *
 * Its recorder is fixed at 25fps and encodes live, with these arguments written
 * into `videoRecorder.ts` and exposed nowhere:
 *
 *     -r 25 -c:v vp8 -qmin 0 -qmax 50 -crf 8 -deadline realtime -speed 8 -b:v 1M
 *
 * `-deadline realtime -speed 8` is VP8's fastest and worst setting. It has to
 * be, because it is encoding while the run is happening, and that — not the
 * frame rate — is what costs the picture.
 *
 * MEASURED, because the obvious assumption is wrong: over a 96.6s take Chromium
 * delivered 2006 frames, or 20.8 a second. `-r 25` was never throwing anything
 * away; the screencast simply does not produce 25 frames a second on a mostly
 * still UI, because it emits a frame only when the compositor draws one. So
 * this does NOT buy smoothness, and nothing here will: the ceiling is
 * Chromium's, not Playwright's. Capturing a headed window with a screen
 * recorder is the only way past it, because that samples the OS compositor
 * rather than the screencast.
 *
 * What it does buy is the picture. The same frames, kept at JPEG 95 and encoded
 * once at the end with x264 at crf 16, instead of thrown at a realtime VP8
 * encoder holding a 1 Mbps target. Offline, quality costs only time.
 *
 * Going through the trace instead — which is what the tools built on
 * `.render({ resolution: '1080p' })` do — is not the same thing. Tracing adds a
 * screencast client with no size, so Chromium is asked for
 * `800 / max(width, height)` of the viewport (800x450 from 1080p), and the
 * tracing recorder throttles acks to one frame per 200ms outside an action.
 * That path upscales 800x450 at 5fps.
 */

/** JPEG quality asked of Chromium. 95 is visually lossless on flat UI. */
const FRAME_QUALITY = 95;

/**
 * Output frame rate. Higher than the ~21 the screencast actually delivers, on
 * purpose: the frames arrive at irregular intervals, and a 60Hz grid quantises
 * their timing less than a 30Hz one, so motion keeps the cadence it was
 * captured with. It does not invent smoothness — a still page stays still.
 */
const OUTPUT_FPS = Number(process.env.DEMO_FPS ?? 60);

/** x264 quality. 16 is high; every point down roughly doubles the file. */
const CRF = Number(process.env.DEMO_CRF ?? 16);

interface Frame {
  file: string;
  /** Chromium's wall-clock timestamp for the frame, in seconds. */
  at: number;
}

export class CdpRecorder {
  private readonly frames: Frame[] = [];
  private readonly writes: Promise<unknown>[] = [];
  private index = 0;
  private stopped = false;

  private constructor(
    private readonly cdp: CDPSession,
    private readonly frameDir: string,
  ) {}

  static async start(page: Page, frameDir: string): Promise<CdpRecorder> {
    rmSync(frameDir, { recursive: true, force: true });
    mkdirSync(frameDir, { recursive: true });

    const cdp = await page.context().newCDPSession(page);
    const recorder = new CdpRecorder(cdp, frameDir);

    cdp.on("Page.screencastFrame", (event) => {
      // Acknowledge first and always. Chromium sends the next frame only once
      // the last is acked, so a throw in here does not drop a frame — it ends
      // the recording.
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
      if (recorder.stopped) return;

      const file = join(frameDir, `f${String(recorder.index++).padStart(6, "0")}.jpg`);
      recorder.frames.push({ file, at: event.metadata.timestamp ?? 0 });
      recorder.writes.push(writeFile(file, Buffer.from(event.data, "base64")));
    });

    const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: FRAME_QUALITY,
      // In CSS pixels. The compositor surface is twice this at the default 2x,
      // so Chromium downsamples into the frame and the result is supersampled —
      // the same trick that made the old path look better, for free.
      //
      // Rounded down to even, as Playwright's own screencast does: yuv420p
      // cannot represent an odd dimension, so an odd viewport would fail the
      // encode at the very end of the take, after all the expensive work.
      maxWidth: viewport.width & ~1,
      maxHeight: viewport.height & ~1,
      everyNthFrame: 1,
    });

    return recorder;
  }

  /**
   * Make `atSeconds` (Chromium's clock, seconds since the epoch — the same clock
   * the frames carry) the first instant of the film. Frames from before it are
   * dropped, except the last one, which is re-stamped to `atSeconds`: the
   * picture that was on screen at that moment is the picture the film opens on,
   * held from t=0 until the next repaint.
   *
   * Why: the screencast is opened before the take navigates anywhere, so its
   * first frame is `about:blank` — white. Whether that frame is ever seen
   * depends on how quickly the app's first paint follows it, which is why Zeus
   * opened on its ground and Iknos opened on ten white frames (IKN-67). The
   * cure is not to race the first paint but to start the film after it: `open`
   * calls this once the page has settled.
   */
  rebase(atSeconds: number): void {
    let first = 0;
    for (let index = 0; index < this.frames.length && this.frames[index].at <= atSeconds; index += 1) first = index;
    if (this.frames.length === 0 || this.frames[first].at > atSeconds) return;
    this.frames.splice(0, first);
    this.frames[0].at = atSeconds;
  }

  /** Frames captured so far, and the rate they arrived at. For reporting. */
  get captured(): { frames: number; fps: number } {
    const first = this.frames[0]?.at ?? 0;
    const last = this.frames.at(-1)?.at ?? 0;
    const span = last - first;
    return { frames: this.frames.length, fps: span > 0 ? this.frames.length / span : 0 };
  }

  async stop(outputFile: string, metadataFile?: string): Promise<{ frames: number; sourceFps: number }> {
    if (this.stopped) return { frames: 0, sourceFps: 0 };
    this.stopped = true;

    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await this.cdp.detach().catch(() => {});
    await Promise.all(this.writes);

    const captured = this.captured;
    if (this.frames.length === 0) throw new Error("demo: the screencast produced no frames");

    // ffmpeg's concat demuxer, one entry per frame with the duration it was
    // actually on screen. This is what keeps the video in step with the run:
    // the encoder holds a frame for exactly as long as Chromium did, rather
    // than assuming a constant source rate that never existed.
    const lines: string[] = ["ffconcat version 1.0"];
    for (const [position, frame] of this.frames.entries()) {
      const next = this.frames[position + 1];
      const duration = next ? Math.max(0.001, next.at - frame.at) : 1 / OUTPUT_FPS;
      lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(6)}`);
    }
    // The concat demuxer ignores the last entry's duration unless the file is
    // named twice; without this the final frame is dropped.
    lines.push(`file '${this.frames.at(-1)?.file}'`);

    const listFile = join(this.frameDir, "frames.txt");
    writeFileSync(listFile, `${lines.join("\n")}\n`, "utf8");

    await encode(listFile, outputFile, metadataFile);
    rmSync(this.frameDir, { recursive: true, force: true });

    return { frames: captured.frames, sourceFps: captured.fps };
  }
}

function encode(listFile: string, outputFile: string, metadataFile?: string): Promise<void> {
  // The chapters ride along in this same pass rather than in a remux after it:
  // ffmpeg is already running, and `-map_metadata 1` costs nothing.
  const metadata = metadataFile ? ["-i", metadataFile, "-map_metadata", "1"] : [];
  const args = [
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    ...metadata,
    // Resample the variable-rate source onto a constant grid. Frames are
    // duplicated where the page was still, which is honest: it was still.
    "-vf",
    `fps=${OUTPUT_FPS},format=yuv420p`,
    "-c:v",
    "libx264",
    "-crf",
    String(CRF),
    "-preset",
    "slow",
    "-movflags",
    "+faststart",
    "-y",
    outputFile,
  ];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(process.env.DEMO_FFMPEG ?? "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    ffmpeg.on("error", (error) =>
      reject(new Error(`demo: could not run ffmpeg (${error.message}). Set DEMO_FFMPEG to its path.`)),
    );
    ffmpeg.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`demo: ffmpeg exited ${code}\n${stderr}`)),
    );
  });
}
