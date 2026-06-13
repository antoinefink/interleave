/**
 * ReviewModeService (T096) — read-only selection of a TARGETED review deck.
 *
 * A "review mode" reviews a CHOSEN SUBSET of cards OUTSIDE normal scheduling. Where
 * the daily session ({@link ReviewSessionService} → {@link QueueRepository.dueCards})
 * surfaces only cards whose FSRS `review_states.due_at ≤ now`, this service resolves
 * a subset by `concept` / `source` / `branch` / `search` / `semantic` / `stale` /
 * `leech` / `random` and IGNORES the due-date filter — a card not yet due IS
 * selectable. That dropped due filter is the WHOLE point; every OTHER deck guard
 * stays: the deck is LIVE, `card`-typed, not soft-deleted, not in an out-of-deck
 * status (`deleted`; `suspended` excluded by default), and NOT retired (T082,
 * `cards.is_retired = false`, mirroring `dueCards`). A retired card the user
 * explicitly removed from rotation stays out of a mode too.
 *
 * It composes the EXISTING selection seams (it never re-queries them):
 *  - `concept`  → {@link ConceptRepository.elementsForConcept}
 *  - `source`   → live `card` elements with `elements.source_id = sourceId`
 *  - `branch`   → {@link LineageQuery.get} subtree nodes, kept where `type === "card"`
 *  - `search`   → {@link SearchRepository.search} ranked `card` hits
 *  - `semantic` → {@link SemanticSearchRepository.search} (FTS+vec fusion), card-only;
 *                 degrades to the keyword resolver when vec/model is unavailable
 *  - `stale`    → the T090 lifetime prefilter + `deriveExpiryStatus` (not-fresh cards)
 *  - `leech`    → {@link ReviewRepository.listLeechCards} (already cards, most-lapsed-first)
 *  - `random`   → a bounded, SEEDED shuffle of live cards (stable + reproducible)
 *
 * Each seam returns MIXED element types (concept members / lineage nodes / search
 * hits can be sources/extracts/cards); the resolvers FILTER each to live `card`
 * elements and ORDER them deterministically per mode. The final deck is capped by
 * {@link MAX_REVIEW_MODE_DECK} (flagged `truncated` when the set exceeds it).
 *
 * Pure read: it performs NO mutation and appends NOTHING to the operation log — the
 * only mutation in this feature is the UNCHANGED `review.grade` path. It is also
 * SYNCHRONOUS: the `semantic` query vector + model id are computed by the DB service
 * (the embed runs in the runner, not here) and INJECTED via the resolve hook; absent
 * → the semantic mode degrades to keyword (never an error). Cards only — the two-
 * scheduler split is intact.
 */

import {
  deriveExpiryStatus,
  type ElementId,
  type ElementStatus,
  type IsoTimestamp,
  MAX_REVIEW_MODE_DECK,
  type ReviewModeSelector,
  reviewModeLabel,
} from "@interleave/core";
import { cards, elements, type InterleaveDatabase } from "@interleave/db";
import { and, eq, inArray, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import { cardRowToLifetime } from "./card-edit-service";
import type { Repositories } from "./index";
import { LineageQuery } from "./lineage-query";
import { rowToElement } from "./mappers";

/**
 * Lifecycle statuses that take a card OUT of a mode deck — mirrors the daily
 * session's {@link QueueRepository}'s exclusions. `suspended` is excluded by default
 * (a suspended card is repaired in the leech remediation view, not surfaced in a
 * mode); `deleted` is redundant with the soft-delete guard but listed for intent.
 */
const MODE_EXCLUDED_STATUSES: readonly ElementStatus[] = ["deleted", "suspended"];

/** A live, non-retired card row this service orders into a deck. */
interface DeckCard {
  readonly id: ElementId;
  /** Numeric priority `0.0`–`1.0` — concept/source/branch order high-value-first. */
  readonly priority: number;
  /** Creation timestamp — the stable secondary sort within a priority band. */
  readonly createdAt: string;
}

/** The resolved mode deck: the ordered live card ids + count + label + truncation flag. */
export interface ReviewModeDeck {
  /**
   * The ordered live `card` element ids, capped at {@link MAX_REVIEW_MODE_DECK} (and,
   * for `random`, at the requested sample `size`).
   */
  readonly cardIds: ElementId[];
  /**
   * The TOTAL underlying selected pool BEFORE any cap (so the UI can say "of N") — for
   * EVERY mode, including `random`, where it is the full live-card pool, not the sample
   * size. The `size` of a random selector caps {@link cardIds}, never `total`.
   */
  readonly total: number;
  /** The calm mode label for the header ("Concept" / "Leeches" / …). */
  readonly label: string;
  /** True when the underlying set exceeded the cap and the deck was truncated. */
  readonly truncated: boolean;
}

/** A cheap count for the entry affordances (no full view build). */
export interface ReviewModeCount {
  readonly total: number;
  readonly label: string;
}

/**
 * The pre-computed query vector for the `semantic` mode, resolved by the DB service
 * (the embed runs in the job runner; this service never embeds). `null` → the
 * semantic mode degrades to the keyword resolver. `enabled` is local vec/model
 * availability; `queryModelId` keeps KNN in the same vector space.
 */
export interface SemanticResolveContext {
  readonly enabled: boolean;
  readonly queryVector: readonly number[] | null;
  readonly queryModelId?: string | null;
}

export class ReviewModeService {
  private readonly lineage: LineageQuery;

  constructor(
    private readonly db: InterleaveDatabase,
    private readonly repos: Repositories,
  ) {
    this.lineage = new LineageQuery(repos);
  }

  /**
   * Resolve a selector to an ORDERED list of live `card` element ids + a count + a
   * label + a truncation flag. `semantic` may be passed a pre-computed query vector
   * via `semantic` (else it degrades to keyword). Read-only.
   */
  deck(
    selector: ReviewModeSelector,
    now: IsoTimestamp,
    semantic?: SemanticResolveContext,
  ): ReviewModeDeck {
    const ordered = this.resolveOrderedCardIds(selector, now, semantic);
    // `total` is ALWAYS the full underlying selected pool BEFORE any cap — including
    // random, whose `size` is a per-mode SAMPLE cap, not a smaller pool. The deck is
    // then bounded by the smaller of the global `MAX_REVIEW_MODE_DECK` and (for random)
    // the requested sample `size`.
    const total = ordered.length;
    const limit = modeDeckLimit(selector);
    const truncated = total > MAX_REVIEW_MODE_DECK;
    const cardIds = ordered.length > limit ? ordered.slice(0, limit) : ordered;
    return { cardIds, total, label: reviewModeLabel(selector.kind), truncated };
  }

  /**
   * A cheap count for the entry affordances. It resolves the SAME ordered pool as
   * {@link deck} (so the count and the deck always agree) but returns only the size +
   * label — the caller never builds the full views just to show "Review 12 cards".
   * `total` is the full underlying pool (matching {@link ReviewModeDeck.total}).
   */
  count(
    selector: ReviewModeSelector,
    now: IsoTimestamp,
    semantic?: SemanticResolveContext,
  ): ReviewModeCount {
    const ordered = this.resolveOrderedCardIds(selector, now, semantic);
    return { total: ordered.length, label: reviewModeLabel(selector.kind) };
  }

  // ---- selection ---------------------------------------------------------------

  /** Dispatch the selector to its per-mode resolver (each a small private method). */
  private resolveOrderedCardIds(
    selector: ReviewModeSelector,
    now: IsoTimestamp,
    semantic?: SemanticResolveContext,
  ): ElementId[] {
    switch (selector.kind) {
      case "concept":
        return this.conceptCardIds(selector.conceptId);
      case "source":
        return this.sourceCardIds(selector.sourceId);
      case "branch":
        return this.branchCardIds(selector.rootId);
      case "search":
        return this.searchCardIds(selector.query);
      case "semantic":
        return this.semanticCardIds(selector.query, semantic);
      case "stale":
        return this.staleCardIds(now);
      case "leech":
        return this.leechCardIds();
      case "random":
        return this.randomCardIds(selector.seed);
      default: {
        // Exhaustiveness guard: a new kind must add a resolver, not silently return [].
        const _never: never = selector;
        return _never;
      }
    }
  }

  /**
   * Concept: the concept's LIVE members (`elementsForConcept`), filtered to live
   * non-retired cards, ordered priority-desc then creation order (high-value first,
   * mirroring the attention queue's bias). Non-card members are dropped.
   */
  private conceptCardIds(conceptId: ElementId): ElementId[] {
    const memberIds = this.repos.concepts.elementsForConcept(conceptId);
    return this.orderByPriority(this.liveCards(memberIds));
  }

  /**
   * Source: live cards under a source — `elements.source_id = sourceId` filtered to
   * `type: "card"`, live, non-retired (mirrors the queue join shape). Ordered
   * priority-desc then creation order.
   */
  private sourceCardIds(sourceId: ElementId): ElementId[] {
    const ids = this.db
      .select({ id: elements.id })
      .from(elements)
      .innerJoin(cards, eq(cards.elementId, elements.id))
      .where(
        and(
          eq(elements.sourceId, sourceId),
          eq(elements.type, "card"),
          isNull(elements.deletedAt),
          notInArray(elements.status, MODE_EXCLUDED_STATUSES as ElementStatus[]),
          eq(cards.isRetired, false),
        ),
      )
      .all()
      .map((r) => r.id as ElementId);
    return this.orderByPriority(this.liveCards(ids));
  }

  /**
   * Branch: the lineage SUBTREE under a `source`/`topic`/`extract` root
   * ({@link LineageQuery.get}), keeping only `type === "card"` nodes, filtered to
   * live non-retired cards, ordered priority-desc then creation order. The lineage
   * read already drops soft-deleted descendants; we re-apply the card guards.
   */
  private branchCardIds(rootId: ElementId): ElementId[] {
    const data = this.lineage.get(rootId);
    if (!data) return [];
    const cardIds = data.nodes.filter((n) => n.type === "card").map((n) => n.id as ElementId);
    return this.orderByPriority(this.liveCards(cardIds));
  }

  /**
   * Search (keyword): the ranked FTS `card` hits ({@link SearchRepository.search}
   * with `type: "card"`), filtered to live non-retired cards while PRESERVING the
   * ranked hit order (best match first). The over-fetch limit lets the cap apply
   * after the live filter without re-querying.
   */
  private searchCardIds(query: string): ElementId[] {
    const hits = this.repos.search.search(query, {
      type: "card",
      limit: MAX_REVIEW_MODE_DECK,
    });
    return this.orderPreserving(hits.map((h) => h.id as ElementId));
  }

  /**
   * Search (semantic): the fused FTS+vec `card` hits ({@link SemanticSearchRepository})
   * when vec/model capability is available AND a query vector was produced; otherwise
   * it DEGRADES to the keyword resolver (never an error — calm fallback). The query
   * vector/model id is injected by the DB service (the embed runs in the runner, not
   * here). Ranked hit order preserved; filtered to live non-retired cards.
   */
  private semanticCardIds(query: string, semantic?: SemanticResolveContext): ElementId[] {
    const enabled = semantic?.enabled ?? false;
    const queryVector = semantic?.queryVector ?? null;
    if (!enabled || queryVector == null || queryVector.length === 0) {
      // Degrade to keyword — same card ids as the `search` resolver.
      return this.searchCardIds(query);
    }
    const fused = this.repos.semanticSearch.search(query, {
      type: "card",
      semanticEnabled: true,
      queryVector,
      queryModelId: semantic?.queryModelId ?? null,
      limit: MAX_REVIEW_MODE_DECK,
    });
    const cardHits = fused.hits.filter((h) => h.type === "card").map((h) => h.id as ElementId);
    return this.orderPreserving(cardHits);
  }

  /**
   * Stale (T090): cards whose claim-lifetime makes them `due_for_review`/`expired`.
   * To avoid a full collection scan, we PREFILTER in SQL to the candidate cards that
   * CAN expire (`valid_until IS NOT NULL OR review_by IS NOT NULL`, cheap via
   * `cards_review_by_idx`) — exactly the T092 scan shape — then run
   * `deriveExpiryStatus` only over that candidate set, keeping the not-fresh ones.
   * Ordered most-overdue-first (`expired` before `due_for_review`, then `review_by`
   * ascending). Live + non-retired.
   */
  private staleCardIds(now: IsoTimestamp): ElementId[] {
    const nowDate = new Date(now);
    const candidates = this.db
      .select({ element: elements, card: cards })
      .from(cards)
      .innerJoin(elements, eq(elements.id, cards.elementId))
      .where(
        and(
          eq(elements.type, "card"),
          isNull(elements.deletedAt),
          notInArray(elements.status, MODE_EXCLUDED_STATUSES as ElementStatus[]),
          eq(cards.isRetired, false),
          or(isNotNull(cards.validUntil), isNotNull(cards.reviewBy)),
        ),
      )
      .all();

    type StaleRow = { id: ElementId; rank: number; reviewBy: string };
    const stale: StaleRow[] = [];
    for (const { element, card } of candidates) {
      if (element.type !== "card") continue;
      const lifetime = cardRowToLifetime(card);
      const status = deriveExpiryStatus(lifetime, nowDate);
      if (status === "fresh") continue;
      stale.push({
        id: element.id as ElementId,
        // `expired` (more urgent) sorts before `due_for_review`.
        rank: status === "expired" ? 0 : 1,
        // The soft re-check deadline (or the validity end) drives most-overdue-first.
        reviewBy: card.reviewBy ?? card.validUntil ?? "",
      });
    }
    stale.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      // Earlier deadline = more overdue = first; empty deadlines sort last.
      if (a.reviewBy === b.reviewBy) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      if (a.reviewBy === "") return 1;
      if (b.reviewBy === "") return -1;
      return a.reviewBy < b.reviewBy ? -1 : 1;
    });
    return stale.map((s) => s.id);
  }

  /**
   * Leech (T040): the durable leech set ({@link ReviewRepository.listLeechCards} —
   * already cards, already most-lapsed-first). Suspended leeches ARE excluded here
   * (a mode is review, not repair — suspended cards are repaired in the remediation
   * view), and retired leeches are dropped. The most-lapsed-first order is preserved.
   */
  private leechCardIds(): ElementId[] {
    const leeches = this.repos.review.listLeechCards();
    const ids = leeches.map((l) => l.element.id as ElementId);
    // `listLeechCards` keeps suspended cards (its view repairs them) and does not
    // join `cards.is_retired` — re-apply the deck guards while preserving its order.
    return this.orderPreserving(ids);
  }

  /**
   * Random audit: a SEEDED shuffle of the FULL live non-retired card pool. The seed
   * (when present in the selector) travels in the descriptor — NOT persisted — so a
   * re-read reproduces the SAME order; absent, a deterministic default seed is used.
   * The shuffle is stable for a given seed + collection, so within a session (one
   * fetch, walked by index) the order never changes. This returns the whole ordered
   * pool so `total` reflects the live-card pool (matching every other mode); the
   * requested sample `size` caps the deck in {@link deck} via {@link modeDeckLimit}.
   */
  private randomCardIds(seed?: number): ElementId[] {
    const liveIds = this.db
      .select({ id: elements.id })
      .from(elements)
      .innerJoin(cards, eq(cards.elementId, elements.id))
      .where(
        and(
          eq(elements.type, "card"),
          isNull(elements.deletedAt),
          notInArray(elements.status, MODE_EXCLUDED_STATUSES as ElementStatus[]),
          eq(cards.isRetired, false),
        ),
      )
      .all()
      .map((r) => r.id as ElementId);

    // Sort by id first so the shuffle input is deterministic regardless of row order.
    liveIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return seededShuffle(liveIds, seed ?? DEFAULT_RANDOM_SEED);
  }

  // ---- shared filters ----------------------------------------------------------

  /**
   * Resolve a candidate id list to live, non-retired `card` rows (one batched read,
   * not a per-id `findById`), dropping soft-deleted / wrong-type / out-of-status /
   * retired ids. Returns the {@link DeckCard} carrying the priority + creation order
   * the priority-ordered modes sort on. ORDER IS NOT GUARANTEED here — callers that
   * need rank order must preserve it themselves ({@link orderPreserving}).
   */
  private liveCards(ids: readonly ElementId[]): DeckCard[] {
    if (ids.length === 0) return [];
    const unique = Array.from(new Set(ids));
    const rows = this.db
      .select({ element: elements, isRetired: cards.isRetired })
      .from(elements)
      .innerJoin(cards, eq(cards.elementId, elements.id))
      .where(
        and(
          inArray(elements.id, unique as ElementId[]),
          eq(elements.type, "card"),
          isNull(elements.deletedAt),
          notInArray(elements.status, MODE_EXCLUDED_STATUSES as ElementStatus[]),
          eq(cards.isRetired, false),
        ),
      )
      .all();
    return rows.map((r) => {
      const el = rowToElement(r.element);
      return { id: el.id as ElementId, priority: el.priority, createdAt: el.createdAt };
    });
  }

  /** Order DeckCards priority-desc then creation order (oldest first), stable. */
  private orderByPriority(deckCards: DeckCard[]): ElementId[] {
    return [...deckCards]
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map((c) => c.id);
  }

  /**
   * Filter a RANK-ORDERED id list (search/semantic/leech) to live non-retired cards
   * while PRESERVING the input order. Unlike {@link orderByPriority}, the input order
   * is the meaningful one (FTS rank / most-lapsed-first), so we only drop the ids the
   * live-card read removed.
   */
  private orderPreserving(orderedIds: readonly ElementId[]): ElementId[] {
    const live = new Set(this.liveCards(orderedIds).map((c) => c.id));
    const seen = new Set<ElementId>();
    const out: ElementId[] = [];
    for (const id of orderedIds) {
      if (live.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }
}

/** The deterministic default random seed (used when the selector carries none). */
const DEFAULT_RANDOM_SEED = 0x9e3779b9;

/**
 * The deck cap for a selector: the global {@link MAX_REVIEW_MODE_DECK} for every mode,
 * tightened to the requested sample `size` for `random` (the per-mode sample is a deck
 * cap, never a smaller pool — `total` still reports the full live-card pool).
 */
function modeDeckLimit(selector: ReviewModeSelector): number {
  if (selector.kind === "random") {
    return Math.max(0, Math.min(selector.size, MAX_REVIEW_MODE_DECK));
  }
  return MAX_REVIEW_MODE_DECK;
}

/**
 * A tiny seeded PRNG (mulberry32) over a 32-bit hash of the seed (xmur3). Used to
 * deterministically shuffle the random-audit candidate ids — pure, dependency-free,
 * and stable for a given seed so a re-read reproduces the SAME sample.
 */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable Fisher–Yates shuffle of `items` driven by a seeded PRNG (does not mutate input). */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rng = mulberry32(seed | 0);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
