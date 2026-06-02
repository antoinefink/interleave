/**
 * Generate the tiny, committed fixture PDFs the `@interleave/importers` PDF tests
 * (and the T064 main-side / E2E tests) run against. One-off generator — run with
 * `node packages/importers/scripts/make-fixtures.mjs`; the produced bytes are
 * checked into `src/__fixtures__/`. We hand-build minimal valid PDFs (a correct
 * cross-reference table) so we need NO heavyweight PDF dependency just for tests.
 *
 * Three fixtures:
 *   - `two-page-text.pdf`   — 2 pages, each with selectable text lines.
 *   - `heading-body.pdf`    — 1 page with a large "heading" line + body lines.
 *   - `scanned-no-text.pdf` — 1 page with an embedded image XObject, NO text
 *     operators (the scanned/image-only case: `hasText === false`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "src", "__fixtures__");
mkdirSync(outDir, { recursive: true });

/** Assemble a PDF from a list of object body strings (object 1..N), with a valid xref. */
function buildPdf(objects) {
  const header = "%PDF-1.4\n";
  let body = "";
  const offsets = [];
  let pos = header.length;
  objects.forEach((obj, i) => {
    const n = i + 1;
    offsets[n] = pos;
    const chunk = `${n} 0 obj\n${obj}\nendobj\n`;
    body += chunk;
    pos += chunk.length;
  });
  const xrefPos = header.length + body.length;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objects.length; n++) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(header + body + xref + trailer, "latin1");
}

/** A text-content stream object for a page (BT … ET with Tj lines). */
function textStream(lines) {
  // Each line is placed top-down with a leading of 24 units; Helvetica 14pt.
  let content = "BT\n/F1 14 Tf\n72 720 Td\n14 TL\n";
  lines.forEach((line, i) => {
    if (i > 0) content += "0 -28 Td\n";
    content += `(${line.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj\n`;
  });
  content += "ET\n";
  return content;
}

/** Build a single-content-stream page PDF (1..N pages share one font). */
function buildTextPdf(pages) {
  // Object layout: 1 Catalog, 2 Pages, 3 Font, then per page: Page + Contents.
  const objects = [];
  const pageObjNums = [];
  // Placeholder for catalog/pages/font — filled after we know kids.
  objects.push(""); // 1 catalog
  objects.push(""); // 2 pages
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); // 3 font

  pages.forEach((lines) => {
    const content = textStream(lines);
    const contentNum = objects.length + 1 + 1; // page first, then contents
    const pageNum = objects.length + 1;
    pageObjNums.push(pageNum);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  });

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(" ");
  objects[1] = `<< /Type /Pages /Kids [${kids}] /Count ${pageObjNums.length} >>`;
  return buildPdf(objects);
}

/** A 1x1 PNG-free image: a raw RGB image XObject (no text → scanned signal). */
function buildScannedPdf() {
  // A tiny 2x2 grayscale image drawn full-page, with NO text operators at all.
  const w = 2;
  const h = 2;
  const imgData = Buffer.from([0x00, 0xff, 0xff, 0x00]); // 2x2 grayscale checker
  // Content: draw the image scaled across the page.
  const content = `q\n612 0 0 792 0 0 cm\n/Im0 Do\nQ\n`;
  const objects = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>"); // 1
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"); // 2
  objects.push(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
  ); // 3
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`); // 4
  // Image XObject (object 5) — DeviceGray, 8bpc.
  const imgHeader =
    `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
    `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${imgData.length} >>\n` +
    `stream\n`;
  // We must splice the binary image bytes; build that object specially below.
  objects.push(`__IMAGE__`);

  // Assemble manually because the image stream holds binary bytes.
  const header = "%PDF-1.4\n";
  const offsets = [];
  let posAcc = header.length;
  const chunks = [];
  objects.forEach((obj, i) => {
    const n = i + 1;
    offsets[n] = posAcc;
    let chunk;
    if (obj === "__IMAGE__") {
      const pre = `${n} 0 obj\n${imgHeader}`;
      const post = `\nendstream\nendobj\n`;
      chunk = Buffer.concat([Buffer.from(pre, "latin1"), imgData, Buffer.from(post, "latin1")]);
    } else {
      chunk = Buffer.from(`${n} 0 obj\n${obj}\nendobj\n`, "latin1");
    }
    chunks.push(chunk);
    posAcc += chunk.length;
  });
  const xrefPos = posAcc;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objects.length; n++) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.concat([
    Buffer.from(header, "latin1"),
    ...chunks,
    Buffer.from(xref + trailer, "latin1"),
  ]);
}

/**
 * A 5x7 bitmap font for the OCR fixture text (only the letters we render). Used to
 * draw a legible, high-contrast grayscale image of words into a "scanned" PDF page
 * (no text operators → `hasText === false`), so the T066 OCR E2E renders the page
 * and the REAL `tesseract.js` worker recognizes the words offline.
 */
const OCR_FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

/**
 * Render `text` (uppercase, supported letters only) into a DeviceGray bitmap +
 * dimensions: white background (0xff), black glyphs (0x00), each font pixel
 * upscaled by `scale`. Returns `{ width, height, data }` for the image XObject.
 */
function renderTextImage(text, scale = 22) {
  const charW = 5;
  const charH = 7;
  const gap = 1;
  const pad = 24;
  const cols = text.length * (charW + gap);
  const width = pad * 2 + cols * scale;
  const height = pad * 2 + charH * scale;
  const data = Buffer.alloc(width * height, 0xff); // white
  const setPx = (x, y) => {
    if (x >= 0 && y >= 0 && x < width && y < height) data[y * width + x] = 0x00;
  };
  let cx = pad;
  for (const ch of text) {
    const glyph = OCR_FONT[ch] ?? OCR_FONT[" "];
    for (let gy = 0; gy < charH; gy++) {
      for (let gx = 0; gx < charW; gx++) {
        if (glyph[gy][gx] === "1") {
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++) setPx(cx + gx * scale + sx, pad + gy * scale + sy);
        }
      }
    }
    cx += (charW + gap) * scale;
  }
  return { width, height, data };
}

/**
 * A single-page "scanned" PDF whose page is a DeviceGray IMAGE of `text` (NO text
 * operators), so `extractPdfPages` reports `hasText === false` but the rendered
 * page is legible — the T066 OCR target. The image is drawn full-page so the
 * renderer's canvas → page-PNG → tesseract path recognizes the words.
 */
function buildScannedTextPdf(text) {
  const { width: w, height: h, data: imgData } = renderTextImage(text);
  const content = `q\n612 0 0 792 0 0 cm\n/Im0 Do\nQ\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", // 1
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", // 2
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>", // 3
    `<< /Length ${content.length} >>\nstream\n${content}endstream`, // 4
    "__IMAGE__", // 5
  ];
  const imgHeader =
    `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
    `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${imgData.length} >>\n` +
    `stream\n`;

  const header = "%PDF-1.4\n";
  const offsets = [];
  let posAcc = header.length;
  const chunks = [];
  objects.forEach((obj, i) => {
    const n = i + 1;
    offsets[n] = posAcc;
    let chunk;
    if (obj === "__IMAGE__") {
      const pre = `${n} 0 obj\n${imgHeader}`;
      const post = `\nendstream\nendobj\n`;
      chunk = Buffer.concat([Buffer.from(pre, "latin1"), imgData, Buffer.from(post, "latin1")]);
    } else {
      chunk = Buffer.from(`${n} 0 obj\n${obj}\nendobj\n`, "latin1");
    }
    chunks.push(chunk);
    posAcc += chunk.length;
  });
  const xrefPos = posAcc;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objects.length; n++) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.concat([
    Buffer.from(header, "latin1"),
    ...chunks,
    Buffer.from(xref + trailer, "latin1"),
  ]);
}

writeFileSync(
  path.join(outDir, "two-page-text.pdf"),
  buildTextPdf([
    ["Page one first paragraph about spaced repetition.", "Page one second line of body text."],
    ["Page two opening line on the forgetting curve.", "Page two closing line of the document."],
  ]),
);

writeFileSync(
  path.join(outDir, "heading-body.pdf"),
  buildTextPdf([
    ["The Spacing Effect", "Spaced study beats cramming for long-term retention of facts."],
  ]),
);

writeFileSync(path.join(outDir, "scanned-no-text.pdf"), buildScannedPdf());

// The T066 OCR target: a "scanned" page that is an IMAGE of legible text ("CARDS
// AND NOTES") — `hasText === false`, but the rendered page OCRs to that text.
writeFileSync(path.join(outDir, "ocr-scanned.pdf"), buildScannedTextPdf("CARDS AND NOTES"));

console.log(`Wrote 4 fixture PDFs to ${outDir}`);
