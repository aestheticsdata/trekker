import { crc32, deflateSync } from "node:zlib";
import { pick, seededRandom } from "./ids";

/**
 * Pictures for the mock's image files (TRE-148, second pass: "il faut afficher
 * la miniature quand on click dessus").
 *
 * A sparse file is zeroes, and zeroes are not a JPEG: the inspector's preview
 * had nothing to show for `hero-01.jpg`. So an image file in the manifest is
 * now `kind: "image"`, and what gets written is a real PNG — a small,
 * deterministic, procedurally painted picture — padded to the size the manifest
 * declares by a sparse tail of zeroes after IEND. Decoders stop at IEND; the
 * file on disk costs nothing but the pixels; and the listing, the scan and
 * the inspector all agree on the size.
 *
 * Nothing here draws anything real. Four styles, all abstract: a product
 * render (a lit shape on a pastel ground with its shadow), a photograph (soft
 * light over a gradient, with grain), a banner (a wide gradient with a
 * diagonal), an avatar (a silhouette on a flat ground). The seed is the
 * file's own path, so `sku-10021.jpg` is the same picture on every machine
 * and `sku-10024.jpg` is a different one.
 */

export type ImageStyle = "product" | "photo" | "banner" | "avatar";

export interface ImageParams {
  style: ImageStyle;
  width: number;
  height: number;
  /** The file's path, or anything else that makes this picture this picture. */
  seed: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The file's length for a declared size: the declared size, or the picture's
 * own length if the picture is bigger than what the manifest asked for.
 */
export function imageBytes(params: ImageParams, declared: number): number {
  return Math.max(Math.round(declared), encodeImage(params).length);
}

/**
 * The picture as a complete PNG — signature, IHDR, one IDAT, IEND. The
 * materialiser writes it and then `truncate`s the file up to the declared
 * size: everything after IEND is a hole of zeroes, which every decoder ignores
 * (checked in Chromium, as `image/png` and as the `image/jpeg` a `.jpg` name
 * gets served as) and which costs no disk. A padding chunk before IEND would
 * have been the tidier PNG, and APFS fills a hole that has data after it.
 *
 * Encoded once per picture and kept: the loader asks for the size before the
 * materialiser asks for the bytes, and the same picture sits in two trees.
 */
export function encodeImage(params: ImageParams): Buffer {
  const key = `${params.style}:${params.width}x${params.height}:${params.seed}`;
  const cached = ENCODED.get(key);
  if (cached) return cached;
  const rgb = paint(params);
  const idat = deflateSync(filtered(rgb, params.width, params.height), { level: 6 });
  const png = Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr(params.width, params.height)),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  ENCODED.set(key, png);
  return png;
}

const ENCODED = new Map<string, Buffer>();

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(typed)));
  return Buffer.concat([length, typed, data, crc]);
}

function ihdr(width: number, height: number): Buffer {
  const out = Buffer.alloc(13);
  out.writeUInt32BE(width, 0);
  out.writeUInt32BE(height, 4);
  out[8] = 8; // bit depth
  out[9] = 2; // colour type: truecolour
  out[10] = 0; // compression
  out[11] = 0; // filter
  out[12] = 0; // interlace
  return out;
}

/** Scanlines with the "none" filter byte in front of each: the simplest valid PNG image data. */
function filtered(rgb: Buffer, width: number, height: number): Buffer {
  const stride = width * 3;
  const out = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    out[y * (stride + 1)] = 0;
    rgb.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return out;
}

// ---------------------------------------------------------------- painting

/** Truecolour pixels, row-major, three bytes each. */
export function paint(params: ImageParams): Buffer {
  const random = seededRandom(`image:${params.seed}`);
  const { width, height } = params;
  const out = Buffer.alloc(width * height * 3);
  const put = (x: number, y: number, c: Rgb) => {
    const at = (y * width + x) * 3;
    out[at] = clamp(c.r);
    out[at + 1] = clamp(c.g);
    out[at + 2] = clamp(c.b);
  };

  switch (params.style) {
    case "product": {
      const ground = pastel(random);
      const body = saturated(random);
      const cx = width * (0.42 + random() * 0.16);
      const cy = height * (0.46 + random() * 0.08);
      const rw = width * (0.16 + random() * 0.1);
      const rh = height * (0.22 + random() * 0.14);
      const radius = Math.min(rw, rh) * (0.25 + random() * 0.5);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          // The ground: a little lighter towards the top.
          let c = mix(ground, WHITE, 0.18 * (1 - y / height));
          // The shadow: an ellipse under the shape, soft at its edge.
          const sd = ellipse(x, y, cx, cy + rh * 0.95, rw * 1.25, rh * 0.22);
          if (sd < 1.3) c = mix(c, BLACK, 0.22 * smooth(1.3 - sd));
          // The shape: a rounded rectangle lit from the upper left.
          const inside = roundedRect(x, y, cx - rw, cy - rh, cx + rw, cy + rh, radius);
          if (inside > 0) {
            const light = 0.75 + 0.45 * ((cx + rw - x) / (2 * rw)) * ((cy + rh - y) / (2 * rh));
            c = mix(scale(body, light), c, 1 - smooth(inside));
          }
          put(x, y, c);
        }
      }
      break;
    }
    case "photo": {
      const top = pastel(random);
      const bottom = deep(random);
      const sun = { x: width * random(), y: height * (0.15 + random() * 0.4), r: width * (0.25 + random() * 0.3) };
      const haze = saturated(random);
      const horizon = height * (0.5 + random() * 0.25);
      const grain = 6 + random() * 10;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          let c = mix(top, bottom, y / height);
          const d = Math.hypot(x - sun.x, y - sun.y) / sun.r;
          if (d < 1) c = mix(c, WHITE, 0.55 * smooth(1 - d));
          if (y > horizon) c = mix(c, haze, 0.35 * smooth(Math.min(1, (y - horizon) / (height * 0.2))));
          const n = (random() - 0.5) * grain;
          put(x, y, { r: c.r + n, g: c.g + n, b: c.b + n });
        }
      }
      break;
    }
    case "banner": {
      const left = saturated(random);
      const right = deep(random);
      const stripe = pastel(random);
      const slope = 0.6 + random() * 0.8;
      const period = 40 + random() * 60;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          let c = mix(left, right, x / width);
          const band = ((x + y * slope) % period) / period;
          if (band < 0.12) c = mix(c, stripe, 0.35);
          put(x, y, c);
        }
      }
      break;
    }
    case "avatar": {
      const ground = pastel(random);
      const skin = mix(saturated(random), WHITE, 0.3);
      const cx = width / 2;
      const headR = width * 0.19;
      const headY = height * 0.38;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          let c = ground;
          const head = Math.hypot(x - cx, y - headY) / headR;
          const body = ellipse(x, y, cx, height * 1.05, width * 0.38, height * 0.42);
          if (head < 1 || body < 1) c = skin;
          put(x, y, c);
        }
      }
      break;
    }
  }
  return out;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
});
const scale = (c: Rgb, k: number): Rgb => ({ r: c.r * k, g: c.g * k, b: c.b * k });

/** Normalised distance from an ellipse's centre: under 1 is inside. */
function ellipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  return Math.hypot((x - cx) / rx, (y - cy) / ry);
}

/** How far inside a rounded rectangle a point is, in pixels, 0 outside. */
function roundedRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): number {
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  const outside = Math.hypot(dx, dy) - r;
  if (x < x0 || x > x1 || y < y0 || y > y1) return 0;
  return outside < 0 ? Math.min(-outside, 1.5) : 0;
}

/** A hue turned into a colour: light, saturated or dark, so the four styles share one palette. */
function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}
const pastel = (random: () => number): Rgb => hsl(pick(random, 0, 359), 0.35, 0.84);
const saturated = (random: () => number): Rgb => hsl(pick(random, 0, 359), 0.55, 0.5);
const deep = (random: () => number): Rgb => hsl(pick(random, 0, 359), 0.5, 0.28);
