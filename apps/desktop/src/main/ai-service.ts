/**
 * AiService (T093/T094) — the main-side AI-assisted-distillation orchestrator.
 *
 * The OcrService/EmbeddingService twin for AI formulation. AI runs on the T058
 * background runner: a DB-FREE `utilityProcess` worker computes a suggestion (a local
 * model OR the user's own-key HTTP call) and posts it back; THIS service is the
 * main-owned glue:
 *
 *  - {@link enqueue} — read settings, throw {@link AiDisabledError} when `aiEnabled` is
 *    false, build the {@link AiRequest} from the selected source span, then
 *    `getRunner().enqueue("ai", { action, providerKind, request })`. **The API key is
 *    NOT in this payload** — it was baked into the worker's fork env when AI was
 *    enabled (the `restartWorker` re-fork); `enqueue` carries only the non-secret
 *    request shape, so no key ever lands in a persisted `jobs` row.
 *  - {@link applyResult} — the runner's `ai` apply handler. It persists ONE inert
 *    `ai_suggestions` DRAFT row (status `draft`) with the grounding (T094), runs
 *    `evaluateCardQuality` on any card draft, and returns a renderer-safe
 *    {@link AiSuggestionSummary} (NO key, NO raw provider internals). NO `operation_log`
 *    op (a suggestion row is transient draft/infra).
 *  - {@link approveCard} — the explicit user approve: mints a PARKED, un-due
 *    `card_draft` via the DRAFT-ONLY `CardService.createDraftFromSuggestion` seam (NOT
 *    the due-now `createFromExtract`), inheriting the grounding as a real
 *    `source_locations` row + a `derived_from` edge, and flips the suggestion to
 *    `approved` — all in ONE transaction. The card is NOT activated, NOT first-scheduled,
 *    NOT in the FSRS deck; activation stays the user's existing explicit card action.
 *  - {@link onSettingsChanged} — when the AI enable/key/provider settings change, call
 *    `runner.restartWorker(...)` so the worker re-forks with the new env (the key/provider
 *    take effect). The re-fork is gated on the worker being fully idle.
 *  - {@link downloadModel} — the guarded main-side fetch for the local instruction model
 *    (NOT a worker job, NOT a new `JOB_TYPES` member). For the reserved-stub local
 *    provider it simply flips `aiModelDownloaded` (the real `node-llama-cpp` download
 *    lands with the integration).
 *
 * SECURITY: the API key is read main-side from settings ONLY; it is NEVER returned to
 * the renderer (the status projects `keyConfigured: boolean`) and NEVER written to a
 * `jobs` row. Tests inject a `FakeAiProvider` via the worker seam — no live model/network.
 */

import {
  type AiActionType,
  AiDisabledError,
  type AiProviderKind,
  type AiSuggestionKind,
  type AppSettings,
  type BlockId,
  type CardQualityCheck,
  type DraftCard,
  type ElementId,
  evaluateCardQuality,
  suggestionKindForAction,
} from "@interleave/core";
import type { AiSuggestionGrounding, CardService, Repositories } from "@interleave/local-db";
import type { JobRunner } from "./job-runner";

/** The grounding (source span) captured from the renderer selection on enqueue. */
export interface AiSourceRef {
  readonly sourceElementId: ElementId;
  readonly blockIds: readonly BlockId[];
  readonly startOffset?: number | null;
  readonly endOffset?: number | null;
  readonly selectedText: string;
  /** Optional surrounding context to improve the formulation. */
  readonly context?: string;
}

/** The non-secret `ai` job payload MAIN enqueues + persists (NO key — see the module doc). */
export interface AiJobPayload {
  readonly action: AiActionType;
  readonly providerKind: AiProviderKind;
  readonly owningElementId: ElementId;
  readonly consent?: {
    readonly sessionId?: string;
    readonly consentedAt: string;
  };
  readonly request: {
    readonly action: AiActionType;
    readonly sourceText: string;
    readonly context?: string;
  };
  readonly grounding: {
    readonly sourceElementId: ElementId;
    readonly blockIds: readonly string[];
    readonly startOffset: number | null;
    readonly endOffset: number | null;
    readonly selectedText: string;
  };
}

/** The worker's `ai` result `data` shape (validated at this apply boundary). */
export interface AiResultData {
  readonly kind: AiSuggestionKind;
  readonly text: string;
  readonly cards?: readonly DraftCard[];
}

/** A renderer-safe suggestion summary (NO key, NO raw provider internals). */
export interface AiSuggestionSummary {
  readonly id: string;
  readonly action: AiActionType;
  readonly kind: AiSuggestionKind;
  readonly text: string;
  readonly cards: readonly DraftCard[];
  readonly status: string;
  /** The card-quality warnings on any card draft (the same T035/T086 checks). */
  readonly qualityChecks: readonly CardQualityCheck[];
}

/** Constructor dependencies (built lazily against the open DB). */
export interface AiServiceDeps {
  readonly repositories: Repositories;
  readonly getRunner: () => JobRunner;
  readonly getSettings: () => AppSettings;
  /** The card-authoring seam (the draft-only approve path lives on `CardService`). */
  readonly getCardService: () => CardService;
}

export class AiService {
  private readonly repositories: Repositories;
  private readonly getRunner: () => JobRunner;
  private readonly getSettings: () => AppSettings;
  private readonly getCardService: () => CardService;

  constructor(deps: AiServiceDeps) {
    this.repositories = deps.repositories;
    this.getRunner = deps.getRunner;
    this.getSettings = deps.getSettings;
    this.getCardService = deps.getCardService;
  }

  /**
   * Enqueue an AI formulation action over a selected span. Throws
   * {@link AiDisabledError} when `aiEnabled` is false (off by default). Builds the
   * non-secret `ai` job payload (action + provider kind + request + grounding) and
   * returns the enqueued job id so the renderer observes progress via `jobs.subscribe`.
   * The API key is NOT in the payload — it was baked into the worker fork env.
   */
  enqueue(input: {
    owningElementId: ElementId;
    action: AiActionType;
    sourceRef: AiSourceRef;
    consent?: { readonly sessionId?: string; readonly consentedAt: string };
  }): {
    jobId: string;
  } {
    const settings = this.getSettings();
    if (!settings.aiEnabled) {
      throw new AiDisabledError();
    }
    const { sourceRef } = input;
    const payload: AiJobPayload = {
      action: input.action,
      providerKind: settings.aiProviderKind,
      owningElementId: input.owningElementId,
      ...(input.consent ? { consent: input.consent } : {}),
      request: {
        action: input.action,
        sourceText: sourceRef.selectedText,
        ...(sourceRef.context ? { context: sourceRef.context } : {}),
      },
      grounding: {
        sourceElementId: sourceRef.sourceElementId,
        blockIds: [...sourceRef.blockIds],
        startOffset: sourceRef.startOffset ?? null,
        endOffset: sourceRef.endOffset ?? null,
        selectedText: sourceRef.selectedText,
      },
    };
    // The payload is plain JSON; the runner's typed enqueue takes a JobJsonValue.
    const job = this.getRunner().enqueue(
      "ai",
      payload as unknown as Parameters<JobRunner["enqueue"]>[1],
    );
    return { jobId: job.id };
  }

  /**
   * Apply a worker `ai` result (the runner apply handler): persist ONE inert
   * `ai_suggestions` DRAFT row with the grounding (T094), and return a renderer-safe
   * summary with the card-quality warnings on any card draft. NO `operation_log` op —
   * a suggestion row is transient draft/infra. Idempotent enough for at-least-once: a
   * crash-resume re-run would write a second draft row, which the user can dismiss; the
   * approve path (the only mutation that matters) is the user's explicit action.
   */
  applyResult(payload: AiJobPayload, result: AiResultData): AiSuggestionSummary {
    const cards = result.cards ?? [];
    const grounding: AiSuggestionGrounding = {
      sourceElementId: payload.grounding.sourceElementId,
      blockIds: payload.grounding.blockIds as BlockId[],
      startOffset: payload.grounding.startOffset,
      endOffset: payload.grounding.endOffset,
      selectedText: payload.grounding.selectedText,
    };
    const suggestion = this.repositories.aiSuggestions.create({
      owningElementId: payload.owningElementId,
      action: payload.action,
      kind: result.kind ?? suggestionKindForAction(payload.action),
      providerKind: payload.providerKind,
      suggestionText: result.text,
      cards,
      grounding,
    });
    return {
      id: suggestion.id,
      action: suggestion.action,
      kind: suggestion.kind,
      text: suggestion.suggestionText,
      cards: suggestion.cards,
      status: suggestion.status,
      qualityChecks: this.qualityForCards(cards, true),
    };
  }

  /** The draft suggestions for an element (the drafts panel read) — newest first. */
  listForElement(owningElementId: ElementId): AiSuggestionSummary[] {
    return this.repositories.aiSuggestions.listForElement(owningElementId).map((s) => ({
      id: s.id,
      action: s.action,
      kind: s.kind,
      text: s.suggestionText,
      cards: s.cards,
      status: s.status,
      qualityChecks: this.qualityForCards(s.cards, true),
    }));
  }

  /** Dismiss a draft suggestion (soft — status → `dismissed`). */
  dismiss(suggestionId: string): { dismissed: boolean } {
    return this.repositories.aiSuggestions.softDismiss(suggestionId);
  }

  /**
   * Approve a card-shaped suggestion → mint a PARKED, un-due `card_draft` via the
   * DRAFT-ONLY `CardService.createDraftFromSuggestion` seam (NOT the due-now
   * `createFromExtract` — that would activate + first-schedule the card). The card is
   * NOT in the FSRS deck, `review_states.dueAt = null`, element stays `card_draft`. The
   * grounding (T094) is inherited as a real `source_locations` row + a `derived_from`
   * edge, so the minted card's refblock + jump-to-source match an extract-derived card.
   * Flips the suggestion to `approved` in the SAME transaction the card is minted in
   * (via the card service's transaction + the status flip). Rejects on a hard `empty`
   * card-quality blocker.
   */
  approveCard(suggestionId: string): {
    approved: boolean;
    cardId?: string;
    reason?: string;
  } {
    const suggestion = this.repositories.aiSuggestions.findById(suggestionId);
    if (!suggestion) return { approved: false, reason: "not_found" };
    if (suggestion.status !== "draft") return { approved: false, reason: "not_draft" };
    const card = suggestion.cards[0];
    if (!card) return { approved: false, reason: "not_a_card" };

    // Re-validate against card-quality — reject on a hard `empty` block (a hollow card).
    const checks = this.qualityForCards(suggestion.cards, true);
    if (checks.some((c) => c.id === "empty" && c.severity === "block")) {
      return { approved: false, reason: "empty_card" };
    }

    const result = this.getCardService().createDraftFromSuggestion({
      owningElementId: suggestion.owningElementId,
      kind: card.kind,
      ...(card.prompt !== undefined ? { prompt: card.prompt } : {}),
      ...(card.answer !== undefined ? { answer: card.answer } : {}),
      ...(card.cloze !== undefined ? { cloze: card.cloze } : {}),
      ...(suggestion.grounding.sourceElementId
        ? {
            grounding: {
              sourceElementId: suggestion.grounding.sourceElementId,
              blockIds: suggestion.grounding.blockIds,
              startOffset: suggestion.grounding.startOffset,
              endOffset: suggestion.grounding.endOffset,
              selectedText: suggestion.grounding.selectedText,
            },
          }
        : {}),
      // Flip the suggestion `draft → approved` in the SAME transaction the card is
      // minted in (T093 atomicity) — if the card commits but the flip is rolled back
      // the suggestion stays `draft` and could be re-approved into a DUPLICATE card.
      onWithin: (tx) => {
        this.repositories.aiSuggestions.setStatusWithin(tx, suggestionId, "approved");
      },
    });
    return { approved: true, cardId: result.element.id };
  }

  /**
   * The disabled-state + disclosure data the surface reads. NO key (only
   * `keyConfigured: boolean`), NO raw provider internals.
   */
  status(): {
    enabled: boolean;
    providerKind: AiProviderKind;
    keyConfigured: boolean;
    modelDownloaded: boolean;
    managedProxyEnabled: boolean;
  } {
    const s = this.getSettings();
    return {
      enabled: s.aiEnabled,
      providerKind: s.aiProviderKind,
      keyConfigured: s.aiApiKey.trim().length > 0,
      modelDownloaded: s.aiModelDownloaded,
      managedProxyEnabled: s.aiManagedProxyEnabled,
    };
  }

  /**
   * Re-fork the worker (T093) so a changed AI enable/key/provider takes effect — the
   * key/provider are baked into the worker fork env at construction; there is no
   * per-job env channel. Gated on idle inside `restartWorker` (so an unrelated
   * in-flight job is never killed). Called when the AI settings change.
   */
  onSettingsChanged(): void {
    const s = this.getSettings();
    this.getRunner().restartWorker({
      aiApiKey: s.aiEnabled ? s.aiApiKey : "",
      aiProviderKind: s.aiProviderKind,
    });
  }

  /**
   * Download / warm the local instruction model on first enable (the guarded main-side
   * action — NOT a worker job, NOT a new `JOB_TYPES` member). The local provider ships
   * as a reserved STUB in T093, so there is no real `node-llama-cpp` GGUF to stream yet;
   * this flips `aiModelDownloaded = true` in one transaction (idempotent). When the real
   * integration lands this becomes the streamed `*.partial` + checksum + atomic-rename
   * fetch with the `ai:modelDownload` progress event the spec describes.
   */
  downloadModel(): { downloaded: boolean } {
    this.repositories.settings.updateAppSettings({ aiModelDownloaded: true });
    return { downloaded: true };
  }

  /** Evaluate card-quality on the draft cards (the same T035/T086 checks). */
  private qualityForCards(
    cards: readonly DraftCard[],
    hasSource: boolean,
  ): readonly CardQualityCheck[] {
    const card = cards[0];
    if (!card) return [];
    if (card.kind === "qa") {
      return evaluateCardQuality({
        kind: "qa",
        prompt: card.prompt ?? "",
        answer: card.answer ?? "",
        hasSource,
      }).checks;
    }
    return evaluateCardQuality({
      kind: "cloze",
      cloze: card.cloze ?? "",
      hasSource,
    }).checks;
  }
}
