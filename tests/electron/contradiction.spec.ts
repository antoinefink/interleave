/**
 * Contradiction detection (T089) E2E — drives the real Electron app, the real
 * `utilityProcess` background runner / on-device embedder, and the real persisted
 * `sqlite-vec` store + the `sources` provenance dates resolved via lineage.
 *
 * The app flags pairs of HIGHLY-SIMILAR cards/extracts that ALSO carry an opposing/
 * superseding signal (negation, numeric divergence, or a NEWER source) as a calm,
 * SUGGESTIVE "possible conflict" — HEURISTIC, never authoritative: it never edits,
 * suspends, or reschedules anything, and never leaks an answer in review.
 *
 * This spec creates (through the typed bridge — no raw SQL) two near-identical extracts
 * under two sources that differ in recency AND polarity, then:
 *   1. the `semantic.contradictions` bridge surface exists (no raw SQL);
 *   2. with semantics enabled + the index built, `semantic.contradictions` flags the
 *      older extract's newer-source-conflicting neighbor, with the neighbor's
 *      title/ref/reasons + `newerSide` resolved from lineage;
 *   3. the inspector shows a calm "Possible conflict" chip → expand the compare view
 *      (both sources + the reasons) → dismiss → it hides;
 *   4. it SURVIVES AN APP RESTART — the flag re-derives from the persisted vectors +
 *      lineage (dismiss being LOCAL UI state, it re-appears — the documented MVP
 *      behavior).
 *
 * Gate: the vector-dependent assertions run only when `semantic.status().vecAvailable`
 * is true (a functional `sqlite-vec` vec0); on an ABI-mismatched host the spec asserts
 * the graceful empty/FTS-only state and stops, mirroring the T087/T088 specs.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

const OLD_EXTRACT_TITLE = "Caffeine claim (2019)";
const NEW_EXTRACT_TITLE = "Caffeine claim (2026)";
const OLD_SOURCE_TITLE = "Sleep study (older)";
const NEW_SOURCE_TITLE = "Sleep study (newer)";

// Long, high-overlap claims differing only in polarity. With the real MiniLM model
// these are near-identical; the deterministic fallback embedder is lexical, so the
// large shared body keeps similarity above the contradiction gate either way.
const AFFIRM =
  "Caffeine taken shortly before bed improves long-term memory consolidation during " +
  "deep sleep and boosts overall recall the following morning according to this study.";
const NEGATE =
  "Caffeine taken shortly before bed does not improve long-term memory consolidation " +
  "during deep sleep and boosts overall recall the following morning according to this study.";

/**
 * Create a source (with a one-paragraph body + a `publishedAt`) and one extract under
 * it spanning the body's first block. Returns the extract id. Runs entirely through
 * the typed bridge — no raw SQL.
 */
async function seedSourceWithExtract(
  page: Page,
  args: {
    sourceTitle: string;
    publishedAt: string;
    extractTitle: string;
    claim: string;
  },
): Promise<string> {
  return page.evaluate(async (a) => {
    const api = window.appApi as unknown as {
      sources: {
        importManual(r: {
          title: string;
          body: string;
          publishedAt: string;
        }): Promise<{ id: string }>;
      };
      documents: {
        get(r: { elementId: string }): Promise<{
          document: { prosemirrorJson: unknown } | null;
        }>;
      };
      extractions: {
        create(r: {
          sourceElementId: string;
          selectedText: string;
          blockIds: string[];
          title: string;
        }): Promise<{ extract: { id: string } }>;
      };
    };

    const created = await api.sources.importManual({
      title: a.sourceTitle,
      body: a.claim,
      publishedAt: a.publishedAt,
    });
    const sourceId = created.id;

    // Read the document to recover the first block's stable id (the extract anchor).
    const doc = await api.documents.get({ elementId: sourceId });
    const pm = doc.document?.prosemirrorJson as
      | { content?: Array<{ attrs?: { blockId?: string } }> }
      | undefined;
    const blockId = pm?.content?.[0]?.attrs?.blockId;
    if (!blockId) throw new Error("no block id in the imported source body");

    const extract = await api.extractions.create({
      sourceElementId: sourceId,
      selectedText: a.claim,
      blockIds: [blockId],
      title: a.extractTitle,
    });
    return extract.extract.id;
  }, args);
}

/** Enable semantics + build + wait for the index. */
async function enableAndIndex(page: Page): Promise<{ vecAvailable: boolean; embedded: number }> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { updateMany(r: { patch: Record<string, unknown> }): Promise<unknown> };
      semantic: {
        status(): Promise<{ vecAvailable: boolean; embedded: number; total: number }>;
        reindex(r: { onlyMissing: boolean }): Promise<{ enqueued: number }>;
      };
    };
    await api.settings.updateMany({
      patch: { semanticSearchEnabled: true, embeddingModelDownloaded: true },
    });
    await api.semantic.reindex({ onlyMissing: false });
    const start = Date.now();
    let status = await api.semantic.status();
    while (status.vecAvailable && status.embedded < status.total && Date.now() - start < 20000) {
      await new Promise((r) => setTimeout(r, 200));
      status = await api.semantic.status();
    }
    return { vecAvailable: status.vecAvailable, embedded: status.embedded };
  });
}

/** Select a seeded element in the inspector picker by its (unique) title. */
async function selectByTitle(page: Page, title: string) {
  const clear = page.getByTestId("inspector-clear");
  if (await clear.isVisible().catch(() => false)) await clear.click();
  const item = page.getByTestId("element-picker-item").filter({ hasText: title });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();
  await expect(page.getByTestId("inspector-title")).toHaveText(title);
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("the semantic.contradictions bridge exists (no raw SQL) and flags a newer-source conflict", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: false });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  // The surface exists; no generic db.query.
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      semantic?: { contradictions?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasContradictions: typeof api?.semantic?.contradictions === "function",
      hasRawQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasContradictions).toBe(true);
  expect(surface.hasRawQuery).toBe(false);

  // Seed the opposing, recency-divergent pair (older affirming, newer negating).
  const olderId = await seedSourceWithExtract(page, {
    sourceTitle: OLD_SOURCE_TITLE,
    publishedAt: "2019-03-01",
    extractTitle: OLD_EXTRACT_TITLE,
    claim: AFFIRM,
  });
  await seedSourceWithExtract(page, {
    sourceTitle: NEW_SOURCE_TITLE,
    publishedAt: "2026-03-01",
    extractTitle: NEW_EXTRACT_TITLE,
    claim: NEGATE,
  });

  const index = await enableAndIndex(page);
  if (!index.vecAvailable) {
    // Graceful FTS-only host (ABI mismatch): contradictions return empty, no crash.
    const flags = await page.evaluate(
      (id) =>
        (
          window.appApi as unknown as {
            semantic: { contradictions(r: { elementId: string }): Promise<{ flags: unknown[] }> };
          }
        ).semantic.contradictions({ elementId: id }),
      olderId,
    );
    expect(flags.flags).toEqual([]);
    await app.close();
    test.skip(true, "sqlite-vec vec0 not functional on this host — empty-flags path verified");
    return;
  }

  // The older extract's flags include the newer-source neighbor (recency), with the
  // newerSide + the neighbor title/ref resolved from lineage.
  const result = await page.evaluate(
    (id) =>
      (
        window.appApi as unknown as {
          semantic: {
            contradictions(r: { elementId: string }): Promise<{
              flags: Array<{
                otherTitle: string;
                reasons: string[];
                newerSide: string | null;
                otherRef: { sourceTitle: string | null } | null;
                severity: string;
              }>;
            }>;
          };
        }
      ).semantic.contradictions({ elementId: id }),
    olderId,
  );

  expect(result.flags.length).toBeGreaterThanOrEqual(1);
  const flag = result.flags.find((f) => f.otherTitle === NEW_EXTRACT_TITLE);
  expect(flag).toBeDefined();
  // The newer source supersedes → the OTHER side (the 2026 neighbor) is newer.
  expect(flag?.reasons).toContain("recency");
  expect(flag?.newerSide).toBe("other");
  expect(flag?.otherRef?.sourceTitle).toBe(NEW_SOURCE_TITLE);
  // Never authoritative: no high severity.
  expect(["low", "medium"]).toContain(flag?.severity);

  await app.close();
});

test("the inspector shows a calm Possible-conflict chip → compare → dismiss", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const status = await page.evaluate(() =>
    (
      window.appApi as unknown as {
        semantic: { status(): Promise<{ vecAvailable: boolean }> };
      }
    ).semantic.status(),
  );
  if (!status.vecAvailable) {
    await app.close();
    test.skip(true, "sqlite-vec vec0 not functional on this host — UI conflict surface skipped");
    return;
  }

  await page.goto(`${baseUrl}/`);
  await page.waitForLoadState("domcontentloaded");
  await selectByTitle(page, OLD_EXTRACT_TITLE);

  // The calm chip appears (the copy says "Possible conflict", never "conflict").
  const section = page.getByTestId("conflict-section");
  await expect(section).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId("conflict-flag-chip").first()).toContainText("Possible conflict");

  // Expand the compare view: both sources + the reason render.
  await page.getByTestId("conflict-flag-chip").first().click();
  await expect(page.getByTestId("conflict-flag-compare").first()).toBeVisible();
  await expect(page.getByTestId("conflict-self-ref").first()).toBeVisible();
  await expect(page.getByTestId("conflict-other-ref").first()).toBeVisible();

  // Dismiss hides the flag (local UI state).
  await page.getByTestId("conflict-flag-dismiss").first().click();
  await expect(page.getByTestId("conflict-flag")).toHaveCount(0);

  await app.close();
});

test("the conflict flag re-derives after an app restart (computed from persisted data)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const status = await page.evaluate(() =>
    (
      window.appApi as unknown as {
        semantic: { status(): Promise<{ vecAvailable: boolean; embedded: number }> };
      }
    ).semantic.status(),
  );
  if (!status.vecAvailable) {
    await app.close();
    test.skip(true, "sqlite-vec vec0 not functional on this host — restart re-derivation skipped");
    return;
  }
  // The embeddings persisted across the restart (no re-index).
  expect(status.embedded).toBeGreaterThan(0);

  await page.goto(`${baseUrl}/`);
  await page.waitForLoadState("domcontentloaded");
  await selectByTitle(page, OLD_EXTRACT_TITLE);

  // The flag re-derives from the persisted vectors + lineage — and (dismiss being
  // LOCAL UI state, not persisted) it re-appears after the restart, as documented.
  await expect(page.getByTestId("conflict-section")).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId("conflict-flag-chip").first()).toContainText("Possible conflict");

  await app.close();
});
