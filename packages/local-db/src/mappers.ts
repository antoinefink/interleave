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
  Document,
  Element,
  ElementId,
  ElementLocation,
  RegionRect,
  ReviewLog,
  ReviewState,
  Source,
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
    dueAt: row.dueAt,
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
    label: row.label,
    selectedText: row.selectedText,
  };
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
    prevState: row.prevState as ReviewLog["prevState"],
    nextState: row.nextState as ReviewLog["nextState"],
    nextStability: row.nextStability,
    nextDifficulty: row.nextDifficulty,
    nextDueAt: row.nextDueAt,
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
