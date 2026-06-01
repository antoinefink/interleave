/**
 * QueueQuery (T029) — the unified, sorted, filtered read behind `/queue`.
 *
 * The daily queue answers TWO different questions with two different schedulers,
 * and this query keeps them distinct (the load-bearing two-scheduler invariant):
 *  - due **cards** come from FSRS via `review_states.due_at` ("can the user
 *    recall this?"), marked `scheduler: "fsrs"` and carrying the memory signals
 *    (retrievability/stability) the `SchedulerChip` shows;
 *  - due **sources/topics/extracts/tasks/synthesis notes** come from the
 *    attention scheduler via `elements.due_at` ("should the user process this
 *    again, and when?"), marked `scheduler: "attention"` and carrying the
 *    stage/postpone signals.
 *
 * It composes {@link QueueRepository} (the two due reads) and the other
 * repositories (provenance/lineage for the per-row meta line, the op log for the
 * attention postpone count). The merged list is then **sorted by priority desc,
 * then `due_at` asc** — deterministic; the 10–20% jitter the daily-queue rule
 * asks for is a SEPARATE, seeded shuffle layer applied by the caller/renderer so
 * re-renders never reshuffle (kept out of here so the sort stays testable).
 *
 * Read-only: no mutations, no `operation_log` append. The renderer reaches this
 * only through the typed `window.appApi.queue.list` command; it never touches SQL.
 */

import type {
  Element,
  ElementId,
  ElementStatus,
  ElementType,
  IsoTimestamp,
} from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import type { Repositories } from "./index";

/** Which scheduler a queue row is on — the FSRS vs attention split. */
export type QueueScheduler = "fsrs" | "attention";

/**
 * The scheduler signals a queue row carries for its `SchedulerChip`. The shape
 * mirrors the inspector's `SchedulerSignals` but is trimmed to what the chip + the
 * queue row need: FSRS rows carry retrievability/stability; attention rows carry
 * stage + postpone count.
 */
export interface QueueSchedulerSignals {
  readonly kind: QueueScheduler;
  /** Card recall probability now (`0.0`–`1.0`), or `null` for new/attention rows. */
  readonly retrievability: number | null;
  /** FSRS memory stability in days, or `null` for attention rows. */
  readonly stability: number | null;
  /** Distillation stage (shown on the attention chip). */
  readonly stage: string;
  /** How many times an attention element has been postponed. */
  readonly postponed: number;
}

/** How "due" a row is relative to `asOf`. */
export type QueueDueState = "overdue" | "today" | "soon";

/** A flat, JSON-serializable queue row crossing IPC to the renderer. */
export interface QueueItemSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  /** The governing due time (FSRS `review_states.due_at` or attention `elements.due_at`). */
  readonly dueAt: string | null;
  readonly scheduler: QueueScheduler;
  readonly schedulerSignals: QueueSchedulerSignals;
  /** The owning source's title (provenance), for the per-row meta line. */
  readonly sourceTitle: string | null;
  /** The source's author, when the row is (or belongs to) a source. */
  readonly author: string | null;
  /** A concept this row is a member of (the first membership), or null (T041). */
  readonly concept: string | null;
  /** Card kind (`qa`/`cloze`), for the card meta line; null for non-cards. */
  readonly cardType: string | null;
  /** True for A-priority items (the `--protected` accent bar). */
  readonly protected: boolean;
  /** Overdue / today / soon, relative to `asOf`. */
  readonly due: QueueDueState;
  /** A short human due label ("Overdue", "Due today", "in 3d"). */
  readonly dueLabel: string;
}

/** The filters a queue read accepts. All optional; absent = no narrowing. */
export interface QueueFilters {
  /** Keep only these element types. */
  readonly types?: readonly ElementType[];
  /** Keep only rows that are a member of this concept (by concept NAME) (T041). */
  readonly concept?: string;
  /** Keep only rows tagged with this tag name (T041). */
  readonly tag?: string;
  /** Keep only these lifecycle statuses. */
  readonly statuses?: readonly ElementStatus[];
}

/** The complete queue read: rows + per-type counts + the budget gauge. */
export interface QueueListData {
  readonly items: readonly QueueItemSummary[];
  /**
   * DRILL-DOWN per-type / at-risk counts: each respects the active status/concept/tag
   * filters but DROPS the type dimension (the chips drive it), so a chip's number
   * equals the rows shown when that chip is selected alongside the other active
   * filters — the count-vs-list invariant. `all` equals the filtered list length (the
   * `/queue` type chips narrow client-side, so `counts.all === items.length` before the
   * optional limit).
   */
  readonly counts: {
    readonly all: number;
    readonly card: number;
    readonly source: number;
    readonly extract: number;
    readonly topic: number;
    readonly task: number;
    readonly highPriority: number;
    readonly overdue: number;
    readonly protected: number;
  };
  /** The daily review budget gauge: items due today vs the configured target. */
  readonly budget: { readonly used: number; readonly target: number };
}

/** The FSRS forgetting-curve constants (factor=19/81, decay=-0.5). */
const FSRS_DECAY = -0.5;
const FSRS_FACTOR = 19 / 81;
const DAY_MS = 86_400_000;

/**
 * Approximate retrievability `R(t) = (1 + FACTOR · t / S)^DECAY` from stability
 * `S` (days) + days since the last review. A never-reviewed card has no value.
 * Mirrors `inspector-query.ts` so the queue + inspector agree until FSRS (T036)
 * owns the authoritative number.
 */
function approximateRetrievability(
  stability: number,
  lastReviewedAt: string | null,
  asOf: number,
): number | null {
  if (!lastReviewedAt || stability <= 0) return null;
  const last = Date.parse(lastReviewedAt);
  if (Number.isNaN(last)) return null;
  const elapsedDays = Math.max(0, (asOf - last) / DAY_MS);
  const r = (1 + (FSRS_FACTOR * elapsedDays) / stability) ** FSRS_DECAY;
  return Math.min(1, Math.max(0, r));
}

/** Classify a due time relative to `asOf` into overdue / today / soon. */
function dueStateFor(dueAt: string | null, asOf: number): QueueDueState {
  if (!dueAt) return "soon";
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return "soon";
  if (due <= asOf) {
    // Same calendar day as `asOf` reads as "today"; earlier reads as "overdue".
    const dueDay = new Date(due).setHours(0, 0, 0, 0);
    const nowDay = new Date(asOf).setHours(0, 0, 0, 0);
    return dueDay < nowDay ? "overdue" : "today";
  }
  return "soon";
}

/** A short human label for a due time relative to `asOf`. */
function dueLabelFor(dueAt: string | null, state: QueueDueState, asOf: number): string {
  if (state === "overdue") return "Overdue";
  if (state === "today") return "Due today";
  if (!dueAt) return "Scheduled";
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return "Scheduled";
  const days = Math.max(1, Math.round((due - asOf) / DAY_MS));
  return `in ${days}d`;
}

/**
 * Read-only queue query layer. Constructed once per open database (alongside
 * {@link Repositories}); the main process exposes it over validated IPC.
 */
export class QueueQuery {
  constructor(private readonly repos: Repositories) {}

  /**
   * The unified, sorted, filtered due queue. Merges due cards (FSRS) and due
   * attention items, decorates each with its scheduler signals + meta, sorts by
   * **priority desc then `due_at` asc**, applies the type/concept/status filters,
   * and computes the DRILL-DOWN per-type counts (respecting the active status/concept/
   * tag filters but not the type dimension, so a chip's count matches the rows shown
   * when that chip is selected) + the budget gauge. Deterministic — jitter is the
   * caller's concern.
   */
  list(
    options: { asOf?: IsoTimestamp; filters?: QueueFilters; limit?: number } = {},
  ): QueueListData {
    const asOfIso = options.asOf ?? (new Date().toISOString() as IsoTimestamp);
    const asOfMs = Date.parse(asOfIso);
    const filters = options.filters ?? {};

    // The two distinct due reads (the FSRS join vs the attention `due_at` read).
    const dueCards = this.repos.queue.dueCards(asOfIso);
    const dueAttention = this.repos.queue.dueAttentionItems(asOfIso);

    const cardRows = dueCards.map((el) => this.toCardSummary(el, asOfMs));
    const attentionRows = dueAttention.map((el) => this.toAttentionSummary(el, asOfMs));
    const all = [...cardRows, ...attentionRows];

    // Pre-resolve concept membership ONCE (not per-row): when a concept-name filter
    // is active, build the canonical `member -> Set<liveConceptId>` map a single time
    // and the set of live concept ids carrying that name, so `matchesFilters` does a
    // map lookup instead of a `conceptsForElement` query per row (no N+1).
    const conceptMatch = filters.concept ? this.buildConceptMatcher(filters.concept) : null;

    // DRILL-DOWN counts (the count-vs-list invariant): the per-type / at-risk counts
    // must respect every ACTIVE filter EXCEPT the type dimension (the chips drive that
    // dimension, so its own value is dropped) — so a chip's number equals the rows you
    // get when that chip is selected together with the OTHER active filters (status /
    // concept / tag). Previously these were over the WHOLE due set ignoring the active
    // status filter, so e.g. the "Active" status filter narrowed the list to 1 source
    // while the "Sources" chip still showed 2 — the same count-vs-list mismatch class as
    // the reported Library bug. We count over the rows that pass status/concept/tag (the
    // non-type predicates); the `/queue` UI applies the type chip client-side and never
    // sends `types`, so this set carries every type and the per-type counts match what
    // each chip shows. (`{ countType: true }` would additionally honour the type filter,
    // but the type dimension is intentionally OMITTED here so the chips drill down.)
    const nonTypeMatched = all.filter((r) =>
      this.matchesFilters(r, filters, conceptMatch, { countType: false }),
    );
    const counts = {
      all: nonTypeMatched.length,
      card: nonTypeMatched.filter((r) => r.type === "card").length,
      source: nonTypeMatched.filter((r) => r.type === "source").length,
      extract: nonTypeMatched.filter((r) => r.type === "extract").length,
      topic: nonTypeMatched.filter((r) => r.type === "topic").length,
      task: nonTypeMatched.filter((r) => r.type === "task").length,
      highPriority: nonTypeMatched.filter((r) => r.protected).length,
      overdue: nonTypeMatched.filter((r) => r.due === "overdue").length,
      protected: nonTypeMatched.filter((r) => r.protected).length,
    };

    // Apply ALL active filters (type included), then sort priority desc, then due date
    // asc (stable). With the type dimension driven client-side this equals
    // `nonTypeMatched`, so `counts.all === items.length` (before the optional limit).
    let rows = all.filter((r) => this.matchesFilters(r, filters, conceptMatch));
    rows = this.sort(rows);
    if (options.limit !== undefined) rows = rows.slice(0, options.limit);

    // The budget gauge counts the items the user actually faces today — the filtered
    // due set (so a status/concept filter narrows the gauge with the list), not the raw
    // pre-filter merge.
    const target = this.repos.settings.getAppSettings().dailyReviewBudget;
    const used = nonTypeMatched.length;

    return { items: rows, counts, budget: { used, target } };
  }

  /**
   * Build the queue-row summary for ONE live element (regardless of whether it is
   * currently due) — the refreshed row a queue action (T030) returns so the renderer
   * can update + re-sort it in place. Returns `null` when the id is unknown or
   * soft-deleted. Routes a `card` through the FSRS-side summary and everything else
   * through the attention-side summary, keeping the two-scheduler split intact.
   */
  summaryFor(id: ElementId, asOf?: IsoTimestamp): QueueItemSummary | null {
    const element = this.repos.elements.findById(id);
    if (!element || element.deletedAt) return null;
    const asOfMs = Date.parse(asOf ?? (new Date().toISOString() as IsoTimestamp));
    return element.type === "card"
      ? this.toCardSummary(element, asOfMs)
      : this.toAttentionSummary(element, asOfMs);
  }

  /** Sort by priority DESCending, then by `due_at` ASCending (nulls last). Stable. */
  private sort(rows: readonly QueueItemSummary[]): QueueItemSummary[] {
    return [...rows].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
      const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
      return aDue - bDue;
    });
  }

  /**
   * Resolve a concept-NAME filter to a reusable, non-N+1 membership matcher built in
   * a CONSTANT number of reads (regardless of row count): the canonical
   * `member -> Set<liveConceptId>` map ({@link ConceptRepository.liveMembershipMap})
   * plus the set of LIVE concept ids carrying the filtered name. `matchesFilters`
   * then tests a row by intersecting its membership set with the named-concept ids —
   * no per-row `conceptsForElement` query. Matches ANY of an element's memberships
   * (an element can join several concepts) with the SAME live/dedup semantics as the
   * Library drill-down and the inspector.
   */
  private buildConceptMatcher(name: string): (elementId: ElementId) => boolean {
    const membership = this.repos.concepts.liveMembershipMap();
    // Live concept ids whose name matches the filter (a name need not be unique).
    const namedConceptIds = new Set(
      this.repos.concepts
        .listConcepts()
        .filter((c) => c.name === name)
        .map((c) => c.id),
    );
    return (elementId) => {
      const conceptIds = membership.get(elementId);
      if (!conceptIds) return false;
      for (const id of conceptIds) if (namedConceptIds.has(id)) return true;
      return false;
    };
  }

  /**
   * Whether a row passes the active type/concept/tag/status filters.
   *
   * `options.countType` (default `true`) controls the TYPE dimension only: pass
   * `false` to DROP the type predicate while still applying status/concept/tag. The
   * drill-down per-type counts use `false` so each type chip's count reflects the
   * other active filters but not its own value (the count-vs-list invariant); the
   * result-list match uses the default `true` so the items honour every filter.
   */
  private matchesFilters(
    row: QueueItemSummary,
    filters: QueueFilters,
    conceptMatch: ((elementId: ElementId) => boolean) | null,
    options: { countType?: boolean } = {},
  ): boolean {
    const applyType = options.countType ?? true;
    if (applyType && filters.types && filters.types.length > 0) {
      if (!filters.types.includes(row.type as ElementType)) return false;
    }
    if (filters.statuses && filters.statuses.length > 0) {
      if (!filters.statuses.includes(row.status as ElementStatus)) return false;
    }
    if (filters.concept) {
      // Match against ANY of the element's concept memberships by name (T041), not
      // just the first one displayed on the row — an element can join several.
      // Resolved once via the prebuilt matcher (no per-row query).
      if (!conceptMatch?.(row.id as ElementId)) return false;
    }
    if (filters.tag) {
      // Tag filtering (T041): the element must carry the tag (filter in the repo
      // layer, never React).
      if (!this.repos.elements.listTags(row.id as ElementId).includes(filters.tag)) return false;
    }
    return true;
  }

  /** Build a card (FSRS) queue row from its element + review state. */
  private toCardSummary(element: Element, asOfMs: number): QueueItemSummary {
    const state = this.repos.review.findReviewState(element.id);
    const card = this.repos.review.findCardById(element.id);
    const retrievability = state
      ? approximateRetrievability(state.stability, state.lastReviewedAt, asOfMs)
      : null;
    const dueAt = state?.dueAt ?? element.dueAt;
    const due = dueStateFor(dueAt, asOfMs);
    const { sourceTitle, author } = this.sourceContext(element);
    return {
      id: element.id,
      type: element.type,
      status: element.status,
      stage: element.stage,
      priority: element.priority,
      title: element.title,
      dueAt,
      scheduler: "fsrs",
      schedulerSignals: {
        kind: "fsrs",
        retrievability,
        stability: state?.stability ?? null,
        stage: element.stage,
        postponed: 0,
      },
      sourceTitle,
      author,
      concept: this.conceptFor(element.id),
      cardType: card?.card.kind ?? null,
      protected: priorityToLabel(element.priority) === "A",
      due,
      dueLabel: dueLabelFor(dueAt, due, asOfMs),
    };
  }

  /** Build an attention (source/topic/extract/task/…) queue row. */
  private toAttentionSummary(element: Element, asOfMs: number): QueueItemSummary {
    const due = dueStateFor(element.dueAt, asOfMs);
    const { sourceTitle, author } = this.sourceContext(element);
    return {
      id: element.id,
      type: element.type,
      status: element.status,
      stage: element.stage,
      priority: element.priority,
      title: element.title,
      dueAt: element.dueAt,
      scheduler: "attention",
      schedulerSignals: {
        kind: "attention",
        retrievability: null,
        stability: null,
        stage: element.stage,
        postponed: this.countPostpones(element.id),
      },
      sourceTitle,
      author,
      concept: this.conceptFor(element.id),
      cardType: null,
      protected: priorityToLabel(element.priority) === "A",
      due,
      dueLabel: dueLabelFor(element.dueAt, due, asOfMs),
    };
  }

  /** The owning source's title + author for the per-row meta line. */
  private sourceContext(element: Element): { sourceTitle: string | null; author: string | null } {
    const sourceId = element.type === "source" ? element.id : element.sourceId;
    if (!sourceId) return { sourceTitle: null, author: null };
    const sourceEl = element.type === "source" ? element : this.repos.elements.findById(sourceId);
    const provenance = this.repos.sources.findById(sourceId)?.source ?? null;
    return {
      sourceTitle: sourceEl && !sourceEl.deletedAt ? sourceEl.title : null,
      author: provenance?.author ?? null,
    };
  }

  /**
   * The first concept this element is a member of (for the per-row meta line), or
   * `null` (T041) — delegates to the ONE shared {@link ConceptRepository.firstConceptName}
   * (the canonical first-membership walk, also used by the search-result + review
   * meta lines, so every surface shows the same concept). Filtering still matches
   * against ALL memberships — see {@link matchesFilters}.
   */
  private conceptFor(id: ElementId): string | null {
    return this.repos.concepts.firstConceptName(id);
  }

  /**
   * How many times an attention element has been postponed — delegates to the ONE
   * canonical {@link OperationLogRepository.countPostpones} (the schema-churn-free
   * counter the `SchedulerChip` shows), shared with the inspector + scheduler.
   */
  private countPostpones(id: ElementId): number {
    return this.repos.operationLog.countPostpones(id);
  }
}
