// PWA icon generator — `npm run icons`.
//
// PLACEHOLDER ART. This draws a speech-bubble glyph in the app's amber on the
// app's dark background so the home-screen icon matches the UI. It is meant to
// be replaced with real art: drop the finished PNGs into public/icons/ with the
// same file names and delete this script (or keep it and redraw here).
//
// Why generate instead of committing binaries only: no design tool in the repo,
// and a 10-line edit here re-renders every size consistently. Pure Node — the
// PNG encoder below is ~40 lines (zlib + CRC32), so there is no image
// dependency to install or keep in sync.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

// Straight from app/globals.css so the icon and the app agree.
const BG_TOP = [33, 22, 18]; // #211612 — the top of the page gradient
const BG_BOTTOM = [9, 9, 9]; // #090909 — the bottom
const AMBER = [245, 158, 11]; // --accent #f59e0b
const AMBER_GLOW = [251, 191, 36]; // amber-400, the UI's highlight

// ── Minimal PNG encoder (RGB, 8-bit, no alpha) ─────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  // 10..12 = compression/filter/interlace, all 0
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    rgb.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ── Drawing ────────────────────────────────────────────────────────────────
// Everything is drawn at SS× resolution and box-filtered down, which is the
// whole anti-aliasing strategy: no per-shape edge math, just supersampling.
const SS = 4;

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function insideRoundedRect(x, y, left, top, right, bottom, r) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const insideCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

// A speech bubble with a tail at the lower left and three dots inside: the
// glyph reads as "someone is talking" at 32px, which is the size that matters
// (iOS shrinks the home-screen icon hard).
function insideBubble(x, y, size, scale) {
  const pad = size * (0.5 - scale / 2);
  const w = size * scale;
  const left = pad;
  const right = pad + w;
  const top = pad + w * 0.06;
  const bottom = top + w * 0.68;
  if (insideRoundedRect(x, y, left, top, right, bottom, w * 0.22)) return true;
  // Tail: a triangle hanging off the bottom-left, clipped to below the body.
  const tailTop = bottom - w * 0.02;
  const tailBottom = bottom + w * 0.2;
  if (y >= tailTop && y <= tailBottom) {
    const t = (y - tailTop) / (tailBottom - tailTop);
    const tailLeft = left + w * 0.2;
    const tailRight = tailLeft + w * 0.22 * (1 - t);
    if (x >= tailLeft && x <= tailRight) return true;
  }
  return false;
}

function insideDots(x, y, size, scale) {
  const pad = size * (0.5 - scale / 2);
  const w = size * scale;
  const cy = pad + w * 0.06 + w * 0.34;
  const r = w * 0.06;
  for (const i of [-1, 0, 1]) {
    if (insideCircle(x, y, pad + w * 0.5 + i * w * 0.2, cy, r)) return true;
  }
  return false;
}

// `glyphScale` is the fraction of the icon the bubble spans. Maskable icons get
// a smaller glyph: Android may crop up to 20% off every edge, and anything
// outside the middle 80% ("safe zone") can be shaved off by a circular mask.
function render(size, { rounded, glyphScale }) {
  const px = Buffer.alloc(size * size * 3);
  const hi = size * SS;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const fx = (x * SS + sx + 0.5) / SS;
          const fy = (y * SS + sy + 0.5) / SS;
          // Background: the page's vertical gradient plus the amber glow that
          // sits at the top of every screen in the app.
          let color = mix(BG_TOP, BG_BOTTOM, Math.min(1, fy / size));
          const glow = Math.max(
            0,
            1 - Math.hypot(fx - size / 2, fy) / (size * 0.75)
          );
          color = mix(color, AMBER, glow * 0.18);
          // A rounded square for the plain icons (iOS masks its own corners,
          // but a square PNG on Android looks unfinished); maskable fills edge
          // to edge and lets the launcher decide the shape.
          if (rounded && !insideRoundedRect(fx, fy, 0, 0, size, size, size * 0.22)) {
            color = BG_BOTTOM;
          }
          if (insideBubble(fx, fy, size, glyphScale)) {
            color = insideDots(fx, fy, size, glyphScale) ? BG_TOP : AMBER_GLOW;
          }
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 3;
      px[o] = Math.round(r / n);
      px[o + 1] = Math.round(g / n);
      px[o + 2] = Math.round(b / n);
    }
  }
  void hi;
  return encodePng(size, size, px);
}

const ICONS = [
  { file: "icon-192.png", size: 192, rounded: true, glyphScale: 0.62 },
  { file: "icon-512.png", size: 512, rounded: true, glyphScale: 0.62 },
  // Maskable: no corner rounding, smaller glyph so a circular crop can't clip it.
  { file: "icon-maskable-512.png", size: 512, rounded: false, glyphScale: 0.48 },
  // iOS applies its own rounding and does NOT support transparency here.
  { file: "apple-touch-icon.png", size: 180, rounded: false, glyphScale: 0.62 },
  { file: "favicon-32.png", size: 32, rounded: true, glyphScale: 0.7 }
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, rounded, glyphScale } of ICONS) {
  writeFileSync(join(OUT_DIR, file), render(size, { rounded, glyphScale }));
  console.log(`wrote public/icons/${file} (${size}×${size})`);
}
