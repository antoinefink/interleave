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
 * attention postpone count). The merged list is then **ordered by the T076 scoring
 * function** (`scoreQueueItems` in `@interleave/scheduler` — a deterministic weighted
 * sum over priority/due/retrievability/type plus sibling/same-source/concept
 * de-clumping, modulated by the active session `mode`), replacing the old
 * priority-desc/due-asc two-key sort. The score is the deterministic ordering; the
 * 10–20% jitter the daily-queue rule asks for is a SEPARATE, seeded shuffle layer
 * applied by the caller/renderer so re-renders never reshuffle (kept out of here so
 * the order stays testable).
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
  ReviewState,
  SiblingGroupId,
  TaskType,
} from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import {
  type SessionMode,
  type SourceRetirementSuggestion,
  scoreQueueItems,
} from "@interleave/scheduler";
import type { Repositories } from "./index";
import type { CurrentScheduleReason } from "./operation-log-repository";
import { isQueueActionableStatus } from "./queue-repository";
import {
  createEmptyQueueTimeCostSummary,
  type QueueTimeCostSummary,
  queueTimeCostSummaryWithItem,
} from "./time-cost-query";

export type { SessionMode } from "@interleave/scheduler";

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
  /**
   * Current FSRS phase (`new`/`learning`/`review`/`relearning`), or `null` for attention
   * rows — the fragile↔mature signal the T077 auto-postpone planner reads (a card is mature
   * only in the `review` phase with high stability). Read-only here; never re-graded.
   */
  readonly fsrsState: string | null;
  /**
   * Cumulative FSRS lapses (failed reviews), or `null` for attention rows — drives the
   * leech exclusion in T077 auto-postpone (a leech under repair is never auto-postponed).
   */
  readonly lapses: number | null;
  /** Distillation stage (shown on the attention chip). */
  readonly stage: string;
  /** How many times an attention element has been postponed. */
  readonly postponed: number;
  /** Structured reason for the currently persisted attention schedule, if explainable. */
  readonly scheduleReason: CurrentScheduleReason | null;
  /** Source-only proactive Done/Abandon suggestion (T103); null for other rows. */
  readonly retirementSuggestion: SourceRetirementSuggestion | null;
}

/** How "due" a row is relative to `asOf`. */
export type QueueDueState = "overdue" | "today" | "soon";

export interface QueueEligibilitySummary {
  readonly eligible: boolean;
  readonly reason: string | null;
}

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
  /**
   * The sibling-group id (cards only), or `null` — a de-clumping key for the T076
   * score (siblings/same-source rows are not placed adjacent). Resolved batched from
   * the `sibling_group` `element_relations` edge; non-cards are always `null`.
   */
  readonly siblingGroupId: string | null;
  /**
   * The owning source's id (provenance), or `null` — the same-source de-clumping key
   * for the T076 score. Already resolved in scope by `sourceContext`.
   */
  readonly sourceId: string | null;
  /** Card kind (`qa`/`cloze`), for the card meta line; null for non-cards. */
  readonly cardType: string | null;
  /** Task kind for `task` rows, or null for non-tasks. */
  readonly taskType: TaskType | null;
  /**
   * The element a `task`-type row protects (its `tasks.linked_element_id`), or `null` —
   * lets the queue/process "Open" affordance JUMP TO the protected card/source/extract's
   * reader (the T092 verification deliverable) rather than opening the maintenance task
   * itself. Populated for task rows only; always `null` for every other type.
   */
  readonly linkedElementId: string | null;
  /**
   * The protected element's TYPE (`card`/`source`/`extract`/…), or `null` — paired with
   * {@link linkedElementId} so the "Open" affordance can route to the right surface
   * (source → reader, extract → extract view, card → review) WITHOUT a second read.
   */
  readonly linkedElementType: string | null;
  /** True for A-priority items (the `--protected` accent bar). */
  readonly protected: boolean;
  /** Overdue / today / soon, relative to `asOf`. */
  readonly due: QueueDueState;
  /** A short human due label ("Overdue", "Due today", "in 3d"). */
  readonly dueLabel: string;
  /** True only when this row is actionable in the due queue at the read clock. */
  readonly queueEligible: boolean;
  /** Human explanation when an inventory row has scheduler history but is not in Queue. */
  readonly notInQueueReason: string | null;
  /** Topic-rest state for this row or an ancestor topic. */
  readonly fallowState: "active" | "returned" | null;
  /** Return timestamp for the active/returned topic rest, when present. */
  readonly fallowUntil: string | null;
  /** User-entered topic-rest reason, when present. */
  readonly fallowReason: string | null;
  /** The topic whose fallow state explains this row, when present. */
  readonly fallowTopicId: string | null;
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
  /** Internal pricing summary for the due set after request filters; not returned across IPC. */
  readonly timeCostSummary: QueueTimeCostSummary;
}

/** The FSRS forgetting-curve constants (factor=19/81, decay=-0.5). */
const FSRS_DECAY = -0.5;
const FSRS_FACTOR = 19 / 81;
const DAY_MS = 86_400_000;

/**
 * The most soonest-due CARDS that get a full summary + the T076 score (T100). In deep
 * overload a 100k collection can have tens of thousands of cards due at once, but the
 * user only ever SEES `limit` (≈50) and can process at most a few hundred a day; the
 * exact ordering of the 5,000th-vs-6,000th due card is immaterial. Scoring only the
 * soonest-due `SCORE_CANDIDATE_CAP` (the due reads are due-ASC ordered) keeps the
 * surfaced top-N identical to scoring the whole pool for any realistic session while
 * bounding the per-read work, so the queue stays fast as the collection grows. The
 * per-type COUNTS + the budget gauge are still computed from the FULL due set (a cheap
 * pass that builds no summaries), so "N due" stays truthful. Attention items are few
 * and never capped. Generously above any day's processing — purely an overload bound.
 */
const SCORE_CANDIDATE_CAP = 2000;

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

function formatReturnDate(dueAt: string): string {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return "later";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(due));
}

function statusLabel(status: ElementStatus): string {
  if (status === "done") return "Done";
  if (status === "dismissed") return "Dismissed";
  if (status === "parked") return "Parked";
  if (status === "suspended") return "Suspended";
  if (status === "inbox") return "Inbox";
  if (status === "deleted") return "Deleted";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function notInQueueReasonFor(
  element: Element,
  dueAt: string | null,
  asOfMs: number,
  cardRetired: boolean,
): string | null {
  if (element.deletedAt) return "Not in queue: deleted";
  if (cardRetired) return "Not in queue: card is retired";
  if (!isQueueActionableStatus(element.status)) {
    return `Not in queue: status is ${statusLabel(element.status)}`;
  }
  if (!dueAt) return "Not in queue: no return scheduled";
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return "Not in queue: invalid due date";
  if (due > asOfMs) return `Not in queue: returns ${formatReturnDate(dueAt)}`;
  return null;
}

function queueEligibilityFor(
  element: Element,
  dueAt: string | null,
  asOfMs: number,
  cardRetired = false,
): QueueEligibilitySummary {
  const reason = notInQueueReasonFor(element, dueAt, asOfMs, cardRetired);
  return { eligible: reason === null, reason };
}

function inventoryDueLabelFor(
  element: Element,
  dueAt: string | null,
  state: QueueDueState,
  asOfMs: number,
  queueEligible: boolean,
  fallow: FallowContext | null = null,
): string {
  if (queueEligible) return dueLabelFor(dueAt, state, asOfMs);
  if (fallow?.state === "active") return `Resting until ${formatReturnDate(fallow.until)}`;
  if (!isQueueActionableStatus(element.status)) return statusLabel(element.status);
  if (!dueAt) return "No return scheduled";
  const due = Date.parse(dueAt);
  if (!Number.isNaN(due) && due > asOfMs) return `Returns ${formatReturnDate(dueAt)}`;
  return "No return scheduled";
}

interface FallowContext {
  readonly topicId: string;
  readonly until: string;
  readonly reason: string | null;
  readonly state: "active" | "returned";
}

/**
 * The pre-built batched maps a `list()` read passes to the per-row decorators so the
 * scoring inputs (sibling group, review state → retrievability, first concept name)
 * resolve by map lookup instead of a per-row query (T100 — the N+1 fix). The expensive
 * DISPLAY-only fields are NOT in here: they are deferred to `decorateDisplay` on the
 * ≤limit survivors.
 */
interface BatchContext {
  readonly siblingGroups: Map<ElementId, SiblingGroupId>;
  readonly conceptNames: Map<ElementId, string>;
}

/**
 * Read-only queue query layer. Constructed once per open database (alongside
 * {@link Repositories}); the main process exposes it over validated IPC.
 */
export class QueueQuery {
  constructor(private readonly repos: Repositories) {}

  /**
   * The unified, scored, filtered due queue. Merges due cards (FSRS) and due
   * attention items, decorates each with its scheduler signals + meta (incl. the
   * sibling-group + source de-clumping keys), orders by the **T076 scoring function**
   * (priority/due/retrievability/type + sibling/source/concept de-clumping, modulated
   * by the session `mode`, default `"full"`), applies the type/concept/status filters,
   * and computes the DRILL-DOWN per-type counts (respecting the active status/concept/
   * tag filters but not the type dimension, so a chip's count matches the rows shown
   * when that chip is selected) + the budget gauge. Deterministic — jitter is the
   * caller's concern.
   */
  list(
    options: {
      asOf?: IsoTimestamp;
      filters?: QueueFilters;
      limit?: number;
      mode?: SessionMode;
    } = {},
  ): QueueListData {
    const asOfIso = options.asOf ?? (new Date().toISOString() as IsoTimestamp);
    const asOfMs = Date.parse(asOfIso);
    const filters = options.filters ?? {};
    const mode = options.mode ?? "full";

    // The two distinct due reads. Cards come WITH their FSRS state from the SAME join
    // (T100 — no separate review-state scan), attention items by `elements.due_at`.
    // Both reads are ordered soonest-due first.
    const dueCardsFull = this.repos.queue.dueCardsWithState(asOfIso);
    const dueAttention = this.repos.queue.dueAttentionItems(asOfIso);

    // Pre-resolve concept membership ONCE (not per-row): when a concept-name filter is
    // active, build the canonical `member -> Set<liveConceptId>` map a single time so
    // the filter is a map lookup, not a `conceptsForElement` query per row (no N+1).
    const conceptMatch = filters.concept ? this.buildConceptMatcher(filters.concept) : null;

    // DRILL-DOWN counts + the budget gauge over the FULL due set (T100) — a CHEAP pass
    // straight over the raw elements (no summaries, no scoring): the per-type / at-risk
    // counts must respect every ACTIVE filter EXCEPT the type dimension (the chips drive
    // that dimension), so a chip's number equals the rows shown when that chip is
    // selected with the other active filters (status/concept/tag). Counting here, before
    // the score-candidate cap, keeps "N due" truthful even in deep overload.
    const counts = {
      all: 0,
      card: 0,
      source: 0,
      extract: 0,
      topic: 0,
      task: 0,
      highPriority: 0,
      overdue: 0,
      protected: 0,
    };
    let timeCostSummary = createEmptyQueueTimeCostSummary();
    const countOne = (
      element: Element,
      dueAt: string | null,
      card?: { readonly kind: string; readonly mediaRef: string | null },
    ): void => {
      if (!this.matchesElementFilters(element, filters, conceptMatch)) return;
      counts.all++;
      if (!filters.types || filters.types.length === 0 || filters.types.includes(element.type)) {
        timeCostSummary = queueTimeCostSummaryWithItem(timeCostSummary, element, card);
      }
      const t = element.type;
      if (t === "card") counts.card++;
      else if (t === "source") counts.source++;
      else if (t === "extract") counts.extract++;
      else if (t === "topic") counts.topic++;
      else if (t === "task") counts.task++;
      if (priorityToLabel(element.priority) === "A") {
        counts.highPriority++;
        counts.protected++;
      }
      if (dueStateFor(dueAt, asOfMs) === "overdue") counts.overdue++;
    };
    for (const { element, state, card } of dueCardsFull) countOne(element, state.dueAt, card);
    for (const element of dueAttention) countOne(element, element.dueAt);

    // SCORE-CANDIDATE CAP (T100): only the soonest-due `SCORE_CANDIDATE_CAP` cards get a
    // full summary + the T076 score — generously above any day's processing, so the
    // surfaced top-N is identical for any realistic session, but the per-read work is
    // bounded as the collection grows (the residual cost after the N+1 fix was building
    // + scoring a summary for EVERY one of tens of thousands of due cards). Attention
    // items are few and never capped.
    const dueCards =
      dueCardsFull.length > SCORE_CANDIDATE_CAP
        ? dueCardsFull.slice(0, SCORE_CANDIDATE_CAP)
        : dueCardsFull;

    // BATCHED scoring inputs (T100): the per-row `findReviewState` / `firstConceptName`
    // / `sourceContext` decoration over every due card was the N+1 that made this read
    // take ~24s. The sibling-group + first-concept-name maps are built ONCE; each card's
    // review state rides the due join. The EXPENSIVE display-only fields (source
    // title/author, card kind, postpone count) are NOT needed to SCORE, so they are
    // deferred to a second pass over only the rows that survive the score+filter+limit.
    const batch: BatchContext = {
      siblingGroups: this.repos.elements.liveSiblingGroupMap(),
      conceptNames: this.repos.concepts.firstConceptNameMap(),
    };
    const cardRows = dueCards.map(({ element, state }) =>
      this.toCardSummary(element, asOfMs, batch, state),
    );
    const attentionRows = dueAttention.map((el) => this.toAttentionSummary(el, asOfMs, batch));
    const all = [...cardRows, ...attentionRows];

    // Apply ALL active filters (type included), then ORDER by the T076 scoring function
    // (priority/due/retrievability/type + sibling/source/concept de-clumping, modulated
    // by the session `mode`). The renderer's seeded jitter still runs on top.
    let rows = all.filter((r) => this.matchesFilters(r, filters, conceptMatch));
    rows = scoreQueueItems(rows, { mode, asOf: asOfIso });
    if (options.limit !== undefined) rows = rows.slice(0, options.limit);

    // SECOND PASS (T100): now that the list is scored, filtered, and LIMITED, decorate
    // ONLY the surviving ≤limit rows with the expensive display-only fields (source
    // title/author, card kind, attention postpone count) — at most `limit` (≈50) reads.
    rows = rows.map((r) => this.decorateDisplay(r, asOfMs));

    // The budget gauge counts the items the user actually faces today — the FULL filtered
    // due set (so a status/concept filter narrows the gauge with the list).
    const target = this.repos.settings.getAppSettings().dailyReviewBudget;
    const used = counts.all;

    return { items: rows, counts, budget: { used, target }, timeCostSummary };
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
  /**
   * The non-type filter predicate evaluated on a RAW {@link Element} (T100) — the
   * cheap counterpart of {@link matchesFilters} used by the full-due-set count pass,
   * which deliberately runs BEFORE the score-candidate cap + summary build so the
   * per-type counts + budget stay truthful in deep overload without materializing a
   * summary per row. It applies status/concept/tag (the type dimension is dropped, as
   * the drill-down counts require) reading the element's own `status`/`id`.
   */
  private matchesElementFilters(
    element: Element,
    filters: QueueFilters,
    conceptMatch: ((elementId: ElementId) => boolean) | null,
  ): boolean {
    if (filters.statuses && filters.statuses.length > 0) {
      if (!filters.statuses.includes(element.status as ElementStatus)) return false;
    }
    if (filters.concept) {
      if (!conceptMatch?.(element.id)) return false;
    }
    if (filters.tag) {
      if (!this.repos.elements.listTags(element.id).includes(filters.tag)) return false;
    }
    return true;
  }

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

  /**
   * Build a card (FSRS) queue row. When a {@link BatchContext} is supplied (the
   * `list()` path), the scoring inputs come from the pre-built maps (no N+1), and the
   * EXPENSIVE display-only fields — `sourceTitle`/`author`/`cardType` — are left as
   * placeholders for {@link decorateDisplay} to fill on the ≤limit survivors only.
   * Without a batch (the single-row {@link summaryFor} path) every field is resolved
   * inline so the returned row is complete on its own.
   */
  private toCardSummary(
    element: Element,
    asOfMs: number,
    batch?: BatchContext,
    /** The card's FSRS state, when the caller already has it (the batched due join). */
    batchedState?: ReviewState,
  ): QueueItemSummary {
    const state = batch ? (batchedState ?? null) : this.repos.review.findReviewState(element.id);
    const retrievability = state
      ? approximateRetrievability(state.stability, state.lastReviewedAt, asOfMs)
      : null;
    const dueAt = state?.dueAt ?? element.dueAt;
    const due = dueStateFor(dueAt, asOfMs);
    const cardRetired = batch
      ? false
      : (this.repos.review.findCardById(element.id)?.card.isRetired ?? false);
    const queueEligibility = batch
      ? { eligible: true, reason: null }
      : queueEligibilityFor(element, dueAt, asOfMs, cardRetired);
    const fallow = batch ? null : this.fallowContextFor(element, asOfMs);
    const sourceId = element.type === "source" ? element.id : element.sourceId;
    const siblingGroupId =
      (batch ? batch.siblingGroups.get(element.id) : this.siblingGroupOf(element.id)) ?? null;
    const concept = batch
      ? (batch.conceptNames.get(element.id) ?? null)
      : this.conceptFor(element.id);
    // Display-only fields: deferred (filled by decorateDisplay) when batched; resolved
    // inline for the single-row summaryFor path.
    const ctx = batch ? null : this.sourceContext(element);
    const card = batch ? null : this.repos.review.findCardById(element.id);
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
        fsrsState: state?.fsrsState ?? null,
        lapses: state?.lapses ?? null,
        stage: element.stage,
        postponed: 0,
        scheduleReason: null,
        retirementSuggestion: null,
      },
      sourceTitle: ctx ? ctx.sourceTitle : null,
      author: ctx ? ctx.author : null,
      concept,
      siblingGroupId,
      sourceId: sourceId ?? null,
      cardType: card?.card.kind ?? null,
      taskType: null,
      // A card is the FSRS leaf — it protects nothing else, never a verification task.
      linkedElementId: null,
      linkedElementType: null,
      protected: priorityToLabel(element.priority) === "A",
      due,
      dueLabel: inventoryDueLabelFor(
        element,
        dueAt,
        due,
        asOfMs,
        queueEligibility.eligible,
        fallow,
      ),
      queueEligible: queueEligibility.eligible,
      notInQueueReason:
        fallow?.state === "active" && !queueEligibility.eligible
          ? "fallow"
          : queueEligibility.reason,
      fallowState: fallow?.state ?? null,
      fallowUntil: fallow?.until ?? null,
      fallowReason: fallow?.reason ?? null,
      fallowTopicId: fallow?.topicId ?? null,
    };
  }

  /**
   * Build an attention (source/topic/extract/task/…) queue row. When batched (the
   * `list()` path), `sourceTitle`/`author`/`postponed` are deferred to
   * {@link decorateDisplay} (filled on the ≤limit survivors); without a batch the
   * single-row {@link summaryFor} path resolves them inline.
   */
  private toAttentionSummary(
    element: Element,
    asOfMs: number,
    batch?: BatchContext,
  ): QueueItemSummary {
    const due = dueStateFor(element.dueAt, asOfMs);
    const queueEligibility = batch
      ? { eligible: true, reason: null }
      : queueEligibilityFor(element, element.dueAt, asOfMs);
    const fallow = batch ? null : this.fallowContextFor(element, asOfMs);
    const sourceId = element.type === "source" ? element.id : element.sourceId;
    const ctx = batch ? null : this.sourceContext(element);
    const concept = batch
      ? (batch.conceptNames.get(element.id) ?? null)
      : this.conceptFor(element.id);
    // ONLY a verification `task` protects another element — resolve its
    // `tasks.linked_element_id` (+ type) ONCE so the "Open" affordance jumps to that
    // card/source's reader. Every other attention type resolves to `null`. This is a
    // task-only read (rare), so it stays inline even when batched.
    const task = element.type === "task" ? this.repos.tasks.findTask(element.id) : null;
    const linked = task?.linkedElement ?? null;
    const scheduleProjection = batch
      ? null
      : this.repos.operationLog.currentScheduleProjection(element.id, element.dueAt);
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
        fsrsState: null,
        lapses: null,
        stage: element.stage,
        postponed: scheduleProjection?.effectivePostponeCount ?? 0,
        scheduleReason: scheduleProjection?.reason ?? null,
        retirementSuggestion:
          !batch && element.type === "source"
            ? this.repos.retirementSuggestions.visibleForSource(element.id)
            : null,
      },
      sourceTitle: ctx ? ctx.sourceTitle : null,
      author: ctx ? ctx.author : null,
      concept,
      // Attention items never carry a sibling group (cards-only relation); `sourceId`
      // is the owning source (or the element itself when it IS a source).
      siblingGroupId: null,
      sourceId: sourceId ?? null,
      cardType: null,
      taskType: task?.taskType ?? null,
      linkedElementId: linked?.id ?? null,
      linkedElementType: linked?.type ?? null,
      protected: priorityToLabel(element.priority) === "A",
      due,
      dueLabel: inventoryDueLabelFor(
        element,
        element.dueAt,
        due,
        asOfMs,
        queueEligibility.eligible,
        fallow,
      ),
      queueEligible: queueEligibility.eligible,
      notInQueueReason:
        fallow?.state === "active" && !queueEligibility.eligible
          ? "fallow"
          : queueEligibility.reason,
      fallowState: fallow?.state ?? null,
      fallowUntil: fallow?.until ?? null,
      fallowReason: fallow?.reason ?? null,
      fallowTopicId: fallow?.topicId ?? null,
    };
  }

  /**
   * Fill the EXPENSIVE display-only fields a batched {@link toCardSummary} /
   * {@link toAttentionSummary} left as placeholders (T100): the owning source's
   * title + author, the card kind, and (attention rows) the postpone count. Called
   * on ONLY the ≤limit rows that survive the score+filter+limit, so these per-row
   * reads run at most `limit` times instead of once per due element.
   */
  private decorateDisplay(row: QueueItemSummary, asOfMs: number): QueueItemSummary {
    const element = this.repos.elements.findById(row.id as ElementId);
    if (!element) return row;
    const { sourceTitle, author } = this.sourceContext(element);
    const fallow = this.fallowContextFor(element, asOfMs);
    const fallowFields = {
      fallowState: fallow?.state ?? null,
      fallowUntil: fallow?.until ?? null,
      fallowReason: fallow?.reason ?? null,
      fallowTopicId: fallow?.topicId ?? null,
    };
    if (row.scheduler === "fsrs") {
      const card = this.repos.review.findCardById(row.id as ElementId);
      return {
        ...row,
        ...fallowFields,
        sourceTitle,
        author,
        cardType: card?.card.kind ?? null,
      };
    }
    const scheduleProjection = this.repos.operationLog.currentScheduleProjection(
      row.id as ElementId,
      element.dueAt,
    );
    return {
      ...row,
      ...fallowFields,
      sourceTitle,
      author,
      schedulerSignals: {
        ...row.schedulerSignals,
        postponed: scheduleProjection.effectivePostponeCount,
        scheduleReason: scheduleProjection.reason,
        retirementSuggestion:
          element.type === "source"
            ? this.repos.retirementSuggestions.visibleForSource(element.id)
            : null,
      },
    };
  }

  private fallowContextFor(element: Element, asOfMs: number): FallowContext | null {
    const seen = new Set<string>();
    let current: Element | null = element;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.type === "topic" && current.fallowUntil) {
        const untilMs = Date.parse(current.fallowUntil);
        if (Number.isFinite(untilMs)) {
          return {
            topicId: current.id,
            until: current.fallowUntil,
            reason: current.fallowReason,
            state: untilMs > asOfMs ? "active" : "returned",
          };
        }
      }
      current = current.parentId ? this.repos.elements.findById(current.parentId) : null;
    }
    return null;
  }

  /**
   * The owning source's title + author + ID for the per-row meta line (the `sourceId`
   * is the same-source de-clumping key the T076 score reads — resolved here ONCE and
   * carried on the summary, never re-resolved at the call sites).
   */
  private sourceContext(element: Element): {
    sourceTitle: string | null;
    author: string | null;
    sourceId: string | null;
  } {
    const sourceId = element.type === "source" ? element.id : element.sourceId;
    if (!sourceId) return { sourceTitle: null, author: null, sourceId: null };
    const sourceEl = element.type === "source" ? element : this.repos.elements.findById(sourceId);
    const provenance = this.repos.sources.findById(sourceId)?.source ?? null;
    return {
      sourceTitle: sourceEl && !sourceEl.deletedAt ? sourceEl.title : null,
      author: provenance?.author ?? null,
      sourceId,
    };
  }

  /**
   * The sibling group of ONE card (the {@link summaryFor} single-row path), via the
   * `sibling_group` `element_relations` edge FROM the card — the same M6 shape
   * {@link ReviewSessionService.siblingGroupOf} reads. The batched `list()` path uses
   * {@link ElementRepository.liveSiblingGroupMap} instead (one read for the whole set).
   */
  private siblingGroupOf(id: ElementId): SiblingGroupId | null {
    const edge = this.repos.elements
      .listRelationsFrom(id)
      .find((r) => r.relationType === "sibling_group" && r.siblingGroupId != null);
    return edge?.siblingGroupId ?? null;
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
}
