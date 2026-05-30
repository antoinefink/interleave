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

import type { BlockId, ElementId, MarkType, Priority, PriorityLabel } from "@interleave/core";
import {
  canonicalizeUrl,
  lowerPriority,
  priorityFromLabel,
  priorityToLabel,
  raisePriority,
} from "@interleave/core";
import { type DbHandle, migrateDatabase, openDatabase } from "@interleave/db";
import {
  createRepositories,
  type DocumentMark,
  ExtractionService,
  ExtractService,
  InboxQuery,
  InspectorQuery,
  LineageQuery,
  type Repositories,
} from "@interleave/local-db";
import { seedDemoCollection } from "@interleave/testing";
import type {
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
  LineageGetResult,
  ReadPointGetRequest,
  ReadPointGetResult,
  ReadPointSetRequest,
  ReadPointSetResult,
  SettingsGetAllResult,
  SettingsGetResult,
  SettingsUpdateManyResult,
  SettingsUpdateResult,
  SettingValue,
  SourcesImportManualRequest,
  SourcesImportManualResult,
} from "../shared/contract";

export class DbService {
  private handle: DbHandle | null = null;
  private repositories: Repositories | null = null;
  private inspector: InspectorQuery | null = null;
  private lineage: LineageQuery | null = null;
  private inboxQuery: InboxQuery | null = null;
  private extraction: ExtractionService | null = null;
  private extractReview: ExtractService | null = null;
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
    this.inboxQuery = new InboxQuery(this.repositories);
    this.extraction = new ExtractionService(this.handle.db);
    this.extractReview = new ExtractService(this.handle.db);
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
    this.inboxQuery = null;
    this.extraction = null;
    this.extractReview = null;
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

  /**
   * Populate an EMPTY database with the shared demo collection (the same factory
   * the Vitest fixtures + `pnpm seed` use), so the inspector has realistic
   * lineage to show in dev and E2E. A no-op when any element already exists, so
   * it never duplicates data or overwrites a real user collection. Opt-in via the
   * caller (gated by `INTERLEAVE_SEED_ON_EMPTY` in `bootstrap`) — production
   * launches do not seed.
   */
  seedIfEmpty(): boolean {
    const { db } = this.require();
    const repos = this.repos;
    const existing = repos.elements.listByType("source");
    if (existing.length > 0) return false;
    seedDemoCollection(repos, db);
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
