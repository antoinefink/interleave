/**
 * Icon generator (T062) — produces the four raster PNGs the MV3 manifest needs
 * (16 / 32 / 48 / 128) under `apps/extension/icons/`.
 *
 * A Chrome manifest icon cannot be an SVG, so the committed artifacts are real
 * PNGs. They are derived from the canonical brand mark `brand/logo.png` — the
 * layered-stack glyph on a **transparent** ground (no white app-card; that is
 * `brand/icon.png`, which is the macOS/dock icon). This script decodes that
 * 1024² RGBA source and high-quality-downscales it to each size with no third-
 * party dependency (Node `zlib` only). Run `node scripts/make-icons.mjs` to
 * (re)generate them; the committed PNGs are the build deliverable, and
 * `build.mjs` copies them into `dist/icons/`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "icons");
const SOURCE = path.join(here, "..", "..", "..", "brand", "logo.png");

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC32 (standard PNG polynomial), shared by the encoder.
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

/**
 * Decode an 8-bit RGBA, non-interlaced PNG into `{ width, height, rgba }`.
 * (Sufficient for the brand source; throws on anything else so a format change
 * fails loudly rather than producing a garbled icon.)
 */
function decodePng(file) {
  const data = readFileSync(file);
  if (!data.subarray(0, 8).equals(PNG_SIG)) throw new Error(`${file}: not a PNG`);

  let width = 0;
  let height = 0;
  const idat = [];
  let i = 8;
  while (i < data.length) {
    const len = data.readUInt32BE(i);
    const type = data.toString("ascii", i + 4, i + 8);
    const body = data.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(
          `${file}: expected 8-bit RGBA non-interlaced (got depth=${bitDepth} colorType=${colorType} interlace=${interlace})`,
        );
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    i += 12 + len; // length + type + data + crc
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const bpp = 4;
  const rgba = Buffer.alloc(stride * height);
  // Reverse the per-scanline PNG filters (None/Sub/Up/Average/Paeth).
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[rowIn + x];
      const left = x >= bpp ? rgba[rowOut + x - bpp] : 0;
      const up = y > 0 ? rgba[rowOut - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? rgba[rowOut - stride + x - bpp] : 0;
      let recon;
      switch (filter) {
        case 0:
          recon = value;
          break;
        case 1:
          recon = value + left;
          break;
        case 2:
          recon = value + up;
          break;
        case 3:
          recon = value + ((left + up) >> 1);
          break;
        case 4:
          recon = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`${file}: bad filter byte ${filter} on row ${y}`);
      }
      rgba[rowOut + x] = recon & 0xff;
    }
  }
  return { width, height, rgba };
}

/** Encode a raw RGBA buffer (width*height*4) into a PNG file buffer. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([len, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA

  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Area-averaging downscale with **premultiplied alpha**. Each destination pixel
 * integrates the source rectangle it covers, weighting colour by alpha so the
 * transparent (0,0,0,0) ground never bleeds a dark fringe into the glyph edge.
 */
function resize(src, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const y0 = dy * scaleY;
    const y1 = (dy + 1) * scaleY;
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = dx * scaleX;
      const x1 = (dx + 1) * scaleX;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let sumW = 0;
      for (let iy = Math.floor(y0); iy < Math.ceil(y1); iy++) {
        const wy = Math.min(y1, iy + 1) - Math.max(y0, iy);
        if (wy <= 0) continue;
        for (let ix = Math.floor(x0); ix < Math.ceil(x1); ix++) {
          const wx = Math.min(x1, ix + 1) - Math.max(x0, ix);
          if (wx <= 0) continue;
          const w = wx * wy;
          const si = (iy * srcW + ix) * 4;
          const a = src[si + 3];
          const af = a / 255;
          sumR += w * src[si] * af; // premultiplied
          sumG += w * src[si + 1] * af;
          sumB += w * src[si + 2] * af;
          sumA += w * a;
          sumW += w;
        }
      }
      const di = (dy * dstW + dx) * 4;
      const meanA = sumW > 0 ? sumA / sumW : 0;
      if (meanA <= 0) {
        out[di] = out[di + 1] = out[di + 2] = out[di + 3] = 0;
        continue;
      }
      // Un-premultiply: divide the alpha-weighted colour mean back out.
      const unp = 255 / sumA;
      out[di] = Math.round(Math.min(255, sumR * unp));
      out[di + 1] = Math.round(Math.min(255, sumG * unp));
      out[di + 2] = Math.round(Math.min(255, sumB * unp));
      out[di + 3] = Math.round(meanA);
    }
  }
  return out;
}

const source = decodePng(SOURCE);
mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const rgba = resize(source.rgba, source.width, source.height, size, size);
  const png = encodePng(size, size, rgba);
  writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log(`[extension] wrote icons/icon-${size}.png (${png.length} bytes)`);
}
