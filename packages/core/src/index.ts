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

// Import/process balance rule — the pure imbalance judgment (./balance).
export type { BalanceCounts, BalanceJudgment, BalanceSeverity } from "./balance";
export {
  clampFactor,
  DANGER_MULTIPLIER,
  DEFAULT_IMPORT_BALANCE_FACTOR,
  IMPORT_BALANCE_FACTOR_MAX,
  IMPORT_BALANCE_FACTOR_MIN,
  IMPORT_BALANCE_FLOOR,
  judgeBalance,
} from "./balance";
// Card-quality heuristics — pure domain checks for the `qc` checklist (./card-quality).
export type {
  AudioQualitySignals,
  CardQualityCheck,
  CardQualityCheckId,
  CardQualityInput,
  CardQualityReport,
  CardQualitySeverity,
  ClozeQualityInput,
  InterferenceCandidate,
  QaQualityInput,
  SourceRecencySignals,
} from "./card-quality";
export {
  ANSWER_MAX_CHARS,
  answerSimilarity,
  CLOZE_DELETION_MAX_WORDS,
  CLOZE_MAX_WORDS,
  CODE_MAX_LINES,
  detectInterference,
  evaluateCardQuality,
  INTERFERENCE_SIMILARITY_THRESHOLD,
  LIST_ITEM_WARN_COUNT,
  LONG_AUDIO_CLIP_MS,
  MAX_CLOZE_DELETIONS,
  MAX_FACTS_HINT,
  PROMPT_MAX_CHARS,
  TIME_SENSITIVE_TERMS,
} from "./card-quality";
// Cloze parse/serialize/preview — structured-metadata source of truth (./cloze).
export type {
  ClozeDeletion,
  ClozeSpan,
  ParsedCloze,
  RenderClozeOptions,
} from "./cloze";
export {
  CLOZE_PLACEHOLDER,
  canonicalizeCloze,
  hasClozeMarker,
  parseCloze,
  renderClozePrompt,
  serializeCloze,
} from "./cloze";
// The universal element + lineage neighbours (./element).
export type {
  ClipWindow,
  Element,
  ElementLocation,
  ElementRelation,
  ReadPoint,
  RegionRect,
} from "./element";
// On-device embedding primitives — vector dim, the local embedder, the row type (./embedding).
export type { EmbeddableType, Embedding } from "./embedding";
export { EMBEDDABLE_TYPES, EMBEDDING_DIM, embedTextLocal } from "./embedding";
// Canonical enums — derived union types (./enums).
export type {
  AssetKind,
  CardKind,
  DistillationStage,
  ElementStatus,
  ElementType,
  FsrsState,
  JobStatus,
  JobType,
  MarkType,
  OcrPageStatus,
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
  JOB_STATUSES,
  JOB_TYPES,
  MARK_TYPES,
  OCR_PAGE_STATUSES,
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
  JobId,
  OperationId,
  RelationId,
  ReviewLogId,
  SiblingGroupId,
  SourceLocationId,
} from "./ids";
// Background-runner job model — local infra, not an element (./job).
export type { Job, JobJsonValue, JobProgress } from "./job";
// Audio-card presentation carrier — the `cards.media_ref` clip pointer (./media-ref).
export type { MediaRef, MediaRefFace } from "./media-ref";
export { isMediaRefFace, MEDIA_REF_FACES, parseMediaRef } from "./media-ref";
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
  lowerPriority,
  PRIORITY_LABEL_VALUE,
  PRIORITY_LABELS,
  priorityFromLabel,
  priorityToLabel,
  raisePriority,
} from "./priority";
// Plain-text → ProseMirror converter — deterministic, editor-free (./prosemirror).
export type {
  BlockIdAttrs,
  BlockIdMinter,
  PlainTextConversion,
  ProseMirrorBlock,
  ProseMirrorBlockNode,
  ProseMirrorBlockquoteNode,
  ProseMirrorBlockType,
  ProseMirrorBulletListNode,
  ProseMirrorCodeBlockNode,
  ProseMirrorDoc,
  ProseMirrorHardBreakNode,
  ProseMirrorHeadingLevel,
  ProseMirrorHeadingNode,
  ProseMirrorHorizontalRuleNode,
  ProseMirrorInlineNode,
  ProseMirrorListItemNode,
  ProseMirrorMark,
  ProseMirrorMarkType,
  ProseMirrorMathNode,
  ProseMirrorOrderedListNode,
  ProseMirrorParagraphNode,
  ProseMirrorTextNode,
} from "./prosemirror";
export { plainTextToProseMirrorDoc } from "./prosemirror";
// FSRS card review state + durable logs — cards only (./review).
export type { ReviewLog, ReviewState } from "./review";
// User/domain settings — the typed model scheduling + UI read (./settings).
export type { AppSettings, EmbeddingProvider, KeyboardLayout, ThemePreference } from "./settings";
export {
  appSettingsFromStored,
  coerceFsrsParams,
  coerceRetentionByBand,
  coerceSettingsPatch,
  coerceSettingValue,
  DAILY_REVIEW_BUDGET_MAX,
  DAILY_REVIEW_BUDGET_MIN,
  DEFAULT_APP_SETTINGS,
  DEFAULT_EMBEDDING_MODEL_ID,
  DESIRED_RETENTION_MAX,
  DESIRED_RETENTION_MIN,
  DISPLAY_NAME_MAX,
  EMBEDDING_API_KEY_MAX,
  EMBEDDING_MODEL_ID_MAX,
  EMBEDDING_PROVIDERS,
  FSRS_PARAM_VECTOR_LENGTH,
  isEmbeddingProvider,
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
export type { Document, DocumentSchemaVersion, MediaKind, Source } from "./source";
// Source reference (the refblock) — citation formatter, one source of truth (./source-ref).
export type { FormattedSourceRef, SourceRef } from "./source-ref";
export { EMPTY_SOURCE_REF, formatSourceRef } from "./source-ref";
// Source-yield scoring — the pure, tunable per-source yield rank (T083, ./source-yield).
export type { SourceYieldInputs, SourceYieldVerdict, YieldBand } from "./source-yield";
export {
  scoreSourceYield,
  UNSTARTED_READ_FLOOR,
  YIELD_BARREN_OUTPUT_THRESHOLD,
  YIELD_HIGH_SCORE,
  YIELD_LEECH_RATIO_PENALTY,
  YIELD_LOW_SCORE,
  YIELD_MINUTES_PER_MATURE_PENALTY,
  YIELD_READ_BARREN_PENALTY,
  YIELD_WEIGHT_CARD,
  YIELD_WEIGHT_EXTRACT,
  YIELD_WEIGHT_MATURE_CARD,
} from "./source-yield";
// URL canonicalization for provenance/duplicate detection — pure, fetch-free (./url).
export { canonicalizeUrl } from "./url";
// Desktop pivot: filesystem asset vault vocabulary (./vault).
export type { Asset, AssetLocation, LocalVaultPath } from "./vault";
