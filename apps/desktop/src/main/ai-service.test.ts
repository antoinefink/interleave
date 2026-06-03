/**
 * AiService tests (T093/T094) — the main-side AI orchestrator.
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB + REAL repos +
 * a REAL `CardService`, with a CONTROLLABLE FAKE runner (records enqueues + restarts) —
 * NO worker, NO model, NO network. They assert the load-bearing AI invariants:
 *
 *  - `enqueue` throws `AiDisabledError` when AI is off (off by default);
 *  - when on, the enqueued `ai` job payload carries ONLY `{ action, providerKind,
 *    owningElementId, request, grounding }` — NO API key (the key never lands in a `jobs`
 *    row); and an `AiStatusResult` never returns the key (only `keyConfigured`);
 *  - `applyResult` persists a `draft` suggestion with card-quality warnings attached;
 *  - `approveCard` mints a PARKED, un-due `card_draft` via the draft-only seam (element
 *    stays `card_draft`, NOT `active_card`; the `review_states` row EXISTS but `dueAt`
 *    is null — NOT due, NOT in the FSRS deck); a non-card suggestion has no approve;
 *  - changing the AI enable/key/provider setting calls `runner.restartWorker(...)`.
 */

import type { BlockId, ElementId } from "@interleave/core";
import { AiDisabledError, DEFAULT_APP_SETTINGS } from "@interleave/core";
import {
  type DbHandle,
  elementRelations,
  elements,
  migrateDatabase,
  openDatabase,
  reviewStates,
  sourceLocations,
} from "@interleave/db";
import {
  CardService,
  createRepositories,
  type Repositories,
  resolveSourceRef,
} from "@interleave/local-db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiService } from "./ai-service";

/** Open a fresh, fully-migrated in-memory DB (mirrors the local-db test-db helper). */
function createInMemoryDb(): DbHandle {
  const handle = openDatabase(":memory:");
  migrateDatabase(handle.db, {});
  return handle;
}

/** A controllable fake runner: records enqueues + restart calls. */
function makeFakeRunner() {
  let seq = 0;
  return {
    enqueued: [] as Array<{ type: string; payload: unknown }>,
    restarts: [] as Array<{ aiApiKey?: string; aiProviderKind?: string } | undefined>,
    enqueue(type: string, payload: unknown) {
      seq += 1;
      this.enqueued.push({ type, payload });
      return { id: `job-${seq}` };
    },
    restartWorker(aiEnv?: { aiApiKey?: string; aiProviderKind?: string }) {
      this.restarts.push(aiEnv);
    },
  };
}

let handle: DbHandle;
let repos: Repositories;
let runner: ReturnType<typeof makeFakeRunner>;
let settings = { ...DEFAULT_APP_SETTINGS };

/** Seed a source + extract; return the owning extract + the grounding span. */
function seed(): { extractId: ElementId; sourceId: ElementId; blockId: BlockId } {
  const sources = repos.sources;
  const { element: source } = sources.createWithDocument({
    title: "On Intelligence",
    priority: 0.875,
    status: "active",
    stage: "raw_source",
    body: "The definition paragraph.\n\nAnother paragraph.",
  });
  const blockId = repos.documents.listBlocks(source.id)[0]?.stableBlockId as BlockId;
  const { element: extract } = sources.createExtract({
    sourceElementId: source.id,
    title: "Definition extract",
    priority: 0.875,
    stage: "atomic_statement",
    selectedText: "The definition paragraph.",
    blockIds: [blockId],
    startOffset: 0,
    endOffset: 25,
    label: "¶1",
  });
  return { extractId: extract.id, sourceId: source.id, blockId };
}

function makeService(): AiService {
  return new AiService({
    repositories: repos,
    getRunner: () => runner as never,
    getSettings: () => settings,
    getCardService: () => new CardService(handle.db),
  });
}

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  runner = makeFakeRunner();
  settings = { ...DEFAULT_APP_SETTINGS };
});

afterEach(() => {
  handle.sqlite.close();
});

describe("AiService.enqueue", () => {
  it("throws AiDisabledError when AI is off (the default)", () => {
    const { extractId, sourceId, blockId } = seed();
    const svc = makeService();
    expect(() =>
      svc.enqueue({
        owningElementId: extractId,
        action: "suggest_qa",
        sourceRef: {
          sourceElementId: sourceId,
          blockIds: [blockId],
          startOffset: 0,
          endOffset: 25,
          selectedText: "The definition paragraph.",
        },
      }),
    ).toThrow(AiDisabledError);
    expect(runner.enqueued).toHaveLength(0);
  });

  it("when on, the enqueued ai payload carries NO API key (never in a jobs row)", () => {
    settings = { ...settings, aiEnabled: true, aiProviderKind: "anthropic", aiApiKey: "sk-SECRET" };
    const { extractId, sourceId, blockId } = seed();
    const svc = makeService();

    const { jobId } = svc.enqueue({
      owningElementId: extractId,
      action: "suggest_qa",
      sourceRef: {
        sourceElementId: sourceId,
        blockIds: [blockId],
        startOffset: 0,
        endOffset: 25,
        selectedText: "The definition paragraph.",
        context: "surrounding",
      },
    });
    expect(jobId).toBe("job-1");
    expect(runner.enqueued).toHaveLength(1);
    const job = runner.enqueued[0];
    if (!job) throw new Error("expected an enqueued job");
    expect(job.type).toBe("ai");
    // The payload carries the action/provider/request/grounding — and NO key anywhere.
    const payload = job.payload as Record<string, unknown>;
    expect(payload.action).toBe("suggest_qa");
    expect(payload.providerKind).toBe("anthropic");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("sk-SECRET");
    expect(serialized).not.toContain("apiKey");
  });
});

describe("AiService.applyResult", () => {
  it("persists a draft suggestion with card-quality warnings on a card draft", () => {
    const { extractId, sourceId, blockId } = seed();
    const svc = makeService();

    const summary = svc.applyResult(
      {
        action: "suggest_qa",
        providerKind: "anthropic",
        owningElementId: extractId,
        request: { action: "suggest_qa", sourceText: "The definition paragraph." },
        grounding: {
          sourceElementId: sourceId,
          blockIds: [blockId],
          startOffset: 0,
          endOffset: 25,
          selectedText: "The definition paragraph.",
        },
      },
      {
        kind: "card_qa",
        text: "model text",
        // A deliberately long answer so a card-quality WARN fires (multiple facts).
        cards: [
          {
            kind: "qa",
            prompt: "What is the definition?",
            answer:
              "It is skill-acquisition efficiency. It also covers a scope of tasks. And prior knowledge.",
          },
        ],
      },
    );

    expect(summary.status).toBe("draft");
    expect(summary.text).toBe("model text");
    // The card-quality checks ran on the draft card (the same T035/T086 heuristics).
    expect(summary.qualityChecks.length).toBeGreaterThan(0);
    expect(summary.qualityChecks.some((c) => c.severity === "warn")).toBe(true);

    // It is a persisted DRAFT row, listable for the element.
    const listed = svc.listForElement(extractId);
    expect(listed.map((s) => s.id)).toContain(summary.id);
  });
});

describe("AiService.approveCard", () => {
  it("mints a PARKED, un-due card_draft (NOT active, dueAt null) via the draft-only seam", () => {
    const { extractId, sourceId, blockId } = seed();
    const svc = makeService();

    const summary = svc.applyResult(
      {
        action: "suggest_qa",
        providerKind: "anthropic",
        owningElementId: extractId,
        request: { action: "suggest_qa", sourceText: "The definition paragraph." },
        grounding: {
          sourceElementId: sourceId,
          blockIds: [blockId],
          startOffset: 0,
          endOffset: 25,
          selectedText: "The definition paragraph.",
        },
      },
      {
        kind: "card_qa",
        text: "model text",
        cards: [{ kind: "qa", prompt: "What is the definition?", answer: "Skill efficiency." }],
      },
    );

    const result = svc.approveCard(summary.id);
    expect(result.approved).toBe(true);
    expect(result.cardId).toBeTruthy();
    const cardId = result.cardId as string;

    // The minted element is a PARKED card_draft — NOT activated.
    const el = handle.db.select().from(elements).where(eq(elements.id, cardId)).get();
    expect(el?.type).toBe("card");
    expect(el?.stage).toBe("card_draft");
    expect(el?.stage).not.toBe("active_card");
    expect(el?.dueAt).toBeNull();

    // The review_states row EXISTS (every card path writes one) but is un-due.
    const rs = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, cardId))
      .get();
    expect(rs).toBeTruthy();
    expect(rs?.dueAt).toBeNull();
    expect(rs?.fsrsState).toBe("new");

    // The suggestion flipped to `approved`.
    expect(repos.aiSuggestions.findById(summary.id)?.status).toBe("approved");
  });

  it("inherits the grounding: writes a source_locations row + derived_from edge so the card resolves the SAME SourceRef (T094)", () => {
    const { extractId, sourceId, blockId } = seed();
    const svc = makeService();

    // The suggestion's grounding refblock (what the model commented ABOUT).
    const summary = svc.applyResult(
      {
        action: "suggest_qa",
        providerKind: "anthropic",
        owningElementId: extractId,
        request: { action: "suggest_qa", sourceText: "The definition paragraph." },
        grounding: {
          sourceElementId: sourceId,
          blockIds: [blockId],
          startOffset: 0,
          endOffset: 25,
          selectedText: "The definition paragraph.",
        },
      },
      {
        kind: "card_qa",
        text: "model text",
        cards: [{ kind: "qa", prompt: "What is the definition?", answer: "Skill efficiency." }],
      },
    );
    const suggestionRef = repos.aiSuggestions.groundingFor(repos, summary.id);

    const result = svc.approveCard(summary.id);
    const cardId = result.cardId as ElementId;

    // A REAL `source_locations` row was written anchored to the minted card, carrying the
    // grounding (the verbatim quote + the same source span) — NOT just copied onto the card.
    const loc = handle.db
      .select()
      .from(sourceLocations)
      .where(eq(sourceLocations.elementId, cardId))
      .get();
    expect(loc).toBeTruthy();
    expect(loc?.sourceElementId).toBe(sourceId);
    expect(loc?.selectedText).toBe("The definition paragraph.");

    // A `derived_from` edge card → owning extract (the `card → extract → source` chain).
    const edge = handle.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.fromElementId, cardId))
      .get();
    expect(edge?.toElementId).toBe(extractId);
    expect(edge?.relationType).toBe("derived_from");

    // The minted card resolves the SAME SourceRef the suggestion's grounding did — the
    // jump-to-source target (sourceElementId) + the verbatim quote match an extract-derived
    // card, so the card's refblock reads identically. (Lineage chain is intact.)
    const cardRef = resolveSourceRef(repos, cardId);
    expect(cardRef?.sourceElementId).toBe(sourceId);
    expect(cardRef?.sourceElementId).toBe(suggestionRef.sourceElementId);
    expect(cardRef?.snippet).toBe(suggestionRef.snippet);
    expect(cardRef?.snippet).toBe("The definition paragraph.");
    expect(cardRef?.sourceTitle).toBe("On Intelligence");
  });

  it("mints the card + flips the suggestion in ONE transaction (a flip failure rolls the card back)", () => {
    const { extractId, sourceId, blockId } = seed();
    const svc = makeService();

    const summary = svc.applyResult(
      {
        action: "suggest_qa",
        providerKind: "anthropic",
        owningElementId: extractId,
        request: { action: "suggest_qa", sourceText: "The definition paragraph." },
        grounding: {
          sourceElementId: sourceId,
          blockIds: [blockId],
          startOffset: 0,
          endOffset: 25,
          selectedText: "The definition paragraph.",
        },
      },
      {
        kind: "card_qa",
        text: "model text",
        cards: [{ kind: "qa", prompt: "What is the definition?", answer: "Skill efficiency." }],
      },
    );

    // Force the in-transaction status flip to throw — atomicity means the WHOLE
    // approve (card mint included) must roll back, leaving no orphan card.
    const spy = vi.spyOn(repos.aiSuggestions, "setStatusWithin").mockImplementation(() => {
      throw new Error("flip failed");
    });

    const cardsBefore = handle.db.select().from(elements).where(eq(elements.type, "card")).all();
    expect(() => svc.approveCard(summary.id)).toThrow("flip failed");

    // No card was committed (the mint rolled back with the failed flip)…
    const cardsAfter = handle.db.select().from(elements).where(eq(elements.type, "card")).all();
    expect(cardsAfter).toHaveLength(cardsBefore.length);
    // …and the suggestion is still a re-approvable `draft` (NOT half-approved).
    expect(repos.aiSuggestions.findById(summary.id)?.status).toBe("draft");

    spy.mockRestore();
  });

  it("refuses to approve a non-card (text) suggestion", () => {
    const { extractId, sourceId, blockId } = seed();
    const svc = makeService();
    const summary = svc.applyResult(
      {
        action: "explain",
        providerKind: "openai",
        owningElementId: extractId,
        request: { action: "explain", sourceText: "The definition paragraph." },
        grounding: {
          sourceElementId: sourceId,
          blockIds: [blockId],
          startOffset: null,
          endOffset: null,
          selectedText: "The definition paragraph.",
        },
      },
      { kind: "text", text: "an explanation" },
    );
    expect(svc.approveCard(summary.id)).toEqual({ approved: false, reason: "not_a_card" });
  });
});

describe("AiService.status + onSettingsChanged", () => {
  it("never returns the key — only keyConfigured", () => {
    settings = { ...settings, aiEnabled: true, aiProviderKind: "openai", aiApiKey: "sk-SECRET" };
    const svc = makeService();
    const status = svc.status();
    expect(status.enabled).toBe(true);
    expect(status.providerKind).toBe("openai");
    expect(status.keyConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("sk-SECRET");
  });

  it("triggers a worker restart with the current AI env when settings change", () => {
    settings = { ...settings, aiEnabled: true, aiProviderKind: "anthropic", aiApiKey: "sk-NEW" };
    const svc = makeService();
    svc.onSettingsChanged();
    expect(runner.restarts).toHaveLength(1);
    expect(runner.restarts[0]).toEqual({ aiApiKey: "sk-NEW", aiProviderKind: "anthropic" });
  });

  it("clears the worker key on restart when AI is disabled", () => {
    settings = { ...settings, aiEnabled: false, aiProviderKind: "anthropic", aiApiKey: "sk-OLD" };
    const svc = makeService();
    svc.onSettingsChanged();
    expect(runner.restarts[0]).toEqual({ aiApiKey: "", aiProviderKind: "anthropic" });
  });
});
