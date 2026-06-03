import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchImportablePage = vi.fn();
const recognizePageImage = vi.fn();
const resolveVaultImagePath = vi.fn((root: string, rel: string) => `${root}/${rel}`);
const computeEmbedding = vi.fn();
const complete = vi.fn();
const resolveProviderFromEnv = vi.fn(() => ({ complete }));
const suggestParameters = vi.fn();
const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

class UrlFetchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class EmbedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

vi.mock("../main/url-fetch", () => ({ fetchImportablePage, UrlFetchError }));
vi.mock("./ocr", () => ({ recognizePageImage, resolveVaultImagePath }));
vi.mock("./embedding-model", () => ({ computeEmbedding, EmbedError }));
vi.mock("./ai-providers", () => ({ resolveProviderFromEnv }));
vi.mock("@interleave/scheduler", () => ({ suggestParameters }));

let listener: ((event: { data: unknown }) => void) | null = null;
const postMessage = vi.fn();
const parentPort = {
  postMessage,
  on: vi.fn((_event: string, fn: (event: { data: unknown }) => void) => {
    listener = fn;
  }),
};

async function loadWorker(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  listener = null;
  postMessage.mockReset();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, undefined);
    else vi.stubEnv(key, value);
  }
  Object.defineProperty(process, "parentPort", {
    configurable: true,
    value: parentPort,
  });
  await import("./job-worker");
  if (!listener) throw new Error("worker did not register a parentPort listener");
}

async function tick() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  fetchImportablePage.mockReset();
  recognizePageImage.mockReset();
  resolveVaultImagePath.mockClear();
  computeEmbedding.mockReset();
  complete.mockReset();
  resolveProviderFromEnv.mockClear();
  suggestParameters.mockReset();
  consoleError.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, "parentPort", {
    configurable: true,
    value: undefined,
  });
});

describe("job-worker", () => {
  it("fetches URL-import jobs off-main and posts progress plus fetched HTML", async () => {
    fetchImportablePage.mockResolvedValue({
      html: "<article>Fetched</article>",
      finalUrl: "https://example.com/final",
    });
    await loadWorker();

    listener?.({
      data: {
        jobId: "job-url",
        type: "url_import",
        payload: { url: "https://example.com/original", allowLoopback: true },
      },
    });
    await tick();

    expect(fetchImportablePage).toHaveBeenCalledWith("https://example.com/original", {
      allowLoopback: true,
    });
    expect(postMessage).toHaveBeenCalledWith({
      kind: "progress",
      jobId: "job-url",
      progress: { ratio: 0.1, note: "fetching" },
    });
    expect(postMessage).toHaveBeenCalledWith({
      kind: "result",
      jobId: "job-url",
      data: { html: "<article>Fetched</article>", finalUrl: "https://example.com/final" },
    });
  });

  it("runs OCR only when the vault root is present and posts normalized word boxes", async () => {
    recognizePageImage.mockResolvedValue({
      text: "OCR text",
      meanConfidence: 90,
      words: [{ text: "OCR", confidence: 91, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }],
    });
    await loadWorker({ INTERLEAVE_ASSETS_DIR: "/vault" });

    listener?.({
      data: {
        jobId: "job-ocr",
        type: "ocr",
        payload: { sourceElementId: "source-1", page: 2, imagePagePath: "sources/source-1/p.png" },
      },
    });
    await tick();

    expect(resolveVaultImagePath).toHaveBeenCalledWith("/vault", "sources/source-1/p.png");
    expect(recognizePageImage).toHaveBeenCalledWith(
      "/vault/sources/source-1/p.png",
      expect.any(Function),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "result",
        jobId: "job-ocr",
        data: {
          page: 2,
          text: "OCR text",
          meanConfidence: 90,
          words: [{ text: "OCR", confidence: 91, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }],
        },
      }),
    );
  });

  it("returns a clear OCR error when the worker has no asset root", async () => {
    await loadWorker({ INTERLEAVE_ASSETS_DIR: undefined });

    listener?.({
      data: {
        jobId: "job-ocr",
        type: "ocr",
        payload: { sourceElementId: "source-1", page: 1, imagePagePath: "page.png" },
      },
    });
    await tick();

    expect(postMessage).toHaveBeenCalledWith({
      kind: "error",
      jobId: "job-ocr",
      code: "ocr_no_assets_dir",
      message: "OCR worker has no INTERLEAVE_ASSETS_DIR — cannot resolve the page image",
    });
    expect(recognizePageImage).not.toHaveBeenCalled();
  });

  it("passes main-side vault jobs through and reports unsupported reserved job types", async () => {
    await loadWorker();

    listener?.({ data: { jobId: "job-vault", type: "vault_verify", payload: null } });
    listener?.({ data: { jobId: "job-cleanup", type: "cleanup", payload: {} } });
    await tick();

    expect(postMessage).toHaveBeenCalledWith({ kind: "result", jobId: "job-vault", data: null });
    expect(postMessage).toHaveBeenCalledWith({
      kind: "error",
      jobId: "job-cleanup",
      code: "unsupported_job",
      message: 'Worker has no handler for job type "cleanup"',
    });
  });

  it("drops malformed requests without posting a result", async () => {
    await loadWorker();

    listener?.({ data: { type: "url_import", payload: {} } });
    await tick();

    expect(postMessage).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[job-worker] rejected malformed request:",
      expect.any(String),
    );
  });

  it("maps known worker errors to their typed code", async () => {
    fetchImportablePage.mockRejectedValue(new UrlFetchError("blocked_host", "loopback denied"));
    await loadWorker();

    listener?.({
      data: { jobId: "job-url", type: "url_import", payload: { url: "http://127.0.0.1" } },
    });
    await tick();

    expect(postMessage).toHaveBeenCalledWith({
      kind: "error",
      jobId: "job-url",
      code: "blocked_host",
      message: "loopback denied",
    });
  });
});
