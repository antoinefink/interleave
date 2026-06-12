/**
 * TopicKnowledgeStateQuery (T108) — current maturity receipts for concepts and topics.
 *
 * This is a read-only model over durable local facts. It never mutates, never appends
 * `operation_log`, and never stores maturity snapshots. Concept subjects are built from live
 * concept membership plus descendants of those members. Topic subjects are the live parent-tree
 * subtree rooted at the topic; `sourceId` is provenance only so sibling chapters from one source do
 * not inflate each other's rollups.
 */

import { type ElementId, type IsoTimestamp, priorityToLabel } from "@interleave/core";
import {
  cards,
  elementRelations,
  elements,
  type InterleaveDatabase,
  reviewLogs,
  reviewStates,
  tasks,
} from "@interleave/db";
import { isCardMature } from "@interleave/scheduler";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { BlockProcessingService } from "./block-processing-service";
import { ConceptRepository } from "./concept-repository";
import { DocumentRepository } from "./document-repository";
import { RetentionService } from "./retention-service";

export const KNOWLEDGE_STATE_WINDOW_DAYS = 90;
export const KNOWLEDGE_STATE_SNAPSHOT_COUNT = 3;
export const KNOWLEDGE_YOUNG_STABILITY_MAX_DAYS = 7;
export const KNOWLEDGE_GRADUATION_MIN_CARDS = 3;
export const KNOWLEDGE_GRADUATION_MIN_REVIEWS = 3;
export const KNOWLEDGE_GRADUATION_MATURE_RATIO = 0.8;
export const KNOWLEDGE_GRADUATION_NEAR_RATIO = 0.6;
export const KNOWLEDGE_RETENTION_TARGET_TOLERANCE = 0.03;
export const KNOWLEDGE_RETENTION_ATTENTION_GAP = 0.1;
export const DEFAULT_TOPIC_KNOWLEDGE_STATE_LIMIT = 50;

const DAY_MS = 86_400_000;

export type TopicKnowledgeStateSubjectType = "concept" | "topic";
export type TopicKnowledgeGraduationStatus =
  | "insufficient_evidence"
  | "building"
  | "near_graduation"
  | "graduated"
  | "needs_attention";

export interface TopicKnowledgeStateOptions {
  readonly windowDays?: number;
  readonly limit?: number;
  readonly subjectType?: TopicKnowledgeStateSubjectType;
  readonly subjectId?: string;
}

export interface KnowledgeFunnel {
  readonly read: number;
  readonly extracted: number;
  readonly distilled: number;
  readonly carded: number;
  readonly mature: number;
  readonly extractedOfRead: number | null;
  readonly distilledOfExtracted: number | null;
  readonly cardedOfDistilled: number | null;
  readonly matureOfCarded: number | null;
}

export interface KnowledgeStabilityBuckets {
  readonly young: number;
  readonly maturing: number;
  readonly mature: number;
  readonly retired: number;
}

export interface KnowledgeRetentionSnapshot {
  readonly start: string;
  readonly end: string;
  readonly reviewCount: number;
  readonly measuredRetention: number | null;
}

export interface KnowledgeRetentionTrend {
  readonly windowDays: number;
  readonly reviewCount: number;
  readonly measuredRetention: number | null;
  readonly retentionTarget: number | null;
  readonly directConceptTarget: number | null;
  readonly deltaFromTarget: number | null;
  readonly snapshots: readonly KnowledgeRetentionSnapshot[];
}

export interface KnowledgeStaleness {
  readonly staleItems: number;
  readonly needsReverify: number;
}

export interface KnowledgeGraduationState {
  readonly status: TopicKnowledgeGraduationStatus;
  readonly reason: string;
  readonly thresholdVersion: "v1";
}

export interface TopicKnowledgeStateSubject {
  readonly subjectType: TopicKnowledgeStateSubjectType;
  readonly subjectId: string;
  readonly title: string;
  readonly priority: number | null;
  readonly priorityLabel: "A" | "B" | "C" | "D" | null;
  readonly directMemberCount: number | null;
  readonly includedElementCount: number;
  readonly funnel: KnowledgeFunnel;
  readonly stability: KnowledgeStabilityBuckets;
  readonly retention: KnowledgeRetentionTrend;
  readonly staleness: KnowledgeStaleness;
  readonly graduationState: KnowledgeGraduationState;
}

export interface KnowledgeGraduationEvent {
  readonly eventId: string;
  readonly eventType: "current_graduated";
  readonly subjectType: TopicKnowledgeStateSubjectType;
  readonly subjectId: string;
  readonly title: string;
  readonly asOf: string;
  readonly thresholdVersion: "v1";
}

export interface TopicKnowledgeStateSummary {
  readonly asOf: string;
  readonly windowDays: number;
  readonly subjects: readonly TopicKnowledgeStateSubject[];
  readonly graduationEvents: readonly KnowledgeGraduationEvent[];
}

interface LiveElement {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  readonly parentId: string | null;
  readonly sourceId: string | null;
  readonly extractFate: string | null;
}

interface CardInfo {
  readonly id: string;
  readonly isRetired: boolean;
  readonly stability: number | null;
  readonly fsrsState: string | null;
}

interface ReviewInfo {
  readonly cardId: string;
  readonly rating: string;
  readonly reviewedAt: string;
}

interface SubjectSeed {
  readonly subjectType: TopicKnowledgeStateSubjectType;
  readonly subjectId: string;
  readonly title: string;
  readonly priority: number | null;
  readonly directMemberCount: number | null;
  readonly includedIds: Set<string>;
  readonly directConceptTarget: number | null;
}

export class TopicKnowledgeStateQuery {
  private readonly conceptsRepo: ConceptRepository;
  private readonly documents: DocumentRepository;
  private readonly blockProcessing: BlockProcessingService;
  private readonly retention: RetentionService;

  constructor(private readonly db: InterleaveDatabase) {
    this.conceptsRepo = new ConceptRepository(db);
    this.documents = new DocumentRepository(db);
    this.blockProcessing = new BlockProcessingService(db);
    this.retention = new RetentionService(db);
  }

  getTopicKnowledgeState(
    asOf: IsoTimestamp,
    options: TopicKnowledgeStateOptions = {},
  ): TopicKnowledgeStateSummary {
    const windowDays = options.windowDays ?? KNOWLEDGE_STATE_WINDOW_DAYS;
    const limit = options.limit ?? DEFAULT_TOPIC_KNOWLEDGE_STATE_LIMIT;
    const liveElements = this.liveElementMap();
    if (liveElements.size === 0) {
      return { asOf, windowDays, subjects: [], graduationEvents: [] };
    }

    const childIdsByParent = this.childIdsByParent(liveElements);
    const membership = this.conceptsRepo.liveMembershipMap();
    const synthesisReferencedExtractIds = this.synthesisReferencedExtractIds(liveElements);
    const cardInfo = this.cardInfo();
    const reviews = this.reviewsForWindow(asOf, windowDays);
    const openTasksByLinked = this.openVerificationTasksByLinkedElement();
    const retentionTargets = this.retention.targets();

    const seeds = this.subjectSeeds(liveElements, childIdsByParent, membership, options).slice(
      0,
      limit,
    );
    const subjects = seeds.map((seed) =>
      this.buildSubject(
        seed,
        liveElements,
        childIdsByParent,
        synthesisReferencedExtractIds,
        cardInfo,
        reviews,
        openTasksByLinked,
        retentionTargets,
        asOf,
        windowDays,
      ),
    );

    const graduationEvents = subjects
      .filter((s) => s.graduationState.status === "graduated")
      .map(
        (s): KnowledgeGraduationEvent => ({
          eventId: `${s.subjectType}:${s.subjectId}:graduated:v1`,
          eventType: "current_graduated",
          subjectType: s.subjectType,
          subjectId: s.subjectId,
          title: s.title,
          asOf,
          thresholdVersion: "v1",
        }),
      );

    return { asOf, windowDays, subjects, graduationEvents };
  }

  private liveElementMap(): Map<string, LiveElement> {
    const rows = this.db
      .select({
        id: elements.id,
        type: elements.type,
        status: elements.status,
        stage: elements.stage,
        priority: elements.priority,
        title: elements.title,
        parentId: elements.parentId,
        sourceId: elements.sourceId,
        extractFate: elements.extractFate,
      })
      .from(elements)
      .where(isNull(elements.deletedAt))
      .all();
    return new Map(rows.map((row) => [row.id, row]));
  }

  private childIdsByParent(liveElements: Map<string, LiveElement>): Map<string, Set<string>> {
    const byParent = new Map<string, Set<string>>();
    for (const row of liveElements.values()) {
      if (!row.parentId || !liveElements.has(row.parentId)) continue;
      let set = byParent.get(row.parentId);
      if (!set) {
        set = new Set<string>();
        byParent.set(row.parentId, set);
      }
      set.add(row.id);
    }
    return byParent;
  }

  private subjectSeeds(
    liveElements: Map<string, LiveElement>,
    childIdsByParent: Map<string, Set<string>>,
    membership: Map<ElementId, Set<ElementId>>,
    options: TopicKnowledgeStateOptions,
  ): SubjectSeed[] {
    const seeds: SubjectSeed[] = [];
    if (!options.subjectType || options.subjectType === "concept") {
      for (const concept of this.conceptsRepo.listConcepts()) {
        if (options.subjectId && concept.id !== options.subjectId) continue;
        const direct = new Set<string>();
        for (const [memberId, conceptIds] of membership.entries()) {
          if (conceptIds.has(concept.id)) direct.add(memberId);
        }
        const includedIds = this.expandConceptSubject(direct, liveElements, childIdsByParent);
        seeds.push({
          subjectType: "concept",
          subjectId: concept.id,
          title: concept.name,
          priority: null,
          directMemberCount: direct.size,
          includedIds,
          directConceptTarget: concept.desiredRetention,
        });
      }
    }
    if (!options.subjectType || options.subjectType === "topic") {
      const topics = [...liveElements.values()]
        .filter((el) => el.type === "topic")
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      for (const topic of topics) {
        if (options.subjectId && topic.id !== options.subjectId) continue;
        seeds.push({
          subjectType: "topic",
          subjectId: topic.id,
          title: topic.title,
          priority: topic.priority,
          directMemberCount: null,
          includedIds: this.descendantSubtree(topic.id, childIdsByParent),
          directConceptTarget: null,
        });
      }
    }
    return seeds;
  }

  private expandConceptSubject(
    direct: Set<string>,
    liveElements: Map<string, LiveElement>,
    childIdsByParent: Map<string, Set<string>>,
  ): Set<string> {
    const included = new Set<string>();
    for (const id of direct) {
      const el = liveElements.get(id);
      if (!el) continue;
      included.add(id);
      for (const childId of this.descendantSubtree(id, childIdsByParent)) included.add(childId);
    }
    return included;
  }

  private descendantSubtree(
    rootId: string,
    childIdsByParent: Map<string, Set<string>>,
  ): Set<string> {
    const out = new Set<string>([rootId]);
    const stack = [...(childIdsByParent.get(rootId) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id || out.has(id)) continue;
      out.add(id);
      for (const childId of childIdsByParent.get(id) ?? []) stack.push(childId);
    }
    return out;
  }

  private synthesisReferencedExtractIds(liveElements: Map<string, LiveElement>): Set<string> {
    const liveNoteIds = [...liveElements.values()]
      .filter((el) => el.type === "synthesis_note")
      .map((el) => el.id);
    if (liveNoteIds.length === 0) return new Set();
    const refs = this.db
      .select({ targetId: elementRelations.toElementId })
      .from(elementRelations)
      .where(
        and(
          eq(elementRelations.relationType, "references"),
          inArray(elementRelations.fromElementId, liveNoteIds),
        ),
      )
      .all();
    const out = new Set<string>();
    for (const ref of refs) {
      if (liveElements.get(ref.targetId)?.type === "extract") out.add(ref.targetId);
    }
    return out;
  }

  private cardInfo(): Map<string, CardInfo> {
    const rows = this.db
      .select({
        id: cards.elementId,
        isRetired: cards.isRetired,
        stability: reviewStates.stability,
        fsrsState: reviewStates.fsrsState,
      })
      .from(cards)
      .leftJoin(reviewStates, eq(reviewStates.elementId, cards.elementId))
      .all();
    return new Map(rows.map((row) => [row.id, row]));
  }

  private reviewsForWindow(asOf: string, windowDays: number): ReviewInfo[] {
    const endMs = safeMs(asOf) ?? Date.now();
    const start = new Date(endMs - Math.max(1, windowDays) * DAY_MS).toISOString();
    return this.db
      .select({
        cardId: reviewLogs.elementId,
        rating: reviewLogs.rating,
        reviewedAt: reviewLogs.reviewedAt,
      })
      .from(reviewLogs)
      .where(and(gte(reviewLogs.reviewedAt, start), lte(reviewLogs.reviewedAt, asOf)))
      .all();
  }

  private openVerificationTasksByLinkedElement(): Map<string, number> {
    const rows = this.db
      .select({ linkedElementId: tasks.linkedElementId, status: tasks.status })
      .from(tasks)
      .innerJoin(elements, eq(elements.id, tasks.elementId))
      .where(isNull(elements.deletedAt))
      .all();
    const out = new Map<string, number>();
    for (const row of rows) {
      if (!row.linkedElementId) continue;
      if (["done", "parked", "dismissed", "deleted"].includes(row.status)) continue;
      out.set(row.linkedElementId, (out.get(row.linkedElementId) ?? 0) + 1);
    }
    return out;
  }

  private buildSubject(
    seed: SubjectSeed,
    liveElements: Map<string, LiveElement>,
    childIdsByParent: Map<string, Set<string>>,
    synthesisReferencedExtractIds: Set<string>,
    cardInfo: Map<string, CardInfo>,
    reviews: readonly ReviewInfo[],
    openTasksByLinked: Map<string, number>,
    retentionTargets: ReturnType<RetentionService["targets"]>,
    asOf: IsoTimestamp,
    windowDays: number,
  ): TopicKnowledgeStateSubject {
    const included = [...seed.includedIds]
      .map((id) => liveElements.get(id))
      .filter((el): el is LiveElement => Boolean(el));
    const includedIdSet = new Set(included.map((el) => el.id));
    const cardIds = included.filter((el) => el.type === "card").map((el) => el.id);
    const activeCardIds = cardIds.filter((id) => !cardInfo.get(id)?.isRetired);
    const activeCardIdSet = new Set(activeCardIds);
    const read = included.filter((el) =>
      this.hasReadEvidence(el, includedIdSet, liveElements, childIdsByParent),
    ).length;
    const extracted = included.filter((el) => el.type === "extract").length;
    const distilled = included.filter(
      (el) =>
        el.type === "extract" &&
        (Boolean(el.extractFate) ||
          synthesisReferencedExtractIds.has(el.id) ||
          el.stage === "clean_extract" ||
          el.stage === "atomic_statement"),
    ).length;
    const carded = activeCardIds.length;

    const stability = this.stabilityBuckets(cardIds, cardInfo);
    const relevantReviews = reviews.filter((review) => activeCardIdSet.has(review.cardId));
    const retentionTarget = this.strictestResolvedTarget(activeCardIds, retentionTargets);
    const retention = this.retentionTrend(
      relevantReviews,
      retentionTarget,
      seed.directConceptTarget,
      asOf,
      windowDays,
    );
    const staleness = this.staleness(included, openTasksByLinked);
    const funnel: KnowledgeFunnel = {
      read,
      extracted,
      distilled,
      carded,
      mature: stability.mature,
      extractedOfRead: ratio(extracted, read),
      distilledOfExtracted: ratio(distilled, extracted),
      cardedOfDistilled: ratio(carded, distilled),
      matureOfCarded: ratio(stability.mature, carded),
    };
    const graduationState = this.graduationState(funnel, retention, staleness);
    return {
      subjectType: seed.subjectType,
      subjectId: seed.subjectId,
      title: seed.title,
      priority: seed.priority,
      priorityLabel: seed.priority === null ? null : priorityToLabel(seed.priority),
      directMemberCount: seed.directMemberCount,
      includedElementCount: included.length,
      funnel,
      stability,
      retention,
      staleness,
      graduationState,
    };
  }

  private hasReadEvidence(
    el: LiveElement,
    includedIds: Set<string>,
    liveElements: Map<string, LiveElement>,
    childIdsByParent: Map<string, Set<string>>,
  ): boolean {
    if (el.type !== "source" && el.type !== "topic") return false;
    if (this.documents.getReadPoint(el.id as ElementId)) return true;
    try {
      const summary = this.blockProcessing.getSourceProcessingSummary(el.id as ElementId);
      if (
        summary.terminalBlocks > 0 ||
        summary.stateCounts.needs_later > 0 ||
        summary.staleAfterEditBlocks > 0
      ) {
        return true;
      }
    } catch {
      // Block processing is source-shaped today; lack of rows is simply no read evidence.
    }
    for (const childId of this.descendantSubtree(el.id, childIdsByParent)) {
      if (childId === el.id || !includedIds.has(childId)) continue;
      const child = liveElements.get(childId);
      if (child && ["extract", "card", "synthesis_note"].includes(child.type)) return true;
    }
    return false;
  }

  private stabilityBuckets(
    cardIds: readonly string[],
    cardInfo: Map<string, CardInfo>,
  ): KnowledgeStabilityBuckets {
    const buckets = { young: 0, maturing: 0, mature: 0, retired: 0 };
    for (const cardId of cardIds) {
      const info = cardInfo.get(cardId);
      if (info?.isRetired) {
        buckets.retired += 1;
        continue;
      }
      if (
        isCardMature({
          retrievability: null,
          stability: info?.stability ?? null,
          fsrsState: info?.fsrsState ?? null,
          lapses: null,
        })
      ) {
        buckets.mature += 1;
      } else if (
        !info ||
        info.fsrsState === "learning" ||
        info.fsrsState === "relearning" ||
        (info.stability ?? 0) < KNOWLEDGE_YOUNG_STABILITY_MAX_DAYS
      ) {
        buckets.young += 1;
      } else {
        buckets.maturing += 1;
      }
    }
    return buckets;
  }

  private strictestResolvedTarget(
    cardIds: readonly string[],
    targets: ReturnType<RetentionService["targets"]>,
  ): number | null {
    let strictest: number | null = null;
    for (const cardId of cardIds) {
      const resolved = this.retention.resolveForCard(cardId as ElementId, targets).target;
      strictest = strictest === null ? resolved : Math.max(strictest, resolved);
    }
    return strictest;
  }

  private retentionTrend(
    reviews: readonly ReviewInfo[],
    target: number | null,
    directConceptTarget: number | null,
    asOf: string,
    windowDays: number,
  ): KnowledgeRetentionTrend {
    const reviewCount = reviews.length;
    const measuredRetention = retentionFor(reviews);
    const snapshots = this.retentionSnapshots(reviews, asOf, windowDays);
    return {
      windowDays,
      reviewCount,
      measuredRetention,
      retentionTarget: target,
      directConceptTarget,
      deltaFromTarget:
        measuredRetention !== null && target !== null ? measuredRetention - target : null,
      snapshots,
    };
  }

  private retentionSnapshots(
    reviews: readonly ReviewInfo[],
    asOf: string,
    windowDays: number,
  ): KnowledgeRetentionSnapshot[] {
    const endMs = safeMs(asOf) ?? Date.now();
    const bucketMs = (Math.max(1, windowDays) * DAY_MS) / KNOWLEDGE_STATE_SNAPSHOT_COUNT;
    return Array.from({ length: KNOWLEDGE_STATE_SNAPSHOT_COUNT }, (_, i) => {
      const startMs = endMs - bucketMs * (KNOWLEDGE_STATE_SNAPSHOT_COUNT - i);
      const end = i === KNOWLEDGE_STATE_SNAPSHOT_COUNT - 1 ? endMs : startMs + bucketMs;
      const bucket = reviews.filter((review) => {
        const ms = safeMs(review.reviewedAt);
        return (
          ms !== null &&
          ms >= startMs &&
          (i === KNOWLEDGE_STATE_SNAPSHOT_COUNT - 1 ? ms <= end : ms < end)
        );
      });
      return {
        start: new Date(startMs).toISOString(),
        end: new Date(end).toISOString(),
        reviewCount: bucket.length,
        measuredRetention: retentionFor(bucket),
      };
    });
  }

  private staleness(
    included: readonly LiveElement[],
    openTasksByLinked: Map<string, number>,
  ): KnowledgeStaleness {
    let needsReverify = 0;
    for (const el of included) needsReverify += openTasksByLinked.get(el.id) ?? 0;
    return { staleItems: 0, needsReverify };
  }

  private graduationState(
    funnel: KnowledgeFunnel,
    retention: KnowledgeRetentionTrend,
    staleness: KnowledgeStaleness,
  ): KnowledgeGraduationState {
    if (
      funnel.carded < KNOWLEDGE_GRADUATION_MIN_CARDS ||
      retention.reviewCount < KNOWLEDGE_GRADUATION_MIN_REVIEWS ||
      retention.measuredRetention === null ||
      retention.retentionTarget === null
    ) {
      return {
        status: "insufficient_evidence",
        reason: "Not enough active cards or in-window reviews to assess graduation.",
        thresholdVersion: "v1",
      };
    }
    const retentionGap = retention.retentionTarget - retention.measuredRetention;
    if (staleness.staleItems > 0 || staleness.needsReverify > 0 || retentionGap > 0.1) {
      return {
        status: "needs_attention",
        reason: "Current retention or verification state is below the graduation bar.",
        thresholdVersion: "v1",
      };
    }
    if (
      (funnel.matureOfCarded ?? 0) >= KNOWLEDGE_GRADUATION_MATURE_RATIO &&
      retentionGap <= KNOWLEDGE_RETENTION_TARGET_TOLERANCE
    ) {
      return {
        status: "graduated",
        reason: "Mature-card ratio and measured retention meet the current graduation bar.",
        thresholdVersion: "v1",
      };
    }
    if (
      (funnel.matureOfCarded ?? 0) >= KNOWLEDGE_GRADUATION_NEAR_RATIO ||
      retentionGap <= KNOWLEDGE_RETENTION_TARGET_TOLERANCE
    ) {
      return {
        status: "near_graduation",
        reason: "The subject is near one graduation threshold but has not met all floors.",
        thresholdVersion: "v1",
      };
    }
    return {
      status: "building",
      reason: "The subject has evidence but has not approached the graduation thresholds.",
      thresholdVersion: "v1",
    };
  }
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function retentionFor(reviews: readonly ReviewInfo[]): number | null {
  if (reviews.length === 0) return null;
  const retained = reviews.filter((review) => review.rating !== "again").length;
  return retained / reviews.length;
}

function safeMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
