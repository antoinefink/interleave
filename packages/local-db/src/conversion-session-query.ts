/**
 * ConversionSessionQuery (T120/U1) — read-only assembly for batch card conversion.
 *
 * The query starts from the canonical due queue session candidates so conversion
 * inherits queue membership, T076 score order, and source/concept de-clumping. It
 * then narrows the deck to due live atomic statements that are safe to offer to a
 * card builder: sourced, grounded, not terminal-fated, not already synthesized, and
 * not already represented by a live child card.
 *
 * Read-only: no due-date changes, no review-state changes, and no operation_log
 * appends. Later IPC/UI layers can freeze this payload into a session snapshot.
 */

import type {
  AiActionType,
  AiSuggestionKind,
  BlockId,
  DraftCard,
  Element,
  ElementId,
  ElementLocation,
  IsoTimestamp,
  SourceRef,
} from "@interleave/core";
import {
  elementRelations,
  elements as elementsTable,
  type InterleaveDatabase,
  sourceLocations,
} from "@interleave/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AiSuggestion } from "./ai-suggestion-repository";
import type { Repositories } from "./index";
import { rowToElement, rowToSourceLocation } from "./mappers";
import { type QueueItemSummary, QueueQuery, type QueueSchedulerSignals } from "./queue-query";
import { resolveSourceRef } from "./source-ref-query";

export const DEFAULT_CONVERSION_SESSION_LIMIT = 25;
export const MAX_CONVERSION_SESSION_LIMIT = 100;
const CONVERSION_SESSION_CANDIDATE_SCAN_MULTIPLIER = 20;

export type ConversionSessionSkipReason =
  | "not_extract"
  | "not_atomic_statement"
  | "not_live"
  | "terminal_fate"
  | "sourceless"
  | "missing_source_location"
  | "empty_selected_text"
  | "missing_source_blocks"
  | "synthesis_reference"
  | "already_carded"
  | "not_due";

export interface ConversionSessionAiGrounding {
  readonly sourceElementId: ElementId;
  readonly blockIds: readonly BlockId[];
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  readonly selectedText: string;
  readonly context: string | null;
}

export interface ConversionSessionDraftSummary {
  readonly id: string;
  readonly action: AiActionType;
  readonly kind: AiSuggestionKind;
  readonly providerKind: string;
  readonly suggestionText: string;
  readonly cards: readonly DraftCard[];
  readonly createdAt: IsoTimestamp;
}

export interface ConversionSessionItem {
  readonly id: ElementId;
  readonly title: string;
  readonly priority: number;
  readonly dueAt: IsoTimestamp | null;
  readonly schedulerSignals: QueueSchedulerSignals;
  readonly sourceRef: SourceRef;
  readonly aiGrounding: ConversionSessionAiGrounding;
  /** Full live extract body when present; falls back to the source-selected text. */
  readonly plainText: string;
  /** A compact excerpt for list/sidebar rendering. */
  readonly excerpt: string;
  readonly drafts: readonly ConversionSessionDraftSummary[];
}

export interface ConversionSessionSkippedCandidate {
  readonly id: ElementId;
  readonly reason: ConversionSessionSkipReason;
}

export interface ConversionSessionPreview {
  readonly asOf: IsoTimestamp;
  readonly limit: number;
  readonly items: readonly ConversionSessionItem[];
  readonly skipped: readonly ConversionSessionSkippedCandidate[];
  readonly candidateCount: number;
}

interface CandidateContext {
  readonly row: QueueItemSummary;
  readonly element: Element;
  readonly location: ElementLocation;
}

export class ConversionSessionQuery {
  private readonly queue: QueueQuery;

  constructor(
    private readonly db: InterleaveDatabase,
    private readonly repos: Repositories,
  ) {
    this.queue = new QueueQuery(repos);
  }

  preview(
    options: { readonly asOf?: IsoTimestamp; readonly limit?: number } = {},
  ): ConversionSessionPreview {
    const asOf = options.asOf ?? (new Date().toISOString() as IsoTimestamp);
    const limit = normalizeLimit(options.limit);
    const candidateCount = this.repos.queue.dueAttentionCount(asOf, { types: ["extract"] });
    let candidateLimit = Math.min(
      candidateCount,
      limit * CONVERSION_SESSION_CANDIDATE_SCAN_MULTIPLIER,
    );
    if (candidateLimit === 0) candidateLimit = limit * CONVERSION_SESSION_CANDIDATE_SCAN_MULTIPLIER;

    while (true) {
      const candidates = this.queue.sessionPlanCandidates({
        asOf,
        filters: { types: ["extract"] },
        candidateLimit,
      }).items;
      const preview = this.previewFromCandidates(asOf, limit, candidates, candidateCount);
      if (preview.items.length >= limit || candidateLimit >= candidateCount) return preview;
      candidateLimit = Math.min(candidateCount, candidateLimit * 2);
    }
  }

  private previewFromCandidates(
    asOf: IsoTimestamp,
    limit: number,
    candidates: readonly QueueItemSummary[],
    candidateCount: number,
  ): ConversionSessionPreview {
    const candidateIds = candidates.map((row) => row.id as ElementId);
    const elements = this.elementsById(candidateIds);
    const locations = this.locationsByElementId(candidateIds);
    const liveSourceLocationIds = this.liveElementIds(
      [...locations.values()].map((location) => location.sourceElementId),
    );
    const liveRootSourceIds = this.liveElementIds(
      candidates.map((row) => row.sourceId).filter((id): id is string => id !== null),
    );
    const synthesized = this.liveSynthesisReferenceTargets(candidateIds);
    const carded = this.liveChildCardParents(candidateIds);

    const bounded: CandidateContext[] = [];
    const skipped: ConversionSessionSkippedCandidate[] = [];
    for (const row of candidates) {
      const id = row.id as ElementId;
      const element = elements.get(id);
      const location = locations.get(id);
      const reason = this.skipReasonFor({
        row,
        element,
        location,
        liveSourceLocationIds,
        liveRootSourceIds,
        synthesized,
        carded,
      });
      if (reason) {
        skipped.push({ id, reason });
        continue;
      }
      bounded.push({ row, element: element as Element, location: location as ElementLocation });
      if (bounded.length >= limit) break;
    }

    const boundedIds = bounded.map((candidate) => candidate.element.id);
    const draftsByElement = this.repos.aiSuggestions.listLiveForElements(boundedIds);

    return {
      asOf,
      limit,
      items: bounded.map((candidate) =>
        this.toItem(candidate, draftsByElement.get(candidate.element.id) ?? []),
      ),
      skipped,
      candidateCount,
    };
  }

  previewByIds(
    ids: readonly ElementId[],
    options: { readonly asOf?: IsoTimestamp } = {},
  ): ConversionSessionPreview {
    const asOf = options.asOf ?? (new Date().toISOString() as IsoTimestamp);
    const orderedIds = [...new Set(ids)];
    const asOfMs = Date.parse(asOf);
    const orderedCandidates = orderedIds.flatMap((id) => {
      const row = this.queue.summaryFor(id, asOf);
      if (!row) return [];
      const dueMs = row.dueAt ? Date.parse(row.dueAt) : Number.POSITIVE_INFINITY;
      return row.queueEligible && dueMs <= asOfMs ? [row] : [];
    });
    const missingOrNotDue = new Set(
      orderedIds.filter((id) => !orderedCandidates.some((row) => row.id === id)),
    );
    const candidateIds = orderedCandidates.map((row) => row.id as ElementId);
    const elements = this.elementsById(candidateIds);
    const locations = this.locationsByElementId(candidateIds);
    const liveSourceLocationIds = this.liveElementIds(
      [...locations.values()].map((location) => location.sourceElementId),
    );
    const liveRootSourceIds = this.liveElementIds(
      orderedCandidates.map((row) => row.sourceId).filter((id): id is string => id !== null),
    );
    const synthesized = this.liveSynthesisReferenceTargets(candidateIds);
    const carded = this.liveChildCardParents(candidateIds);

    const bounded: CandidateContext[] = [];
    const skipped: ConversionSessionSkippedCandidate[] = [];
    for (const id of missingOrNotDue) {
      skipped.push({ id, reason: "not_due" });
    }
    for (const row of orderedCandidates) {
      const id = row.id as ElementId;
      const element = elements.get(id);
      const location = locations.get(id);
      const reason = this.skipReasonFor({
        row,
        element,
        location,
        liveSourceLocationIds,
        liveRootSourceIds,
        synthesized,
        carded,
      });
      if (reason) {
        skipped.push({ id, reason });
        continue;
      }
      bounded.push({ row, element: element as Element, location: location as ElementLocation });
    }

    const boundedIds = bounded.map((candidate) => candidate.element.id);
    const draftsByElement = this.repos.aiSuggestions.listLiveForElements(boundedIds);

    return {
      asOf,
      limit: orderedIds.length,
      items: bounded.map((candidate) =>
        this.toItem(candidate, draftsByElement.get(candidate.element.id) ?? []),
      ),
      skipped,
      candidateCount: orderedIds.length,
    };
  }

  private skipReasonFor(input: {
    readonly row: QueueItemSummary;
    readonly element: Element | undefined;
    readonly location: ElementLocation | undefined;
    readonly liveSourceLocationIds: ReadonlySet<ElementId>;
    readonly liveRootSourceIds: ReadonlySet<ElementId>;
    readonly synthesized: ReadonlySet<ElementId>;
    readonly carded: ReadonlySet<ElementId>;
  }): ConversionSessionSkipReason | null {
    const id = input.row.id as ElementId;
    const element = input.element;
    if (!element || element.deletedAt) return "not_live";
    if (element.type !== "extract") return "not_extract";
    if (element.stage !== "atomic_statement") return "not_atomic_statement";
    if (element.extractFate !== null) return "terminal_fate";
    if (!element.sourceId || !input.liveRootSourceIds.has(element.sourceId)) return "sourceless";
    if (!input.location) return "missing_source_location";
    if (!input.liveSourceLocationIds.has(input.location.sourceElementId)) return "sourceless";
    if (input.location.selectedText.trim().length === 0) return "empty_selected_text";
    if (input.location.blockIds.length === 0) return "missing_source_blocks";
    if (input.synthesized.has(id)) return "synthesis_reference";
    if (input.carded.has(id)) return "already_carded";
    return null;
  }

  private toItem(
    candidate: CandidateContext,
    suggestions: readonly AiSuggestion[],
  ): ConversionSessionItem {
    const { element, location, row } = candidate;
    const sourceRef = resolveSourceRef(this.repos, element.id) ?? {
      sourceElementId: null,
      sourceTitle: null,
      url: null,
      author: null,
      publishedAt: null,
      locationLabel: null,
      snippet: null,
      sourceType: null,
      reliabilityTier: null,
      confidence: null,
      reliabilityNotes: null,
    };
    const plainText = this.extractPlainText(element.id, location.selectedText);
    return {
      id: element.id,
      title: row.title,
      priority: row.priority,
      dueAt: row.dueAt as IsoTimestamp | null,
      schedulerSignals: row.schedulerSignals,
      sourceRef,
      aiGrounding: {
        sourceElementId: location.sourceElementId,
        blockIds: location.blockIds,
        startOffset: location.startOffset,
        endOffset: location.endOffset,
        selectedText: location.selectedText,
        context: sourceRef.snippet ?? null,
      },
      plainText,
      excerpt: excerptFor(plainText),
      drafts: suggestions.map(toDraftSummary),
    };
  }

  private extractPlainText(extractId: ElementId, fallback: string): string {
    const text = this.repos.documents.findById(extractId)?.plainText.trim();
    return text && text.length > 0 ? text : fallback.trim();
  }

  private elementsById(ids: readonly ElementId[]): Map<ElementId, Element> {
    const unique = [...new Set(ids)];
    const byId = new Map<ElementId, Element>();
    if (unique.length === 0) return byId;
    const rows = this.db
      .select()
      .from(elementsTable)
      .where(inArray(elementsTable.id, unique))
      .all();
    for (const row of rows) byId.set(row.id as ElementId, rowToElement(row));
    return byId;
  }

  private locationsByElementId(ids: readonly ElementId[]): Map<ElementId, ElementLocation> {
    const unique = [...new Set(ids)];
    const byElement = new Map<ElementId, ElementLocation>();
    if (unique.length === 0) return byElement;
    const rows = this.db
      .select()
      .from(sourceLocations)
      .where(inArray(sourceLocations.elementId, unique))
      .all();
    for (const row of rows) {
      const location = rowToSourceLocation(row);
      if (!byElement.has(location.elementId)) byElement.set(location.elementId, location);
    }
    return byElement;
  }

  private liveElementIds(ids: readonly string[]): Set<ElementId> {
    const unique = [...new Set(ids)];
    const out = new Set<ElementId>();
    if (unique.length === 0) return out;
    const rows = this.db
      .select({ id: elementsTable.id })
      .from(elementsTable)
      .where(and(inArray(elementsTable.id, unique), isNull(elementsTable.deletedAt)))
      .all();
    for (const row of rows) out.add(row.id as ElementId);
    return out;
  }

  private liveChildCardParents(ids: readonly ElementId[]): Set<ElementId> {
    const unique = [...new Set(ids)];
    const out = new Set<ElementId>();
    if (unique.length === 0) return out;
    const rows = this.db
      .select({ parentId: elementsTable.parentId })
      .from(elementsTable)
      .where(
        and(
          inArray(elementsTable.parentId, unique),
          eq(elementsTable.type, "card"),
          isNull(elementsTable.deletedAt),
        ),
      )
      .all();
    for (const row of rows) if (row.parentId) out.add(row.parentId as ElementId);
    return out;
  }

  private liveSynthesisReferenceTargets(ids: readonly ElementId[]): Set<ElementId> {
    const unique = [...new Set(ids)];
    const out = new Set<ElementId>();
    if (unique.length === 0) return out;
    const rows = this.db
      .select({ targetId: elementRelations.toElementId })
      .from(elementRelations)
      .innerJoin(elementsTable, eq(elementRelations.fromElementId, elementsTable.id))
      .where(
        and(
          inArray(elementRelations.toElementId, unique),
          eq(elementRelations.relationType, "references"),
          eq(elementsTable.type, "synthesis_note"),
          isNull(elementsTable.deletedAt),
        ),
      )
      .all();
    for (const row of rows) out.add(row.targetId as ElementId);
    return out;
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONVERSION_SESSION_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CONVERSION_SESSION_LIMIT;
  return Math.min(MAX_CONVERSION_SESSION_LIMIT, Math.floor(value));
}

function excerptFor(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 500).trimEnd()}...` : normalized;
}

function toDraftSummary(suggestion: AiSuggestion): ConversionSessionDraftSummary {
  return {
    id: suggestion.id,
    action: suggestion.action,
    kind: suggestion.kind,
    providerKind: suggestion.providerKind,
    suggestionText: suggestion.suggestionText,
    cards: suggestion.cards,
    createdAt: suggestion.createdAt,
  };
}
