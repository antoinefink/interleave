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

// AI-assisted distillation contract — the provider seam + action/suggestion shapes (./ai, T093).
export type {
  AiProvider,
  AiRequest,
  AiSuggestion,
  DraftCard,
} from "./ai";
export {
  AI_ACTION_TYPES,
  AI_CONTEXT_MAX,
  AI_PROVIDER_KINDS,
  AI_SOURCE_TEXT_MAX,
  AI_SUGGESTION_KINDS,
  AI_SUGGESTION_STATUSES,
  type AiActionType,
  AiDisabledError,
  AiProviderError,
  type AiProviderKind,
  AiProxyUnavailableError,
  type AiSuggestionKind,
  type AiSuggestionStatus,
  actionProducesCard,
  isAiActionType,
  isAiProviderKind,
  suggestionKindForAction,
} from "./ai";
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
// Capture origin (T126) — where a source entered the system (./capture-origin).
export type { CapturedVia } from "./capture-origin";
export { CAPTURED_VIA, capturedViaLabel, isCapturedVia } from "./capture-origin";
// Card-edit shape classifier — substantive-vs-typo heuristic for the write barrier (T125).
export type {
  CardEditBody,
  CardEditClass,
  CardEditClassification,
} from "./card-edit-classifier";
export {
  classifyCardEdit,
  SUBSTANTIVE_DISTANCE_RATIO,
  SUBSTANTIVE_MIN_DISTANCE,
} from "./card-edit-classifier";
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
// Contradiction detection (T089) — pure heuristic flag over similar+opposing pairs (./contradiction).
export type {
  ContradictionFlag,
  ContradictionPair,
  ContradictionReason,
  ContradictionSide,
} from "./contradiction";
export {
  CONTRADICTION_NUMERIC_TOLERANCE,
  CONTRADICTION_RECENCY_GAP_YEARS,
  CONTRADICTION_SIMILARITY_MIN,
  detectContradictions,
  NEGATION_CUES,
} from "./contradiction";
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
export {
  EMBEDDABLE_TYPES,
  EMBEDDING_DIM,
  embedTextLocal,
  FALLBACK_EMBEDDING_MODEL_ID,
} from "./embedding";
// Canonical enums — derived union types (./enums).
export type {
  AssetKind,
  CardEditChoiceValue,
  CardEditClassValue,
  CardKind,
  DistillationStage,
  ElementStatus,
  ElementType,
  ExtractFate,
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
  CARD_EDIT_CHOICES,
  CARD_EDIT_CLASSES,
  CARD_KINDS,
  DISTILLATION_STAGES,
  ELEMENT_STATUSES,
  ELEMENT_TYPES,
  EXTRACT_FATES,
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
// Shape-aware extract staging — pure atomic-ready vs raw classifier (./extract-shape, T122).
export type {
  ExtractShapeBlockType,
  ExtractShapeClassification,
  ExtractShapeInput,
  ExtractShapeInputSignals,
  ExtractShapeReasonCode,
  ExtractShapeResult,
  ExtractShapeStage,
  ExtractShapeStats,
} from "./extract-shape";
export {
  classifyExtractShape,
  EXTRACT_SHAPE_HEURISTIC_VERSION,
  EXTRACT_SHAPE_REASON_CODES,
} from "./extract-shape";
// Fact lifetime + expiry derivation (T090) — the claim-lifetime model + pure status (./fact-lifetime).
export type { FactExpiryStatus, FactLifetime, FactStability } from "./fact-lifetime";
export {
  deriveExpiryStatus,
  EMPTY_FACT_LIFETIME,
  expiryLabel,
  FACT_STABILITY,
  hasFactLifetime,
  isFactStability,
  lifetimeToRecencySignals,
} from "./fact-lifetime";
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
  RichSelectionConversionInput,
} from "./prosemirror";
export {
  PROSEMIRROR_ROW_BLOCK_TYPES,
  plainTextToProseMirrorDoc,
  richSelectionToProseMirrorDoc,
  shouldCarryProseMirrorRowBlockId,
} from "./prosemirror";
// FSRS card review state + durable logs — cards only (./review).
export type { ReviewLog, ReviewState } from "./review";
// Review-mode vocabulary (T096) — the closed targeted-review kinds + the typed selector.
export type { ReviewModeKind, ReviewModeSelector } from "./review-mode";
export {
  DEFAULT_RANDOM_AUDIT_SIZE,
  isReviewModeKind,
  MAX_REVIEW_MODE_DECK,
  REVIEW_MODE_KINDS,
  REVIEW_MODE_LABEL,
  reviewModeLabel,
} from "./review-mode";
// User/domain settings — the typed model scheduling + UI read (./settings).
export type {
  AppSettings,
  EmbeddingProvider,
  ExtractAgingPolicy,
  KeyboardLayout,
  OverloadPolicy,
  RendererSettings,
  ThemePreference,
} from "./settings";
export {
  AI_API_KEY_MAX,
  AI_LOCAL_MODEL_ID_MAX,
  appSettingsFromStored,
  CHRONIC_POSTPONE_THRESHOLD_MAX,
  CHRONIC_POSTPONE_THRESHOLD_MIN,
  coerceAiProviderKind,
  coerceFsrsParams,
  coerceRetentionByBand,
  coerceSettingsPatch,
  coerceSettingValue,
  DAILY_BUDGET_MINUTE_PRESETS,
  DAILY_BUDGET_MINUTES_MAX,
  DAILY_BUDGET_MINUTES_MIN,
  DAILY_REVIEW_BUDGET_MAX,
  DAILY_REVIEW_BUDGET_MIN,
  DEFAULT_AI_LOCAL_MODEL_ID,
  DEFAULT_APP_SETTINGS,
  DEFAULT_EMBEDDING_MODEL_DTYPE,
  DEFAULT_EMBEDDING_MODEL_ID,
  DESIRED_RETENTION_MAX,
  DESIRED_RETENTION_MIN,
  DISPLAY_NAME_MAX,
  DISTILLATION_QUOTA_PERCENT_MAX,
  DISTILLATION_QUOTA_PERCENT_MIN,
  EMBEDDING_API_KEY_MAX,
  EMBEDDING_MODEL_ID_MAX,
  EMBEDDING_PROVIDERS,
  EXTRACT_AGING_AGE_DAYS_MAX,
  EXTRACT_AGING_AGE_DAYS_MIN,
  EXTRACT_AGING_POLICIES,
  EXTRACT_AGING_RETURN_THRESHOLD_MAX,
  EXTRACT_AGING_RETURN_THRESHOLD_MIN,
  FSRS_PARAM_VECTOR_LENGTH,
  isEmbeddingProvider,
  isExtractAgingPolicy,
  isKeyboardLayout,
  isOverloadPolicy,
  isThemePreference,
  KEYBOARD_LAYOUTS,
  LAPSE_CLUSTER_MIN_CARDS_MAX,
  LAPSE_CLUSTER_MIN_CARDS_MIN,
  LAPSE_CLUSTER_MIN_LAPSES_MAX,
  LAPSE_CLUSTER_MIN_LAPSES_MIN,
  LAPSE_CLUSTER_WINDOW_DAYS_MAX,
  LAPSE_CLUSTER_WINDOW_DAYS_MIN,
  OVERLOAD_POLICIES,
  PARKED_RESURFACE_AFTER_DAYS_MAX,
  PARKED_RESURFACE_AFTER_DAYS_MIN,
  projectToRendererSettings,
  SETTINGS_KEYS,
  settingsPatchToStored,
  sourcePriorityFromLabel,
  THEMES,
  TOPIC_INTERVAL_OPTIONS,
  WEEKLY_REVIEW_CADENCE_DAYS_MAX,
  WEEKLY_REVIEW_CADENCE_DAYS_MIN,
} from "./settings";
// Source provenance + editable document body + durable block-processing vocabulary (./source).
export type {
  Document,
  DocumentSchemaVersion,
  MediaKind,
  Source,
  SourceBlockOutputType,
  SourceBlockProcessing,
  SourceBlockProcessingAction,
  SourceBlockProcessingDerivation,
  SourceBlockProcessingOutput,
  SourceBlockProcessingState,
  SourceBlockProcessingSummary,
  SourceBlockProcessingView,
  SourceBlockReconcileReport,
} from "./source";
export {
  isTerminalSourceBlockProcessingState,
  SOURCE_BLOCK_OUTPUT_TYPES,
  SOURCE_BLOCK_PROCESSING_ACTIONS,
  SOURCE_BLOCK_PROCESSING_STATES,
  TERMINAL_SOURCE_BLOCK_PROCESSING_STATES,
} from "./source";
// Source reference (the refblock) — citation formatter, one source of truth (./source-ref).
// Source-reliability metadata (T091) — tier/type/confidence tuples + the badge summary.
export type {
  ConfidenceLevel,
  FormattedSourceRef,
  ReliabilitySummary,
  ReliabilityTier,
  SourceRef,
  SourceType,
} from "./source-ref";
export {
  CONFIDENCE_LEVELS,
  EMPTY_SOURCE_REF,
  formatSourceRef,
  isConfidenceLevel,
  isReliabilityTier,
  isSourceType,
  RELIABILITY_TIERS,
  SOURCE_TYPES,
} from "./source-ref";
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
// Task vocabulary (T092/T110) — the closed `task` kinds + their labels.
export type { SystemTaskType, TaskType } from "./task";
export {
  isSystemTaskType,
  isTaskType,
  SYSTEM_TASK_TYPES,
  TASK_TYPE_LABEL,
  TASK_TYPES,
  taskTypeLabel,
} from "./task";
// Suggested-priority scorer (T127) — pure band/placement/justification rule (./triage-suggestion).
export type {
  TriageInsufficientReason,
  TriageInsufficientSignal,
  TriageJustification,
  TriageJustificationSignal,
  TriagePlacementCandidate,
  TriageSemanticSignal,
  TriageSignalInputs,
  TriageSuggestion,
  TriageSuggestionVerdict,
  TriageYieldSignal,
} from "./triage-suggestion";
export {
  authorDomainYieldBand,
  computeTriageSignalHash,
  scoreTriageSuggestion,
} from "./triage-suggestion";
// URL canonicalization for provenance/duplicate detection — pure, fetch-free (./url).
export { canonicalizeUrl } from "./url";
// Desktop pivot: filesystem asset vault vocabulary (./vault).
export type { Asset, AssetLocation, LocalVaultPath } from "./vault";
