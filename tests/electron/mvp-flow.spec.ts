/**
 * MVP end-to-end flow (T049) — the single, uninterrupted user journey + the
 * canonical restart proof. Drives the REAL built Electron desktop app.
 *
 * This is the convergence gate for Part I: one Playwright/Electron spec walks the
 * ENTIRE MVP pipeline against the real app, then restarts it against the same data
 * dir and verifies every artifact survived:
 *
 *   import → activate → read → set read-point → extract → convert-to-card
 *   (Q&A + cloze) → review (grade) → reschedule → search → open original source
 *   → backup → RESTART → verify persistence
 *
 * Architecture (non-negotiable): the spec drives the app ONLY through the UI + the
 * typed `window.appApi` bridge — there is no raw DB poke. Reads go through
 * `inbox.list` / `inspector.get` / `lineage.get` / `review.sessionNext` /
 * `search.query` / `readPoints.get`; the backup `.zip` is read off disk (Node
 * side) only to verify the bundle the bridge produced. The restart reuses the same
 * `INTERLEAVE_DATA_DIR` via `launchApp(sameDataDir)` — the load-bearing assertion.
 *
 * Determinism + isolation: a per-run temp data dir (`makeDataDir`, so it never
 * touches the developer's real Application Support data); the flow CREATES its own
 * data (no dev seed) so it proves the real authoring path, not just seeded reads;
 * the review step uses a fixed-future `asOf` clock so an authored card reads as due
 * deterministically.
 *
 * Reuse, not rewrite: the per-step assertions are lifted from the existing feature
 * specs (`inbox` / `source-reader` / `read-points` / `extraction` / `cards` /
 * `review` / `search` / `backup`); the VALUE here is the single journey + restart.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

// One isolated data dir shared across the whole journey (incl. the restart).
let dataDir: string;
/** The renderer base URL (`app://bundle`), captured from the first window. */
let baseUrl: string;

// Artifacts threaded through the journey (created by the flow, verified after restart).
let sourceId: string;
let extractId: string;
let qaCardId: string;
let clozeCardId: string;
/** The stable block id (read off the rendered reader DOM) the extract anchors to. */
let extractBlockId: string;
/** The FSRS due date the Q&A card advanced to (asserted to survive the restart). */
let qaDueAfterGrade: string | null = null;
/** The on-disk path of the backup `.zip` (asserted to survive the restart). */
let backupZipPath: string;

/**
 * A fixed FUTURE clock so the just-authored, just-graded card reads as due in the
 * review step (the same trick the review/queue specs use). Grading at this clock
 * pushes the next due strictly later, so a follow-up read at a LATER clock is due.
 */
const AS_OF_GRADE = "2027-06-01T12:00:00.000Z";
const AS_OF_DUE = "2030-01-01T12:00:00.000Z";

const SOURCE_TITLE = "Spaced Repetition and the Forgetting Curve";
// A multi-paragraph body — each blank-line paragraph becomes its own stable block.
const SOURCE_BODY = [
  "Spaced repetition is a learning technique that schedules reviews at increasing intervals.",
  "The forgetting curve describes how memory of new information decays over time without reinforcement.",
  "By reviewing material just before it is forgotten, the interval to the next review can grow steadily.",
  "Active recall — retrieving an answer from memory — strengthens retention far more than passive rereading.",
].join("\n\n");
// A distinctive word that appears across the source/extract/card for the search step.
const SEARCH_TERM = "forgetting";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

// --- bridge read helpers (no raw SQL — only the typed window.appApi) -----------

/** Read the live inbox list through the bridge. */
async function listInbox(page: Page) {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string; title: string; status: string }[] }> };
    };
    return (await api.inbox.list()).items;
  });
}

/** Read an element's full inspector payload through the bridge. */
async function inspect(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: { type: string; stage: string; status: string; dueAt: string | null };
            parent: { id: string } | null;
            source: { id: string } | null;
            children: { id: string; type: string }[];
            scheduler: { kind: string };
            location: { sourceElementId: string; blockIds: string[]; selectedText: string } | null;
            review: { dueAt: string | null; reps: number; logCount: number } | null;
          } | null;
        }>;
      };
    };
    return (await api.inspector.get({ id: elementId })).data;
  }, id);
}

/** The flattened lineage nodes for an element, via the bridge. */
async function lineageNodes(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      lineage: {
        get(req: {
          id: string;
        }): Promise<{ lineage: { nodes: { id: string; type: string }[] } | null }>;
      };
    };
    return (await api.lineage.get({ id: elementId })).lineage?.nodes ?? [];
  }, id);
}

async function openReader(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();
}

async function openExtract(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/extract/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("extract-stage-stepper")).toBeVisible();
}

// =============================================================================
// 1. IMPORT — paste a multi-paragraph article; it lands in the inbox.
// =============================================================================
test("1. import: a pasted multi-paragraph article lands in the inbox", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // Create the source through the New-source modal (the real authoring path).
  await page.getByTestId("inbox-empty-new").click();
  await expect(page.getByTestId("new-source-modal")).toBeVisible();
  await page.getByTestId("new-source-title").fill(SOURCE_TITLE);
  await page.getByTestId("new-source-url").fill("https://example.com/spaced-repetition");
  await page.getByTestId("new-source-author").fill("A. Researcher");
  await page.getByTestId("new-source-body").fill(SOURCE_BODY);
  await page.getByTestId("new-source-submit").click();
  await expect(page.getByTestId("new-source-modal")).toBeHidden();

  // It appears in the list + preview (UI).
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await expect(page.getByTestId("inbox-preview-title")).toHaveText(SOURCE_TITLE);

  // And through the bridge (the persisted inbox source).
  const items = await listInbox(page);
  expect(items).toHaveLength(1);
  expect(items[0]?.title).toBe(SOURCE_TITLE);
  expect(items[0]?.status).toBe("inbox");
  sourceId = items[0]?.id ?? "";
  expect(sourceId).toBeTruthy();

  await app.close();
});

// =============================================================================
// 2. ACTIVATE — triage the source into active learning; it leaves the inbox.
// =============================================================================
test("2. activate: accepting the source moves it to active and out of the inbox", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await page.getByTestId("inbox-row").filter({ hasText: SOURCE_TITLE }).click();
  await expect(page.getByTestId("inbox-preview-title")).toHaveText(SOURCE_TITLE);

  // Accept → status active; leaves the inbox (the SAME inbox.triage the row uses).
  await page.getByTestId("inbox-accept").click();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // The inbox is empty; the source is now `active` (read through the bridge).
  expect(await listInbox(page)).toHaveLength(0);
  const data = await inspect(page, sourceId);
  expect(data?.element.type).toBe("source");
  expect(data?.element.status).toBe("active");

  await app.close();
});

// =============================================================================
// 3. READ + SET READ-POINT — open the reader, set a read-point, persist it.
// =============================================================================
test("3. read + set read-point: a read-point is set and reads back through the bridge", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  // No read-point yet.
  const before = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      readPoints: { get(req: { elementId: string }): Promise<{ readPoint: unknown | null }> };
    };
    return (await api.readPoints.get({ elementId: id })).readPoint;
  }, sourceId);
  expect(before).toBeNull();

  // Place the caret in the body's FIRST block, then set the read-point. The
  // "Set read-point" button is the SAME `appApi.setReadPoint` path as the `␣` key
  // (the key is suppressed inside the contenteditable body, so the button is the
  // deterministic mouse-free affordance for the same command).
  const blocks = page.locator(".reader .ProseMirror [data-block-id]");
  await expect(blocks.first()).toBeVisible();
  await blocks.first().click();
  await page.getByTestId("reader-set-readpoint").click();

  // The read-point persisted (a stable block id + offset), read back through the bridge.
  const readPoint = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      readPoints: {
        get(req: { elementId: string }): Promise<{
          readPoint: { blockId: string; offset: number } | null;
        }>;
      };
    };
    return (await api.readPoints.get({ elementId: id })).readPoint;
  }, sourceId);
  expect(readPoint).not.toBeNull();
  expect(typeof readPoint?.blockId).toBe("string");
  expect((readPoint?.blockId.length ?? 0) > 0).toBe(true);

  await app.close();
});

// =============================================================================
// 4. EXTRACT — select a paragraph + press `E` (the mouse-free T048 path) → a
//    child extract with a source location; lineage shows source → extract.
// =============================================================================
test("4. extract: selecting a paragraph and pressing E creates a scheduled extract with lineage", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  // Extract from the paragraph that contains the search term ("forgetting") so the
  // extract body carries it (the search step then finds the extract too). Find that
  // block's stable id by reading the rendered DOM, then select + press `E` — the
  // SAME `extractions.create` the Extract toolbar button calls (T021/T048).
  extractBlockId = await page.evaluate((term) => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(".reader .ProseMirror [data-block-id]"),
    );
    const match = nodes.find((n) => (n.textContent ?? "").toLowerCase().includes(term));
    return match?.getAttribute("data-block-id") ?? "";
  }, SEARCH_TERM);
  expect(extractBlockId).toBeTruthy();

  const block = page.locator(`.reader [data-block-id="${extractBlockId}"]`);
  await expect(block).toBeVisible();
  await block.click({ clickCount: 3 });
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await page.keyboard.press("e");
  await expect(page.getByText("Extracted")).toBeVisible();

  // Exactly one extract now exists; resolve its id through the bridge.
  const extracts = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    return elements.filter((e) => e.type === "extract").map((e) => e.id);
  });
  expect(extracts).toHaveLength(1);
  extractId = extracts[0] ?? "";
  expect(extractId).toBeTruthy();

  // The extract is an ATTENTION item with the right lineage + a source location.
  const data = await inspect(page, extractId);
  expect(data?.element.type).toBe("extract");
  expect(data?.element.stage).toBe("raw_extract");
  expect(data?.scheduler.kind).toBe("attention");
  expect(data?.review).toBeNull(); // never an FSRS card
  expect(data?.source?.id).toBe(sourceId);
  expect(data?.location?.sourceElementId).toBe(sourceId);
  expect(data?.location?.blockIds).toContain(extractBlockId);
  expect(data?.element.dueAt).toBeTruthy(); // future attention due

  // Lineage: source → extract.
  const nodes = await lineageNodes(page, extractId);
  expect(nodes.some((n) => n.id === sourceId && n.type === "source")).toBe(true);
  expect(nodes.some((n) => n.id === extractId && n.type === "extract")).toBe(true);

  // The parent block paints `.extracted` without a reload.
  await expect(page.locator(`.reader [data-block-id="${extractBlockId}"].extracted`)).toBeVisible();

  await app.close();
});

// =============================================================================
// 5. CONVERT TO CARD (both kinds) — from the extract, build a Q&A card AND a
//    cloze card; both carry lineage back to the extract + the source.
// =============================================================================
test("5. convert-to-card: a Q&A card and a cloze card are authored from the extract with lineage", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openExtract(page, extractId);

  // --- Q&A card ---------------------------------------------------------------
  await page.getByTestId("extract-convert").click();
  await expect(page.getByTestId("card-builder")).toBeVisible();
  await expect(page.getByTestId("cb-qa-front")).toBeVisible();
  await page.getByTestId("cb-qa-front").fill("What does the forgetting curve describe?");
  await page.getByTestId("cb-qa-back").fill("How memory of new information decays over time.");
  await page.getByTestId("cb-create").click();
  await expect(page.getByText("Q&A card created")).toBeVisible();

  // --- Cloze card -------------------------------------------------------------
  await page.getByTestId("cb-tab-cloze").click();
  await expect(page.getByTestId("cb-cloze-text")).toBeVisible();
  await page
    .getByTestId("cb-cloze-text")
    .fill("Reviewing just before the {{c1::forgetting}} point grows the {{c2::interval}}.");
  await expect(page.getByTestId("cb-cloze-count")).toContainText("2 cloze deletions");
  await page.getByTestId("cb-create").click();
  await expect(page.getByText("Cloze card created")).toBeVisible();

  // Both cards are children of the extract (the extract's only children are these two).
  await expect
    .poll(async () => {
      const data = await inspect(page, extractId);
      return (data?.children ?? []).filter((c) => c.type === "card").length;
    })
    .toBe(2);

  // Resolve the two card ids through the bridge.
  const cardIds = await page.evaluate(async (exId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { children: { id: string; type: string }[] } }>;
      };
    };
    const { data } = await api.inspector.get({ id: exId });
    return (data?.children ?? []).filter((c) => c.type === "card").map((c) => c.id);
  }, extractId);
  expect(cardIds).toHaveLength(2);

  // Classify each card (qa vs cloze) by its cloze-mark count — a READ-ONLY
  // discriminator (the cloze card holds 2 cloze marks; the Q&A card holds 0) — and
  // assert each card's lineage parent/source + first-scheduled FSRS state.
  for (const id of cardIds) {
    const data = await inspect(page, id);
    expect(data?.element.type).toBe("card");
    // A freshly authored card is first-scheduled into active rotation (T036), so it
    // enters the deck and is reviewable — stage active_card, with a real dueAt.
    expect(data?.element.stage).toBe("active_card");
    expect(data?.parent?.id).toBe(extractId);
    expect(data?.source?.id).toBe(sourceId);
    expect(data?.scheduler.kind).toBe("fsrs");
    // First-scheduled due (no interval math yet — fsrsState stays "new" until graded).
    expect(data?.review?.dueAt ?? null).not.toBeNull();
    const markCount = await page.evaluate(async (cardId) => {
      const api = window.appApi as unknown as {
        documents: {
          marks: {
            list(req: { elementId: string; markType?: string }): Promise<{ marks: unknown[] }>;
          };
        };
      };
      return (await api.documents.marks.list({ elementId: cardId, markType: "cloze" })).marks
        .length;
    }, id);
    if (markCount === 2) clozeCardId = id;
    else qaCardId = id;
  }
  expect(qaCardId).toBeTruthy();
  expect(clozeCardId).toBeTruthy();
  expect(qaCardId).not.toBe(clozeCardId);

  await app.close();
});

// =============================================================================
// 6. REVIEW (grade) + RESCHEDULE — grade the Q&A card to seed a real due date,
//    then drive the `/review` UI (reveal + grade) so it reschedules + logs.
// =============================================================================
test("6. review + reschedule: grading writes a durable log and advances the due date", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const before = await inspect(page, qaCardId);
  expect(before?.review?.logCount ?? 0).toBe(0);

  // FSRS ORDERING + first reschedule: preview the Q&A card, then grade it. "again"
  // reschedules SOONER than "easy" (the FSRS invariant) — asserted from the pure
  // preview so it never mutates twice. Then a real GOOD grade through the SAME
  // `review.grade` the UI button calls seeds a real future due date + a durable log.
  const graded = await page.evaluate(
    async ({ cardId, clock }) => {
      const api = window.appApi as unknown as {
        review: {
          preview(req: { cardId: string; asOf: string }): Promise<{
            intervals: Record<string, { scheduledDays: number }> | null;
          }>;
          grade(req: {
            cardId: string;
            rating: string;
            responseMs: number;
            asOf: string;
          }): Promise<{
            reviewLog: { id: string; nextDueAt: string };
            reviewState: { dueAt: string | null };
          }>;
        };
      };
      const preview = await api.review.preview({ cardId, asOf: clock });
      const res = await api.review.grade({
        cardId,
        rating: "good",
        responseMs: 1800,
        asOf: clock,
      });
      return {
        againDays: preview.intervals?.again.scheduledDays ?? null,
        easyDays: preview.intervals?.easy.scheduledDays ?? null,
        logId: res.reviewLog.id,
        nextDueAt: res.reviewLog.nextDueAt,
        stateDueAt: res.reviewState.dueAt,
      };
    },
    { cardId: qaCardId, clock: AS_OF_GRADE },
  );

  // FSRS interval ordering (the reschedule-per-rating proof).
  expect(graded.againDays).not.toBeNull();
  expect(graded.easyDays).not.toBeNull();
  expect(graded.againDays ?? 0).toBeLessThanOrEqual(graded.easyDays ?? 0);

  // A durable review log was written + the card rescheduled forward off the grade clock.
  expect(graded.logId.length).toBeGreaterThan(0);
  expect(graded.stateDueAt).toBe(graded.nextDueAt);
  expect(Date.parse(graded.nextDueAt)).toBeGreaterThan(Date.parse(AS_OF_GRADE));

  const afterGrade = await inspect(page, qaCardId);
  expect(afterGrade?.review?.logCount ?? 0).toBe(1);
  expect(afterGrade?.element.stage).toBe("active_card"); // active rotation (first-scheduled at creation)

  // The cloze sibling card is ALSO first-scheduled (both authored cards enter the
  // deck), so suspend it through the bridge FIRST — it leaves the deck entirely,
  // leaving the Q&A card as the sole due card so the UI drive below is deterministic
  // (the session completes after the single UI grade, as the review surface intends).
  await page.evaluate(async (cardId) => {
    const api = window.appApi as unknown as {
      cards: { suspend(req: { cardId: string }): Promise<unknown> };
    };
    await api.cards.suspend({ cardId });
  }, clozeCardId);

  // Now drive the `/review` UI at a far-future clock so the Q&A card reads as due.
  // The screen reveals the answer + shows the four interval previews, and a UI grade
  // writes ANOTHER durable log + reschedules — the real review surface, mouse-free.
  await page.goto(`${baseUrl}/review?asOf=${encodeURIComponent(AS_OF_DUE)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-review")).toBeVisible();
  await expect(page.getByTestId("review-card")).toBeVisible();
  await expect(page.getByTestId("review-prompt")).toBeVisible();
  await expect(page.getByTestId("review-answer")).toHaveCount(0);

  // Reveal (Space) → the answer + the four grade buttons with real previews appear.
  await page.getByTestId("review-reveal").click();
  await expect(page.getByTestId("review-answer")).toBeVisible();
  await expect(page.getByTestId("review-grades")).toBeVisible();
  for (const rating of ["again", "hard", "good", "easy"]) {
    await expect(page.getByTestId(`review-interval-${rating}`)).not.toHaveText("…");
  }

  // Grade "good" through the UI button → reschedule + a second durable log.
  await page.getByTestId("review-grade-good").click();
  // The Q&A card was the only remaining due card → the session completes.
  await expect(page.getByTestId("review-summary")).toBeVisible();

  // The Q&A card got its SECOND durable log through the UI grade + rescheduled forward.
  const afterUi = await inspect(page, qaCardId);
  expect(afterUi?.review?.logCount ?? 0).toBe(2);
  expect(afterUi?.review?.reps ?? 0).toBe(2);
  qaDueAfterGrade = afterUi?.review?.dueAt ?? null;
  expect(qaDueAfterGrade).toBeTruthy();
  expect(Date.parse(qaDueAfterGrade ?? "")).toBeGreaterThan(Date.parse(AS_OF_DUE));

  await app.close();
});

// =============================================================================
// 7. SEARCH — a query for a word in the source/extract/card returns all three.
// =============================================================================
test("7. search: a seeded term returns the source, extract, and card", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Through the `/search` UI: typing the term surfaces grouped results.
  await page.goto(`${baseUrl}/search`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-search")).toBeVisible();
  await page.getByTestId("library-search-input").fill(SEARCH_TERM);
  await expect(page.getByTestId("library-group-source")).toBeVisible();

  // Through the bridge: the FTS index returns the source + extract + card we authored.
  const res = await page.evaluate(async (term) => {
    const api = window.appApi as unknown as {
      search: {
        query(r: { q: string }): Promise<{ results: { id: string; type: string }[] }>;
      };
    };
    const { results } = await api.search.query({ q: term });
    return {
      ids: results.map((r) => r.id),
      types: [...new Set(results.map((r) => r.type))],
    };
  }, SEARCH_TERM);
  expect(res.types).toContain("source");
  expect(res.types).toContain("extract");
  expect(res.types).toContain("card");
  expect(res.ids).toContain(sourceId);
  expect(res.ids).toContain(extractId);
  // The term ("forgetting") is in the Q&A prompt + the cloze text, so at least one
  // of the two authored cards is returned.
  expect(res.ids.some((id) => id === qaCardId || id === clozeCardId)).toBe(true);

  await app.close();
});

// =============================================================================
// 8. OPEN ORIGINAL SOURCE — from the extract, jump to the originating paragraph
//    (the T022 navigateToLocation flash), proving lineage is navigable.
// =============================================================================
test("8. open original source: jumping from the extract lands on the originating paragraph", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Open the reader, select the extract in the inspector's lineage, jump to source.
  await openReader(page, sourceId);
  const row = page.locator(`[data-testid="lineage-row"][data-element-id="${extractId}"]`).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();

  const jump = page.getByTestId("location-jump");
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(page.getByText(/^Jumped to source/)).toBeVisible();
  // The originating paragraph (the extract's anchor block) scrolls in + flashes.
  await expect(page.locator(`.reader [data-block-id="${extractBlockId}"].jumped`)).toBeVisible();

  await app.close();
});

// =============================================================================
// 9. BACKUP — produce a restore-ready `.zip` (app.sqlite + assets + manifest);
//    verify the bundle + integrity hashes off disk.
// =============================================================================
test("9. backup: a valid, hashed backup zip is written to the vault", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Trigger the backup through the typed bridge (the SAME `backups.create` the
  // /settings "Back up now" button calls). The renderer never touches the fs.
  const result = (await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      backups: {
        create(): Promise<{
          archiveName: string;
          sizeBytes: number;
          fileCount: number;
          schemaVersion: string;
        }>;
      };
    };
    return api.backups.create();
  })) as { archiveName: string; sizeBytes: number; fileCount: number; schemaVersion: string };

  expect(result.archiveName.endsWith(".zip")).toBe(true);
  expect(result.sizeBytes).toBeGreaterThan(0);
  expect(result.fileCount).toBeGreaterThanOrEqual(1); // at least app.sqlite
  // The backup lives under the test data dir's backups/ — outside the DB.
  backupZipPath = path.join(dataDir, "backups", result.archiveName);
  expect(fs.existsSync(backupZipPath)).toBe(true);

  // Unzip with the system tool + verify the canonical layout + every manifest hash.
  const unzipDir = fs.mkdtempSync(path.join(dataDir, "unzip-"));
  execFileSync("unzip", ["-q", backupZipPath, "-d", unzipDir]);
  expect(fs.existsSync(path.join(unzipDir, "app.sqlite"))).toBe(true);
  expect(fs.existsSync(path.join(unzipDir, "manifest.json"))).toBe(true);

  const manifest = JSON.parse(fs.readFileSync(path.join(unzipDir, "manifest.json"), "utf8"));
  expect(manifest.formatVersion).toBe(1);
  expect(manifest.schemaVersion).toBe(result.schemaVersion);
  expect(manifest.counts.elements).toBeGreaterThan(0);
  expect(manifest.files[0].path).toBe("app.sqlite");
  for (const entry of manifest.files as { path: string; sha256: string; size: number }[]) {
    const bytes = fs.readFileSync(path.join(unzipDir, ...entry.path.split("/")));
    expect(entry.sha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    expect(entry.size).toBe(bytes.length);
  }

  await app.close();
});

// =============================================================================
// 10 + 11. RESTART → VERIFY PERSISTENCE — relaunch against the SAME data dir and
//    re-read every artifact through the bridge. Nothing was lost.
// =============================================================================
test("10+11. restart + verify: every artifact survives an app restart", async () => {
  // The RESTART: a brand-new Electron process against the SAME data dir.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  // --- the source (active, still present) ------------------------------------
  const source = await inspect(page, sourceId);
  expect(source?.element.type).toBe("source");
  expect(source?.element.status).toBe("active");

  // --- the read-point ---------------------------------------------------------
  const readPoint = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      readPoints: {
        get(req: { elementId: string }): Promise<{ readPoint: { blockId: string } | null }>;
      };
    };
    return (await api.readPoints.get({ elementId: id })).readPoint;
  }, sourceId);
  expect(readPoint).not.toBeNull();

  // --- the extract + its source location + lineage ---------------------------
  const extract = await inspect(page, extractId);
  expect(extract?.element.type).toBe("extract");
  expect(extract?.source?.id).toBe(sourceId);
  expect(extract?.review).toBeNull(); // still an attention item, not FSRS
  expect(extract?.location?.sourceElementId).toBe(sourceId);
  expect(extract?.location?.blockIds).toContain(extractBlockId);
  const nodes = await lineageNodes(page, extractId);
  expect(nodes.some((n) => n.id === sourceId)).toBe(true);
  expect(nodes.some((n) => n.id === extractId)).toBe(true);

  // --- both cards (lineage intact) -------------------------------------------
  for (const cardId of [qaCardId, clozeCardId]) {
    const card = await inspect(page, cardId);
    expect(card?.element.type).toBe("card");
    expect(card?.parent?.id).toBe(extractId);
    expect(card?.source?.id).toBe(sourceId);
  }

  // --- the review logs + advanced due date (two grades survived) -------------
  const qa = await inspect(page, qaCardId);
  expect(qa?.review?.logCount ?? 0).toBe(2);
  expect(qa?.review?.reps ?? 0).toBe(2);
  expect(qa?.review?.dueAt).toBe(qaDueAfterGrade);

  // --- the search index still finds the content ------------------------------
  const search = await page.evaluate(async (term) => {
    const api = window.appApi as unknown as {
      search: { query(r: { q: string }): Promise<{ results: { id: string; type: string }[] }> };
    };
    const { results } = await api.search.query({ q: term });
    return { ids: results.map((r) => r.id), types: [...new Set(results.map((r) => r.type))] };
  }, SEARCH_TERM);
  expect(search.types).toContain("source");
  expect(search.types).toContain("extract");
  expect(search.types).toContain("card");
  expect(search.ids).toContain(sourceId);
  expect(search.ids).toContain(extractId);

  // --- the source location is still navigable (open-source jump) -------------
  await openReader(page, sourceId);
  const row = page.locator(`[data-testid="lineage-row"][data-element-id="${extractId}"]`).first();
  await expect(row).toBeVisible();
  await row.click();
  const jump = page.getByTestId("location-jump");
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(page.locator(`.reader [data-block-id="${extractBlockId}"].jumped`)).toBeVisible();

  // --- the backup bundle is still on disk ------------------------------------
  expect(fs.existsSync(backupZipPath)).toBe(true);

  await app.close();
});

test("12. render-loop continuity: review resume is preserved across relaunch", async () => {
  expect(qaCardId).toBeTruthy();
  expect(qaDueAfterGrade).toBeTruthy();

  const renderClock = qaDueAfterGrade ?? AS_OF_DUE;

  const appA = await launchApp(dataDir);
  const pageA = await appA.firstWindow();
  await pageA.waitForLoadState("domcontentloaded");
  const launchUrl = new URL(pageA.url());
  baseUrl = `${launchUrl.protocol}//${launchUrl.host}`;

  await pageA.goto(`${baseUrl}/review?asOf=${encodeURIComponent(renderClock)}`);
  await pageA.waitForLoadState("domcontentloaded");
  await expect(pageA.getByTestId("route-review")).toBeVisible();

  const firstReview = await pageA.evaluate(
    async (cardId, clock) => {
      const api = window.appApi as unknown as {
        review: {
          preview(req: { cardId: string; asOf?: string }): Promise<{
            intervals: Record<"again" | "hard" | "good" | "easy", { scheduledDays: number }> | null;
          }>;
        };
      };
      return api.review.preview({ cardId, asOf: clock });
    },
    qaCardId,
    renderClock,
  );
  expect(firstReview.intervals).toBeTruthy();
  await appA.close();

  const appB = await launchApp(dataDir);
  const pageB = await appB.firstWindow();
  await pageB.waitForLoadState("domcontentloaded");
  const nextLaunchUrl = new URL(pageB.url());
  baseUrl = `${nextLaunchUrl.protocol}//${nextLaunchUrl.host}`;

  await pageB.goto(`${baseUrl}/review?asOf=${encodeURIComponent(renderClock)}`);
  await pageB.waitForLoadState("domcontentloaded");
  await expect(pageB.getByTestId("route-review")).toBeVisible();

  const secondReview = await pageB.evaluate(
    async (cardId, clock) => {
      const api = window.appApi as unknown as {
        review: {
          preview(req: { cardId: string; asOf?: string }): Promise<{
            intervals: Record<"again" | "hard" | "good" | "easy", { scheduledDays: number }> | null;
          }>;
        };
      };
      return api.review.preview({ cardId, asOf: clock });
    },
    qaCardId,
    renderClock,
  );
  expect(secondReview.intervals).toEqual(firstReview.intervals);

  await appB.close();
});
