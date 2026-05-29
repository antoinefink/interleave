/**
 * Stable ID + timestamp generation for the repository/service layer (T008).
 *
 * Per the SQLite rules, IDs are **generated in the domain/service layer**, never
 * by SQLite autoincrement — lineage references and operation-log replay depend on
 * stable, portable IDs that survive exports, restores, and the eventual cloud
 * sync. We use UUID v4 strings (via Node's `crypto.randomUUID`), cast to the
 * branded ID aliases from `@interleave/core` so callers keep their type safety.
 *
 * This is the single place IDs are minted, so a later switch to ULID (for
 * sortable, time-ordered ids) is a one-line change here.
 */

import { randomUUID } from "node:crypto";
import type {
  AssetId,
  ElementId,
  IsoTimestamp,
  OperationId,
  RelationId,
  ReviewLogId,
  SiblingGroupId,
  SourceLocationId,
} from "@interleave/core";

/** Mint a raw UUID v4 string. */
function uuid(): string {
  return randomUUID();
}

export const newElementId = (): ElementId => uuid() as ElementId;
export const newRelationId = (): RelationId => uuid() as RelationId;
export const newSourceLocationId = (): SourceLocationId => uuid() as SourceLocationId;
export const newAssetId = (): AssetId => uuid() as AssetId;
export const newOperationId = (): OperationId => uuid() as OperationId;
export const newReviewLogId = (): ReviewLogId => uuid() as ReviewLogId;
export const newSiblingGroupId = (): SiblingGroupId => uuid() as SiblingGroupId;

/** Mint a stable id for a non-branded row (document block, read-point, etc.). */
export const newRowId = (): string => uuid();

/**
 * The current instant as an ISO-8601 UTC timestamp string (SQLite stores text).
 * Centralized so tests can wrap/freeze time and every repository agrees on the
 * timestamp format.
 */
export const nowIso = (): IsoTimestamp => new Date().toISOString();
