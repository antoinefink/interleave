/**
 * Native SQLite DB service (T007) — the Electron main-process owner of the local
 * database. It is the only place the DB file is opened; the renderer reaches it
 * solely through validated IPC (never directly).
 *
 * Responsibilities for M1:
 *  - open `app.sqlite` via `@interleave/db` (`better-sqlite3` + the mandatory
 *    pragmas: `foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`),
 *  - run the generated Drizzle migrations on startup (explicit + safe for prod),
 *  - serve `db.getStatus()` and the `settings.get/update` surface.
 *
 * The full repository layer (`packages/local-db`, with the operation-log append
 * and transactional multi-table mutations) is constructed here on open (T008):
 * the renderer reaches it only through validated IPC, never directly. The narrow
 * settings surface routes through `SettingsRepository` so all data access flows
 * through the repository seam.
 */

import type {
  BlockId,
  CardKind,
  ElementId,
  ElementStatus,
  IsoTimestamp,
  MarkType,
  Priority,
  PriorityLabel,
  ReviewLog,
  ReviewRating,
  ReviewState,
  SiblingGroupId,
  SourceLocationId,
} from "@interleave/core";
import {
  canonicalizeUrl,
  lowerPriority,
  priorityFromLabel,
  priorityToLabel,
  raisePriority,
} from "@interleave/core";
import { type DbHandle, migrateDatabase, openDatabase } from "@interleave/db";
import {
  SchedulerService as AttentionScheduleService,
  CardEditService,
  CardService,
  createRepositories,
  type DocumentMark,
  ExtractionService,
  ExtractService,
  InboxQuery,
  InspectorQuery,
  type LibraryBrowseFilters,
  LibraryQuery,
  LineageQuery,
  nowIso,
  QueueActionService,
  QueueQuery,
  type Repositories,
  type ReviewOutcome,
  ReviewSessionService,
  resolveSourceRef,
  UndoService,
} from "@interleave/local-db";
import { CardSchedulerService, type IntervalPreview } from "@interleave/scheduler";
import { seedDemoCollection } from "@interleave/testing";
import type {
  AnalyticsGetRequest,
  AnalyticsGetResult,
  BalanceGetRequest,
  BalanceGetResult,
  CardEditSummary,
  CardsCreateRequest,
  CardsCreateResult,
  CardsDeleteRequest,
  CardsDeleteResult,
  CardsFlagRequest,
  CardsFlagResult,
  CardsMarkLeechRequest,
  CardsMarkLeechResult,
  CardsSuspendRequest,
  CardsSuspendResult,
  CardsUpdateRequest,
  CardsUpdateResult,
  ConceptMemberSummary,
  ConceptsAssignRequest,
  ConceptsAssignResult,
  ConceptsCreateRequest,
  ConceptsCreateResult,
  ConceptsListResult,
  ConceptsMembersRequest,
  ConceptsMembersResult,
  ConceptsUnassignRequest,
  ConceptsUnassignResult,
  DbStatus,
  DocumentMarkPayload,
  DocumentMarksAddRequest,
  DocumentMarksAddResult,
  DocumentMarksListRequest,
  DocumentMarksListResult,
  DocumentMarksRemoveRequest,
  DocumentMarksRemoveResult,
  DocumentsGetRequest,
  DocumentsGetResult,
  DocumentsSaveRequest,
  DocumentsSaveResult,
  ElementOrganizeState,
  ElementsSetPriorityRequest,
  ElementsSetPriorityResult,
  ExtractActionSummary,
  ExtractionCreateRequest,
  ExtractionCreateResult,
  ExtractsDeleteRequest,
  ExtractsDeleteResult,
  ExtractsMarkDoneRequest,
  ExtractsMarkDoneResult,
  ExtractsPostponeRequest,
  ExtractsPostponeResult,
  ExtractsRewriteRequest,
  ExtractsRewriteResult,
  ExtractsUpdateStageRequest,
  ExtractsUpdateStageResult,
  InboxGetResult,
  InboxItemSummary,
  InboxListResult,
  InboxTriageRequest,
  InboxTriageResult,
  InspectorGetResult,
  InspectorListResult,
  LeechSummary,
  LibraryBrowseRequest,
  LibraryBrowseResult,
  LibraryItem,
  LineageGetResult,
  QueueActRequest,
  QueueActResult,
  QueueListRequest,
  QueueListResult,
  QueueScheduleRequest,
  QueueScheduleResult,
  QueueUndoRequest,
  QueueUndoResult,
  ReadPointGetRequest,
  ReadPointGetResult,
  ReadPointSetRequest,
  ReadPointSetResult,
  ReviewCardRequest,
  ReviewCardResult,
  ReviewCardView,
  ReviewGradeRequest,
  ReviewGradeResult,
  ReviewLeechesResult,
  ReviewPreviewRequest,
  ReviewPreviewResult,
  ReviewSessionNextRequest,
  ReviewSessionNextResult,
  SearchQueryRequest,
  SearchQueryResult,
  SearchResult,
  SettingsGetAllResult,
  SettingsGetResult,
  SettingsUpdateManyResult,
  SettingsUpdateResult,
  SettingValue,
  SourcesImportManualRequest,
  SourcesImportManualResult,
  TagsAddRequest,
  TagsAddResult,
  TagsListResult,
  TagsRemoveRequest,
  TagsRemoveResult,
  TrashEmptyResult,
  TrashListResult,
  TrashPurgeRequest,
  TrashPurgeResult,
  TrashRestoreRequest,
  TrashRestoreResult,
  UndoLastResult,
} from "../shared/contract";
import { type BackupCounts, resolveSchemaVersion } from "./backup-manifest";

export class DbService {
  private handle: DbHandle | null = null;
  private repositories: Repositories | null = null;
  private inspector: InspectorQuery | null = null;
  private lineage: LineageQuery | null = null;
  private queue: QueueQuery | null = null;
  private library: LibraryQuery | null = null;
  private inboxQuery: InboxQuery | null = null;
  private queueAction: QueueActionService | null = null;
  private extraction: ExtractionService | null = null;
  private extractReview: ExtractService | null = null;
  private cardService: CardService | null = null;
  private cardEditService: CardEditService | null = null;
  private reviewSession: ReviewSessionService | null = null;
  private scheduler: CardSchedulerService | null = null;
  /**
   * The ATTENTION-scheduler APPLY seam (T028) — explicit tomorrow / next-week /
   * next-month / manual scheduling for non-card attention items, distinct from the
   * FSRS `scheduler` above (the two-scheduler split). Reachable from the renderer
   * via `queue.schedule`.
   */
  private attentionScheduler: AttentionScheduleService | null = null;
  private undoService: UndoService | null = null;
  private migrated = false;

  /** Whether the database handle is currently open. */
  get isOpen(): boolean {
    return this.handle !== null;
  }

  /** Whether startup migrations have been applied this session. */
  get isMigrated(): boolean {
    return this.migrated;
  }

  /**
   * Open the database at `dbPath` and run all pending migrations. Idempotent:
   * calling again while open is a no-op. `migrationsDir` is resolved by the
   * caller (the desktop bundle ships its own copy — see `migrations.ts`);
   * `nativeBinding`, when set, points `better-sqlite3` at the Electron-ABI addon
   * (see `native-binding.ts`).
   */
  open(
    dbPath: string,
    options: { migrationsDir?: string | undefined; nativeBinding?: string | undefined } = {},
  ): void {
    if (this.handle) return;
    this.handle = options.nativeBinding
      ? openDatabase(dbPath, { nativeBinding: options.nativeBinding })
      : openDatabase(dbPath);
    migrateDatabase(this.handle.db, options.migrationsDir);
    this.repositories = createRepositories(this.handle.db);
    this.inspector = new InspectorQuery(this.repositories);
    this.lineage = new LineageQuery(this.repositories);
    this.queue = new QueueQuery(this.repositories);
    // The facet-driven browse-all read behind `/library` (distinct from search):
    // lists ALL live elements narrowed by type/concept/priority/status facets,
    // including topic/synthesis_note/task which the FTS index never covers.
    this.library = new LibraryQuery(this.handle.db, this.repositories);
    this.queueAction = new QueueActionService(this.handle.db);
    this.inboxQuery = new InboxQuery(this.repositories);
    this.extraction = new ExtractionService(this.handle.db);
    this.extractReview = new ExtractService(this.handle.db);
    this.cardService = new CardService(this.handle.db);
    this.cardEditService = new CardEditService(this.handle.db);
    // The sibling-aware review-session ordering seam (T039): chooses the next due
    // card and buries siblings (session-ordering ONLY — it writes nothing).
    this.reviewSession = new ReviewSessionService(this.handle.db);
    // The FSRS card scheduler (T036) — one instance per open DB, reading the
    // `defaultDesiredRetention` setting (T011) as its first-class retention input.
    // FSRS schedules CARDS ONLY; sources/topics/extracts stay on the separate
    // attention scheduler (AttentionScheduleService / QueueActionService /
    // ExtractService), never here.
    this.scheduler = new CardSchedulerService({
      desiredRetention: this.repositories.settings.getAppSettings().defaultDesiredRetention,
    });
    // The attention-scheduler APPLY seam (T028): the only place explicit
    // tomorrow/next-week/next-month/manual scheduling for non-card attention items
    // is persisted. Cards are rejected here (the two-scheduler split holds).
    this.attentionScheduler = new AttentionScheduleService(this.handle.db);
    // The general, command-level undo (T044): inverts the last operation_log op via
    // the existing repository write paths. Distinct from the queue's recipe undo (T030).
    this.undoService = new UndoService(this.handle.db);
    this.migrated = true;
  }

  /** Close the database handle (called on app shutdown). */
  close(): void {
    if (!this.handle) return;
    this.handle.sqlite.close();
    this.handle = null;
    this.repositories = null;
    this.inspector = null;
    this.lineage = null;
    this.queue = null;
    this.library = null;
    this.queueAction = null;
    this.inboxQuery = null;
    this.extraction = null;
    this.extractReview = null;
    this.cardService = null;
    this.cardEditService = null;
    this.reviewSession = null;
    this.scheduler = null;
    this.attentionScheduler = null;
    this.undoService = null;
    this.migrated = false;
  }

  private require(): DbHandle {
    if (!this.handle) {
      throw new Error("DbService: database is not open");
    }
    return this.handle;
  }

  /**
   * The repository layer (`packages/local-db`) bound to the open database. All
   * domain data access goes through these — IPC handlers route here, never to
   * raw SQL.
   */
  get repos(): Repositories {
    if (!this.repositories) {
      throw new Error("DbService: database is not open");
    }
    return this.repositories;
  }

  /** Read effective pragmas + applied-migration count for `db.getStatus()`. */
  getStatus(): DbStatus {
    const { sqlite } = this.require();
    const journalMode = String(sqlite.pragma("journal_mode", { simple: true }));
    const foreignKeys = Number(sqlite.pragma("foreign_keys", { simple: true }));
    const busyTimeoutMs = Number(sqlite.pragma("busy_timeout", { simple: true }));

    let appliedMigrations = 0;
    try {
      const row = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as
        | { n: number }
        | undefined;
      appliedMigrations = row?.n ?? 0;
    } catch {
      // Migration table absent only if migrations never ran; report 0.
      appliedMigrations = 0;
    }

    return {
      open: true,
      migrated: this.migrated,
      journalMode,
      foreignKeys,
      busyTimeoutMs,
      appliedMigrations,
    };
  }

  /** Read one setting (by key) or all settings, parsing JSON values. */
  getSettings(key?: string): SettingsGetResult {
    const repo = this.repos.settings;
    if (key) {
      const value = repo.get<SettingValue>(key);
      return { settings: value === null ? {} : { [key]: value } };
    }
    return { settings: repo.getAll() as Record<string, SettingValue> };
  }

  /**
   * Create/overwrite a setting through `SettingsRepository` (the repository seam)
   * so the value persists as JSON text and survives an app restart.
   */
  updateSetting(key: string, value: unknown): SettingsUpdateResult {
    const stored = this.repos.settings.set(key, value ?? null);
    return { key, value: stored as SettingValue };
  }

  /**
   * Read the complete, validated typed {@link AppSettings} (T011) through the
   * `SettingsRepository` — unset keys resolve to the canonical defaults, so the
   * scheduler/UI always see a complete object.
   */
  getAppSettings(): SettingsGetAllResult {
    return { settings: this.repos.settings.getAppSettings() };
  }

  /**
   * Apply a validated partial {@link AppSettings} patch (T011). The repository
   * coerces/clamps and persists in one transaction, then returns the full
   * resulting settings — so it survives an app restart.
   */
  updateAppSettings(patch: Readonly<Record<string, unknown>>): SettingsUpdateManyResult {
    return { settings: this.repos.settings.updateAppSettings(patch) };
  }

  /** Read-only inspector query layer (T010), bound to the open database. */
  private get inspectorQuery(): InspectorQuery {
    if (!this.inspector) {
      throw new Error("DbService: database is not open");
    }
    return this.inspector;
  }

  /** All live element summaries for the inspector's selection picker. */
  listInspectableElements(): InspectorListResult {
    return { elements: this.inspectorQuery.list() };
  }

  /** The full inspector payload for one element, or `null` if unknown/deleted. */
  getInspectorData(id: string): InspectorGetResult {
    return { data: this.inspectorQuery.get(id as ElementId) };
  }

  /**
   * Set / raise / lower an element's priority (T027) — the universal priority
   * write path for ANY element type (source/extract/card/task/topic/synthesis
   * note). The renderer sends an intent only; the MAIN process computes the new
   * numeric value with the `@interleave/core` band helpers and persists it through
   * {@link ElementRepository.setPriority}, which mutates `elements.priority` and
   * appends `update_element` in ONE transaction (NO new op type — priority changes
   * stay within the closed op set). Returns the updated summary carrying the new
   * numeric value + its derived A/B/C/D label so the renderer can update the badge
   * without a re-fetch; `null` when the id is unknown / soft-deleted.
   */
  setElementPriority(request: ElementsSetPriorityRequest): ElementsSetPriorityResult {
    const id = request.id as ElementId;
    const element = this.repos.elements.findById(id);
    if (!element || element.deletedAt) return { element: null };

    let nextPriority: Priority;
    switch (request.action.kind) {
      case "set":
        nextPriority = priorityFromLabel(request.action.priority);
        break;
      case "raise":
        nextPriority = raisePriority(element.priority);
        break;
      case "lower":
        nextPriority = lowerPriority(element.priority);
        break;
    }

    const updated = this.repos.elements.setPriority(id, nextPriority);
    return {
      element: {
        id: updated.id,
        type: updated.type,
        status: updated.status,
        stage: updated.stage,
        priority: updated.priority,
        title: updated.title,
        dueAt: updated.dueAt,
        priorityLabel: priorityToLabel(updated.priority),
      },
    };
  }

  /** Read-only lineage query layer (T023), bound to the open database. */
  private get lineageQuery(): LineageQuery {
    if (!this.lineage) {
      throw new Error("DbService: database is not open");
    }
    return this.lineage;
  }

  /**
   * The full, depth-tagged lineage tree for one element (T023), or `null` when the
   * id is unknown/soft-deleted. The {@link LineageQuery} resolves the lineage ROOT
   * and flattens the `source → extract → sub-extract → card` descendant tree —
   * read-only lineage computed main-side so the renderer only renders + navigates.
   */
  getLineage(id: string): LineageGetResult {
    return { lineage: this.lineageQuery.get(id as ElementId) };
  }

  /** Read-only queue query layer (T029), bound to the open database. */
  private get queueQuery(): QueueQuery {
    if (!this.queue) {
      throw new Error("DbService: database is not open");
    }
    return this.queue;
  }

  /**
   * The unified, sorted, filtered due queue (T029). The {@link QueueQuery} merges
   * the two DISTINCT due reads (due cards via the FSRS `review_states.due_at` join;
   * due sources/topics/extracts/tasks via the attention `elements.due_at` read),
   * decorates each row with its scheduler signals + meta, **sorts priority-then-due
   * date**, applies the type/concept/status filters, and reads the daily review
   * budget from {@link SettingsRepository} for the gauge. Read-only — no mutation,
   * no `operation_log`. The two schedulers stay separate inside the read.
   */
  listQueue(request: QueueListRequest): QueueListResult {
    const data = this.queueQuery.list({
      ...(request.asOf ? { asOf: request.asOf as IsoTimestamp } : {}),
      filters: {
        ...(request.types ? { types: request.types } : {}),
        ...(request.concept ? { concept: request.concept } : {}),
        ...(request.tag ? { tag: request.tag } : {}),
        ...(request.statuses ? { statuses: request.statuses } : {}),
      },
    });
    return { items: data.items, counts: data.counts, budget: data.budget };
  }

  /** The per-row queue ACT seam (T030), bound to the open database. */
  private get queueActionService(): QueueActionService {
    if (!this.queueAction) {
      throw new Error("DbService: database is not open");
    }
    return this.queueAction;
  }

  /**
   * Apply one in-place queue action (T030) — postpone / raise / lower / done /
   * dismiss / delete — through the {@link QueueActionService}, a thin DISPATCHER over
   * the already-built mutation paths. Each path runs in ONE transaction and appends
   * the correct EXISTING op (no new op types): postpone routes an ATTENTION item
   * through the attention scheduler (`reschedule_element`) and a CARD through a thin
   * FSRS `review_states.due_at` defer (the two schedulers stay separate); raise/lower
   * → `update_element`; done/dismiss → `update_element` status; delete →
   * `soft_delete_element` (soft + undoable). Returns the REFRESHED queue row (so the
   * renderer updates + re-sorts it in place), whether the row LEAVES the due list,
   * and the undo recipe for the snackbar. The renderer reaches this only over
   * validated IPC — there is no generic `db.query`.
   */
  actOnQueueItem(request: QueueActRequest): QueueActResult {
    const id = request.id as ElementId;
    const result = this.queueActionService.act(id, request.action.kind);
    // A removing action (done/dismiss/delete) drops the row from the list; a
    // postpone recedes it from the DUE set (so it has no due row either). Only an
    // in-place change (raise/lower) returns a refreshed, still-due summary.
    const item =
      result.removed || request.action.kind === "postpone" ? null : this.queueQuery.summaryFor(id);
    return {
      item,
      removed: result.removed,
      undo: result.undo
        ? { kind: result.undo.kind, previousStatus: result.undo.previousStatus }
        : null,
    };
  }

  /** The attention-scheduler APPLY seam (T028), bound to the open database. */
  private get attentionScheduleService(): AttentionScheduleService {
    if (!this.attentionScheduler) {
      throw new Error("DbService: database is not open");
    }
    return this.attentionScheduler;
  }

  /**
   * Schedule a non-card attention item for an EXPLICIT return (T028) — tomorrow /
   * next week / next month / a manual date — through the attention
   * {@link AttentionScheduleService} (`SchedulerService.scheduleAt`), the apply seam
   * over the pure `AttentionScheduler.scheduleForChoice`. It computes the new
   * `due_at` and persists it via {@link ElementRepository.reschedule}
   * (`reschedule_element`, status → `scheduled`) in ONE transaction — NO new op type.
   *
   * THE TWO-SCHEDULER SPLIT holds: a `card` is rejected by the service (cards
   * schedule on FSRS, never the attention heuristic). After scheduling, the item
   * usually recedes from the DUE set (a future date), so the refreshed `item` is
   * `null` exactly as a `postpone` returns — the renderer re-reads the queue. The
   * renderer reaches this only over validated IPC; there is no generic `db.query`.
   */
  scheduleQueueItem(request: QueueScheduleRequest): QueueScheduleResult {
    const id = request.id as ElementId;
    const choice =
      request.choice.kind === "manual"
        ? { manual: request.choice.date as IsoTimestamp }
        : request.choice.kind;
    const { intervalDays, element } = this.attentionScheduleService.scheduleAt(id, choice);
    return { item: null, dueAt: element.dueAt as string, intervalDays };
  }

  /**
   * Undo a removing queue action (T030) — the snackbar's "Undo" — through the
   * {@link QueueActionService}. `restore` brings a soft-deleted row back via
   * {@link ElementRepository.restore} (`restore_element`); `status` re-sets the prior
   * lifecycle status via {@link ElementRepository.update} (`update_element`). One
   * transaction + the correct existing op (no new op types). Returns the restored
   * queue-row summary so the renderer re-inserts it; `null` when the id is unknown.
   */
  undoQueueAction(request: QueueUndoRequest): QueueUndoResult {
    const id = request.id as ElementId;
    this.queueActionService.undo(id, {
      kind: request.undo.kind,
      previousStatus: request.undo.previousStatus as ElementStatus,
    });
    return { item: this.queueQuery.summaryFor(id) };
  }

  /** Read-only inbox query layer (T012), bound to the open database. */
  private get inbox(): InboxQuery {
    if (!this.inboxQuery) {
      throw new Error("DbService: database is not open");
    }
    return this.inboxQuery;
  }

  /**
   * Create a source in the `inbox` with its document body (T012 + T013). The
   * {@link SourceRepository.createWithDocument} writes the `elements` row, the
   * `sources` provenance row, AND the `documents` body + stable `document_blocks`
   * in ONE transaction, appending `create_element` + `create_source` +
   * `update_document` together — a source never persists without its body. The
   * raw pasted `body` is converted main-side to plain text + ProseMirror JSON
   * (the renderer never builds the doc). The A/B/C/D label maps to a numeric
   * priority via `priorityFromLabel` (default `C`, so new material never dominates
   * older high-value material).
   *
   * Provenance derivation (T014, NO remote fetching): the entered `url` is
   * preserved verbatim as `originalUrl`, and a conservative `canonicalUrl` is
   * derived from it with the pure `canonicalizeUrl` normalizer (tracking params /
   * fragment stripped, host lowercased). `accessedAt` is auto-stamped to "now"
   * (ISO) when the renderer did not supply one. `snapshotKey` stays `null` in M2.
   * If the renderer explicitly passes any of these, its value wins. This entire
   * path is fetch-free — it imports no network module and works fully offline.
   * Returns the new id + its inbox summary.
   */
  importManualSource(request: SourcesImportManualRequest): SourcesImportManualResult {
    const label: PriorityLabel = request.priority ?? "C";
    const url = request.url ?? null;
    const canonicalUrl = request.canonicalUrl ?? canonicalizeUrl(url);
    const originalUrl = request.originalUrl ?? url;
    const accessedAt = request.accessedAt ?? new Date().toISOString();
    const { element } = this.repos.sources.createWithDocument({
      title: request.title,
      priority: priorityFromLabel(label),
      status: "inbox",
      stage: "raw_source",
      url,
      canonicalUrl,
      originalUrl,
      accessedAt,
      snapshotKey: request.snapshotKey ?? null,
      author: request.author ?? null,
      publishedAt: request.publishedAt ?? null,
      reasonAdded: request.reasonAdded ?? null,
      body: request.body,
    });
    const detail = this.inbox.get(element.id);
    const item = detail?.summary ?? this.inbox.list().find((i) => i.id === element.id) ?? null;
    if (!item) {
      throw new Error("DbService.importManualSource: created source not found in inbox");
    }
    return { id: element.id, item };
  }

  /** Live inbox-status source summaries (T012). */
  listInbox(): InboxListResult {
    return { items: this.inbox.list() };
  }

  /** Full preview payload for one inbox item, or `null` (T012). */
  getInboxItem(id: string): InboxGetResult {
    const detail = this.inbox.get(id as ElementId);
    if (!detail) return { detail: null };
    return {
      detail: {
        summary: detail.summary,
        provenance: {
          elementId: detail.provenance.elementId,
          url: detail.provenance.url,
          canonicalUrl: detail.provenance.canonicalUrl,
          originalUrl: detail.provenance.originalUrl,
          author: detail.provenance.author,
          publishedAt: detail.provenance.publishedAt,
          accessedAt: detail.provenance.accessedAt,
          reasonAdded: detail.provenance.reasonAdded,
        },
        bodyPreview: detail.bodyPreview,
      },
    };
  }

  /**
   * Apply one triage action to an inbox source (T012). Each branch runs through
   * {@link ElementRepository}, which mutates + appends the matching op in ONE
   * transaction:
   *  - `accept`       → `update_element` (status `active`)
   *  - `keepForLater` → `update_element` (status `dismissed`)
   *  - `setPriority`  → `update_element` (numeric priority from the label)
   *  - `delete`       → `soft_delete_element` (`deletedAt` + status `deleted`)
   */
  triageInboxItem(request: InboxTriageRequest): InboxTriageResult {
    const id = request.id as ElementId;
    const { action } = request;
    switch (action.kind) {
      case "accept": {
        this.repos.elements.update(id, { status: "active" });
        break;
      }
      case "keepForLater": {
        this.repos.elements.update(id, { status: "dismissed" });
        break;
      }
      case "setPriority": {
        this.repos.elements.update(id, { priority: priorityFromLabel(action.priority) });
        break;
      }
      case "delete": {
        this.repos.elements.softDelete(id);
        return { item: null, deleted: true };
      }
    }
    // After accept/keep the source leaves the inbox; after setPriority it stays.
    // Re-read it as a fresh summary so the renderer reflects the new state.
    const summary: InboxItemSummary | null = this.summaryForId(id);
    return { item: summary, deleted: false };
  }

  /** A fresh inbox summary for one source id (whatever its current status), or `null`. */
  private summaryForId(id: ElementId): InboxItemSummary | null {
    const element = this.repos.elements.findById(id);
    if (!element || element.deletedAt || element.type !== "source") return null;
    const provenance = this.repos.sources.findById(id)?.source ?? null;
    const doc = this.repos.documents.findById(id);
    const plainText = doc?.plainText ?? "";
    const normalized = plainText.replace(/\s+/g, " ").trim();
    const previewSnippet =
      normalized.length === 0
        ? null
        : normalized.length > 160
          ? `${normalized.slice(0, 160).trimEnd()}…`
          : normalized;
    return {
      id: element.id,
      type: element.type,
      status: element.status,
      stage: element.stage,
      priority: element.priority,
      title: element.title,
      srcType: "Manual note",
      author: provenance?.author ?? null,
      accessedAt: provenance?.accessedAt ?? null,
      charCount: plainText.length,
      previewSnippet,
    };
  }

  /**
   * Load an element's document body (T015) through {@link DocumentRepository}.
   * Returns the ProseMirror JSON + plain-text mirror + schema version, or `null`
   * when the element has no document row yet. Read-only; never re-parses the JSON.
   */
  getDocument(request: DocumentsGetRequest): DocumentsGetResult {
    const elementId = request.elementId as ElementId;
    const doc = this.repos.documents.findById(elementId);
    if (!doc) return { document: null, extractedBlockIds: [] };
    // Derive the source's already-extracted block ids from its child extracts'
    // source locations (lineage stays main-side; the reader only DISPLAYS them in
    // M3). Distinct + stable-ordered so the reader can mark `mark.extracted`.
    const extractedBlockIds = this.collectExtractedBlockIds(elementId);
    return {
      document: {
        prosemirrorJson: doc.prosemirrorJson,
        plainText: doc.plainText,
        schemaVersion: doc.schemaVersion,
        updatedAt: doc.updatedAt,
      },
      extractedBlockIds,
    };
  }

  /**
   * The DISTINCT stable block ids in a source's body that have a child extract
   * anchored to them (T018 display markers). Reads the source's `source_locations`
   * (each extract's anchor stores the block ids it covers) — read-only lineage,
   * computed main-side so the renderer never touches the DB. Returns `[]` for
   * elements with no anchors (including non-sources).
   */
  private collectExtractedBlockIds(sourceElementId: ElementId): string[] {
    const locations = this.repos.sources.listLocationsForSource(sourceElementId);
    const seen = new Set<string>();
    for (const loc of locations) {
      for (const blockId of loc.blockIds) seen.add(blockId);
    }
    return [...seen];
  }

  /**
   * Upsert an element's document body (T015 + T016) through
   * {@link DocumentRepository}, which persists the body + `plainText`, replaces
   * the stable `document_blocks`, and appends `update_document` in ONE
   * transaction. The main process stores EXACTLY what the renderer sent — it does
   * not re-parse ProseMirror or re-mint ids (the renderer already enforced the
   * constrained schema, computed `plainText`, and derived the stable block list
   * via `toBlockInputs`). The `blocks` carry the STABLE ids; persisting them
   * verbatim is what preserves the lineage anchor across saves. When `blocks` is
   * omitted, the existing block set is left untouched.
   */
  saveDocument(request: DocumentsSaveRequest): DocumentsSaveResult {
    const saved = this.repos.documents.upsert({
      elementId: request.elementId as ElementId,
      prosemirrorJson: request.prosemirrorJson,
      plainText: request.plainText,
      ...(request.schemaVersion !== undefined ? { schemaVersion: request.schemaVersion } : {}),
      ...(request.blocks !== undefined
        ? {
            blocks: request.blocks.map((b) => ({
              blockType: b.blockType,
              order: b.order,
              stableBlockId: b.stableBlockId as BlockId,
            })),
          }
        : {}),
    });
    return {
      document: {
        prosemirrorJson: saved.prosemirrorJson,
        plainText: saved.plainText,
        schemaVersion: saved.schemaVersion,
        updatedAt: saved.updatedAt,
      },
    };
  }

  /**
   * Add a document mark (T020 highlight; reused by T021/T026) over a STABLE block
   * range through {@link DocumentRepository}, which inserts the `document_marks`
   * row and appends `update_document` in ONE transaction. A mark is an annotation,
   * NOT an element — no `elements` row is created. The renderer-supplied `markType`
   * is already validated against `MARK_TYPES` at the IPC boundary.
   */
  addDocumentMark(request: DocumentMarksAddRequest): DocumentMarksAddResult {
    const mark = this.repos.documents.addMark({
      elementId: request.elementId as ElementId,
      blockId: request.blockId as BlockId,
      markType: request.markType as MarkType,
      range: [request.range[0], request.range[1]],
      attrs: request.attrs ?? null,
    });
    return { mark: markToPayload(mark) };
  }

  /**
   * Remove one document mark by id (T020) through {@link DocumentRepository},
   * which deletes the annotation row and logs `update_document` in ONE
   * transaction. The source BODY is untouched. Returns whether a row was removed.
   */
  removeDocumentMark(request: DocumentMarksRemoveRequest): DocumentMarksRemoveResult {
    const removed = this.repos.documents.removeMark(request.markId);
    return { removed };
  }

  /**
   * List an element's document marks (T020), optionally filtered to one kind
   * (e.g. only highlights). Read-only; the renderer renders them as overlay
   * decorations keyed by stable block id + range.
   */
  listDocumentMarks(request: DocumentMarksListRequest): DocumentMarksListResult {
    const elementId = request.elementId as ElementId;
    const marks = request.markType
      ? this.repos.documents.listMarksByType(elementId, request.markType as MarkType)
      : this.repos.documents.listMarks(elementId);
    return { marks: marks.map(markToPayload) };
  }

  /** The extraction service (T021), bound to the open database. */
  private get extractionService(): ExtractionService {
    if (!this.extraction) {
      throw new Error("DbService: database is not open");
    }
    return this.extraction;
  }

  /**
   * Lift selected source text into a new independent, attention-scheduled `extract`
   * element (T021 — the keystone) via {@link ExtractionService}. In ONE transaction
   * the service creates the extract element + its `source_locations` anchor, seeds
   * the extract's own document body, adds a `derived_from` relation to its
   * source/parent, inherits the source's priority + tags, sets an initial attention
   * `due_at` (status `scheduled`; NEVER an FSRS `review_states` row), and marks the
   * parent body `extracted_span`. A throw anywhere rolls the whole extraction back.
   *
   * The priority is INHERITED from the source by default (the A/B/C/D label, when
   * supplied, overrides it); the title is derived from the selection main-side. The
   * renderer-supplied payload is already validated against the contract schema at
   * the IPC boundary.
   */
  createExtraction(request: ExtractionCreateRequest): ExtractionCreateResult {
    const sourceElementId = request.sourceElementId as ElementId;
    const sourceElement = this.repos.elements.findById(sourceElementId);
    if (!sourceElement || sourceElement.deletedAt) {
      throw new Error(`DbService.createExtraction: source ${sourceElementId} not found`);
    }
    // Inherit the source's numeric priority unless the renderer overrode it.
    const priority: Priority = request.priority
      ? priorityFromLabel(request.priority)
      : sourceElement.priority;

    const { element, location } = this.extractionService.createExtraction({
      sourceElementId,
      parentId: request.parentId as ElementId | undefined,
      selectedText: request.selectedText,
      blockIds: request.blockIds as BlockId[],
      startOffset: request.startOffset,
      endOffset: request.endOffset,
      title: request.title,
      label: request.label ?? undefined,
      page: request.page ?? null,
      priority,
    });

    return {
      extract: {
        id: element.id,
        type: element.type,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        title: element.title,
        dueAt: element.dueAt,
        sourceId: element.sourceId,
        parentId: element.parentId,
      },
      location: {
        id: location.id,
        sourceElementId: location.sourceElementId,
        blockIds: location.blockIds,
        startOffset: location.startOffset,
        endOffset: location.endOffset,
        label: location.label,
        selectedText: location.selectedText,
      },
    };
  }

  /** The card-authoring service (T032), bound to the open database. */
  private get cards(): CardService {
    if (!this.cardService) {
      throw new Error("DbService: database is not open");
    }
    return this.cardService;
  }

  /**
   * Author a card (Q&A or cloze) from an extract (T032 — the M6 keystone) via
   * {@link CardService}. In ONE transaction the service creates the `card` element
   * (stage `card_draft`) + its `cards` row (`kind`/prompt/answer/cloze + the
   * INHERITED `sourceLocationId` anchor) + an UN-DUE `review_states` row
   * (`fsrsState = "new"`, `dueAt = null`), inherits the extract's priority + tags,
   * and links the card to a `sibling_group`. Logs `create_element` + `create_card`
   * (+ `add_tag`/`add_relation`). A throw anywhere rolls the whole card back.
   *
   * **Two-scheduler split (load-bearing):** M6 does NO FSRS math — the card is
   * authored at `card_draft` and parked un-due; M7 (T036) owns the first FSRS
   * schedule + the `card_draft → active_card` transition. The originating extract is
   * UNCHANGED (still its own attention-scheduled element).
   *
   * The priority is INHERITED from the extract by default (the A/B/C/D label, when
   * supplied, overrides it, mapped to a numeric value here main-side); the title is
   * derived from the body main-side when absent. The renderer-supplied payload is
   * already validated against the contract schema (incl. the coarse Q&A/cloze
   * non-empty check) at the IPC boundary.
   */
  createCard(request: CardsCreateRequest): CardsCreateResult {
    const extractId = request.extractId as ElementId;
    const extract = this.repos.elements.findById(extractId);
    if (!extract || extract.deletedAt) {
      throw new Error(`DbService.createCard: extract ${extractId} not found`);
    }
    const { element, siblingGroupId, sourceLocationId } = this.cards.createFromExtract({
      extractId,
      kind: request.kind as CardKind,
      ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      ...(request.answer !== undefined ? { answer: request.answer } : {}),
      ...(request.cloze !== undefined ? { cloze: request.cloze } : {}),
      ...(request.title !== undefined ? { title: request.title } : {}),
      // Inherit the extract's numeric priority unless the renderer overrode it.
      ...(request.priority ? { priority: priorityFromLabel(request.priority) } : {}),
      ...(request.siblingGroupId
        ? { siblingGroupId: request.siblingGroupId as SiblingGroupId }
        : {}),
    });
    return {
      card: {
        id: element.id,
        type: element.type,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        title: element.title,
        kind: request.kind,
        parentId: element.parentId,
        sourceId: element.sourceId,
        siblingGroupId,
      },
      sourceLocationId,
    };
  }

  /** The in-review card-repair service (T038), bound to the open database. */
  private get cardEdit(): CardEditService {
    if (!this.cardEditService) {
      throw new Error("DbService: database is not open");
    }
    return this.cardEditService;
  }

  /** Map a {@link CardEditResult} (element + cards row) onto the flat wire shape. */
  private toCardEditSummary(result: {
    element: {
      id: ElementId;
      type: string;
      status: string;
      stage: string;
      priority: number;
      title: string;
      parentId: ElementId | null;
      sourceId: ElementId | null;
      deletedAt: string | null;
    };
    card: {
      kind: string;
      prompt: string | null;
      answer: string | null;
      cloze: string | null;
      isLeech: boolean;
    };
  }): CardEditSummary {
    const { element, card } = result;
    return {
      id: element.id,
      type: element.type,
      status: element.status,
      stage: element.stage,
      priority: element.priority,
      title: element.title,
      kind: card.kind,
      prompt: card.prompt,
      answer: card.answer,
      cloze: card.cloze,
      parentId: element.parentId,
      sourceId: element.sourceId,
      flagged: this.cardEdit.isFlagged(element.id),
      // The durable leech flag (T040) lives on the `cards` row.
      leech: card.isLeech,
      deleted: element.deletedAt != null,
    };
  }

  /**
   * Edit a card's body in review (T038) via {@link CardEditService.updateBody}: the
   * `cards` row's prompt/answer (Q&A) or cloze text is updated, `elements.updatedAt`
   * is stamped, and `update_element` is logged — all in ONE transaction. Lineage
   * (`sourceLocationId`), the FSRS `review_states`, and the append-only `review_logs`
   * are NEVER touched (an edit must not corrupt the in-flight FSRS state). The body
   * is kept non-empty for the card's kind; the rich card-quality gate is M6/T035.
   */
  updateCard(request: CardsUpdateRequest): CardsUpdateResult {
    const result = this.cardEdit.updateBody(request.cardId as ElementId, {
      ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      ...(request.answer !== undefined ? { answer: request.answer } : {}),
      ...(request.cloze !== undefined ? { cloze: request.cloze } : {}),
    });
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * Suspend a card in review (T038) via {@link CardEditService.suspend}: status
   * `suspended` (`update_element`). The card drops out of `QueueRepository.dueCards`
   * (which excludes suspended) but keeps its `review_states` + `review_logs`,
   * recoverable by un-suspending.
   */
  suspendCard(request: CardsSuspendRequest): CardsSuspendResult {
    const result = this.cardEdit.suspend(request.cardId as ElementId);
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * SOFT-delete a card in review (T038) via {@link CardEditService.delete}
   * (`soft_delete_element`): `deletedAt` + status `deleted`, never a hard DELETE.
   * Lineage references remain valid and it is restorable from the trash (T044).
   */
  deleteCard(request: CardsDeleteRequest): CardsDeleteResult {
    const result = this.cardEdit.delete(request.cardId as ElementId);
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * Flag/un-flag a card as bad in review (T038) via {@link CardEditService.flag} — a
   * non-destructive QUALITY marker stored in the `update_element` op payload (no new
   * column; the durable leech/flag migration is T040's). The card stays in the deck;
   * its body, lineage, and FSRS state are untouched. Logs `update_element`.
   */
  flagCard(request: CardsFlagRequest): CardsFlagResult {
    const result = this.cardEdit.flag(
      request.cardId as ElementId,
      request.flagged,
      request.reason ?? null,
    );
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * Set / clear a card's durable leech flag (T040) via
   * {@link ReviewRepository.setCardLeech}: writes `cards.is_leech` + logs
   * `update_element` in ONE transaction (no new op type). Backs the manual "Mark
   * leech" button and un-leeching a remediated card after a rewrite. Flagging never
   * destroys the card or its `review_logs`; the card stays in the deck (leech is
   * flag + warn, not auto-suspend).
   */
  markLeechCard(request: CardsMarkLeechRequest): CardsMarkLeechResult {
    const result = this.repos.review.setCardLeech(request.cardId as ElementId, request.leech);
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * The leech cleanup view's read (T040) — every card flagged a leech (auto after
   * ≥4 lapses, or manual) with its lapse count + source. Composes
   * {@link ReviewRepository.listLeechCards} (the durable `cards.is_leech` query,
   * most-lapsed first) with each card's lineage source title + location label.
   * Read-only — no mutation, no `operation_log`. Soft-deleted cards are excluded;
   * suspended cards are kept (the cleanup view is where they are repaired).
   */
  reviewLeeches(): ReviewLeechesResult {
    const leeches = this.repos.review.listLeechCards();
    const cards: LeechSummary[] = leeches.map((leech) => {
      const { element, card } = leech;
      const sourceLocationId = card.sourceLocationId as SourceLocationId | null;
      const location = sourceLocationId
        ? this.repos.sources.findLocationById(sourceLocationId)
        : null;
      const sourceEl = element.sourceId ? this.repos.elements.findById(element.sourceId) : null;
      const sourceTitle = sourceEl && !sourceEl.deletedAt ? sourceEl.title : null;
      return {
        id: element.id,
        kind: card.kind,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        title: element.title,
        prompt: card.prompt,
        answer: card.answer,
        cloze: card.cloze,
        lapses: leech.lapses,
        reps: leech.reps,
        sourceTitle,
        sourceLocationLabel: location?.label ?? null,
      };
    });
    return { cards };
  }

  /** The FSRS card scheduler (T036), bound to the open database. */
  private get cardScheduler(): CardSchedulerService {
    if (!this.scheduler) {
      throw new Error("DbService: database is not open");
    }
    return this.scheduler;
  }

  /**
   * Preview the four possible next intervals for a card (T036) — the data the
   * review grade buttons render (T037). Reads the card's current `review_states`
   * via {@link ReviewRepository.findReviewState} and asks the FSRS
   * {@link CardSchedulerService} for the four outcomes. PURE: it mutates NOTHING (no
   * `review_states` write, no `operation_log`). Returns `null` when the id is not a
   * card or has no review state. The renderer reaches this only over validated IPC
   * (T037's `review.preview`); there is no generic `db.query`.
   */
  previewCardIntervals(
    cardElementId: ElementId,
    asOf: IsoTimestamp = new Date().toISOString() as IsoTimestamp,
  ): Record<ReviewRating, IntervalPreview> | null {
    const card = this.repos.review.findCardById(cardElementId);
    if (card?.element.type !== "card" || card.element.deletedAt) return null;
    const state = this.repos.review.findReviewState(cardElementId);
    if (!state) return null;
    return this.cardScheduler.previewIntervals(state, asOf);
  }

  /**
   * Grade one card (T036) — the FSRS write path. FSRS is for CARDS ONLY: this
   * rejects a non-card element so the engine never schedules an extract/source.
   * It reads the card's current `review_states`, asks the FSRS
   * {@link CardSchedulerService} to compute the next memory state (the FSRS math lives
   * in `packages/scheduler`, never here or in the repository), then persists it via
   * {@link ReviewRepository.recordReview} — which appends the immutable
   * `review_logs` row, advances `review_states` (due/stability/difficulty/elapsed/
   * scheduled/reps/lapses/fsrsState) + `elements.due_at`, and logs `add_review_log`,
   * ALL in one transaction. A `card_draft`/un-due card is moved to `active_card` on
   * its first real review (the `card_draft → active_card` transition). The renderer
   * reaches this only over validated IPC (T037's `review.grade`).
   */
  gradeCard(
    cardElementId: ElementId,
    rating: ReviewRating,
    responseMs: number,
    asOf: IsoTimestamp = new Date().toISOString() as IsoTimestamp,
  ): { reviewLog: ReviewLog; reviewState: ReviewState } {
    const card = this.repos.review.findCardById(cardElementId);
    if (card?.element.type !== "card" || card.element.deletedAt) {
      throw new Error(`DbService.gradeCard: card ${cardElementId} not found`);
    }
    const state = this.repos.review.findReviewState(cardElementId);
    if (!state) {
      throw new Error(`DbService.gradeCard: review state for card ${cardElementId} missing`);
    }
    const outcome: ReviewOutcome = this.cardScheduler.gradeCard(state, rating, asOf, responseMs);
    // First real review promotes a parked draft card into active rotation
    // (`card_draft → active_card`) in the SAME transaction as the review log, so the
    // first review is atomic (no durable review log on a card still flagged draft).
    // Normally a card is already `active_card` (it is first-scheduled + activated at
    // creation), but this stays self-healing for any legacy un-activated draft.
    const reviewLog = this.repos.review.recordReview(cardElementId, outcome, {
      promoteFromDraft: card.element.stage === "card_draft",
    });
    const reviewState = this.repos.review.findReviewState(cardElementId);
    if (!reviewState) {
      throw new Error(`DbService.gradeCard: review state vanished after recordReview`);
    }
    return { reviewLog, reviewState };
  }

  /** The FSRS forgetting-curve constants (factor=19/81, decay=-0.5). */
  private static readonly FSRS_DECAY = -0.5;
  private static readonly FSRS_FACTOR = 19 / 81;

  /**
   * Approximate retrievability `R(t) = (1 + FACTOR · t / S)^DECAY` from stability
   * `S` (days) + days since the last review — the same pure presentation formula
   * the inspector/queue use for the `SchedulerChip`/`FsrsStats`. A never-reviewed
   * card has no meaningful value (`null`).
   */
  private static approximateRetrievability(
    stability: number,
    lastReviewedAt: string | null,
    asOfMs: number,
  ): number | null {
    if (!lastReviewedAt || stability <= 0) return null;
    const last = Date.parse(lastReviewedAt);
    if (Number.isNaN(last)) return null;
    const elapsedDays = Math.max(0, (asOfMs - last) / 86_400_000);
    const r = (1 + (DbService.FSRS_FACTOR * elapsedDays) / stability) ** DbService.FSRS_DECAY;
    return Math.min(1, Math.max(0, r));
  }

  /**
   * Assemble the flat {@link ReviewCardView} for one card element — everything the
   * review face needs WITHOUT a reveal round-trip (the answer/cloze/ref ship with
   * the card; the renderer hides them until reveal). Composes the `cards` row, the
   * `review_states` FSRS signals, the lineage source location (jump-to-source), the
   * owning source title, and the concept. Returns `null` for a non-card / deleted id.
   */
  private toReviewCardView(cardElementId: ElementId, asOfMs: number): ReviewCardView | null {
    const card = this.repos.review.findCardById(cardElementId);
    if (card?.element.type !== "card" || card.element.deletedAt) return null;
    const element = card.element;
    const state = this.repos.review.findReviewState(cardElementId);

    // Lineage: the card's source-location anchor (card → source location → source).
    const sourceLocationId = card.card.sourceLocationId as SourceLocationId | null;
    const location = sourceLocationId
      ? this.repos.sources.findLocationById(sourceLocationId)
      : null;

    // The owning source's title (provenance) for the refblock.
    const sourceId = element.sourceId;
    const sourceEl = sourceId ? this.repos.elements.findById(sourceId) : null;
    const sourceTitle = sourceEl && !sourceEl.deletedAt ? sourceEl.title : null;

    const retrievability = state
      ? DbService.approximateRetrievability(state.stability, state.lastReviewedAt, asOfMs)
      : null;

    return {
      id: element.id,
      kind: card.card.kind,
      // The front prompt: a Q&A card's `prompt`; a cloze card's `cloze` text (the
      // renderer masks the `{{cN::…}}` spans until reveal).
      prompt: card.card.kind === "cloze" ? (card.card.cloze ?? "") : (card.card.prompt ?? ""),
      answer: card.card.answer,
      cloze: card.card.cloze,
      priority: element.priority,
      stage: element.stage,
      concept: this.conceptForElement(element.id),
      sourceTitle,
      sourceLocationLabel: location?.label ?? null,
      ref: location?.selectedText ?? null,
      // The enriched refblock (T043): title + URL + author + date + location +
      // snippet, resolved from the card's lineage with the SAME resolver the
      // inspector uses. Ships with the card but the renderer hides it until reveal.
      sourceRef: resolveSourceRef(this.repos, element.id),
      schedulerSignals: {
        kind: "fsrs",
        retrievability,
        stability: state?.stability ?? null,
        difficulty: state?.difficulty ?? null,
        reps: state?.reps ?? null,
        lapses: state?.lapses ?? null,
        fsrsState: state?.fsrsState ?? null,
      },
      // Leech surfacing (T040): the durable `cards.is_leech` flag set automatically
      // once `lapses` crosses the threshold (or manually). The review face shows the
      // leech banner + badge from this. `lapses` is the running lapse count.
      leech: card.card.isLeech,
      lapses: state?.lapses ?? 0,
      // Flag-as-bad (T038) — derived from the card's op-log (no column); the review
      // face shows the flag so the user sees a previously-flagged card resurface.
      flagged: this.cardEdit.isFlagged(element.id),
      // The card's sibling group (T039) — the renderer threads it forward so the
      // next `session.next` can bury it. `null` when the card has no siblings.
      siblingGroupId: this.reviewSessionService.siblingGroupOf(element.id),
    };
  }

  /**
   * The first concept this element is a member of, or `null` — delegates to the
   * ONE shared {@link ConceptRepository.firstConceptName} (also used by the queue
   * + review meta lines) so every surface agrees on the displayed concept.
   */
  private conceptForElement(id: ElementId): string | null {
    return this.repos.concepts.firstConceptName(id);
  }

  /**
   * The next due card in the active-recall session (T037 + T039 sibling burying).
   * Reads the FSRS due deck (`QueueRepository.dueCards` — cards due by
   * `review_states.due_at`, soonest first), skips the `exclude` set (already-seen
   * cards), and caps the session at the `dailyReviewBudget` setting (the soft cap
   * on items surfaced per day, default 60 — read from {@link SettingsRepository}).
   * The budget bounds the WHOLE session: cards already reviewed (the `exclude` set)
   * count against it, so the surfaceable remainder is `budget − exclude.length`.
   *
   * **Sibling burying (T039):** within the budget-bounded deck, the next card is
   * chosen by {@link ReviewSessionService} — when burying is on (the persisted
   * `burySiblings` setting, overridable per-request), a card whose sibling group is
   * in `recentSiblingGroups` is skipped so siblings aren't shown back-to-back; if
   * every remaining card is a recent sibling, the soonest-due card is returned
   * anyway (never starve). The chosen card's `siblingGroupId` rides back on the
   * view so the renderer threads it into the next call. Burying is session-ordering
   * ONLY — it never mutates `review_states`/`due_at`/logs.
   *
   * **Cards only** (the two-scheduler split — attention items are not in the review
   * session). Read-only: no mutation, no `operation_log`.
   */
  reviewSessionNext(request: ReviewSessionNextRequest): ReviewSessionNextResult {
    const asOf = (request.asOf ?? new Date().toISOString()) as IsoTimestamp;
    const asOfMs = Date.parse(asOf);
    const exclude = (request.exclude ?? []) as ElementId[];
    const settings = this.repos.settings.getAppSettings();
    // The daily review budget is the deck cap (soft cap on items surfaced per day).
    // It bounds the entire session, so cards already seen this session (the `exclude`
    // set) consume it — only `budget − seen` further cards may be surfaced.
    const surfaceableCap = Math.max(0, settings.dailyReviewBudget - exclude.length);
    // Burying defaults to the persisted setting; the request may override it (the
    // /settings toggle drives the setting, but a session can pass an explicit value).
    const burySiblings = request.burySiblings ?? settings.burySiblings;
    const next = this.reviewSessionService.nextReviewCard({
      asOf,
      exclude,
      burySiblings,
      limit: surfaceableCap,
      recentSiblingGroups: (request.recentSiblingGroups ?? []) as SiblingGroupId[],
    });
    const total = next.deckSize;
    if (!next.cardId) return { card: null, remaining: 0, total };
    // `toReviewCardView` resolves the card's `siblingGroupId` itself (it equals
    // `next.siblingGroupId`), so the renderer gets the group to bury on the next call.
    const card = this.toReviewCardView(next.cardId, asOfMs);
    if (!card) return { card: null, remaining: Math.max(0, total - 1), total };
    return { card, remaining: Math.max(0, total - 1), total };
  }

  /** The {@link ReviewSessionService} (sibling-aware deck ordering, T039). */
  private get reviewSessionService(): ReviewSessionService {
    if (!this.reviewSession) {
      throw new Error("DbService: database is not open");
    }
    return this.reviewSession;
  }

  /**
   * Fetch ONE card's full reveal-ready {@link ReviewCardView} by id (T037/T031) —
   * the SAME view {@link reviewSessionNext} ships, but TARGETED by id instead of
   * soonest-due. The process loop (T031) walks a FROZEN queue order with a cursor;
   * to reveal a card inline it needs that specific card's full view (answer / cloze
   * / source ref / FSRS signals), which the soonest-due session read cannot return.
   * Read-only: it wraps the private {@link toReviewCardView} (no mutation, no
   * `operation_log`). `card` is `null` for a non-card / deleted id. Cards only —
   * the two-scheduler split holds (this never touches the attention seam).
   */
  reviewCard(request: ReviewCardRequest): ReviewCardResult {
    const asOf = (request.asOf ?? new Date().toISOString()) as IsoTimestamp;
    const asOfMs = Date.parse(asOf);
    const card = this.toReviewCardView(request.cardId as ElementId, asOfMs);
    return { card };
  }

  /**
   * Preview the four next intervals for a card's grade buttons (T037) via the FSRS
   * {@link CardSchedulerService} — wraps {@link previewCardIntervals} into the flat wire
   * shape. PURE: mutates nothing. `intervals` is `null` when the id is not a card or
   * has no review state.
   */
  reviewPreview(request: ReviewPreviewRequest): ReviewPreviewResult {
    const asOf = (request.asOf ?? new Date().toISOString()) as IsoTimestamp;
    const previews = this.previewCardIntervals(request.cardId as ElementId, asOf);
    if (!previews) return { intervals: null };
    return {
      intervals: {
        again: previews.again,
        hard: previews.hard,
        good: previews.good,
        easy: previews.easy,
      },
    };
  }

  /**
   * Grade a card (T037) — the FSRS write path wrapped into the flat wire shape.
   * Delegates to {@link gradeCard} (which runs `CardSchedulerService.gradeCard` →
   * `ReviewRepository.recordReview`, appending the immutable `review_logs` row,
   * advancing `review_states` + `elements.due_at`, and logging `add_review_log` in
   * ONE transaction, plus the `card_draft → active_card` first-review promotion).
   * Records the response time. Cards only.
   */
  reviewGrade(request: ReviewGradeRequest): ReviewGradeResult {
    const asOf = (request.asOf ?? new Date().toISOString()) as IsoTimestamp;
    const { reviewLog, reviewState } = this.gradeCard(
      request.cardId as ElementId,
      request.rating as ReviewRating,
      request.responseMs,
      asOf,
    );
    return {
      reviewLog: {
        id: reviewLog.id,
        elementId: reviewLog.elementId,
        rating: reviewLog.rating,
        reviewedAt: reviewLog.reviewedAt,
        responseMs: reviewLog.responseMs,
        nextDueAt: reviewLog.nextDueAt,
      },
      reviewState: {
        dueAt: reviewState.dueAt,
        stability: reviewState.stability,
        difficulty: reviewState.difficulty,
        reps: reviewState.reps,
        lapses: reviewState.lapses,
        fsrsState: reviewState.fsrsState,
        lastReviewedAt: reviewState.lastReviewedAt,
      },
    };
  }

  private get extractService(): ExtractService {
    if (!this.extractReview) {
      throw new Error("DbService: database is not open");
    }
    return this.extractReview;
  }

  /** Map a domain {@link Element} into the flat `ExtractActionSummary` wire shape. */
  private toExtractActionSummary(element: {
    id: ElementId;
    type: string;
    status: string;
    stage: string;
    priority: number;
    title: string;
    dueAt: string | null;
    sourceId: ElementId | null;
    parentId: ElementId | null;
  }): ExtractActionSummary {
    return {
      id: element.id,
      type: element.type,
      status: element.status,
      stage: element.stage,
      priority: element.priority,
      title: element.title,
      dueAt: element.dueAt,
      sourceId: element.sourceId,
      parentId: element.parentId,
    };
  }

  /**
   * Advance an extract `raw_extract → clean_extract → atomic_statement` (or set an
   * explicit stage when the stepper targets one) (T024) via {@link ExtractService}.
   * In ONE transaction the service persists the new `stage` (`update_element`) AND
   * reschedules the extract on the ATTENTION scheduler (`reschedule_element`) by the
   * by-stage interval — it never creates a card and never touches FSRS. The
   * renderer payload is already validated at the IPC boundary.
   */
  updateExtractStage(request: ExtractsUpdateStageRequest): ExtractsUpdateStageResult {
    const id = request.id as ElementId;
    const { element } = request.stage
      ? this.extractService.setStage(id, request.stage)
      : this.extractService.advanceStage(id);
    return { extract: this.toExtractActionSummary(element) };
  }

  /**
   * Rewrite (or trim) an extract's body (T024) via {@link ExtractService}, which
   * upserts the new ProseMirror body + stable blocks (logs `update_document`). The
   * lineage/anchor + scheduling are untouched — editing the text is not a stage
   * move. `trim` is a renderer-side normalization that flows through this command.
   */
  rewriteExtract(request: ExtractsRewriteRequest): ExtractsRewriteResult {
    const result = this.extractService.rewrite({
      elementId: request.id as ElementId,
      prosemirrorJson: request.prosemirrorJson,
      plainText: request.plainText,
      ...(request.blocks ? { blocks: request.blocks } : {}),
    });
    return {
      extract: this.toExtractActionSummary(result.element),
      plainText: result.plainText ?? request.plainText,
    };
  }

  /**
   * Postpone an extract (T024) via {@link ExtractService}: reschedule it further out
   * on the attention scheduler and record a postpone marker + running count in the
   * `reschedule_element` op payload (no schema migration), so the attention
   * scheduler (T028) + stagnation analytics (T084) can read the postpone history.
   */
  postponeExtract(request: ExtractsPostponeRequest): ExtractsPostponeResult {
    const id = request.id as ElementId;
    const { element } = this.extractService.postpone(id);
    return {
      extract: this.toExtractActionSummary(element),
      postponeCount: this.extractService.countPostpones(id),
    };
  }

  /**
   * Mark an extract done (T024): status `done` via {@link ExtractService}
   * (`update_element`). The extract leaves the active rotation; its body, anchor,
   * and lineage stay intact and recoverable.
   */
  markExtractDone(request: ExtractsMarkDoneRequest): ExtractsMarkDoneResult {
    const { element } = this.extractService.markDone(request.id as ElementId);
    return { extract: this.toExtractActionSummary(element) };
  }

  /**
   * SOFT-delete an extract (T024) via {@link ExtractService} (`soft_delete_element`):
   * `deletedAt` + status `deleted`, never a hard DELETE. User data is never
   * destroyed; lineage references remain valid and it is restorable from the trash.
   */
  deleteExtract(request: ExtractsDeleteRequest): ExtractsDeleteResult {
    const { element } = this.extractService.delete(request.id as ElementId);
    return { extract: this.toExtractActionSummary(element) };
  }

  // -------------------------------------------------------------------------
  // concepts.* / tags.*  (T041 — organize)
  // -------------------------------------------------------------------------

  /**
   * Create a hierarchical concept (T041) through {@link ConceptRepository}: the
   * `concept`-type element (logging `create_element`) AND its `concepts` row, in
   * ONE transaction. Validates the parent (when given) exists. No new op type.
   */
  createConcept(request: ConceptsCreateRequest): ConceptsCreateResult {
    const concept = this.repos.concepts.createConcept({
      name: request.name,
      ...(request.parentConceptId ? { parentConceptId: request.parentConceptId as ElementId } : {}),
    });
    return {
      concept: { id: concept.id, name: concept.name, parentConceptId: concept.parentConceptId },
    };
  }

  /**
   * All concepts as a flat hierarchy (id/name/parent + direct-child & member
   * counts) for the filterbar + the read-only concept map (T041). Read-only.
   */
  listConcepts(): ConceptsListResult {
    return {
      concepts: this.repos.concepts.listConcepts().map((c) => ({
        id: c.id,
        name: c.name,
        parentConceptId: c.parentConceptId,
        childCount: c.childCount,
        memberCount: c.memberCount,
      })),
    };
  }

  /**
   * Assign an element to a concept (T041) — add the `concept_membership` edge via
   * {@link ConceptRepository.assignConcept} (logs `add_relation`, idempotent).
   * Returns the element's refreshed `{ concepts, tags }`.
   */
  assignConcept(request: ConceptsAssignRequest): ConceptsAssignResult {
    this.repos.concepts.assignConcept(
      request.elementId as ElementId,
      request.conceptId as ElementId,
    );
    return { element: this.organizeState(request.elementId as ElementId) };
  }

  /** Unassign an element from a concept (T041) — remove the edge; logs `remove_relation`. */
  unassignConcept(request: ConceptsUnassignRequest): ConceptsUnassignResult {
    this.repos.concepts.unassignConcept(
      request.elementId as ElementId,
      request.conceptId as ElementId,
    );
    return { element: this.organizeState(request.elementId as ElementId) };
  }

  /**
   * The LIVE member elements of one concept (the `/concepts` knowledge-map
   * drill-in). Reads the member ids through the EXISTING
   * {@link ConceptRepository.elementsForConcept} (already excludes soft-deleted
   * members), then enriches each with the SAME fields a search/library row carries
   * — priority + label, owning-source title, the FSRS-vs-attention
   * {@link SchedulerSignals}, and the due state/label — by reusing the inspector +
   * queue builders, so a member row reads identically to a search/queue/library
   * row (no duplicated scheduling math). Read-only (appends no op).
   */
  conceptMembers(request: ConceptsMembersRequest): ConceptsMembersResult {
    const memberIds = this.repos.concepts.elementsForConcept(request.conceptId as ElementId);

    const members: ConceptMemberSummary[] = [];
    for (const id of memberIds) {
      const element = this.repos.elements.findById(id);
      if (!element || element.deletedAt) continue;

      // The owning-source title for the row's meta line (shared T043 resolver — a
      // source references itself; extract/card reference their owning source).
      const { sourceTitle } = this.refMetaForElement(element.id);

      // The load-bearing scheduler chip + due badge — reuse the SAME builders the
      // inspector + queue use so the chip/due read identically across surfaces. Both
      // are best-effort: an element that vanished mid-read degrades to a calm
      // attention "Scheduled" default rather than dropping out of the list.
      const inspectorData = this.inspectorQuery.get(element.id);
      const summary = this.queueQuery.summaryFor(element.id);
      const scheduler = inspectorData?.scheduler ?? {
        kind: "attention" as const,
        retrievability: null,
        stability: null,
        difficulty: null,
        reps: null,
        lapses: null,
        fsrsState: null,
        stage: element.stage,
        postponed: 0,
        lastProcessedAt: element.updatedAt ?? null,
      };

      members.push({
        id: element.id,
        type: element.type,
        title: element.title,
        priority: element.priority,
        priorityLabel: priorityToLabel(element.priority),
        status: element.status,
        stage: element.stage,
        sourceTitle,
        dueAt: summary?.dueAt ?? element.dueAt ?? null,
        scheduler,
        due: summary?.due ?? "soon",
        dueLabel: summary?.dueLabel ?? "Scheduled",
      });
    }
    return { members };
  }

  /** All tags with their live usage count (T041) — the library filterbar. Read-only. */
  listAllTags(): TagsListResult {
    return { tags: this.repos.elements.listAllTags() };
  }

  /** Tag an element (T041) — created on demand; logs `add_tag`. Idempotent. */
  addTag(request: TagsAddRequest): TagsAddResult {
    this.repos.elements.addTag(request.elementId as ElementId, request.tag);
    return { element: this.organizeState(request.elementId as ElementId) };
  }

  /** Untag an element (T041); logs `remove_tag`. */
  removeTag(request: TagsRemoveRequest): TagsRemoveResult {
    this.repos.elements.removeTag(request.elementId as ElementId, request.tag);
    return { element: this.organizeState(request.elementId as ElementId) };
  }

  // -------------------------------------------------------------------------
  // search.*  (T042 — local FTS5 full-text search)
  // -------------------------------------------------------------------------

  /**
   * Local FTS5 full-text search (T042) through {@link SearchRepository.search}:
   * ranked matches over source title/body + extract body + card prompt/answer +
   * tags, with the optional type/concept/tag filters applied in the query layer.
   * Each ranked hit is enriched main-side with its priority label, concept, and
   * source provenance/location (the row's refblock) — reusing the same lineage
   * reads the review/inspector use, so the library row reads consistently. An
   * empty/malformed query yields `{ results: [] }`. Read-only (appends no op).
   */
  search(request: SearchQueryRequest): SearchQueryResult {
    const hits = this.repos.search.search(request.q, {
      ...(request.type ? { type: request.type } : {}),
      ...(request.conceptId ? { conceptId: request.conceptId as ElementId } : {}),
      ...(request.tag ? { tag: request.tag } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    });

    const results: SearchResult[] = [];
    for (const hit of hits) {
      const element = this.repos.elements.findById(hit.id as ElementId);
      if (!element || element.deletedAt) continue;

      // Source provenance + location for the row's refblock. For a `source` hit
      // the element IS the source; for an extract/card, resolve the owning source
      // and the card's/extract's source-location anchor.
      const { sourceTitle, sourceLocationLabel } = this.refMetaForElement(element.id);

      // Scheduler chip + due badge for the selection detail (kit parity). Reuse the
      // SAME builders the inspector + queue use so the chip/due read identically:
      // the inspector resolves the full FSRS/attention `SchedulerSignals`, and the
      // queue summary classifies the due state/label — no duplicated scheduling math.
      // Both are best-effort: a row that vanished between the FTS hit and this read
      // degrades to a calm attention/"Scheduled" default rather than dropping.
      const inspectorData = this.inspectorQuery.get(element.id);
      const summary = this.queueQuery.summaryFor(element.id);
      const scheduler = inspectorData?.scheduler ?? {
        kind: "attention" as const,
        retrievability: null,
        stability: null,
        difficulty: null,
        reps: null,
        lapses: null,
        fsrsState: null,
        stage: element.stage,
        postponed: 0,
        lastProcessedAt: element.updatedAt ?? null,
      };

      results.push({
        id: element.id,
        type: hit.type,
        title: hit.title,
        snippet: hit.snippet,
        score: hit.score,
        priority: element.priority,
        priorityLabel: priorityToLabel(element.priority),
        concept: this.conceptForElement(element.id),
        sourceTitle,
        sourceLocationLabel,
        dueAt: summary?.dueAt ?? element.dueAt ?? null,
        scheduler,
        due: summary?.due ?? "soon",
        dueLabel: summary?.dueLabel ?? "Scheduled",
      });
    }
    return { results };
  }

  // -------------------------------------------------------------------------
  // library.browse()  (Library route — the facet-driven browse-everything read)
  // -------------------------------------------------------------------------

  /** Read-only library browse query layer, bound to the open database. */
  private get libraryQuery(): LibraryQuery {
    if (!this.library) {
      throw new Error("DbService: database is not open");
    }
    return this.library;
  }

  /**
   * The facet-driven "browse everything" read behind `/library`. DISTINCT from
   * {@link search}: it takes NO keyword and lists ALL live elements by default,
   * narrowing only by the type/concept/priority/status facets — and it covers
   * `topic`/`synthesis_note`/`task`, which the FTS-backed search can never return.
   *
   * {@link LibraryQuery} does the live-elements read + ordering + per-facet counts
   * (no SQL/ranking in the renderer); here each returned id is enriched with the
   * SAME fields a search/queue row carries — priority label, concept, source
   * provenance/location (the refblock), the FSRS-vs-attention {@link SchedulerSignals},
   * and the due state/label — by reusing the inspector/queue/refblock builders, so
   * a Library row reads identically to a search/queue row (no duplicated scheduling
   * math). Read-only (appends no op).
   */
  libraryBrowse(request: LibraryBrowseRequest): LibraryBrowseResult {
    const filters: LibraryBrowseFilters = {
      ...(request.types ? { types: request.types } : {}),
      ...(request.conceptId ? { conceptId: request.conceptId as ElementId } : {}),
      ...(request.priorityLabel ? { priorityLabel: request.priorityLabel } : {}),
      ...(request.statuses ? { statuses: request.statuses } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    };
    const { items: elements, counts } = this.libraryQuery.browse(filters);

    const items: LibraryItem[] = [];
    for (const element of elements) {
      // The owning-source provenance + location for the row's refblock (shared
      // T043 resolver — a source references itself; extract/card reference their
      // owning source + location anchor).
      const { sourceTitle, sourceLocationLabel } = this.refMetaForElement(element.id);

      // The load-bearing scheduler chip + due badge — reuse the SAME builders the
      // inspector + queue use so the chip/due read identically across surfaces. Both
      // are best-effort: a row that vanished mid-read degrades to a calm attention
      // "Scheduled" default rather than dropping out of the browse.
      const inspectorData = this.inspectorQuery.get(element.id);
      const summary = this.queueQuery.summaryFor(element.id);
      const scheduler = inspectorData?.scheduler ?? {
        kind: "attention" as const,
        retrievability: null,
        stability: null,
        difficulty: null,
        reps: null,
        lapses: null,
        fsrsState: null,
        stage: element.stage,
        postponed: 0,
        lastProcessedAt: element.updatedAt ?? null,
      };

      items.push({
        id: element.id,
        type: element.type as LibraryItem["type"],
        title: element.title,
        priority: element.priority,
        priorityLabel: priorityToLabel(element.priority),
        status: element.status,
        stage: element.stage,
        concept: this.conceptForElement(element.id),
        sourceTitle,
        sourceLocationLabel,
        dueAt: summary?.dueAt ?? element.dueAt ?? null,
        scheduler,
        due: summary?.due ?? "soon",
        dueLabel: summary?.dueLabel ?? "Scheduled",
      });
    }
    return { items, counts };
  }

  /**
   * Resolve the source title + location label for a search row's refblock through
   * the ONE shared {@link resolveSourceRef} (the same T043 resolver the inspector,
   * review face, and extract view use), so the library row reads a reference
   * identically. A `source` hit references itself; an `extract`/`card` references
   * its owning source element + its source-location anchor (a card additionally
   * falls back to its `cards.source_location_id`). A soft-deleted/missing source
   * degrades to `null` (a calm "no source"), never a broken reference.
   */
  private refMetaForElement(id: ElementId): {
    sourceTitle: string | null;
    sourceLocationLabel: string | null;
  } {
    const ref = resolveSourceRef(this.repos, id);
    return {
      sourceTitle: ref?.sourceTitle ?? null,
      sourceLocationLabel: ref?.locationLabel ?? null,
    };
  }

  /** The element's organize state (concepts + tags), or `null` when soft-deleted/unknown. */
  private organizeState(id: ElementId): ElementOrganizeState | null {
    const element = this.repos.elements.findById(id);
    if (!element || element.deletedAt) return null;
    return {
      elementId: id,
      concepts: this.repos.concepts
        .conceptsForElement(id)
        .map((c) => ({ id: c.id, name: c.name, parentConceptId: c.parentConceptId })),
      tags: this.repos.elements.listTags(id),
    };
  }

  /**
   * Load an element's read-point (resume position) (T017) through
   * {@link DocumentRepository}. Returns the STABLE block id + offset + updated
   * timestamp, or `null` when no read-point has been set yet. Read-only.
   */
  getReadPoint(request: ReadPointGetRequest): ReadPointGetResult {
    const rp = this.repos.documents.getReadPoint(request.elementId as ElementId);
    if (!rp) return { readPoint: null };
    return { readPoint: { blockId: rp.blockId, offset: rp.offset, updatedAt: rp.updatedAt } };
  }

  /**
   * Upsert an element's read-point (T017) through {@link DocumentRepository},
   * which writes the single `read_points` row (one per element) and appends
   * `set_read_point` in ONE transaction. The renderer resolves the STABLE block
   * id + offset from the editor selection; the main process persists exactly what
   * it receives. The same command backs the `markReadThrough` auto-advance seam
   * reserved for T021.
   */
  setReadPoint(request: ReadPointSetRequest): ReadPointSetResult {
    const saved = this.repos.documents.setReadPoint({
      elementId: request.elementId as ElementId,
      documentId: request.documentId as ElementId,
      blockId: request.blockId as BlockId,
      offset: request.offset,
    });
    return {
      readPoint: { blockId: saved.blockId, offset: saved.offset, updatedAt: saved.updatedAt },
    };
  }

  // -------------------------------------------------------------------------
  // Deletion, trash & undo (T044)
  // -------------------------------------------------------------------------

  /** The general command-level undo service (T044), bound to the open database. */
  private get undo(): UndoService {
    if (!this.undoService) {
      throw new Error("DbService: database is not open");
    }
    return this.undoService;
  }

  /**
   * List every soft-deleted element for the Trash view (T044) via the
   * {@link TrashRepository}: newest-deleted first, each with its type, owning-source
   * title, deletion time, and the status it had BEFORE delete (what restore returns
   * it to). Read-only — no mutation, no `operation_log`.
   */
  listTrash(): TrashListResult {
    const items = this.repos.trash.listTrash().map((it) => ({
      id: it.element.id,
      type: it.element.type,
      title: it.element.title,
      deletedAt: it.deletedAt,
      originStatus: it.originStatus,
      sourceTitle: it.sourceTitle,
    }));
    return { items };
  }

  /**
   * Restore a soft-deleted element to its prior lifecycle status (T044) via
   * {@link ElementRepository.restore} (`restore_element`, one transaction, lineage
   * intact). The prior status comes from the latest `soft_delete_element` op's
   * pre-image. Returns the restored summary so the renderer drops the row from the
   * trash; `null` when the id is unknown or the element is not in the trash.
   */
  restoreFromTrash(request: TrashRestoreRequest): TrashRestoreResult {
    const id = request.id as ElementId;
    const element = this.repos.elements.findById(id);
    if (!element?.deletedAt) return { item: null };
    // Reuse the trash read's origin-status resolution so restore returns it to where
    // it was (the same source of truth the Trash list shows).
    const trashItem = this.repos.trash.listTrash().find((it) => it.element.id === id);
    const originStatus = trashItem?.originStatus ?? "active";
    const restored = this.repos.elements.restore(id, originStatus);
    return {
      item: {
        id: restored.id,
        type: restored.type,
        status: restored.status,
        stage: restored.stage,
        priority: restored.priority,
        title: restored.title,
        dueAt: restored.dueAt,
      },
    };
  }

  /**
   * Permanently delete ONE trashed element (T044) — the only hard delete in the
   * app, gated behind explicit UI confirmation — via {@link TrashRepository.purge}.
   * FK cascades + the FTS5 delete trigger clean up dependents; appends no op
   * (irreversible by design). Returns `{ purged: 1 }` or `{ purged: 0 }`.
   */
  purgeFromTrash(request: TrashPurgeRequest): TrashPurgeResult {
    const purged = this.repos.trash.purge(request.id as ElementId) ? 1 : 0;
    return { purged };
  }

  /**
   * Permanently delete EVERY trashed element in one transaction (T044, the "Empty
   * trash" action) via {@link TrashRepository.emptyTrash}. UI-confirmed.
   */
  emptyTrash(): TrashEmptyResult {
    return this.repos.trash.emptyTrash();
  }

  /**
   * Reverse the MOST-RECENT operation from anywhere (T044) via {@link UndoService}:
   * delete → restore, mark-done/dismiss/suspend → prior status, postpone (incl.
   * bulk) → prior schedule. The inverse runs through the existing repository write
   * paths and is itself logged (no new op type). A non-invertible last op returns
   * `{ undone: false }` and mutates nothing.
   */
  undoLastOperation(): UndoLastResult {
    const result = this.undo.undoLast();
    return {
      undone: result.undone,
      opType: result.opType,
      elementId: result.elementId,
      label: result.label,
      ...(result.reason ? { reason: result.reason } : {}),
      count: result.count,
    };
  }

  /**
   * The system-wide learning-health snapshot (T045) via
   * {@link AnalyticsService.computeAnalytics} (in `packages/local-db`): daily
   * reviews + retention from `review_logs`, due cards/topics from the two
   * schedulers, new cards/extracts + deletions from `elements`, and the live leech
   * count. Read-only — no mutation, no `operation_log`. `asOf` defaults to "now"
   * and `windowDays` to 30.
   */
  getAnalytics(request?: AnalyticsGetRequest): AnalyticsGetResult {
    const asOf = (request?.asOf ?? nowIso()) as IsoTimestamp;
    const summary = this.repos.analytics.computeAnalytics(asOf, {
      ...(request?.windowDays !== undefined ? { windowDays: request.windowDays } : {}),
    });
    return {
      asOf: summary.asOf,
      windowDays: summary.windowDays,
      reviewsByDay: summary.reviewsByDay,
      reviewsTotal: summary.reviewsTotal,
      reviewsPerDayAvg: summary.reviewsPerDayAvg,
      retention30d: summary.retention30d,
      dueCards: summary.dueCards,
      dueTopics: summary.dueTopics,
      newCards: summary.newCards,
      newExtracts: summary.newExtracts,
      deletions: summary.deletions,
      leeches: summary.leeches,
      dayStreak: summary.dayStreak,
    };
  }

  /**
   * The import/process balance snapshot (T046) via
   * {@link AnalyticsService.computeBalance} (in `packages/local-db`): the week's
   * sources imported / extracts created / cards created / reviews due, plus the
   * imbalance judgment (the pure `@interleave/core` `judgeBalance` rule, tuned by
   * the user's `importBalanceFactor` setting). REUSES the analytics aggregation so
   * the inbox banner + analytics view can't disagree. Read-only — no mutation, no
   * `operation_log`, no schedule changes. `asOf` defaults to "now", `windowDays`
   * to 7. The `balanceWarnings` on/off setting is honoured in the RENDERER (it
   * controls whether the banner shows); the snapshot is always computed so the
   * analytics view can surface the numbers regardless.
   */
  getBalance(request?: BalanceGetRequest): BalanceGetResult {
    const asOf = (request?.asOf ?? nowIso()) as IsoTimestamp;
    const factor = this.repos.settings.getAppSettings().importBalanceFactor;
    const summary = this.repos.analytics.computeBalance(asOf, {
      factor,
      ...(request?.windowDays !== undefined ? { windowDays: request.windowDays } : {}),
    });
    return {
      asOf: summary.asOf,
      windowDays: summary.windowDays,
      sourcesImported: summary.sourcesImported,
      extractsCreated: summary.extractsCreated,
      cardsCreated: summary.cardsCreated,
      reviewsDueThisWeek: summary.reviewsDueThisWeek,
      imbalanced: summary.imbalanced,
      severity: summary.severity,
    };
  }

  /**
   * Snapshot the live SQLite database to `destPath` consistently (T047) — used by
   * {@link BackupService}. Delegates to better-sqlite3's online `backup()` API,
   * which produces a consistent copy INCLUDING un-checkpointed WAL pages WITHOUT
   * disturbing the live connection (the WAL-consistency correctness guarantee a
   * naive file copy lacks). The renderer never calls this — it is reached only via
   * the typed `backups.create` command in the main process.
   */
  backupDatabaseTo(destPath: string): void {
    const { sqlite } = this.require();
    // `VACUUM INTO` writes a transactionally CONSISTENT, fully self-contained copy
    // of the database to `destPath` in one synchronous statement — it reads a single
    // point-in-time snapshot (so un-checkpointed WAL pages are included) and emits a
    // defragmented DB file with NO `-wal`/`-shm` siblings, which is exactly what a
    // portable, restore-ready backup wants. It requires the destination to not yet
    // exist (the caller writes into a fresh `backups/<timestamp>/`). A defensive
    // checkpoint first keeps the live DB tidy; the snapshot would be consistent
    // either way.
    sqlite.pragma("wal_checkpoint(PASSIVE)");
    sqlite.prepare("VACUUM INTO ?").run(destPath);
  }

  /**
   * The latest applied Drizzle migration TAG (T047) — the backup manifest's
   * "schema version". Reads the runtime count of applied migrations from
   * `__drizzle_migrations` (the source of truth that the DB is at) and maps it to a
   * tag via the staged `_journal.json`. NOT a `schema_version` column (there is
   * none) and NOT `documents.schemaVersion`.
   */
  getSchemaVersion(migrationsDir: string): string {
    const { sqlite } = this.require();
    const row = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as
      | { n: number }
      | undefined;
    const appliedCount = row?.n ?? 0;
    return resolveSchemaVersion(migrationsDir, appliedCount);
  }

  /**
   * Element/source/extract/card/asset counts for the backup manifest's quick
   * human sanity check (T047). Counts LIVE (non-soft-deleted) elements by type and
   * the total asset-metadata rows. Read-only.
   */
  getBackupCounts(): BackupCounts {
    const { sqlite } = this.require();
    // Count ALL rows the backup file actually contains (including soft-deleted) so
    // the manifest sanity check matches the captured `app.sqlite`, not the live view.
    const count = (sql: string): number => {
      const row = sqlite.prepare(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    return {
      elements: count("SELECT COUNT(*) AS n FROM elements"),
      sources: count("SELECT COUNT(*) AS n FROM elements WHERE type = 'source'"),
      extracts: count("SELECT COUNT(*) AS n FROM elements WHERE type = 'extract'"),
      cards: count("SELECT COUNT(*) AS n FROM elements WHERE type = 'card'"),
      assets: count("SELECT COUNT(*) AS n FROM assets"),
    };
  }

  /**
   * Populate an EMPTY database with the shared demo collection (the same factory
   * the Vitest fixtures + `pnpm seed` use), so the inspector has realistic
   * lineage to show in dev and E2E. A no-op when any element already exists, so
   * it never duplicates data or overwrites a real user collection. Opt-in via the
   * caller (gated by `INTERLEAVE_SEED_ON_EMPTY` in `bootstrap`) — production
   * launches do not seed.
   */
  seedIfEmpty(): boolean {
    const repos = this.repos;
    const existing = repos.elements.listByType("source");
    if (existing.length > 0) return false;
    seedDemoCollection(repos);
    return true;
  }

  /** Cheap connectivity check used by `app.health()`. */
  ping(): boolean {
    const { sqlite } = this.require();
    const row = sqlite.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  /** Exposed only for diagnostics/tests; never wired to the renderer. */
  get raw(): DbHandle {
    return this.require();
  }
}

/** Map a repository {@link DocumentMark} onto the flat, JSON-serializable IPC payload. */
function markToPayload(mark: DocumentMark): DocumentMarkPayload {
  return {
    id: mark.id,
    elementId: mark.elementId,
    blockId: mark.blockId,
    markType: mark.markType,
    range: [mark.range[0], mark.range[1]],
    attrs: mark.attrs,
  };
}
