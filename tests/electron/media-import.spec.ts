/**
 * Media import E2E (T073) — drives the real Electron app end to end, fully on-device.
 *
 * The native media file picker is stubbed via `INTERLEAVE_MEDIA_IMPORT_PATH` and the
 * sidecar-subtitles picker via `INTERLEAVE_SUBTITLES_PATH` (both honored only in the
 * unpackaged build — mirrors the `INTERLEAVE_PDF_IMPORT_PATH` escape), pointed at the
 * tiny committed fixture video + its `.vtt` sidecar. The spec proves:
 *
 *   1. clicking the inbox "Import media" chip → MAIN reads + validates + streams the
 *      original into the vault + parses the transcript + creates an `inbox` source;
 *   2. the source opens in the media reading mode (the `<video>` element mounts, the
 *      transcript pane shows cues), and a timestamp read-point persists;
 *   3. after an APP RESTART against the same data dir, the source, its transcript body,
 *      its `original.mp4`, and the read-point all survive.
 *
 * (YouTube import is covered by the fake-fetch integration test; the E2E avoids live
 * network.) The renderer reaches all of this only through `window.appApi` — no fs/SQL.
 */

import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
  "transcript",
);
const MEDIA_FIXTURE = path.join(FIXTURE_DIR, "tiny-video.mp4");
const SUBS_FIXTURE = path.join(FIXTURE_DIR, "tiny-video.vtt");

let dataDir: string;
let baseUrl: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Launch the app with the media + subtitles pickers stubbed to the fixtures. */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { mediaImportPath: MEDIA_FIXTURE, subtitlesPath: SUBS_FIXTURE });
}

/** The renderer base URL (`app://…`) captured from the first window. */
async function captureBaseUrl(page: Page): Promise<void> {
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
}

/** Read the one inbox source id via the bridge. */
async function firstInboxId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items[0]?.id as string;
  });
}

test("the bridge exposes sources.importMedia + getMediaData (not raw SQL)", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      sources?: { importMedia?: unknown; getMediaData?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasImportMedia: typeof api?.sources?.importMedia === "function",
      hasGetMediaData: typeof api?.sources?.getMediaData === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasImportMedia).toBe(true);
  expect(surface.hasGetMediaData).toBe(true);
  expect(surface.hasQuery).toBe(false);
  await app.close();
});

test("importing a media file lands a video inbox source the reader plays", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // Click the "Import media" chip — MAIN stubs both pickers to the fixtures.
  await page.getByTestId("inbox-import-import-media").click();

  // The media source lands in the inbox list.
  await expect(page.getByTestId("inbox-row")).toHaveCount(1, { timeout: 20_000 });

  // The original.mp4 is in the vault.
  const id = await firstInboxId(page);
  const mediaPath = path.join(dataDir, "assets", "sources", id, "original.mp4");
  expect(fs.existsSync(mediaPath)).toBe(true);

  // Through the bridge: documents.get reports the video format + a transcript body.
  const meta = await page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      documents: {
        get(req: { elementId: string }): Promise<{
          sourceFormat: string | null;
          mediaSource: string | null;
          blockTimestamps: Record<string, number>;
        }>;
      };
      sources: {
        getMediaData(req: { elementId: string }): Promise<{
          mediaSource: string;
          mediaUrl: string | null;
        }>;
      };
    };
    const doc = await api.documents.get({ elementId });
    const data = await api.sources.getMediaData({ elementId });
    return {
      sourceFormat: doc.sourceFormat,
      mediaSource: doc.mediaSource,
      cueCount: Object.keys(doc.blockTimestamps).length,
      dataSource: data.mediaSource,
      mediaUrl: data.mediaUrl,
    };
  }, id);
  expect(meta.sourceFormat).toBe("video");
  expect(meta.mediaSource).toBe("local");
  expect(meta.cueCount).toBe(2); // two cues in the sidecar
  expect(meta.dataSource).toBe("local");
  expect(meta.mediaUrl).toBe(`media://${id}`);

  // Open the media reader — the <video> mounts + the transcript pane shows cues.
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("media-reader")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("media-reader-video")).toBeVisible();
  await expect(page.getByTestId("media-reader-transcript")).toBeVisible();
  await expect(page.getByTestId("media-reader-cue").first()).toBeVisible();

  await app.close();
});

test("setting a timestamp read-point persists it on a cue block", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  const id = await firstInboxId(page);
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("media-reader")).toBeVisible({ timeout: 20_000 });

  // Seek the <video> to ~0.6s by clicking the second cue (drives the player time),
  // then set the read-point — it persists the active cue's block id.
  await page.getByTestId("media-reader-cue").nth(1).click();
  // Give the player a tick to apply currentTime before reading it.
  await page.waitForTimeout(200);
  await page.getByTestId("media-set-readpoint").click();
  await expect(page.getByTestId("reader-flash")).toContainText("Read-point set");

  // Through the bridge: a read-point row now exists for this element.
  const rp = await page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      readPoints: {
        get(req: {
          elementId: string;
        }): Promise<{ readPoint: { blockId: string; offset: number } | null }>;
      };
    };
    const { readPoint } = await api.readPoints.get({ elementId });
    return readPoint;
  }, id);
  expect(rp).not.toBeNull();
  expect(typeof rp?.blockId).toBe("string");

  await app.close();
});

test("the media source, transcript body, original.mp4, and read-point survive an app restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  const id = await firstInboxId(page);

  // The original.mp4 still on disk after restart.
  expect(fs.existsSync(path.join(dataDir, "assets", "sources", id, "original.mp4"))).toBe(true);

  // The source still reports video format + a transcript body + a saved read-point.
  const state = await page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      documents: {
        get(req: { elementId: string }): Promise<{
          sourceFormat: string | null;
          blockTimestamps: Record<string, number>;
          document: { plainText: string } | null;
        }>;
      };
      readPoints: {
        get(req: { elementId: string }): Promise<{ readPoint: { blockId: string } | null }>;
      };
    };
    const doc = await api.documents.get({ elementId });
    const { readPoint } = await api.readPoints.get({ elementId });
    return {
      sourceFormat: doc.sourceFormat,
      cueCount: Object.keys(doc.blockTimestamps).length,
      hasBody: (doc.document?.plainText.length ?? 0) > 0,
      hasReadPoint: readPoint != null,
    };
  }, id);
  expect(state.sourceFormat).toBe("video");
  expect(state.cueCount).toBe(2);
  expect(state.hasBody).toBe(true);
  expect(state.hasReadPoint).toBe(true);

  // The reader still mounts after restart.
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("media-reader")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("media-reader-video")).toBeVisible();

  await app.close();
});
