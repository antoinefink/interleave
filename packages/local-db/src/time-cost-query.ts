/**
 * TimeCostQuery (T115) — read-only pricing for due queue work.
 *
 * Queue membership stays owned by QueueRepository/QueueQuery. This read model prices a
 * supplied queue-due universe in minutes, using durable card review timings when there
 * is enough history and documented attention defaults otherwise. It never mutates and
 * never appends operation_log rows.
 */

import {
  type CardKind,
  type DistillationStage,
  type ElementType,
  parseMediaRef,
} from "@interleave/core";
import { cards, type InterleaveDatabase, reviewLogs } from "@interleave/db";
import { inArray, sql } from "drizzle-orm";

export type TimeCostConfidence = "learned" | "default";
export type CardTimingBucket = CardKind | "audio";
export type AttentionCostKey =
  | "source"
  | "extract"
  | "atomicStatement"
  | "topic"
  | "task"
  | "synthesis"
  | "mediaFragment"
  | "fallback";

export interface QueueTimeCostInputItem {
  readonly id: string;
  readonly type: ElementType | string;
  readonly stage?: DistillationStage | string | null;
}

export interface TimeCostPricingItem extends QueueTimeCostInputItem {}

export interface QueueTimeCostSummary {
  readonly cardBuckets: Record<CardKind, number>;
  readonly audioCardBuckets: Record<CardKind, number>;
  readonly attention: Record<AttentionCostKey, number>;
  readonly pricedItemCount: number;
}

export interface TimeCostEstimateItem {
  readonly id: string;
  readonly estimatedMinutes: number;
  readonly confidence: TimeCostConfidence;
  readonly basis: string;
}

export type TimeCostItemEstimate = TimeCostEstimateItem;

export interface QueueTimeCostEstimate {
  readonly totalMinutes: number;
  readonly pricedItemCount: number;
  readonly confidence: TimeCostConfidence;
  readonly items: readonly TimeCostEstimateItem[];
}

export type QueueTimeEstimate = QueueTimeCostEstimate;

export interface QueueTimeCostOptions {
  /**
   * Optional visible subset to decorate. The aggregate always prices the supplied
   * summary; these rows only control the per-visible-row estimates returned for display.
   */
  readonly visibleItems?: readonly TimeCostPricingItem[];
  readonly asOf?: string;
}

export const CARD_TIMING_DEFAULT_MINUTES: Readonly<Record<CardKind, number>> = {
  qa: 2,
  cloze: 1,
  image_occlusion: 2,
};

export const ATTENTION_DEFAULT_MINUTES = {
  source: 10,
  extract: 6,
  atomicStatement: 4,
  topic: 8,
  task: 5,
  synthesis: 10,
  mediaFragment: 5,
  fallback: 6,
} as const;

const MIN_VALID_REVIEW_MS = 250;
const MAX_VALID_REVIEW_MS = 10 * 60 * 1000;
const ROLLING_BUCKET_OBSERVATIONS = 50;
const LEARNED_OBSERVATION_THRESHOLD = 3;
const MS_PER_MINUTE = 60_000;
const SQLITE_SAFE_IN_ARRAY_SIZE = 900;

interface TimingBucketStats {
  readonly bucket: CardTimingBucket;
  readonly observations: readonly number[];
  readonly medianMinutes: number | null;
  readonly confidence: TimeCostConfidence;
}

interface CardPricingRow {
  readonly kind: string;
  readonly mediaRef: string | null;
}

interface RawTimingRow {
  readonly bucket: string;
  readonly totalMs: number;
}

interface ComponentEstimate {
  readonly minutes: number;
  readonly confidence: TimeCostConfidence;
  readonly basis: string;
}

export class TimeCostQuery {
  constructor(private readonly db: InterleaveDatabase) {}

  estimateQueue(
    summary: QueueTimeCostSummary,
    options: QueueTimeCostOptions = {},
  ): QueueTimeEstimate {
    const visibleItems = options.visibleItems ?? [];
    const cardRows = this.cardRowsById(visibleItems);
    const timing = this.loadTimingBuckets(options.asOf);
    const estimatedItems: TimeCostEstimateItem[] = [];

    let totalMinutes = 0;
    let allLearned = true;

    for (const [bucket, count] of Object.entries(summary.cardBuckets) as [CardKind, number][]) {
      if (count <= 0) continue;
      const estimate = this.estimateCardBucket(bucket, timing);
      totalMinutes += estimate.minutes * count;
      if (estimate.confidence !== "learned") allLearned = false;
    }

    for (const [baseKind, count] of Object.entries(summary.audioCardBuckets) as [
      CardKind,
      number,
    ][]) {
      if (count <= 0) continue;
      const estimate = this.estimateAudioCardBucket(baseKind, timing);
      totalMinutes += estimate.minutes * count;
      if (estimate.confidence !== "learned") allLearned = false;
    }

    for (const [key, count] of Object.entries(summary.attention) as [AttentionCostKey, number][]) {
      if (count <= 0) continue;
      const estimate = attentionDefault(key, ATTENTION_DEFAULT_MINUTES[key]);
      totalMinutes += estimate.minutes * count;
      allLearned = false;
    }

    for (const item of visibleItems) {
      const estimate =
        item.type === "card"
          ? this.estimateCard(cardRows.get(item.id) ?? null, timing)
          : this.estimateAttention(item);
      estimatedItems.push({
        id: item.id,
        estimatedMinutes: estimate.minutes,
        confidence: estimate.confidence,
        basis: estimate.basis,
      });
    }

    return {
      totalMinutes,
      pricedItemCount: summary.pricedItemCount,
      confidence: allLearned ? "learned" : "default",
      items: estimatedItems,
    };
  }

  private loadTimingBuckets(asOf?: string): ReadonlyMap<CardTimingBucket, TimingBucketStats> {
    const rawRows = this.db.all<RawTimingRow>(sql`
      WITH valid_timings AS (
        SELECT
          CASE
            WHEN ${cards.mediaRef} IS NOT NULL
              AND json_valid(${cards.mediaRef})
              AND json_type(${cards.mediaRef}, '$.sourceElementId') = 'text'
              AND length(json_extract(${cards.mediaRef}, '$.sourceElementId')) > 0
              AND json_type(${cards.mediaRef}, '$.startMs') IN ('integer', 'real')
              AND json_type(${cards.mediaRef}, '$.endMs') IN ('integer', 'real')
              AND json_extract(${cards.mediaRef}, '$.startMs') >= 0
              AND json_extract(${cards.mediaRef}, '$.endMs') > json_extract(${cards.mediaRef}, '$.startMs')
              AND json_extract(${cards.mediaRef}, '$.on') IN ('prompt', 'answer', 'both')
              THEN 'audio'
            WHEN ${cards.kind} IN ('qa', 'cloze', 'image_occlusion') THEN ${cards.kind}
            ELSE 'qa'
          END AS bucket,
          ${reviewLogs.responseMs} + COALESCE(${reviewLogs.promptMs}, 0) AS totalMs,
          ${reviewLogs.reviewedAt} AS reviewedAt
        FROM ${reviewLogs}
        INNER JOIN ${cards} ON ${cards.elementId} = ${reviewLogs.elementId}
        WHERE ${reviewLogs.responseMs} > 0
          AND (${asOf ?? null} IS NULL OR ${reviewLogs.reviewedAt} <= ${asOf ?? null})
          AND (${reviewLogs.promptMs} IS NULL OR ${reviewLogs.promptMs} >= 0)
          AND (${reviewLogs.responseMs} + COALESCE(${reviewLogs.promptMs}, 0))
            BETWEEN ${MIN_VALID_REVIEW_MS} AND ${MAX_VALID_REVIEW_MS}
      ),
      ranked AS (
        SELECT
          bucket,
          totalMs,
          row_number() OVER (PARTITION BY bucket ORDER BY reviewedAt DESC) AS rn
        FROM valid_timings
      )
      SELECT bucket, totalMs
      FROM ranked
      WHERE rn <= ${ROLLING_BUCKET_OBSERVATIONS}
    `);

    const byBucket = new Map<CardTimingBucket, number[]>();
    for (const bucket of ["qa", "cloze", "image_occlusion", "audio"] as const) {
      byBucket.set(bucket, []);
    }

    for (const row of rawRows) {
      const bucket = cardTimingBucketOrDefault(row.bucket);
      const observations = byBucket.get(bucket);
      if (!observations || observations.length >= ROLLING_BUCKET_OBSERVATIONS) continue;
      observations.push(row.totalMs);
    }

    const stats = new Map<CardTimingBucket, TimingBucketStats>();
    for (const [bucket, observations] of byBucket) {
      const confidence =
        observations.length >= LEARNED_OBSERVATION_THRESHOLD ? "learned" : "default";
      stats.set(bucket, {
        bucket,
        observations,
        medianMinutes: confidence === "learned" ? median(observations) / MS_PER_MINUTE : null,
        confidence,
      });
    }
    return stats;
  }

  private cardRowsById(
    items: readonly QueueTimeCostInputItem[],
  ): ReadonlyMap<string, CardPricingRow> {
    const ids = [...new Set(items.filter((item) => item.type === "card").map((item) => item.id))];
    if (ids.length === 0) return new Map();
    const rows: { elementId: string; kind: string; mediaRef: string | null }[] = [];
    for (let i = 0; i < ids.length; i += SQLITE_SAFE_IN_ARRAY_SIZE) {
      const chunk = ids.slice(i, i + SQLITE_SAFE_IN_ARRAY_SIZE);
      rows.push(
        ...this.db
          .select({ elementId: cards.elementId, kind: cards.kind, mediaRef: cards.mediaRef })
          .from(cards)
          .where(inArray(cards.elementId, chunk))
          .all(),
      );
    }
    return new Map(rows.map((row) => [row.elementId, { kind: row.kind, mediaRef: row.mediaRef }]));
  }

  private estimateCardBucket(
    bucket: CardKind,
    timing: ReadonlyMap<CardTimingBucket, TimingBucketStats>,
  ): ComponentEstimate {
    const stats = timing.get(bucket);
    if (stats?.confidence === "learned" && stats.medianMinutes !== null) {
      return {
        minutes: stats.medianMinutes,
        confidence: "learned",
        basis: `card:${bucket}:median`,
      };
    }
    return {
      minutes: CARD_TIMING_DEFAULT_MINUTES[bucket],
      confidence: "default",
      basis: `card:${bucket}:default`,
    };
  }

  private estimateAudioCardBucket(
    baseKind: CardKind,
    timing: ReadonlyMap<CardTimingBucket, TimingBucketStats>,
  ): ComponentEstimate {
    const audio = timing.get("audio");
    if (audio?.confidence === "learned" && audio.medianMinutes !== null) {
      return {
        minutes: audio.medianMinutes,
        confidence: "learned",
        basis: "card:audio:median",
      };
    }
    const base = timing.get(baseKind);
    if (base?.confidence === "learned" && base.medianMinutes !== null) {
      return {
        minutes: base.medianMinutes,
        confidence: "learned",
        basis: `card:audio->${baseKind}:median`,
      };
    }
    return {
      minutes: CARD_TIMING_DEFAULT_MINUTES[baseKind],
      confidence: "default",
      basis: `card:audio->${baseKind}:default`,
    };
  }

  private estimateCard(
    card: CardPricingRow | null,
    timing: ReadonlyMap<CardTimingBucket, TimingBucketStats>,
  ): ComponentEstimate {
    const baseKind = cardKindOrDefault(card?.kind ?? "qa");
    if (parseMediaRef(card?.mediaRef ?? null)) {
      const audio = timing.get("audio");
      if (audio?.confidence === "learned" && audio.medianMinutes !== null) {
        return {
          minutes: audio.medianMinutes,
          confidence: "learned",
          basis: "card:audio:median",
        };
      }
      const base = timing.get(baseKind);
      if (base?.confidence === "learned" && base.medianMinutes !== null) {
        return {
          minutes: base.medianMinutes,
          confidence: "learned",
          basis: `card:audio->${baseKind}:median`,
        };
      }
      return {
        minutes: CARD_TIMING_DEFAULT_MINUTES[baseKind],
        confidence: "default",
        basis: `card:audio->${baseKind}:default`,
      };
    }

    const stats = timing.get(baseKind);
    if (stats?.confidence === "learned" && stats.medianMinutes !== null) {
      return {
        minutes: stats.medianMinutes,
        confidence: "learned",
        basis: `card:${baseKind}:median`,
      };
    }
    return {
      minutes: CARD_TIMING_DEFAULT_MINUTES[baseKind],
      confidence: "default",
      basis: `card:${baseKind}:default`,
    };
  }

  private estimateAttention(item: QueueTimeCostInputItem): ComponentEstimate {
    if (item.type === "source") return attentionDefault("source", ATTENTION_DEFAULT_MINUTES.source);
    if (item.type === "atomic_statement") {
      return attentionDefault("atomicStatement", ATTENTION_DEFAULT_MINUTES.atomicStatement);
    }
    if (item.type === "extract" && item.stage === "atomic_statement") {
      return attentionDefault("atomicStatement", ATTENTION_DEFAULT_MINUTES.atomicStatement);
    }
    if (item.type === "extract") {
      return attentionDefault("extract", ATTENTION_DEFAULT_MINUTES.extract);
    }
    if (item.type === "topic") return attentionDefault("topic", ATTENTION_DEFAULT_MINUTES.topic);
    if (item.type === "task") return attentionDefault("task", ATTENTION_DEFAULT_MINUTES.task);
    if (item.type === "synthesis_note") {
      return attentionDefault("synthesis", ATTENTION_DEFAULT_MINUTES.synthesis);
    }
    if (item.type === "media_fragment") {
      return attentionDefault("mediaFragment", ATTENTION_DEFAULT_MINUTES.mediaFragment);
    }
    return attentionDefault("fallback", ATTENTION_DEFAULT_MINUTES.fallback);
  }
}

function attentionDefault(basis: AttentionCostKey, minutes: number): ComponentEstimate {
  return { minutes, confidence: "default", basis: `attention:${basis}:default` };
}

function cardKindOrDefault(value: string): CardKind {
  if (value === "cloze" || value === "image_occlusion" || value === "qa") return value;
  return "qa";
}

function cardTimingBucketOrDefault(value: string): CardTimingBucket {
  if (value === "audio") return "audio";
  return cardKindOrDefault(value);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function createEmptyQueueTimeCostSummary(): QueueTimeCostSummary {
  return {
    cardBuckets: { qa: 0, cloze: 0, image_occlusion: 0 },
    audioCardBuckets: { qa: 0, cloze: 0, image_occlusion: 0 },
    attention: {
      source: 0,
      extract: 0,
      atomicStatement: 0,
      topic: 0,
      task: 0,
      synthesis: 0,
      mediaFragment: 0,
      fallback: 0,
    },
    pricedItemCount: 0,
  };
}

export function queueTimeCostSummaryWithItem(
  summary: QueueTimeCostSummary,
  item: QueueTimeCostInputItem,
  card?: { readonly kind: string; readonly mediaRef: string | null },
): QueueTimeCostSummary {
  const next = {
    cardBuckets: { ...summary.cardBuckets },
    audioCardBuckets: { ...summary.audioCardBuckets },
    attention: { ...summary.attention },
    pricedItemCount: summary.pricedItemCount + 1,
  };
  if (item.type === "card") {
    const baseKind = cardKindOrDefault(card?.kind ?? "qa");
    if (parseMediaRef(card?.mediaRef ?? null)) next.audioCardBuckets[baseKind]++;
    else next.cardBuckets[baseKind]++;
    return next;
  }
  next.attention[attentionKeyForItem(item)]++;
  return next;
}

function attentionKeyForItem(item: QueueTimeCostInputItem): AttentionCostKey {
  if (item.type === "source") return "source";
  if (item.type === "atomic_statement") return "atomicStatement";
  if (item.type === "extract" && item.stage === "atomic_statement") return "atomicStatement";
  if (item.type === "extract") return "extract";
  if (item.type === "topic") return "topic";
  if (item.type === "task") return "task";
  if (item.type === "synthesis_note") return "synthesis";
  if (item.type === "media_fragment") return "mediaFragment";
  return "fallback";
}
