/**
 * ReviewSessionService (T039) — sibling-aware due-card ordering for review.
 *
 * The review session is the FSRS due-card deck ({@link QueueRepository.dueCards} —
 * cards due by `review_states.due_at`, soonest first). T037 walks it via an
 * `exclude` set of already-seen ids. T039 layers SIBLING BURYING on top: two cards
 * that share a sibling group (the same extract / cloze set — e.g. `{{c1}}`/`{{c2}}`
 * from one passage) must NOT appear back-to-back, so siblings don't prime each
 * other's answers. Burying is on by default and can be disabled (the
 * `burySiblings` setting); when off, the natural due order is used unchanged.
 *
 * Load-bearing invariants:
 *  - Burying is SESSION-ORDERING ONLY. It never mutates `review_states`, `due_at`,
 *    or any durable log — it only chooses WHICH due card to surface NEXT. (Spacing
 *    by rescheduling is M16/T076, explicitly out of scope here.)
 *  - The sibling-group source of truth is the M6 shape: an `element_relations`
 *    `sibling_group` edge FROM the card, carrying the grouping `siblingGroupId`
 *    (see {@link CardService}). A card with no such edge has no group and is never
 *    buried.
 *  - This is the deck-selection seam the renderer drives main-side (it passes the
 *    last-shown sibling group(s) as opaque session state); the renderer never
 *    computes sibling relationships. FSRS math + the two-scheduler split stay
 *    untouched — this service does NO scheduling math and writes nothing.
 *
 * Cards only (the two-scheduler split): the deck is FSRS cards; attention items
 * (sources/extracts) are not part of review.
 */

import type { ElementId, IsoTimestamp, SiblingGroupId } from "@interleave/core";
import { ElementRepository } from "./element-repository";
import { QueueRepository } from "./queue-repository";

/** Selection inputs for {@link ReviewSessionService.nextReviewCard}. */
export interface NextReviewCardInput {
  /** "Now" the FSRS due read compares against (ISO-8601). */
  readonly asOf: IsoTimestamp;
  /**
   * Sibling group(s) shown most recently this session — a card in any of these
   * groups is skipped (when `burySiblings` is on) so siblings aren't consecutive.
   * The MVP window is the immediately-preceding card (one group); a larger window
   * is a later refinement.
   */
  readonly recentSiblingGroups?: readonly SiblingGroupId[];
  /** Card ids already seen this session — never surfaced again (the T037 cursor). */
  readonly exclude?: readonly ElementId[];
  /** When `false`, sibling burying is disabled and the natural due order is used. */
  readonly burySiblings?: boolean;
  /**
   * Optional cap on the due deck considered (the daily review budget). When set,
   * only the first `limit` non-excluded due cards form the surfaceable deck — so
   * the budget bounds the whole session exactly as T037's reviewSessionNext does.
   */
  readonly limit?: number;
}

/** The chosen next card + the size of the surfaceable (budget-bounded) deck. */
export interface NextReviewCard {
  /** The next card's element id, or `null` when the deck is exhausted. */
  readonly cardId: ElementId | null;
  /** The card's sibling group, or `null` — the renderer threads this forward. */
  readonly siblingGroupId: SiblingGroupId | null;
  /** How many surfaceable due cards remain (excluding the `exclude` set). */
  readonly deckSize: number;
}

export class ReviewSessionService {
  private readonly queue: QueueRepository;
  private readonly elements: ElementRepository;

  constructor(db: ConstructorParameters<typeof QueueRepository>[0]) {
    this.queue = new QueueRepository(db);
    this.elements = new ElementRepository(db);
  }

  /**
   * Resolve a card's sibling group from the M6 shape: the `sibling_group`
   * `element_relations` edge FROM the card carries the grouping `siblingGroupId`.
   * A card with no such edge (or no `siblingGroupId` on it) returns `null` — it is
   * never buried. Reads only; mutates nothing.
   */
  siblingGroupOf(cardElementId: ElementId): SiblingGroupId | null {
    const edge = this.elements
      .listRelationsFrom(cardElementId)
      .find((r) => r.relationType === "sibling_group" && r.siblingGroupId != null);
    return edge?.siblingGroupId ?? null;
  }

  /**
   * Pick the next due card for the session, burying siblings when enabled.
   *
   * With `burySiblings` on (the default), the soonest-due non-excluded card is
   * returned UNLESS its sibling group is in `recentSiblingGroups`, in which case
   * the next due card from a DIFFERENT group is returned instead. If every
   * remaining due card is a sibling of a recent group (a degenerate all-siblings
   * deck), the soonest-due card is returned anyway — burying never STARVES the
   * session. With `burySiblings` off, the soonest-due non-excluded card is always
   * returned (natural due order). `deckSize` is the surfaceable remainder, so the
   * caller can report progress identically in both modes.
   */
  nextReviewCard(input: NextReviewCardInput): NextReviewCard {
    const exclude = new Set<string>(input.exclude ?? []);
    const due = this.queue.dueCards(input.asOf);
    // The surfaceable deck: due cards not already seen, bounded by the optional cap.
    let deck = due.filter((c) => !exclude.has(c.id));
    if (input.limit !== undefined) deck = deck.slice(0, Math.max(0, input.limit));
    const deckSize = deck.length;
    if (deckSize === 0) return { cardId: null, siblingGroupId: null, deckSize: 0 };

    const bury = input.burySiblings ?? true;
    const recent = new Set<string>(input.recentSiblingGroups ?? []);

    // Resolve each candidate's sibling group once (a small read per card).
    const withGroup = deck.map((c) => ({
      id: c.id as ElementId,
      group: this.siblingGroupOf(c.id as ElementId),
    }));

    if (bury && recent.size > 0) {
      // Prefer the soonest-due card whose group was NOT just shown (or has no group).
      const nonSibling = withGroup.find((c) => c.group == null || !recent.has(c.group));
      if (nonSibling) {
        return { cardId: nonSibling.id, siblingGroupId: nonSibling.group, deckSize };
      }
      // Every remaining due card is a recent sibling — fall through to natural order
      // rather than starve the session (the deck must always drain).
    }

    const chosen = withGroup[0];
    if (!chosen) return { cardId: null, siblingGroupId: null, deckSize };
    return { cardId: chosen.id, siblingGroupId: chosen.group, deckSize };
  }
}
