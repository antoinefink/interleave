/**
 * LapseClusterQuery (T128) — the read-only "which source regions are struggling?" model.
 *
 * Sees the correlation no per-card view can: several live cards descended from one source
 * region all lapsing in a recent window is ONE comprehension problem, not N formulation bugs.
 * It groups live, lapsing cards by their shared **source-region ancestor** (the extract pulled
 * directly from the source), counts true FSRS lapse increments per card over a rolling window
 * (the SHARED `lapse-window` predicate — one definition, so the cluster list can never
 * contradict the leech screen or descendant-health), and returns the clusters that cross the
 * conservative, settings-tunable floors.
 *
 * ## Invariants
 * - **Read-only.** It NEVER mutates and NEVER appends an `operation_log` row — and never
 *   touches FSRS/attention scheduler state. (Pinned by a "no writes to any table" test.) It
 *   uses pure read paths only — no lazy materialization of any cache.
 * - **Cluster key = the nearest live source-region ancestor**, resolved by walking
 *   `elements.parentId` up THROUGH any intermediary extracts/atomic-statements to the first
 *   extract whose `source_locations` anchor points into a `source` element. This is what stops
 *   the signal from fragmenting (cards authored off an atomic statement cluster together with
 *   cards authored straight off the extract) AND from over-clustering (it is never the
 *   denormalized `source_id` root — that would collapse a whole book into one useless cluster).
 *   A card with no such live ancestor (tombstoned ancestor, sourceless/lineage-wiped, or
 *   anchored directly to a source with no extract) does not cluster.
 * - **Strength score orders only** (never gates inclusion; the K/min-cards/window floors do).
 */

import type { ElementId, IsoTimestamp } from "@interleave/core";
import { cards, elements, reviewLogs, sourceLocations } from "@interleave/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { scoreLapseCluster } from "./lapse-cluster-score";
import { liveCardLapseWhere, windowStart } from "./lapse-window";
import type { DbClient } from "./types";

export const LAPSE_CLUSTER_DEFAULT_WINDOW_DAYS = 30;
export const LAPSE_CLUSTER_DEFAULT_MIN_LAPSES = 5;
export const LAPSE_CLUSTER_DEFAULT_MIN_CARDS = 2;
export const DEFAULT_LAPSE_CLUSTER_LIMIT = 50;

/** Bound on the parentId ancestor walk (cycle/depth guard), mirroring `lineage-query`. */
const MAX_WALK = 64;

export interface LapseClusterMember {
  readonly cardId: ElementId;
  /** Card prompt (or cloze text) for display. */
  readonly prompt: string;
  /** True lapse increments by THIS card in the window (window-scoped, not cumulative). */
  readonly windowLapseCount: number;
}

export interface LapseClusterRegion {
  /** The source element the region points into. */
  readonly sourceElementId: ElementId;
  /** Stable block ids spanned by the shared region. */
  readonly blockIds: string[];
  /** Human-readable region label ("Chapter 2 · ¶4"), degrading to "Selected text". */
  readonly label: string;
  /** 1-based page for paginated sources, else null. */
  readonly page: number | null;
}

export interface LapseCluster {
  /** The source-region extract that all members share (the cluster key). */
  readonly ancestorId: ElementId;
  /** The lineage-root source (for source-page scoping + title); = region.sourceElementId. */
  readonly sourceId: ElementId;
  readonly sourceTitle: string;
  readonly region: LapseClusterRegion;
  readonly members: LapseClusterMember[];
  /** Total true lapse increments across members in the window. */
  readonly totalWindowLapses: number;
  /** Distinct live member cards that lapsed in the window. */
  readonly affectedCardCount: number;
  /** Ordering heuristic (strongest first); never shown raw to users. */
  readonly strength: number;
  /** Most recent member lapse, the deterministic tiebreak. */
  readonly mostRecentLapseAt: IsoTimestamp;
}

export interface LapseClusterQueryInput {
  /** When provided, restrict to clusters whose region points into THIS source. */
  readonly sourceId?: ElementId;
  readonly asOf: IsoTimestamp;
  readonly minLapses?: number;
  readonly windowDays?: number;
  readonly minCards?: number;
  /** When `false`, short-circuit to `[]` (the feature toggle). */
  readonly enabled?: boolean;
  readonly limit?: number;
}

interface ElementLite {
  readonly id: ElementId;
  readonly parentId: ElementId | null;
  readonly type: string;
  readonly title: string | null;
  readonly deletedAt: string | null;
}

interface AnchorLite {
  readonly sourceElementId: ElementId;
  readonly blockIds: string;
  readonly label: string | null;
  readonly page: number | null;
}

interface ResolvedAncestor {
  readonly ancestorId: ElementId;
  readonly source: ElementLite;
  readonly anchor: AnchorLite;
}

function parseBlockIds(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export class LapseClusterQuery {
  constructor(private readonly db: DbClient) {}

  list(input: LapseClusterQueryInput): LapseCluster[] {
    if (input.enabled === false) {
      return [];
    }
    const windowDays = input.windowDays ?? LAPSE_CLUSTER_DEFAULT_WINDOW_DAYS;
    const minLapses = input.minLapses ?? LAPSE_CLUSTER_DEFAULT_MIN_LAPSES;
    const minCards = input.minCards ?? LAPSE_CLUSTER_DEFAULT_MIN_CARDS;
    const limit = input.limit ?? DEFAULT_LAPSE_CLUSTER_LIMIT;
    const since = windowStart(input.asOf, windowDays);

    // 1. Candidate live cards with at least one true in-window lapse increment (bounded set).
    const candidates = this.db
      .select({
        cardId: reviewLogs.elementId,
        parentId: elements.parentId,
        prompt: cards.prompt,
        cloze: cards.cloze,
        windowLapseCount: sql<number>`sum(${reviewLogs.nextLapses} - ${reviewLogs.prevLapses})`,
        mostRecentLapseAt: sql<string>`max(${reviewLogs.reviewedAt})`,
      })
      .from(reviewLogs)
      .innerJoin(elements, eq(elements.id, reviewLogs.elementId))
      .innerJoin(cards, eq(cards.elementId, elements.id))
      .where(
        // When scoped to a source, pre-filter candidate cards by their denormalized
        // lineage root so the source-page indicator never walks the whole vault.
        liveCardLapseWhere(
          since,
          input.asOf,
          input.sourceId ? eq(elements.sourceId, input.sourceId) : undefined,
        ),
      )
      .groupBy(reviewLogs.elementId)
      .all();

    if (candidates.length === 0) {
      return [];
    }

    // 2. Resolve each candidate to its nearest live source-region ancestor (memoized walk).
    const elementCache = new Map<string, ElementLite | null>();
    const anchorCache = new Map<string, { anchor: AnchorLite; source: ElementLite } | null>();
    const ancestorCache = new Map<string, ResolvedAncestor | null>();

    const getElement = (id: string): ElementLite | null => {
      if (elementCache.has(id)) return elementCache.get(id) ?? null;
      const row = this.db
        .select({
          id: elements.id,
          parentId: elements.parentId,
          type: elements.type,
          title: elements.title,
          deletedAt: elements.deletedAt,
        })
        .from(elements)
        .where(eq(elements.id, id))
        .get();
      const lite: ElementLite | null = row
        ? {
            id: row.id as ElementId,
            parentId: (row.parentId as ElementId | null) ?? null,
            type: row.type,
            title: row.title ?? null,
            deletedAt: row.deletedAt ?? null,
          }
        : null;
      elementCache.set(id, lite);
      return lite;
    };

    // The element's anchor that points into a LIVE `source` (the source-region anchor),
    // chosen DETERMINISTICALLY. An element may carry more than one `source_locations` row
    // (`element_id` is non-unique), and some may point into a parent extract rather than the
    // source — so we join to the source element, require it live + `type = "source"`, and
    // order by the anchor id so the same durable rows always yield the same cluster key/region.
    const getSourceAnchor = (
      elementId: string,
    ): { anchor: AnchorLite; source: ElementLite } | null => {
      if (anchorCache.has(elementId)) {
        const cached = anchorCache.get(elementId) ?? null;
        return cached;
      }
      const row = this.db
        .select({
          sourceElementId: sourceLocations.sourceElementId,
          blockIds: sourceLocations.blockIds,
          label: sourceLocations.label,
          page: sourceLocations.page,
          sourceTitle: elements.title,
        })
        .from(sourceLocations)
        .innerJoin(elements, eq(elements.id, sourceLocations.sourceElementId))
        .where(
          and(
            eq(sourceLocations.elementId, elementId),
            eq(elements.type, "source"),
            isNull(elements.deletedAt),
          ),
        )
        .orderBy(sourceLocations.id)
        .get();
      const resolved = row
        ? {
            anchor: {
              sourceElementId: row.sourceElementId as ElementId,
              blockIds: row.blockIds,
              label: row.label ?? null,
              page: row.page ?? null,
            },
            source: {
              id: row.sourceElementId as ElementId,
              parentId: null,
              type: "source",
              title: row.sourceTitle ?? null,
              deletedAt: null,
            } satisfies ElementLite,
          }
        : null;
      anchorCache.set(elementId, resolved);
      return resolved;
    };

    const resolveAncestor = (startParentId: ElementId | null): ResolvedAncestor | null => {
      if (!startParentId) return null;
      if (ancestorCache.has(startParentId)) return ancestorCache.get(startParentId) ?? null;
      let current: ElementId | null = startParentId;
      let resolved: ResolvedAncestor | null = null;
      for (let i = 0; i < MAX_WALK && current; i += 1) {
        const el = getElement(current);
        if (!el || el.deletedAt) break; // missing or tombstoned ancestor → no cluster (KTD-3)
        const sourceAnchor = getSourceAnchor(el.id);
        if (sourceAnchor) {
          // Nearest ancestor anchored into a LIVE source — the source-region cluster key.
          resolved = {
            ancestorId: el.id,
            source: sourceAnchor.source,
            anchor: sourceAnchor.anchor,
          };
          break;
        }
        // No source anchor here (none, or only parent-extract anchors) — keep walking up.
        current = el.parentId;
      }
      ancestorCache.set(startParentId, resolved);
      return resolved;
    };

    // 3. Group candidates by their source-region ancestor.
    interface Bucket {
      readonly ancestor: ResolvedAncestor;
      readonly members: LapseClusterMember[];
      total: number;
      mostRecentLapseAt: string;
    }
    const buckets = new Map<string, Bucket>();
    for (const c of candidates) {
      const ancestor = resolveAncestor(c.parentId as ElementId | null);
      if (!ancestor) continue;
      const lapses = Number(c.windowLapseCount ?? 0);
      if (lapses <= 0) continue;
      const member: LapseClusterMember = {
        cardId: c.cardId as ElementId,
        prompt: c.prompt ?? c.cloze ?? "",
        windowLapseCount: lapses,
      };
      const existing = buckets.get(ancestor.ancestorId);
      if (existing) {
        existing.members.push(member);
        existing.total += lapses;
        if (c.mostRecentLapseAt > existing.mostRecentLapseAt) {
          existing.mostRecentLapseAt = c.mostRecentLapseAt;
        }
      } else {
        buckets.set(ancestor.ancestorId, {
          ancestor,
          members: [member],
          total: lapses,
          mostRecentLapseAt: c.mostRecentLapseAt,
        });
      }
    }

    // 4. Threshold + scope, then 5–6 name/score/order/cap.
    const clusters: LapseCluster[] = [];
    for (const [ancestorId, bucket] of buckets) {
      const affectedCardCount = bucket.members.length;
      if (affectedCardCount < minCards || bucket.total < minLapses) continue;
      if (input.sourceId && bucket.ancestor.source.id !== input.sourceId) continue;

      const { anchor, source } = bucket.ancestor;
      clusters.push({
        ancestorId: ancestorId as ElementId,
        sourceId: source.id,
        sourceTitle: source.title ?? "",
        region: {
          sourceElementId: anchor.sourceElementId,
          blockIds: parseBlockIds(anchor.blockIds),
          label: anchor.label && anchor.label.length > 0 ? anchor.label : "Selected text",
          page: anchor.page,
        },
        members: bucket.members.slice().sort((a, b) => b.windowLapseCount - a.windowLapseCount),
        totalWindowLapses: bucket.total,
        affectedCardCount,
        strength: scoreLapseCluster({ totalWindowLapses: bucket.total, affectedCardCount }),
        mostRecentLapseAt: bucket.mostRecentLapseAt as IsoTimestamp,
      });
    }

    clusters.sort(
      (a, b) =>
        b.strength - a.strength ||
        (a.mostRecentLapseAt < b.mostRecentLapseAt
          ? 1
          : a.mostRecentLapseAt > b.mostRecentLapseAt
            ? -1
            : 0) ||
        (a.ancestorId < b.ancestorId ? -1 : a.ancestorId > b.ancestorId ? 1 : 0),
    );
    return clusters.slice(0, limit);
  }
}
