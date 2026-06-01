/**
 * Icon generator (T062) — produces the four raster PNGs the MV3 manifest needs
 * (16 / 32 / 48 / 128) under `apps/extension/icons/`.
 *
 * `lucide` is React/SVG and cannot be a Chrome manifest icon directly, so the
 * committed artifacts are real PNGs. This script draws a minimal "layers" mark
 * (evoking the Interleave incremental-reading stack) in the accent color on a
 * transparent ground, using a tiny dependency-free PNG encoder (zlib only). Run
 * `node scripts/make-icons.mjs` to (re)generate them; the committed PNGs are the
 * build deliverable, and `build.mjs` copies them into `dist/icons/`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "icons");

/** Accent (OKLCH ~0.55 0.13 250) ≈ a calm indigo, in sRGB. */
const ACCENT = [79, 91, 196];
const ACCENT_DARK = [54, 64, 150];

/** Encode a raw RGBA buffer (width*height*4) into a PNG file buffer. */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // Each scanline is prefixed with a filter byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// CRC32 (standard PNG polynomial).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Draw the "stacked layers" mark into an RGBA buffer of the given size. */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4, 0); // transparent
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  };

  // Three offset rounded bars evoking an incremental stack.
  const pad = Math.round(size * 0.16);
  const barH = Math.round(size * 0.16);
  const gap = Math.round(size * 0.1);
  const left = pad;
  const right = size - pad;
  const bars = [
    { y: pad, color: ACCENT },
    { y: pad + barH + gap, color: ACCENT_DARK },
    { y: pad + 2 * (barH + gap), color: ACCENT },
  ];
  const radius = Math.max(1, Math.round(barH * 0.35));
  for (const bar of bars) {
    for (let y = bar.y; y < bar.y + barH; y++) {
      for (let x = left; x < right; x++) {
        // Rounded corners: skip the corner squares outside the radius.
        const cx =
          x < left + radius ? left + radius : x > right - 1 - radius ? right - 1 - radius : x;
        const cy =
          y < bar.y + radius
            ? bar.y + radius
            : y > bar.y + barH - 1 - radius
              ? bar.y + barH - 1 - radius
              : y;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= radius * radius) {
          set(x, y, bar.color);
        }
      }
    }
  }
  return rgba;
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, drawIcon(size));
  writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log(`[extension] wrote icons/icon-${size}.png (${png.length} bytes)`);
}
