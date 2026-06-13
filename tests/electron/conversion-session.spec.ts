/**
 * Batch conversion session E2E (T120).
 *
 * Drives the real Electron app against an isolated data dir:
 *  - seed three due `atomic_statement` extracts through the typed bridge;
 *  - seed inert `ai_suggestions` drafts directly into SQLite while Electron is closed
 *    (deterministic draft fixture, no model/network);
 *  - open `/convert`, create one manual card, one card from a draft, and fate one item;
 *  - restart and verify cards, draft statuses, fate state, and lineage persisted.
 */

import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let dataDir: string;
let baseUrl: string;

interface SeededBacklog {
  readonly sourceId: string;
  readonly manualExtractId: string;
  readonly draftExtractId: string;
  readonly fateExtractId: string;
  readonly draftBlockId: string;
  readonly manualBlockId: string;
}

async function seedBacklog(page: Page): Promise<SeededBacklog> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      sources: {
        importManual(req: { title: string; body: string; priority: "A" | "B" | "C" }): Promise<{
          id: string;
        }>;
      };
      documents: {
        get(req: { elementId: string }): Promise<{ document: { prosemirrorJson: unknown } | null }>;
      };
      extractions: {
        create(req: {
          sourceElementId: string;
          selectedText: string;
          blockIds: string[];
          startOffset?: number;
          endOffset?: number;
          title?: string;
          priority?: "A" | "B" | "C";
        }): Promise<{ extract: { id: string } }>;
      };
      extracts: {
        updateStage(req: { id: string; stage: "atomic_statement" }): Promise<unknown>;
      };
      queue: {
        schedule(req: { id: string; choice: { kind: "manual"; date: string } }): Promise<unknown>;
      };
    };
    const source = await api.sources.importManual({
      title: "T120 conversion fixture",
      priority: "A",
      body: "Intelligence is skill-acquisition efficiency over a scope of tasks.\n\nThe task scope defines the generalization space.\n\nReference-only statements can be retired without producing a card.",
    });
    const doc = await api.documents.get({ elementId: source.id });
    const blocks = (
      (doc.document?.prosemirrorJson as { content?: { attrs?: { blockId?: string } }[] })
        ?.content ?? []
    )
      .map((node) => node.attrs?.blockId ?? "")
      .filter(Boolean);
    if (blocks.length < 3) throw new Error("manual source did not produce three stable blocks");

    const manual = await api.extractions.create({
      sourceElementId: source.id,
      selectedText: "Intelligence is skill-acquisition efficiency over a scope of tasks.",
      blockIds: [blocks[0] as string],
      startOffset: 0,
      endOffset: 68,
      title: "Skill acquisition efficiency",
      priority: "A",
    });
    const draft = await api.extractions.create({
      sourceElementId: source.id,
      selectedText: "The task scope defines the generalization space.",
      blockIds: [blocks[1] as string],
      startOffset: 0,
      endOffset: 48,
      title: "Generalization scope",
      priority: "B",
    });
    const fate = await api.extractions.create({
      sourceElementId: source.id,
      selectedText: "Reference-only statements can be retired without producing a card.",
      blockIds: [blocks[2] as string],
      startOffset: 0,
      endOffset: 64,
      title: "Reference-only statement",
      priority: "C",
    });
    for (const id of [manual.extract.id, draft.extract.id, fate.extract.id]) {
      await api.extracts.updateStage({ id, stage: "atomic_statement" });
      await api.queue.schedule({
        id,
        choice: { kind: "manual", date: "2025-01-01T09:00:00.000Z" },
      });
    }
    return {
      sourceId: source.id,
      manualExtractId: manual.extract.id,
      draftExtractId: draft.extract.id,
      fateExtractId: fate.extract.id,
      draftBlockId: blocks[1] as string,
      manualBlockId: blocks[0] as string,
    };
  });
}

function seedDraft(input: {
  backlog: SeededBacklog;
  owningElementId: string;
  blockId: string;
  suffix: string;
  prompt: string;
  answer: string;
  suggestionText: string;
  selectedText: string;
}): string {
  const db = new Database(path.join(dataDir, "app.sqlite"));
  const id = `sug_e2e_${input.suffix}_${Date.now()}`;
  try {
    db.prepare(
      `INSERT INTO ai_suggestions (
        id,
        owning_element_id,
        action,
        kind,
        provider_kind,
        suggestion_text,
        cards,
        source_element_id,
        source_block_ids,
        start_offset,
        end_offset,
        selected_text,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.owningElementId,
      "suggest_qa",
      "card_qa",
      "anthropic",
      input.suggestionText,
      JSON.stringify([
        {
          kind: "qa",
          prompt: input.prompt,
          answer: input.answer,
        },
      ]),
      input.backlog.sourceId,
      JSON.stringify([input.blockId]),
      0,
      input.selectedText.length,
      input.selectedText,
      "draft",
      new Date().toISOString(),
    );
    return id;
  } finally {
    db.close();
  }
}

function readPersistedConversionState(backlog: SeededBacklog, suggestionIds: readonly string[]) {
  const db = new Database(path.join(dataDir, "app.sqlite"));
  try {
    const cards = db
      .prepare(
        `SELECT
           e.parent_id AS parentId,
           e.source_id AS sourceId,
           c.source_location_id AS sourceLocationId,
           c.prompt AS prompt,
           c.answer AS answer,
           sl.source_element_id AS locationSourceId,
           sl.selected_text AS selectedText,
           rs.due_at AS dueAt,
           (
             SELECT COUNT(*)
             FROM element_relations er
             WHERE er.from_element_id = e.id
               AND er.to_element_id = e.parent_id
               AND er.relation_type = 'derived_from'
           ) AS derivedFromCount
         FROM cards c
         JOIN elements e ON e.id = c.element_id
         LEFT JOIN source_locations sl ON sl.id = c.source_location_id
         LEFT JOIN review_states rs ON rs.element_id = c.element_id
         WHERE e.parent_id IN (?, ?, ?)
         ORDER BY e.parent_id, c.prompt`,
      )
      .all(backlog.manualExtractId, backlog.draftExtractId, backlog.fateExtractId) as {
      parentId: string;
      sourceId: string;
      sourceLocationId: string | null;
      prompt: string | null;
      answer: string | null;
      locationSourceId: string | null;
      selectedText: string | null;
      dueAt: string | null;
      derivedFromCount: number;
    }[];
    const suggestions = db
      .prepare(
        `SELECT id, status FROM ai_suggestions WHERE id IN (${suggestionIds.map(() => "?").join(",")})`,
      )
      .all(...suggestionIds) as { id: string; status: string }[];
    const fate = db
      .prepare("SELECT extract_fate AS extractFate FROM elements WHERE id = ?")
      .get(backlog.fateExtractId) as { extractFate: string | null };
    const fateOps = db
      .prepare(
        "SELECT COUNT(*) AS count FROM operation_log WHERE element_id = ? AND op_type = 'update_element'",
      )
      .get(backlog.fateExtractId) as { count: number };
    return { cards, suggestions, fate, fateOps };
  } finally {
    db.close();
  }
}

async function cardsByParent(page: Page, parentIds: readonly string[]) {
  return page.evaluate(async (parents) => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{
          elements: { id: string; type: string; title: string; status: string; stage: string }[];
        }>;
        get(req: { id: string }): Promise<{
          data: {
            parent: { id: string } | null;
            source: { id: string } | null;
            review: unknown | null;
          } | null;
        }>;
      };
    };
    const { elements } = await api.inspector.list();
    const cards = elements.filter((element) => element.type === "card");
    const out: {
      id: string;
      title: string;
      parentId: string | null;
      sourceId: string | null;
      hasReview: boolean;
    }[] = [];
    for (const card of cards) {
      const detail = await api.inspector.get({ id: card.id });
      const parentId = detail.data?.parent?.id ?? null;
      if (!parentId || !parents.includes(parentId)) continue;
      out.push({
        id: card.id,
        title: card.title,
        parentId,
        sourceId: detail.data?.source?.id ?? null,
        hasReview: detail.data?.review != null,
      });
    }
    return out;
  }, parentIds);
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("batch conversion authors manual and draft-backed cards with restart-safe lineage", async () => {
  const app1 = await launchApp(dataDir);
  const seedPage = await app1.firstWindow();
  await seedPage.waitForLoadState("domcontentloaded");
  const url = new URL(seedPage.url());
  baseUrl = `${url.protocol}//${url.host}`;
  const backlog = await seedBacklog(seedPage);
  await app1.close();

  const suggestionId = seedDraft({
    backlog,
    owningElementId: backlog.draftExtractId,
    blockId: backlog.draftBlockId,
    suffix: "used",
    prompt: "What does the task scope define?",
    answer: "The generalization space.",
    suggestionText: "MODEL: task scope question",
    selectedText: "The task scope defines the generalization space.",
  });
  const unusedSuggestionId = seedDraft({
    backlog,
    owningElementId: backlog.manualExtractId,
    blockId: backlog.manualBlockId,
    suffix: "unused",
    prompt: "Unused prompt?",
    answer: "Unused answer.",
    suggestionText: "MODEL: unused draft",
    selectedText: "Intelligence is skill-acquisition efficiency over a scope of tasks.",
  });

  const app2 = await launchApp(dataDir);
  const page = await app2.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.goto(`${baseUrl}/convert`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("convert-session")).toBeVisible();
  await expect(page.getByTestId("convert-selected-title")).toContainText(
    "Skill acquisition efficiency",
  );

  await page.getByTestId("convert-prompt").fill("How does Chollet define intelligence?");
  await page.getByTestId("convert-answer").fill("Skill-acquisition efficiency.");
  await page.getByTestId("convert-create").click();
  await expect(page.getByTestId("convert-selected-title")).toContainText("Generalization scope");

  await page.getByTestId(`convert-use-draft-${suggestionId}`).click();
  await expect(page.getByTestId("convert-prompt")).toHaveValue("What does the task scope define?");
  await page.getByTestId("convert-create").click();
  await expect(page.getByTestId("convert-selected-title")).toContainText(
    "Reference-only statement",
  );
  await page.getByTestId("convert-fate-reference").click();
  await expect(page.getByTestId("convert-empty")).toBeVisible();

  const created = await cardsByParent(page, [backlog.manualExtractId, backlog.draftExtractId]);
  expect(created).toHaveLength(2);
  expect(created.every((card) => card.sourceId === backlog.sourceId)).toBe(true);
  expect(created.every((card) => card.hasReview)).toBe(true);
  await app2.close();

  const afterCreate = readPersistedConversionState(backlog, [suggestionId, unusedSuggestionId]);
  expect(afterCreate.cards).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        parentId: backlog.manualExtractId,
        prompt: "How does Chollet define intelligence?",
        answer: "Skill-acquisition efficiency.",
      }),
      expect.objectContaining({
        parentId: backlog.draftExtractId,
        prompt: "What does the task scope define?",
        answer: "The generalization space.",
      }),
    ]),
  );
  expect(afterCreate.cards.map((card) => card.parentId)).not.toContain(backlog.fateExtractId);
  expect(afterCreate.cards.every((card) => card.sourceLocationId)).toBe(true);
  expect(afterCreate.cards.every((card) => card.locationSourceId === backlog.sourceId)).toBe(true);
  expect(afterCreate.cards.every((card) => card.selectedText?.trim())).toBe(true);
  expect(afterCreate.cards.every((card) => card.derivedFromCount > 0)).toBe(true);
  expect(afterCreate.cards.every((card) => card.dueAt)).toBe(true);
  expect(Object.fromEntries(afterCreate.suggestions.map((row) => [row.id, row.status]))).toEqual({
    [suggestionId]: "dismissed",
    [unusedSuggestionId]: "draft",
  });
  expect(afterCreate.fate.extractFate).toBe("reference");
  expect(afterCreate.fateOps.count).toBeGreaterThan(0);

  const app3 = await launchApp(dataDir);
  const restarted = await app3.firstWindow();
  await restarted.waitForLoadState("domcontentloaded");
  const persisted = await cardsByParent(restarted, [
    backlog.manualExtractId,
    backlog.draftExtractId,
  ]);
  expect(persisted).toHaveLength(2);
  expect(persisted.every((card) => card.sourceId === backlog.sourceId)).toBe(true);
  const afterRestart = readPersistedConversionState(backlog, [suggestionId, unusedSuggestionId]);
  expect(afterRestart.cards).toHaveLength(2);
  expect(afterRestart.cards.every((card) => card.sourceLocationId)).toBe(true);
  expect(afterRestart.cards.every((card) => card.locationSourceId === backlog.sourceId)).toBe(true);
  expect(afterRestart.cards.every((card) => card.derivedFromCount > 0)).toBe(true);
  expect(afterRestart.cards.every((card) => card.dueAt)).toBe(true);
  expect(Object.fromEntries(afterRestart.suggestions.map((row) => [row.id, row.status]))).toEqual({
    [suggestionId]: "dismissed",
    [unusedSuggestionId]: "draft",
  });
  expect(afterRestart.fate.extractFate).toBe("reference");
  await app3.close();
});
