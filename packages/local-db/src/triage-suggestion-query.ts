/**
 * Suggested priority & placement read-model (T127).
 *
 * Gathers the three deterministic signals for an inbox item — semantic neighbors
 * (T087/T088), per-author/per-domain yield (T083), and source-reliability confidence
 * (T091) — and runs them through the pure {@link scoreTriageSuggestion} scorer to
 * produce a suggested band + optional concept placement + cited justification, or an
 * `insufficient_signal` verdict. The UI accepts or overrides with one keystroke; this
 * surface never writes (no transaction, no `operation_log`) — it only RANKS.
 *
 * Mirrors {@link ConversionSessionQuery}: constructed `(db, repos)`, composes existing
 * repositories, returns a flat JSON-serializable DTO. The heuristic itself lives in
 * `@interleave/core`; this layer only gathers DB-keyed inputs and selects the placement
 * concept deterministically.
 *
 * ## Why not `RelatedService` for the semantic signal
 *
 * `RelatedService.related`'s `similar` bucket is extract-only, and its concept/sibling
 * buckets early-return `[]` when the seed has no concept memberships — which a fresh
 * inbox source always lacks. So the seed's neighbors and the placement concept are
 * gathered HERE, directly: KNN over the seed's stored **source** vector (same-model
 * only — KTD5), with the placement concept taken from the NEIGHBORS' shared memberships
 * (KTD6), never the seed's own.
 */

import {
  type ConfidenceLevel,
  computeTriageSignalHash,
  DEFAULT_PRIORITY,
  type ElementId,
  FALLBACK_EMBEDDING_MODEL_ID,
  type IsoTimestamp,
  PRIORITY_LABELS,
  type PriorityLabel,
  priorityToLabel,
  scoreTriageSuggestion,
  type TriageInsufficientReason,
  type TriageJustification,
  type TriageSignalInputs,
  type TriageSuggestionVerdict,
  type TriageYieldSignal,
} from "@interleave/core";
import { inboxSourceDomain } from "./inbox-query";
import type { Repositories } from "./index";
import type { AuthorDomainYieldAggregate, AuthorDomainYieldEntry } from "./source-yield-query";

/** How many KNN source neighbors to over-fetch before the non-default-priority filter. */
const NEIGHBOR_FETCH_LIMIT = 20;

/** A suggested band + optional placement + cited justification, carrying a stable signal hash. */
export interface TriageSuggestionSuggestion {
  readonly kind: "suggestion";
  readonly band: PriorityLabel;
  readonly placement?: { readonly conceptId: string; readonly conceptName: string };
  readonly justification: TriageJustification;
  /** The versioned signature of the evidence behind this band (for acceptance-vs-override tuning). */
  readonly signalHash: string;
}

/** A suppressed suggestion (the UI renders nothing); the reason is retained for diagnostics. */
export interface TriageSuggestionInsufficient {
  readonly kind: "insufficient_signal";
  readonly reason: TriageInsufficientReason;
}

/** The flat result the read-model returns for one item. */
export type TriageSuggestionResult = TriageSuggestionSuggestion | TriageSuggestionInsufficient;

/** Metadata-keyed inputs for the import-modal path (no element id, no semantic at intake). */
export interface TriageMetadataInput {
  readonly author?: string | null;
  readonly url?: string | null;
  readonly canonicalUrl?: string | null;
  readonly confidence?: ConfidenceLevel | null;
  /** The picker's current band; a suggestion equal to it is a no-op (`matches_current`). */
  readonly currentBand?: PriorityLabel;
}

/** Map a U2 author/domain aggregate entry into the scorer's yield-signal shape. */
function toYieldSignal(
  entry: AuthorDomainYieldEntry | null | undefined,
): TriageYieldSignal | undefined {
  if (!entry) return undefined;
  return {
    band: entry.yieldBand,
    workedSourceCount: entry.workedSourceCount,
    totalCards: entry.totalCards,
    totalMatureCards: entry.totalMatureCards,
  };
}

/** Lift a core verdict to the read-model result, attaching the signal hash for a suggestion. */
function toResult(
  verdict: TriageSuggestionVerdict,
  inputs: TriageSignalInputs,
): TriageSuggestionResult {
  if (verdict.kind === "insufficient_signal") {
    return { kind: "insufficient_signal", reason: verdict.reason };
  }
  return {
    kind: "suggestion",
    band: verdict.band,
    ...(verdict.placement ? { placement: verdict.placement } : {}),
    justification: verdict.justification,
    signalHash: computeTriageSignalHash(inputs, verdict.band),
  };
}

/**
 * Read-only suggested priority & placement aggregation. Constructed once per open
 * database (alongside the lazy db-service query getters); the main process exposes it
 * over validated IPC.
 */
export class TriageSuggestionQuery {
  constructor(private readonly repos: Repositories) {}

  /** Suggest for one inbox item. Read-only. */
  suggestForInboxItem(id: ElementId, asOf: IsoTimestamp): TriageSuggestionResult {
    return this.suggestOne(id, asOf, null);
  }

  /**
   * Suggest for a batch of inbox items. Builds the author/domain yield aggregate ONCE
   * and indexes it per item (the per-item path would otherwise re-scan the library each
   * call). Read-only.
   */
  suggestForInboxItems(
    ids: readonly ElementId[],
    asOf: IsoTimestamp,
  ): Map<ElementId, TriageSuggestionResult> {
    const aggregate = this.repos.sourceYield.aggregateYieldByAuthorAndDomain(asOf);
    const out = new Map<ElementId, TriageSuggestionResult>();
    for (const id of ids) out.set(id, this.suggestOne(id, asOf, aggregate));
    return out;
  }

  /**
   * Metadata-keyed suggestion for import modals — driven by the author/URL the user
   * entered, before the source is persisted or embedded. Yield + reliability only (the
   * semantic signal is structurally thin at intake); never proposes a placement.
   */
  suggestForMetadata(input: TriageMetadataInput, asOf: IsoTimestamp): TriageSuggestionResult {
    const aggregate = this.repos.sourceYield.aggregateYieldByAuthorAndDomain(asOf);
    const author = input.author?.trim() ? input.author.trim() : null;
    const domain = inboxSourceDomain({
      canonicalUrl: input.canonicalUrl ?? null,
      url: input.url ?? null,
    });
    const authorSignal = toYieldSignal(author ? aggregate.byAuthor.get(author) : undefined);
    const domainSignal = toYieldSignal(domain ? aggregate.byDomain.get(domain) : undefined);
    const inputs: TriageSignalInputs = {
      ...(authorSignal ? { authorYield: authorSignal } : {}),
      ...(domainSignal ? { domainYield: domainSignal } : {}),
      confidence: input.confidence ?? null,
      ...(input.currentBand ? { currentBand: input.currentBand } : {}),
    };
    return toResult(scoreTriageSuggestion(inputs), inputs);
  }

  /**
   * Gather all three signals for one item and score them. `aggregate` is the batch's
   * shared author/domain rollup when present; otherwise a single-item rollup is run.
   */
  private suggestOne(
    id: ElementId,
    asOf: IsoTimestamp,
    aggregate: AuthorDomainYieldAggregate | null,
  ): TriageSuggestionResult {
    const element = this.repos.elements.findById(id);
    if (element?.type !== "source" || element.status !== "inbox") {
      return { kind: "insufficient_signal", reason: "not_inbox_source" };
    }
    const currentBand = priorityToLabel(element.priority);

    // ── Semantic (KTD5): same-model KNN over the seed's own source vector ──
    const semantic = this.gatherSemantic(id);

    // ── Placement (KTD6): the neighbors' most-shared concept ──
    const placementCandidate = semantic ? this.selectPlacement(semantic.neighborIds) : undefined;

    // ── Yield (T083): author preferred, domain fallback ──
    const sourceRow = this.repos.sources.findById(id);
    const author = sourceRow?.source.author?.trim() ? sourceRow.source.author.trim() : null;
    const domain = inboxSourceDomain(sourceRow?.source ?? null);
    let authorEntry: AuthorDomainYieldEntry | null = null;
    let domainEntry: AuthorDomainYieldEntry | null = null;
    if (aggregate) {
      authorEntry = author ? (aggregate.byAuthor.get(author) ?? null) : null;
      domainEntry = domain ? (aggregate.byDomain.get(domain) ?? null) : null;
    } else {
      const lookup = this.repos.sourceYield.getAuthorDomainYield(asOf, author, domain);
      authorEntry = lookup.author;
      domainEntry = lookup.domain;
    }

    const authorSignal = toYieldSignal(authorEntry);
    const domainSignal = toYieldSignal(domainEntry);
    const inputs: TriageSignalInputs = {
      ...(semantic ? { semantic: semantic.signal } : {}),
      ...(authorSignal ? { authorYield: authorSignal } : {}),
      ...(domainSignal ? { domainYield: domainSignal } : {}),
      confidence: sourceRow?.source.confidence ?? null,
      currentBand,
      ...(placementCandidate ? { placementCandidate } : {}),
    };
    return toResult(scoreTriageSuggestion(inputs), inputs);
  }

  /**
   * Gather the semantic neighbor signal for the seed, or `undefined` when thin. Reads
   * the seed's stored vector; a missing record or a fallback-model vector is thin (no
   * comparable neighbor space). KNN is filtered to the seed's own model + `source` type;
   * neighbors still at the default priority carry no signal and are dropped.
   */
  private gatherSemantic(id: ElementId):
    | {
        readonly signal: NonNullable<TriageSignalInputs["semantic"]>;
        readonly neighborIds: readonly ElementId[];
      }
    | undefined {
    const record = this.repos.embeddings.getVectorRecord(id);
    if (!record || record.modelId === FALLBACK_EMBEDDING_MODEL_ID) return undefined;

    const hits = this.repos.embeddings.knn(record.vector, {
      type: "source",
      modelId: record.modelId,
      excludeElementId: id,
      limit: NEIGHBOR_FETCH_LIMIT,
    });

    const neighborIds: ElementId[] = [];
    let prioritySum = 0;
    const bandOrdinals: number[] = [];
    for (const hit of hits) {
      const neighbor = this.repos.elements.findById(hit.elementId);
      // Drop neighbors with no explicit priority signal (still at the fresh-import default).
      if (!neighbor || neighbor.priority === DEFAULT_PRIORITY) continue;
      neighborIds.push(hit.elementId);
      prioritySum += neighbor.priority;
      bandOrdinals.push(PRIORITY_LABELS.indexOf(priorityToLabel(neighbor.priority)));
    }
    if (neighborIds.length === 0) return undefined;

    // Anti-automation-bias (the spec's law): a DISPERSED neighbor set — e.g. two A's and
    // two D's — would average to a confident MIDDLE band (B/C) that NO neighbor actually
    // holds, justified as "Near 4 priority-B neighbors". That is a manufactured guess, so
    // when the surviving neighbors span more than one band the semantic signal is not
    // trustworthy → suppress it (the yield/reliability signals may still fire).
    if (Math.max(...bandOrdinals) - Math.min(...bandOrdinals) > 1) return undefined;

    // The lean is the band of the surviving neighbors' average priority (concentrated set).
    const lean = priorityToLabel(prioritySum / neighborIds.length);
    return {
      signal: { lean, sourceNeighborCount: neighborIds.length, realModel: true },
      neighborIds,
    };
  }

  /**
   * Select the concept shared by the most semantic-neighbor sources (KTD6). Requires a
   * concept shared by ≥2 neighbors; suppresses on an exact tie for the top share count.
   * Tie-break for ordering is share-count DESC then name ASC (deterministic). Returns the
   * candidate or `undefined` (band-only suggestion).
   */
  private selectPlacement(
    neighborIds: readonly ElementId[],
  ): NonNullable<TriageSignalInputs["placementCandidate"]> | undefined {
    const byConcept = new Map<string, { name: string; count: number }>();
    for (const neighborId of neighborIds) {
      const concepts = this.repos.concepts.conceptsForElement(neighborId);
      for (const concept of concepts) {
        const existing = byConcept.get(concept.id);
        if (existing) existing.count += 1;
        else byConcept.set(concept.id, { name: concept.name, count: 1 });
      }
    }
    if (byConcept.size === 0) return undefined;

    // Order by share-count DESC, then name ASC, then id ASC — total + deterministic.
    const ranked = [...byConcept.entries()].sort((a, b) => {
      if (a[1].count !== b[1].count) return b[1].count - a[1].count;
      if (a[1].name !== b[1].name) return a[1].name < b[1].name ? -1 : 1;
      return a[0] < b[0] ? -1 : 1;
    });
    const top = ranked[0];
    if (!top) return undefined;
    const [topId, topInfo] = top;
    // A real shared concept means ≥2 neighbors; a single-neighbor concept is not "shared".
    if (topInfo.count < 2) return undefined;
    // Suppress on an exact tie for the top share count (an arbitrary pick is the confident-guess failure mode).
    const runnerUp = ranked[1];
    if (runnerUp && runnerUp[1].count === topInfo.count) return undefined;

    return { conceptId: topId, conceptName: topInfo.name, sharedByNeighborCount: topInfo.count };
  }
}
