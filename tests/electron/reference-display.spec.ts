/**
 * Source/reference display (T043) E2E — drives the real Electron app.
 *
 * Every extract and card shows WHERE it came from — the originating source
 * title / URL / author / date / location (the `refblock`) plus the verbatim
 * snippet — so nothing feels orphaned. In review the refblock stays HIDDEN until
 * the answer is revealed (it must not leak the answer). This reuses the existing
 * lineage + `source_locations` data; the citation formatting lives in
 * `@interleave/core` (`formatSourceRef`) and the shared `RefBlock` renders it.
 *
 * This spec launches the built desktop app against a fresh data dir seeded with
 * the shared demo collection (the Chollet paper → an extract → a Q&A card) and
 * asserts:
 *
 *   1. opening the seeded EXTRACT shows its refblock (source title + author/year +
 *      URL + location + snippet), and "open source at this location" jumps back to
 *      the originating paragraph (reusing T022);
 *   2. opening `/review` shows the prompt WITHOUT the refblock; revealing the
 *      answer reveals the refblock (title/author/URL/location);
 *   3. it SURVIVES AN APP RESTART — the refblock still resolves from lineage.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
/** The renderer base URL (`app://bundle`), captured from the first window. */
let baseUrl: string;

/** A fixed future clock so the seeded near-future Q&A card reads as due. */
const AS_OF = "2027-06-01T12:00:00.000Z";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Resolve the seeded top-level extract id (the "skill-acquisition efficiency" one). */
async function seededExtractId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string; title: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    // Match the top-level extract by title (the seed also has a sub-extract); both
    // anchor at `blk_def_p1`, but this one's snippet is the full definition.
    const extract = elements.find(
      (e) => e.type === "extract" && e.title === "Intelligence = skill-acquisition efficiency",
    );
    if (!extract) throw new Error("seeded extract not found");
    return extract.id;
  });
}

async function openExtract(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/extract/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("extract-stage-stepper")).toBeVisible();
}

async function openReview(page: Page, asOf: string): Promise<void> {
  await page.goto(`${baseUrl}/review?asOf=${encodeURIComponent(asOf)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-review")).toBeVisible();
}

test("the seeded extract shows the source refblock (title/URL/author/date/location)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const extractId = await seededExtractId(page);
  await openExtract(page, extractId);

  // The refblock resolves from lineage: the Chollet paper title/author/year, its
  // URL, the location label, and the verbatim snippet.
  const ref = page.getByTestId("extract-refblock");
  await expect(ref).toBeVisible();
  await expect(page.getByTestId("extract-refblock-citation")).toContainText("François Chollet");
  await expect(page.getByTestId("extract-refblock-citation")).toContainText(
    "On the Measure of Intelligence",
  );
  await expect(page.getByTestId("extract-refblock-citation")).toContainText("2019");
  await expect(page.getByTestId("extract-refblock-url")).toHaveAttribute(
    "href",
    "https://arxiv.org/abs/1911.01547",
  );
  await expect(page.getByTestId("extract-refblock-quote")).toContainText(
    "skill-acquisition efficiency",
  );

  // "Open source at this location" jumps to the originating paragraph (T022 reuse).
  await page.getByTestId("extract-refblock-open-source").click();
  await expect(page.getByText(/^Jumped to source/)).toBeVisible();
  await expect(page.locator('.reader [data-block-id="blk_def_p1"].jumped')).toBeVisible();

  await app.close();
});

test("in review the refblock is hidden until the answer is revealed", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openReview(page, AS_OF);

  // The prompt shows; the answer + the refblock are NOT in the DOM until reveal.
  await expect(page.getByTestId("review-card")).toBeVisible();
  await expect(page.getByTestId("review-prompt")).toBeVisible();
  await expect(page.getByTestId("review-answer")).toHaveCount(0);
  await expect(page.getByTestId("review-refblock")).toHaveCount(0);

  // Reveal → the answer AND the enriched refblock appear.
  await page.getByTestId("review-reveal").click();
  await expect(page.getByTestId("review-answer")).toBeVisible();
  await expect(page.getByTestId("review-refblock")).toBeVisible();
  await expect(page.getByTestId("review-refblock-citation")).toContainText("François Chollet");
  await expect(page.getByTestId("review-refblock-citation")).toContainText(
    "On the Measure of Intelligence",
  );
  await expect(page.getByTestId("review-refblock-open-source")).toBeVisible();

  await app.close();
});

test("the reference display still resolves from lineage after an app restart", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const extractId = await seededExtractId(page);
  await openExtract(page, extractId);

  // The same enriched refblock is rebuilt from the persisted lineage after restart.
  await expect(page.getByTestId("extract-refblock")).toBeVisible();
  await expect(page.getByTestId("extract-refblock-citation")).toContainText("François Chollet");
  await expect(page.getByTestId("extract-refblock-url")).toHaveAttribute(
    "href",
    "https://arxiv.org/abs/1911.01547",
  );
  await expect(page.getByTestId("extract-refblock-quote")).toContainText(
    "skill-acquisition efficiency",
  );

  await app.close();
});
