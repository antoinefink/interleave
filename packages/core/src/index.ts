/**
 * @interleave/core — framework-agnostic domain vocabulary (T005).
 *
 * This package is the shared language the whole codebase imports: the universal
 * `Element` primitive, the canonical enums (types/statuses/stages), priority,
 * review state, source/document shapes, lineage edges/locations, and the
 * desktop-pivot persistence vocabulary (asset vault + operation log).
 *
 * It MUST stay free of React, Drizzle, and better-sqlite3 (see the layering
 * rules in CLAUDE.md): `packages/db` mirrors these shapes as the SQLite schema
 * (T006); `packages/local-db` reads/writes them behind the Electron/IPC boundary
 * (T008); `apps/web` (the renderer) consumes the types only.
 *
 * Enum string values are the canonical product vocabulary and match
 * `docs/domain-model.md` / `CLAUDE.md` exactly — they are persisted and synced,
 * so renames are migrations, not refactors.
 */

export const CORE_PACKAGE = "@interleave/core" as const;

// Re-exports below are grouped by source module. Biome sorts `export type`
// before value exports and alphabetizes by module, so per-block comments are
// kept minimal; the authoritative docs live on each declaration in its module.

// The universal element + lineage neighbours (./element).
export type {
  Element,
  ElementLocation,
  ElementRelation,
  ReadPoint,
} from "./element";
// Canonical enums — derived union types (./enums).
export type {
  AssetKind,
  CardKind,
  DistillationStage,
  ElementStatus,
  ElementType,
  FsrsState,
  MarkType,
  RelationType,
  ReviewRating,
  VaultRoot,
} from "./enums";
// Canonical enums — const tuples + value maps (./enums).
export {
  ASSET_KINDS,
  CARD_KINDS,
  DISTILLATION_STAGES,
  ELEMENT_STATUSES,
  ELEMENT_TYPES,
  FSRS_STATES,
  isMarkType,
  MARK_TYPES,
  RELATION_TYPES,
  REVIEW_RATING_VALUE,
  REVIEW_RATINGS,
  VAULT_ROOTS,
} from "./enums";
// Stable IDs + timestamps — branded string aliases (./ids).
export type {
  AssetId,
  BlockId,
  DocumentId,
  ElementId,
  IsoTimestamp,
  OperationId,
  RelationId,
  ReviewLogId,
  SiblingGroupId,
  SourceLocationId,
} from "./ids";
// Shared numeric helpers (./numeric).
export { clamp01 } from "./numeric";
// Desktop pivot: command-shaped operation log — day-one invariant (./operation-log).
export type { OperationLogEntry, OperationType } from "./operation-log";
export { isOperationType, OPERATION_TYPES } from "./operation-log";
// Priority: numeric store ↔ A/B/C/D label, both directions (./priority).
export type { Priority, PriorityLabel } from "./priority";
export {
  DEFAULT_PRIORITY,
  isPriorityLabel,
  PRIORITY_LABEL_VALUE,
  PRIORITY_LABELS,
  priorityFromLabel,
  priorityToLabel,
} from "./priority";
// Plain-text → ProseMirror converter — deterministic, editor-free (./prosemirror).
export type {
  BlockIdMinter,
  PlainTextConversion,
  ProseMirrorBlock,
  ProseMirrorDoc,
  ProseMirrorParagraphNode,
  ProseMirrorTextNode,
} from "./prosemirror";
export { plainTextToProseMirrorDoc } from "./prosemirror";
// FSRS card review state + durable logs — cards only (./review).
export type { ReviewLog, ReviewState } from "./review";
// User/domain settings — the typed model scheduling + UI read (./settings).
export type { AppSettings, KeyboardLayout, ThemePreference } from "./settings";
export {
  appSettingsFromStored,
  coerceSettingsPatch,
  coerceSettingValue,
  DAILY_REVIEW_BUDGET_MAX,
  DAILY_REVIEW_BUDGET_MIN,
  DEFAULT_APP_SETTINGS,
  DESIRED_RETENTION_MAX,
  DESIRED_RETENTION_MIN,
  isKeyboardLayout,
  isThemePreference,
  KEYBOARD_LAYOUTS,
  SETTINGS_KEYS,
  settingsPatchToStored,
  sourcePriorityFromLabel,
  THEMES,
  TOPIC_INTERVAL_OPTIONS,
} from "./settings";
// Source provenance + editable document body (./source).
export type { Document, DocumentSchemaVersion, Source } from "./source";
// URL canonicalization for provenance/duplicate detection — pure, fetch-free (./url).
export { canonicalizeUrl } from "./url";
// Desktop pivot: filesystem asset vault vocabulary (./vault).
export type { Asset, AssetLocation, LocalVaultPath } from "./vault";
