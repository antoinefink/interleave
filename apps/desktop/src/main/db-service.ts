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

import type { BlockId, ElementId, PriorityLabel } from "@interleave/core";
import { canonicalizeUrl, priorityFromLabel } from "@interleave/core";
import { type DbHandle, migrateDatabase, openDatabase } from "@interleave/db";
import {
  createRepositories,
  InboxQuery,
  InspectorQuery,
  type Repositories,
} from "@interleave/local-db";
import { seedDemoCollection } from "@interleave/testing";
import type {
  DbStatus,
  DocumentsGetRequest,
  DocumentsGetResult,
  DocumentsSaveRequest,
  DocumentsSaveResult,
  InboxGetResult,
  InboxItemSummary,
  InboxListResult,
  InboxTriageRequest,
  InboxTriageResult,
  InspectorGetResult,
  InspectorListResult,
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
  private inboxQuery: InboxQuery | null = null;
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
    this.inboxQuery = new InboxQuery(this.repositories);
    this.migrated = true;
  }

  /** Close the database handle (called on app shutdown). */
  close(): void {
    if (!this.handle) return;
    this.handle.sqlite.close();
    this.handle = null;
    this.repositories = null;
    this.inspector = null;
    this.inboxQuery = null;
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
