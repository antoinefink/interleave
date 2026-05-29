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

import type { Element, ElementId, SourceLocationId } from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import type { Repositories } from "./index";

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
  readonly lastProcessedAt: string | null;
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
}

export interface LocationSummary {
  readonly label: string | null;
  readonly selectedText: string;
  readonly page: number | null;
}

export interface InspectorData {
  readonly element: ElementSummary;
  readonly scheduler: SchedulerSignals;
  readonly parent: LineageItem | null;
  readonly children: readonly LineageItem[];
  readonly source: LineageItem | null;
  readonly provenance: SourceProvenance | null;
  readonly location: LocationSummary | null;
  readonly tags: readonly string[];
  readonly review: ReviewSummary | null;
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
      ? { label: locationRow.label, selectedText: locationRow.selectedText, page: locationRow.page }
      : null;

    let scheduler: SchedulerSignals;
    let reviewSummary: ReviewSummary | null = null;

    if (element.type === "card") {
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
        lastProcessedAt: state?.lastReviewedAt ?? null,
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
        };
      }
    } else {
      scheduler = {
        kind: "attention",
        retrievability: null,
        stability: null,
        difficulty: null,
        reps: null,
        lapses: null,
        fsrsState: null,
        stage: element.stage,
        // The attention scheduler's postponed-count + last-processed land with
        // T028; until then they read from the available signals (0 / updatedAt).
        postponed: 0,
        lastProcessedAt: element.updatedAt,
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
      tags,
      review: reviewSummary,
    };
  }
}

/** Re-exported for callers that need the A/B/C/D label (kept colocated). */
export { priorityToLabel };
