import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

/**
 * The portfolio demo run — the only Playwright config in this repo, and a filming job rather
 * than a test one.
 *
 * One worker, no retries (half a retried take is worse than no take), a long timeout because the
 * run deliberately spends most of its time waiting, and video at the exact viewport size, so no
 * scaling ever touches the picture.
 *
 * The session is kept in its own file under `e2e/.auth/`, not shared with anything: the corpus
 * the take films is the fake tree TRE-140 loads, and it lives only in the dev database.
 */
config({ path: ".env.test.local" });

const STORAGE_STATE = "e2e/.auth/demo.json";

/** 1080p by default: native, 16:9, and nothing upscales on the way to a landing page. */
const viewport = {
  width: Number(process.env.DEMO_WIDTH ?? 1920),
  height: Number(process.env.DEMO_HEIGHT ?? 1080),
};

/**
 * Renders at twice the resolution and lets the encoder downsample into the same
 * frame. Supersampling: visibly crisper text, for CPU. It is the default
 * because `pnpm video:generate` should produce the best picture it can without
 * being asked — `DEMO_SCALE=1` is the way out if a slow machine drops frames.
 */
const deviceScaleFactor = Number(process.env.DEMO_SCALE ?? 2);

const chrome = {
  ...devices["Desktop Chrome"],
  viewport,
  deviceScaleFactor,
  launchOptions: {
    headless: process.env.DEMO_HEADED !== "1",
    args: ["--force-color-profile=srgb", "--hide-scrollbars"],
  },
};

export default defineConfig({
  testDir: "./e2e/demo",
  // Checks the app is actually up before a browser is launched, so a shut-down
  // server is reported as a shut-down server rather than as a login failure.
  globalSetup: "./e2e/demo/preflight.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 8 * 60_000,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3005",
    trace: "off",
    // Off unless asked for: the CDP recorder in `e2e/demo/recorder.ts` captures
    // the same screencast without the 25fps ceiling, and running both at once
    // would have two clients acking the same frames.
    video: process.env.DEMO_RECORDER === "playwright" ? { mode: "on" as const, size: viewport } : ("off" as const),
  },
  projects: [
    { name: "setup", testMatch: /demo\.setup\.ts/, use: chrome },
    {
      name: "demo",
      testMatch: /.*\.demo\.ts/,
      dependencies: ["setup"],
      use: { ...chrome, storageState: STORAGE_STATE },
    },
  ],
});
