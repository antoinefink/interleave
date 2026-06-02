/**
 * On-device OCR runner (T066) — the `tesseract.js` WASM call, isolated.
 *
 * Runs INSIDE the background-job `utilityProcess` worker (DB-FREE): it reads a
 * page PNG that MAIN already rendered + wrote to the vault, recognizes its text
 * with `tesseract.js` (WASM) FULLY ON-DEVICE — no native binary, no server, no
 * CDN — and returns the recognized text + per-word confidence. MAIN persists it.
 *
 * ## Offline, bundled WASM + language data (load-bearing)
 *
 * `tesseract.js` defaults to FETCHING its WASM core + the `eng.traineddata` from a
 * CDN — forbidden (offline-first, no network). And the packaged app ships NO
 * `node_modules` (electron-builder `files:` excludes it), so the engine + its core
 * + the language data are STAGED at build time (`build.mjs` `stageTesseract()`)
 * into `dist/resources/tesseract/` and packaged + `asarUnpack`'d. This module
 * resolves those LOCAL staged paths (NEVER `node_modules`, NEVER the CDN):
 *
 *   - `workerPath` → the staged tesseract node worker-script,
 *   - `corePath`   → the staged `tesseract.js-core` dir (WASM),
 *   - `langPath`   → the staged dir holding `eng.traineddata.gz`,
 *   - `cacheMethod: "none"` so it never writes/reads a CDN cache.
 *
 * `tesseract.js` itself is loaded by a DYNAMIC require from the staged dir (it is
 * marked external in the worker esbuild target — its node worker-thread script
 * must be a real file on disk, so it cannot be inlined into the bundle).
 */

import { createRequire } from "node:module";
import path from "node:path";
import { aggregateOcrWords, type OcrResult, type RawOcrWord } from "@interleave/importers";

/**
 * A real Node `require` resolved relative to THIS worker bundle, so the staged
 * `tesseract.js` (kept external — see build.mjs) is loaded from disk at runtime,
 * not bundled. `createRequire(__filename)` works in the esbuild CJS bundle (the
 * worker target sets `__filename`); it avoids a direct-`eval` and its esbuild warn.
 */
const nodeRequire = createRequire(__filename);

/** A minimal structural type for the `tesseract.js` surface we use (it is external). */
interface TesseractModule {
  createWorker(
    langs: string,
    oem: number,
    options: {
      workerPath: string;
      corePath: string;
      langPath: string;
      cacheMethod: string;
      gzip: boolean;
      logger?: (m: { status: string; progress: number }) => void;
    },
  ): Promise<TesseractWorker>;
}

interface TesseractWorker {
  recognize(
    image: Buffer | string,
    options?: Record<string, unknown>,
    output?: { blocks?: boolean; text?: boolean },
  ): Promise<{ data: TesseractData }>;
  terminate(): Promise<unknown>;
}

/** A recognized word in the tesseract block tree (the subset we read). */
interface TesseractWord {
  readonly text: string;
  readonly confidence: number;
  readonly bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** A line in the block tree. */
interface TesseractLine {
  readonly words?: readonly TesseractWord[];
}

/** A paragraph in the block tree. */
interface TesseractParagraph {
  readonly lines?: readonly TesseractLine[];
}

/** A block in the block tree (the `output: { blocks: true }` shape). */
interface TesseractBlock {
  readonly paragraphs?: readonly TesseractParagraph[];
}

interface TesseractData {
  readonly text: string;
  readonly confidence?: number;
  /**
   * v6 nests words under `blocks → paragraphs → lines → words` (it does NOT
   * flatten `data.words`); we walk the tree for the per-word confidence + bbox.
   */
  readonly blocks?: readonly TesseractBlock[] | null;
}

/** OEM.LSTM_ONLY — the LSTM engine (the modern, accurate, smaller-core mode). */
const OEM_LSTM_ONLY = 1;

/** Resolve the staged tesseract resources dir next to the worker bundle. */
function resourcesDir(): string {
  // The worker bundle is `dist/job-worker.cjs`; the staged data sits at
  // `dist/resources/tesseract/` (build.mjs `stageTesseract`). Packaged, both land
  // under `app.asar.unpacked/dist/...` and `__dirname` already points there
  // (electron rewrites the worker fork path), so a sibling resolve is correct.
  return path.join(__dirname, "resources", "tesseract");
}

/** Load the staged (NOT `node_modules`, NOT CDN) `tesseract.js` module. */
function loadTesseract(stageDir: string): TesseractModule {
  const entry = path.join(stageDir, "node_modules", "tesseract.js", "src", "index.js");
  // Loaded from the staged path at runtime (tesseract.js is external — see build.mjs)
  // so its node worker-thread script is a real file on disk that can `require` its deps.
  return nodeRequire(entry) as TesseractModule;
}

/** The OFFLINE `createWorker` config (local staged paths + no CDN cache). */
export interface OfflineTesseractPaths {
  readonly workerPath: string;
  readonly corePath: string;
  readonly langPath: string;
  /** Always `"none"` — never write/read a CDN cache (fully offline). */
  readonly cacheMethod: "none";
}

/**
 * Build the OFFLINE tesseract paths from the staged resources dir — all three
 * paths resolve UNDER `stageDir` (the bundled, `asarUnpack`'d tree), and the cache
 * is disabled. Pure + exported so a unit test can assert the offline invariant (no
 * `http(s)`/CDN URL, every path local) WITHOUT spinning up the real WASM worker.
 */
export function offlineTesseractPaths(stageDir: string): OfflineTesseractPaths {
  return {
    workerPath: path.join(
      stageDir,
      "node_modules",
      "tesseract.js",
      "src",
      "worker-script",
      "node",
      "index.js",
    ),
    corePath: path.join(stageDir, "node_modules", "tesseract.js-core"),
    // langPath is a directory; tesseract builds `<langPath>/eng.traineddata.gz`.
    langPath: path.join(stageDir, "lang"),
    // Fully offline: never write/read a CDN cache; the staged `.gz` is the source.
    cacheMethod: "none",
  };
}

/** Recognize one page image (an absolute path) into an {@link OcrResult}. */
export async function recognizePageImage(
  imagePath: string,
  onProgress?: (ratio: number) => void,
): Promise<OcrResult> {
  const stageDir = resourcesDir();
  const tesseract = loadTesseract(stageDir);
  const paths = offlineTesseractPaths(stageDir);

  const worker = await tesseract.createWorker("eng", OEM_LSTM_ONLY, {
    workerPath: paths.workerPath,
    corePath: paths.corePath,
    langPath: paths.langPath,
    cacheMethod: paths.cacheMethod,
    gzip: true,
    ...(onProgress
      ? {
          logger: (m: { status: string; progress: number }) => {
            if (m.status === "recognizing text" && typeof m.progress === "number") {
              onProgress(m.progress);
            }
          },
        }
      : {}),
  });

  try {
    // Request the word-level output (v6 defaults `blocks:false`, which omits the
    // per-word confidences + bboxes this task surfaces). `text` stays on for the
    // body. Words are nested under blocks → paragraphs → lines → words.
    const { data } = await worker.recognize(imagePath, {}, { blocks: true, text: true });
    const words: RawOcrWord[] = flattenWords(data.blocks ?? []);
    return aggregateOcrWords(words, data.text);
  } finally {
    await worker.terminate().catch(() => {
      /* best-effort cleanup */
    });
  }
}

/** Flatten the tesseract block tree into a flat `{ text, confidence, bbox }[]`. */
function flattenWords(blocks: readonly TesseractBlock[]): RawOcrWord[] {
  const out: RawOcrWord[] = [];
  for (const block of blocks) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          out.push({
            text: w.text,
            confidence: w.confidence,
            bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
          });
        }
      }
    }
  }
  return out;
}

/** Resolve a vault-relative page-image path against the worker's vault root. */
export function resolveVaultImagePath(assetsDir: string, relative: string): string {
  // Normalize POSIX-style relative paths (the persisted payload uses `/`).
  const parts = relative.split("/").filter((p) => p.length > 0 && p !== "..");
  return path.join(assetsDir, ...parts);
}
