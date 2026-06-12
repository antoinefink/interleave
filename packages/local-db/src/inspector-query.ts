/**
 * Inspector read query (T010) — assembles the universal element inspector's
 * payload by composing the repositories. Read-only: it performs no mutations and
 * appends nothing to the operation log.
 *
 * This is the seam that keeps inspector domain logic OUT of React: the renderer
 * calls `window.appApi.inspector.get(id)` and the Electron main process runs
 * THIS against the open database. It decides — per the load-bearing two-scheduler
 * invariant — whether an element is on the FSRS scheduler (cards: "can the user
 * recall this?") or the attention scheduler (sources/topics/extracts/tasks/
 * synthesis notes: "should the user process this again, and when?"), and surfaces
 * the matching signals. The shapes returned are flat + JSON-serializable so they
 * cross IPC unchanged.
 *
 * Retrievability for cards is approximated here from the persisted FSRS stability
 * and the days since the last review using the FSRS forgetting curve — a pure
 * presentation calculation. The real scheduler (T036) will own the authoritative
 * value; until then this gives the inspector a faithful preview from seeded data.
 */

import type {
  ClipWindow,
  ConfidenceLevel,
  Element,
  ElementId,
  FactExpiryStatus,
  FactLifetime,
  IsoTimestamp,
  RegionRect,
  ReliabilityTier,
  SourceLocationId,
  SourceRef,
  SourceType,
} from "@interleave/core";
import { deriveExpiryStatus, priorityToLabel } from "@interleave/core";
import type { SourceRetirementSuggestion } from "@interleave/scheduler";
import { cardRowToLifetime } from "./card-edit-service";
import type { Repositories } from "./index";
import type { CurrentScheduleReason } from "./operation-log-repository";
import { resolveSourceRef } from "./source-ref-query";

/** Which scheduler an element type is governed by (the FSRS vs attention split). */
export function schedulerKindForType(type: Element["type"]): "fsrs" | "attention" {
  return type === "card" ? "fsrs" : "attention";
}

/** A lightweight element summary (selection picker + lineage rows). */
export interface ElementSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  readonly dueAt: string | null;
  readonly fallowUntil: string | null;
  readonly fallowReason: string | null;
  readonly extractFate: Element["extractFate"];
}

export interface SchedulerSignals {
  readonly kind: "fsrs" | "attention";
  readonly retrievability: number | null;
  readonly stability: number | null;
  readonly difficulty: number | null;
  readonly reps: number | null;
  readonly lapses: number | null;
  readonly fsrsState: string | null;
  readonly stage: string;
  readonly postponed: number;
  /** Structured reason for the currently persisted attention schedule, if explainable. */
  readonly scheduleReason: CurrentScheduleReason | null;
  readonly lastProcessedAt: string | null;
  /**
   * The attention `SchedulerChip`'s promised "yield (N extracts / M cards)" for a
   * SOURCE (T083) — its read %, extracts created, and cards created, surfaced from
   * the SAME read-only `SourceYieldQuery` rollup. `null` for non-source attention
   * items (extracts/topics/tasks) and for cards (the FSRS branch). Read-only.
   */
  readonly yield: SourceYieldSignals | null;
  /** Source-only proactive Done/Abandon suggestion (T103); null for other elements. */
  readonly retirementSuggestion: SourceRetirementSuggestion | null;
}

/** The per-source yield summary the inspector chip shows (T083). */
export interface SourceYieldSignals {
  /** How far the source has been read, in `[0, 1]`. */
  readonly readPct: number;
  /** Live `extract` descendants created from the source. */
  readonly extractsCreated: number;
  /** Extracts that produced non-card value, de-duplicated across fate + synthesis refs. */
  readonly productiveExtracts: number;
  /** Live `card` descendants created from the source. */
  readonly cardsCreated: number;
}

export interface LineageItem {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly stage: string;
}

export interface ReviewSummary {
  readonly dueAt: string | null;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly fsrsState: string;
  readonly lastReviewedAt: string | null;
  readonly logCount: number;
  /**
   * Whether the card is currently RETIRED (T082) — out of active review but kept
   * for reference. The inspector surfaces a Retire / Un-retire toggle from this.
   */
  readonly isRetired: boolean;
}

export interface SourceProvenance {
  readonly elementId: string;
  readonly url: string | null;
  /** Normalized URL derived from `url` (tracking params/fragment stripped). */
  readonly canonicalUrl: string | null;
  /** The as-entered URL preserved verbatim for provenance. */
  readonly originalUrl: string | null;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly accessedAt: string | null;
  readonly reasonAdded: string | null;
  /** Source-reliability metadata (T091) — all nullable (no badge when all absent). */
  readonly sourceType: SourceType | null;
  readonly reliabilityTier: ReliabilityTier | null;
  readonly confidence: ConfidenceLevel | null;
  readonly reliabilityNotes: string | null;
}

export interface LocationSummary {
  readonly label: string | null;
  readonly selectedText: string;
  readonly page: number | null;
  /** The PDF region bbox (T065) for a `media_fragment` region extract, else `null`. */
  readonly region: RegionRect | null;
  /** The media clip window (T074) for a `media_fragment` clip extract, else `null`. */
  readonly clip: ClipWindow | null;
  /** The media clip start in ms (T074) — mirrors `clip.startMs`; else `null`. */
  readonly timestampMs: number | null;
  /** The source element this location points INTO — the reader to open on jump (T022). */
  readonly sourceElementId: string;
  /** Ordered STABLE block ids the selection spans (the scroll target is the first). */
  readonly blockIds: readonly string[];
  /** Char offset within the FIRST spanned block (caret target), or `null`. */
  readonly startOffset: number | null;
  /** Char offset within the LAST spanned block, or `null`. */
  readonly endOffset: number | null;
}

export interface InspectorData {
  readonly element: ElementSummary;
  readonly scheduler: SchedulerSignals;
  readonly parent: LineageItem | null;
  readonly children: readonly LineageItem[];
  readonly source: LineageItem | null;
  readonly provenance: SourceProvenance | null;
  readonly location: LocationSummary | null;
  /**
   * The originating source reference (T043 — the refblock): title/url/author/date
   * + location label + verbatim snippet, resolved from the element's lineage for a
   * source/extract/card so an extract or card selected here never feels orphaned.
   * `null` only when the element has no resolvable source.
   */
  readonly sourceRef: SourceRef | null;
  readonly tags: readonly string[];
  /** Concepts this element is a member of (T041 — `concept_membership` edges). */
  readonly concepts: readonly ConceptInspectorSummary[];
  readonly review: ReviewSummary | null;
  /**
   * The card's claim-lifetime fields + the DERIVED expiry status (T090). Present only
   * for a `card` (the fact carrier; the element-level mirror is deferred). `null` for
   * non-card elements. The `status` is computed MAIN-side via `deriveExpiryStatus(now)`
   * so the renderer never recomputes it; the raw fields back the inspector's Expiry
   * section editor. A card with no lifetime is still present here with `status: "fresh"`
   * and every field `null` (the section renders an "Add expiry" affordance).
   */
  readonly lifetime: FactLifetimeSummary | null;
}

/** The card's claim-lifetime fields + derived expiry status, for the inspector (T090). */
export interface FactLifetimeSummary extends FactLifetime {
  /** The derived `fresh` / `due_for_review` / `expired` attribute (NOT a status). */
  readonly status: FactExpiryStatus;
}

/** A concept summary embedded in the inspector payload (T041). */
export interface ConceptInspectorSummary {
  readonly id: string;
  readonly name: string;
}

/** The FSRS decay constant (factor=19/81, decay=-0.5) used by the forgetting curve. */
const FSRS_DECAY = -0.5;
const FSRS_FACTOR = 19 / 81;

/**
 * Approximate retrievability `R(t) = (1 + FACTOR · t / S)^DECAY` from stability
 * `S` (days) and elapsed days `t` since the last review. A never-reviewed card
 * (no `lastReviewedAt` or non-positive stability) has no meaningful value.
 */
function approximateRetrievability(
  stability: number,
  lastReviewedAt: string | null,
  asOf: Date,
): number | null {
  if (!lastReviewedAt || stability <= 0) return null;
  const last = Date.parse(lastReviewedAt);
  if (Number.isNaN(last)) return null;
  const elapsedDays = Math.max(0, (asOf.getTime() - last) / 86_400_000);
  const r = (1 + (FSRS_FACTOR * elapsedDays) / stability) ** FSRS_DECAY;
  return Math.min(1, Math.max(0, r));
}

function toSummary(el: Element): ElementSummary {
  return {
    id: el.id,
    type: el.type,
    status: el.status,
    stage: el.stage,
    priority: el.priority,
    title: el.title,
    dueAt: el.dueAt,
    fallowUntil: el.fallowUntil,
    fallowReason: el.fallowReason,
    extractFate: el.extractFate,
  };
}

function toLineageItem(el: Element): LineageItem {
  return { id: el.id, type: el.type, title: el.title, stage: el.stage };
}

/**
 * Read-only inspector query layer. Constructed once per open database (alongside
 * {@link Repositories}); the main process exposes its two methods over validated
 * IPC. The renderer never instantiates this.
 */
export class InspectorQuery {
  constructor(private readonly repos: Repositories) {}

  /**
   * Lightweight summaries of every live (not soft-deleted) element across all
   * eight types, newest first, so the renderer can offer a selection picker. The
   * "selected element" the rest of the app sets is just one of these ids.
   */
  list(): ElementSummary[] {
    const { elements } = this.repos;
    const all = [
      ...elements.listByType("source"),
      ...elements.listByType("topic"),
      ...elements.listByType("extract"),
      ...elements.listByType("card"),
      ...elements.listByType("task"),
      ...elements.listByType("concept"),
      ...elements.listByType("media_fragment"),
      ...elements.listByType("synthesis_note"),
    ];
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return all.map(toSummary);
  }

  /**
   * The full inspector payload for one element, or `null` when the id is unknown
   * or soft-deleted. Composes the element + its lineage (parent/children/source),
   * provenance, source location, tags, and the type-appropriate scheduler
   * signals + review summary.
   */
  get(id: ElementId, asOf: Date = new Date()): InspectorData | null {
    const { elements, sources, review } = this.repos;
    const element = elements.findById(id);
    if (!element || element.deletedAt) return null;

    const parent = element.parentId ? elements.findById(element.parentId) : null;
    const source =
      element.sourceId && element.sourceId !== element.id
        ? elements.findById(element.sourceId)
        : null;
    const children = elements.listChildren(id);
    const tags = elements.listTags(id);
    // Concepts the element is a member of (T041 — the `concept_membership` edges).
    const concepts = this.repos.concepts
      .conceptsForElement(id)
      .map((c) => ({ id: c.id as string, name: c.name }));

    const provenanceRow = element.type === "source" ? sources.findById(id) : null;
    const provenance: SourceProvenance | null = provenanceRow
      ? {
          elementId: provenanceRow.element.id,
          url: provenanceRow.source.url,
          canonicalUrl: provenanceRow.source.canonicalUrl,
          originalUrl: provenanceRow.source.originalUrl,
          author: provenanceRow.source.author,
          publishedAt: provenanceRow.source.publishedAt,
          accessedAt: provenanceRow.source.accessedAt,
          reasonAdded: provenanceRow.source.reasonAdded,
          // Source-reliability metadata (T091) — surfaced as the inspector badge.
          sourceType: provenanceRow.source.sourceType,
          reliabilityTier: provenanceRow.source.reliabilityTier,
          confidence: provenanceRow.source.confidence,
          reliabilityNotes: provenanceRow.source.reliabilityNotes,
        }
      : null;

    // An extract's source location is keyed by its own element id; a card's is
    // referenced through the card row's `sourceLocationId` (the card → source
    // location → source anchor). Resolve both so lineage is actionable either way.
    let locationRow = sources.findLocationForElement(id);
    if (!locationRow && element.type === "card") {
      const card = review.findCardById(id);
      const sourceLocationId = card?.card.sourceLocationId as SourceLocationId | null | undefined;
      if (sourceLocationId) {
        locationRow = sources.findLocationById(sourceLocationId);
      }
    }
    const location: LocationSummary | null = locationRow
      ? {
          label: locationRow.label,
          selectedText: locationRow.selectedText,
          page: locationRow.page,
          // The PDF region bbox (T065) for a `media_fragment` region extract.
          region: locationRow.region,
          // The media clip window (T074) for a `media_fragment` clip extract.
          clip: locationRow.clip,
          timestampMs: locationRow.timestampMs,
          // Jump target (T022): everything the renderer needs to open the source
          // reader and scroll/flash the originating block — no extra IPC.
          sourceElementId: locationRow.sourceElementId,
          blockIds: locationRow.blockIds,
          startOffset: locationRow.startOffset,
          endOffset: locationRow.endOffset,
        }
      : null;

    let scheduler: SchedulerSignals;
    let reviewSummary: ReviewSummary | null = null;
    // T090 — the card's claim-lifetime fields + the derived expiry status (cards only).
    let lifetime: FactLifetimeSummary | null = null;

    if (element.type === "card") {
      const cardRow = review.findCardById(id)?.card;
      if (cardRow) {
        const fields = cardRowToLifetime(cardRow);
        lifetime = { ...fields, status: deriveExpiryStatus(fields, asOf) };
      }
      const state = review.findReviewState(id);
      const logCount = review.listReviewLogs(id).length;
      const retrievability = state
        ? approximateRetrievability(state.stability, state.lastReviewedAt, asOf)
        : null;
      scheduler = {
        kind: "fsrs",
        retrievability,
        stability: state?.stability ?? null,
        difficulty: state?.difficulty ?? null,
        reps: state?.reps ?? null,
        lapses: state?.lapses ?? null,
        fsrsState: state?.fsrsState ?? null,
        stage: element.stage,
        postponed: 0,
        scheduleReason: null,
        lastProcessedAt: state?.lastReviewedAt ?? null,
        // Yield is a SOURCE concern; a card's panel shows FSRS stats instead.
        yield: null,
        retirementSuggestion: null,
      };
      if (state) {
        reviewSummary = {
          dueAt: state.dueAt,
          stability: state.stability,
          difficulty: state.difficulty,
          reps: state.reps,
          lapses: state.lapses,
          fsrsState: state.fsrsState,
          lastReviewedAt: state.lastReviewedAt,
          logCount,
          isRetired: review.isCardRetired(id),
        };
      }
    } else {
      // The "yield (N extracts / M cards)" chip the attention `SchedulerChip` promises
      // — only meaningful for a SOURCE (the lineage root). Computed from the SAME
      // read-only `SourceYieldQuery` rollup (no duplicated read-%/lineage math).
      let sourceYield: SourceYieldSignals | null = null;
      if (element.type === "source") {
        const row = this.repos.sourceYield.getSourceYield(id, asOf.toISOString() as IsoTimestamp);
        if (row) {
          sourceYield = {
            readPct: row.readPct,
            extractsCreated: row.extractsCreated,
            productiveExtracts: row.productiveExtracts,
            cardsCreated: row.cardsCreated,
          };
        }
      }
      const scheduleProjection = this.repos.operationLog.currentScheduleProjection(
        id,
        element.dueAt,
      );
      scheduler = {
        kind: "attention",
        retrievability: null,
        stability: null,
        difficulty: null,
        reps: null,
        lapses: null,
        fsrsState: null,
        stage: element.stage,
        // The postponed count is read from the op log (T024): each postpone records
        // a `postpone` marker on its `reschedule_element` op, so the count needs no
        // schema column. The full attention scheduler lands with T028.
        postponed: scheduleProjection.effectivePostponeCount,
        scheduleReason: scheduleProjection.reason,
        lastProcessedAt: element.updatedAt,
        yield: sourceYield,
        retirementSuggestion:
          element.type === "source"
            ? this.repos.retirementSuggestions.visibleForSource(element.id)
            : null,
      };
    }

    return {
      element: toSummary(element),
      scheduler,
      parent: parent && !parent.deletedAt ? toLineageItem(parent) : null,
      children: children.map(toLineageItem),
      source: source && !source.deletedAt ? toLineageItem(source) : null,
      provenance,
      location,
      // The originating source reference (T043): one resolver shared with review /
      // extract view / library so the refblock reads consistently everywhere. For a
      // source this is its own provenance; for an extract/card it's the owning
      // source + this element's location anchor (a soft-deleted source degrades to
      // null fields, never a throw).
      sourceRef: resolveSourceRef(this.repos, id),
      tags,
      concepts,
      review: reviewSummary,
      // T090 — claim-lifetime + derived expiry (cards only; null for other types).
      lifetime,
    };
  }
}

/** Re-exported for callers that need the A/B/C/D label (kept colocated). */
export { priorityToLabel };
