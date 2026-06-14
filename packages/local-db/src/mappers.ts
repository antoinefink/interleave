/**
 * Row ↔ domain mappers (T008).
 *
 * SQLite stores everything as text/number columns; `@interleave/core` speaks in
 * branded ids and structured shapes. These pure functions translate between the
 * two so repositories return domain objects, not raw rows. JSON-encoded columns
 * (block-id arrays, ProseMirror bodies) are parsed here in one place.
 */

import type {
  Asset,
  ClipWindow,
  Document,
  Element,
  ElementId,
  ElementLocation,
  RegionRect,
  ReviewLog,
  ReviewState,
  Source,
} from "@interleave/core";
import {
  isCapturedVia,
  isConfidenceLevel,
  isReliabilityTier,
  isSourceType,
} from "@interleave/core";
import type {
  AssetRow,
  DocumentRow,
  ElementRow,
  ReviewLogRow,
  ReviewStateRow,
  SourceLocationRow,
  SourceRow,
} from "@interleave/db";

export function rowToElement(row: ElementRow): Element {
  return {
    id: row.id as ElementId,
    type: row.type as Element["type"],
    status: row.status as Element["status"],
    stage: row.stage as Element["stage"],
    priority: row.priority,
    attentionIntervalMultiplier: row.attentionIntervalMultiplier,
    dueAt: row.dueAt,
    parkedAt: row.parkedAt ?? null,
    fallowUntil: row.fallowUntil ?? null,
    fallowReason: row.fallowReason ?? null,
    fallowBatchId: row.fallowBatchId ?? null,
    extractFate: row.extractFate as Element["extractFate"],
    needsReverify: row.needsReverify === true,
    staleSince: row.staleSince ?? null,
    title: row.title,
    parentId: (row.parentId as ElementId | null) ?? null,
    sourceId: (row.sourceId as ElementId | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function rowToSource(row: SourceRow): Source {
  return {
    elementId: row.elementId as ElementId,
    url: row.url,
    canonicalUrl: row.canonicalUrl,
    originalUrl: row.originalUrl,
    author: row.author,
    publishedAt: row.publishedAt,
    accessedAt: row.accessedAt,
    snapshotKey: row.snapshotKey,
    reasonAdded: row.reasonAdded,
    mediaKind: (row.mediaKind as Source["mediaKind"]) ?? null,
    // Source-reliability metadata (T091) — narrowed to the core tuples (a non-tuple
    // legacy value degrades to `null` rather than mis-typing the badge).
    sourceType: isSourceType(row.sourceType) ? row.sourceType : null,
    reliabilityTier: isReliabilityTier(row.reliabilityTier) ? row.reliabilityTier : null,
    confidence: isConfidenceLevel(row.confidence) ? row.confidence : null,
    reliabilityNotes: row.reliabilityNotes ?? null,
    // Capture origin (T126) — narrowed to the core tuple (a non-tuple legacy value
    // degrades to `null` → renders as "Other").
    capturedVia: isCapturedVia(row.capturedVia) ? row.capturedVia : null,
  };
}

export function rowToDocument(row: DocumentRow): Document {
  return {
    elementId: row.elementId as ElementId,
    prosemirrorJson: JSON.parse(row.prosemirrorJson) as unknown,
    plainText: row.plainText,
    schemaVersion: row.schemaVersion,
    updatedAt: row.updatedAt,
  };
}

export function rowToSourceLocation(row: SourceLocationRow): ElementLocation {
  return {
    id: row.id as ElementLocation["id"],
    elementId: row.elementId as ElementId,
    sourceElementId: row.sourceElementId as ElementId,
    blockIds: JSON.parse(row.blockIds) as ElementLocation["blockIds"],
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    page: row.page,
    timestampMs: row.timestampMs,
    // The PDF region bbox (T065), stored as JSON `{ x0, y0, x1, y1 }`; `null` for
    // text/page-only locations.
    region: parseRegion(row.region),
    // The video/audio clip window (T074), stored as JSON `{ startMs, endMs }`;
    // `null` for non-clip locations.
    clip: parseClip(row.clip),
    label: row.label,
    selectedText: row.selectedText,
  };
}

/** Parse a stored `source_locations.clip` JSON cell into a {@link ClipWindow}, or `null`. */
function parseClip(raw: string | null): ClipWindow | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ClipWindow>;
    if (
      typeof value.startMs === "number" &&
      typeof value.endMs === "number" &&
      value.startMs >= 0 &&
      value.endMs > value.startMs
    ) {
      return { startMs: value.startMs, endMs: value.endMs };
    }
  } catch {
    // A malformed cell degrades to "no clip" rather than throwing on read.
  }
  return null;
}

/** Parse a stored `source_locations.region` JSON cell into a {@link RegionRect}, or `null`. */
function parseRegion(raw: string | null): RegionRect | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RegionRect>;
    if (
      typeof value.x0 === "number" &&
      typeof value.y0 === "number" &&
      typeof value.x1 === "number" &&
      typeof value.y1 === "number"
    ) {
      return { x0: value.x0, y0: value.y0, x1: value.x1, y1: value.y1 };
    }
  } catch {
    // A malformed cell degrades to "no region" rather than throwing on read.
  }
  return null;
}

export function rowToReviewState(row: ReviewStateRow): ReviewState {
  return {
    elementId: row.elementId as ElementId,
    dueAt: row.dueAt,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsedDays,
    scheduledDays: row.scheduledDays,
    reps: row.reps,
    lapses: row.lapses,
    fsrsState: row.fsrsState as ReviewState["fsrsState"],
    learningSteps: row.learningSteps,
    lastReviewedAt: row.lastReviewedAt,
  };
}

export function rowToReviewLog(row: ReviewLogRow): ReviewLog {
  return {
    id: row.id as ReviewLog["id"],
    elementId: row.elementId as ElementId,
    rating: row.rating as ReviewLog["rating"],
    reviewedAt: row.reviewedAt,
    responseMs: row.responseMs,
    promptMs: row.promptMs,
    prevState: row.prevState as ReviewLog["prevState"],
    prevDueAt: row.prevDueAt,
    prevStability: row.prevStability,
    prevDifficulty: row.prevDifficulty,
    prevElapsedDays: row.prevElapsedDays,
    prevScheduledDays: row.prevScheduledDays,
    prevReps: row.prevReps,
    prevLapses: row.prevLapses,
    prevLearningSteps: row.prevLearningSteps,
    prevLastReviewedAt: row.prevLastReviewedAt,
    nextState: row.nextState as ReviewLog["nextState"],
    nextStability: row.nextStability,
    nextDifficulty: row.nextDifficulty,
    nextDueAt: row.nextDueAt,
    nextElapsedDays: row.nextElapsedDays,
    nextScheduledDays: row.nextScheduledDays,
    nextReps: row.nextReps,
    nextLapses: row.nextLapses,
    nextLearningSteps: row.nextLearningSteps,
    // Card-edit write-barrier marker (T125) — non-null only on a re-stabilization row.
    editMarkerAt: row.editMarkerAt,
    editClass: row.editClass as ReviewLog["editClass"],
    editChoice: row.editChoice as ReviewLog["editChoice"],
  };
}

export function rowToAsset(row: AssetRow): Asset {
  return {
    id: row.id as Asset["id"],
    owningElementId: row.owningElementId as ElementId,
    kind: row.kind as Asset["kind"],
    location: {
      assetId: row.id as Asset["id"],
      vaultPath: {
        root: row.vaultRoot as Asset["location"]["vaultPath"]["root"],
        relativePath: row.relativePath,
      },
    },
    contentHash: row.contentHash,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}
