/**
 * UrlImportService (T060) — the local-first web-import orchestrator (main side).
 *
 * The ONE place the pure `@interleave/importers` transforms, the filesystem asset
 * vault, and the `local-db` repositories are composed for URL import. It runs
 * ENTIRELY in the Electron main process: it fetches the page (with a timeout, a
 * body-size cap, an SSRF/redirect guard, and a non-HTML reject), extracts the
 * readable article (Readability), sanitizes it, converts it to the constrained
 * ProseMirror doc, writes BOTH `original.html` + `cleaned.html` into the vault
 * (content-hashed `AssetRepository` metadata; bytes NEVER touch SQLite), and
 * creates an `inbox` source through the existing source pipeline — all in ONE
 * transaction appending the right operation_log entries.
 *
 * Construction-time injection (binding on M13): `new UrlImportService({ db,
 * repositories, assetsDir })`. The renderer IPC handler AND M13's loopback
 * capture server receive the SAME built instance, so both callers share one
 * fully-wired service without going through the renderer. The renderer never
 * fetches, never builds the doc, and never touches the vault.
 *
 * `importFromUrl` fetches first; `importFromHtml` (M12 owns this — the M13
 * extension "save page" entry point) skips the fetch and runs the identical
 * step 2–6 pipeline over supplied HTML. Both produce IDENTICAL sources.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type CapturedVia,
  canonicalizeUrl,
  type ElementId,
  type PlainTextConversion,
  type PriorityLabel,
  priorityFromLabel,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { extractArticle, htmlToProseMirrorDoc, sanitizeArticleHtml } from "@interleave/importers";
import {
  type AssetRepository,
  type InboxItemSummary,
  InboxQuery,
  newElementId,
  type Repositories,
  type SourceDedupQuery,
  type SourceDuplicateMatch,
  type SourceRepository,
} from "@interleave/local-db";
import { importArticleImages } from "./article-image-import";
import { sha256 } from "./backup-manifest";
import {
  assertImportableUrl as assertFetchableUrl,
  fetchImportablePage,
  UrlFetchError,
  type UrlFetchErrorCode,
} from "./url-fetch";

/** The friendly error codes the IPC layer maps to a user-facing message. */
export type UrlImportErrorCode = UrlFetchErrorCode;

/**
 * A typed import failure carrying a `code` the IPC layer maps to a friendly line.
 * The fetch layer ({@link UrlFetchError}, shared with the background-runner
 * worker) is the same closed `code` set; this subclass is the public type the IPC
 * handler + the renderer modal already match on, and {@link fromFetchError}
 * reconstructs one from a worker-reported `{ code, message }` so a job that fails
 * in the worker re-throws here exactly as the inline path does.
 */
export class UrlImportError extends Error {
  readonly code: UrlImportErrorCode;
  constructor(code: UrlImportErrorCode, message: string) {
    super(message);
    this.name = "UrlImportError";
    this.code = code;
  }

  /** Reconstruct a `UrlImportError` from a worker fetch error (same code set). */
  static fromFetchError(error: UrlFetchError): UrlImportError {
    return new UrlImportError(error.code, error.message);
  }
}

/**
 * One existing live source that an import candidate duplicates (T061). Carries the
 * existing element so the caller can offer "Open existing" / "Import new version".
 */
export interface UrlImportDuplicateMatch {
  readonly elementId: string;
  readonly title: string;
  readonly status: string;
  readonly accessedAt: string | null;
  readonly matchedBy: "canonicalUrl" | "contentHash";
}

/**
 * A discriminated import result. T060 always returned `"imported"`; T061 adds the
 * `"duplicate"` arm — when the canonical URL or the cleaned-snapshot content hash
 * already maps to a live source (and `forceNewVersion` is false), the import
 * creates NOTHING and returns the existing match(es) so the caller can offer
 * reuse-or-new-version. The same shape is the IPC contract's `SourcesImportUrlResult`.
 */
export type UrlImportResult =
  | {
      readonly status: "imported";
      readonly id: string;
      readonly item: InboxItemSummary;
    }
  | {
      readonly status: "duplicate";
      readonly matches: readonly UrlImportDuplicateMatch[];
    };

/** Constructor dependencies (injected once; shared by the IPC + loopback callers). */
export interface UrlImportServiceDeps {
  /** The open Drizzle database (for the atomic source+asset transaction). */
  readonly db: InterleaveDatabase;
  /** The repository bag bound to the same DB. */
  readonly repositories: Repositories;
  /** The asset-vault root (`<dataDir>/assets`). */
  readonly assetsDir: string;
  /**
   * The fetch implementation (defaults to the Node global `fetch`). Injectable so
   * the service test can mock the network without a live server.
   */
  readonly fetchImpl?: typeof fetch;
  /** Source priority to use when an import caller omits one. */
  readonly getDefaultPriority?: () => PriorityLabel;
  /**
   * Permit loopback / private hosts (DEV/E2E ONLY). The E2E serves its article
   * fixture from a `127.0.0.1` HTTP server, which the SSRF guard normally blocks;
   * the harness sets this so the test can reach it. NEVER true in a packaged app —
   * `bootstrap()` only forwards it from `INTERLEAVE_ALLOW_LOOPBACK_IMPORT` when
   * `!app.isPackaged` (mirrors the `INTERLEAVE_DATA_DIR` override discipline).
   */
  readonly allowLoopback?: boolean;
}

/** Arguments to {@link UrlImportService.importFromUrl}. */
export interface ImportFromUrlInput {
  readonly url: string;
  readonly priority?: PriorityLabel;
  readonly reasonAdded?: string | null;
  /** Reserved for T061 dedup ("import new version anyway"). Ignored at T060. */
  readonly forceNewVersion?: boolean;
  /**
   * Capture origin (T126) — WHERE this import was initiated. Optional; defaults to
   * `url` (this path fetches a URL). Threaded to `sources.captured_via`.
   */
  readonly capturedVia?: CapturedVia;
}

/** Arguments to {@link UrlImportService.importFromHtml} (the M13 capture entry point). */
export interface ImportFromHtmlInput {
  /** The page url — the FINAL (post-redirect) url for the url_import job path. */
  readonly url: string;
  readonly html: string;
  readonly title?: string | null;
  readonly priority?: PriorityLabel;
  readonly reasonAdded?: string | null;
  readonly accessedAt?: string | null;
  readonly forceNewVersion?: boolean;
  /**
   * The as-ENTERED url, preserved verbatim as `originalUrl` (T058 runner path).
   * The background-runner worker follows redirects, so the entered url and the
   * final `url` can differ; passing it keeps provenance correct. Defaults to
   * `url` (the M13 capture path has no separate entered url).
   */
  readonly originalUrl?: string | null;
  /**
   * Capture origin (T126) — distinguishes the two callers that share this method:
   * the extension loopback (`capture-handler.ts` → `extension`) and the URL
   * background runner (`job-apply-handlers.ts` → `url`). Optional; defaults to `url`.
   */
  readonly capturedVia?: CapturedVia;
}

/**
 * Arguments to {@link UrlImportService.importSelection} (the M13 extension "save
 * selection" entry point — M13 owns this method).
 */
export interface ImportSelectionInput {
  readonly url: string;
  readonly title?: string | null;
  readonly selection: string;
  readonly priority?: PriorityLabel;
  readonly reasonAdded?: string | null;
  /** Surrounding-text anchor for selection lineage; folded into `reasonAdded`. */
  readonly blockContext?: string | null;
  readonly accessedAt?: string | null;
  /**
   * Capture origin (T126) — a selection capture comes from the extension loopback
   * (`capture-handler.ts` → `extension`). Optional; defaults to `extension`.
   */
  readonly capturedVia?: CapturedVia;
}

/** The shared, internal step 2–6 inputs (after the fetch has produced the HTML). */
interface PipelineInput {
  /** The raw page HTML (→ `original.html`). */
  readonly html: string;
  /** The FINAL url (after redirects) used for `url`/`canonicalUrl`. */
  readonly finalUrl: string;
  /** The as-ENTERED url, preserved verbatim as `originalUrl`. */
  readonly originalUrl: string;
  readonly priority: PriorityLabel;
  readonly reasonAdded: string | null;
  /** An explicit title override (capture path), else extracted/fallback. */
  readonly titleOverride?: string | null;
  /** An explicit accessed timestamp (capture path), else auto-stamped now. */
  readonly accessedAt?: string | null;
  /**
   * T061: when true, skip the canonical-URL + content-hash dedup checks and import
   * a SECOND source even if a duplicate exists (the user's "import new version
   * anyway" choice; the canonical-URL index is non-unique by design).
   */
  readonly forceNewVersion: boolean;
  /** Capture origin (T126) written to `sources.captured_via` for the created source. */
  readonly capturedVia: CapturedVia;
}

export class UrlImportService {
  private readonly db: InterleaveDatabase;
  private readonly sources: SourceRepository;
  private readonly assetsRepo: AssetRepository;
  private readonly dedup: SourceDedupQuery;
  private readonly inbox: InboxQuery;
  private readonly assetsDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getDefaultPriority: () => PriorityLabel;
  private readonly allowLoopback: boolean;

  constructor(deps: UrlImportServiceDeps) {
    this.db = deps.db;
    this.sources = deps.repositories.sources;
    this.assetsRepo = deps.repositories.assets;
    this.dedup = deps.repositories.sourceDedup;
    this.inbox = new InboxQuery(deps.repositories);
    this.assetsDir = deps.assetsDir;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.getDefaultPriority = deps.getDefaultPriority ?? (() => "C");
    this.allowLoopback = deps.allowLoopback ?? false;
  }

  private resolvePriority(priority?: PriorityLabel): PriorityLabel {
    return priority ?? this.getDefaultPriority();
  }

  /**
   * Fetch a live web page and import it as an inbox source. Throws a typed
   * {@link UrlImportError} on any network/scheme/SSRF/size/non-HTML failure
   * (nothing is persisted).
   */
  async importFromUrl(input: ImportFromUrlInput): Promise<UrlImportResult> {
    const entered = input.url.trim();
    const { html, finalUrl } = await this.fetchPage(entered);
    return this.runPipeline({
      html,
      finalUrl,
      originalUrl: entered,
      priority: this.resolvePriority(input.priority),
      reasonAdded: input.reasonAdded ?? null,
      forceNewVersion: input.forceNewVersion ?? false,
      // This path fetches a URL — origin `url` unless a caller overrides it.
      capturedVia: input.capturedVia ?? "url",
    });
  }

  /**
   * Import a page from ALREADY-RENDERED HTML (the M13 extension "save page"
   * path — the worker has the rendered DOM, getting past paywalls/JS the bare
   * fetch cannot). Skips the fetch; runs the identical step 2–6 pipeline.
   */
  async importFromHtml(input: ImportFromHtmlInput): Promise<UrlImportResult> {
    const finalUrl = input.url.trim();
    // The as-entered url (the runner's worker followed redirects); falls back to
    // the final url for the M13 capture path, which has no separate entered url.
    const originalUrl = (input.originalUrl ?? finalUrl).trim();
    // The supplied URL still passes the scheme/SSRF guard (defense in depth).
    this.assertImportableUrl(finalUrl);
    return this.runPipeline({
      html: input.html,
      finalUrl,
      originalUrl,
      priority: this.resolvePriority(input.priority),
      reasonAdded: input.reasonAdded ?? null,
      titleOverride: input.title ?? null,
      accessedAt: input.accessedAt ?? null,
      forceNewVersion: input.forceNewVersion ?? false,
      // The two distinct callers pass `extension` (loopback) or `url` (runner);
      // default `url` for any other caller of this shared path.
      capturedVia: input.capturedVia ?? "url",
    });
  }

  /**
   * Import a TEXT SELECTION captured by the M13 browser extension as a fresh
   * inbox `source` (M13 owns + defines this; M12 owns `importFromUrl`/
   * `importFromHtml`). Unlike a page capture, a selection is NOT a page snapshot:
   *
   *   - it reuses `SourceRepository.createWithDocument`'s EXISTING raw-`body` path
   *     (which runs `plainTextToProseMirrorDoc(body)` → constrained-schema doc +
   *     stable block ids — no pre-built `conversion` needed),
   *   - it writes NO vault snapshot (the selection IS the document, not a page),
   *   - it writes NO `source_locations` row (a clean lineage root pointing at no
   *     existing source document — there is nothing to anchor a location into),
   *   - it does NOT run T061 dedup (distinct selections from the same page are
   *     intentionally separate captures; there is no page-snapshot hash to compare),
   *     so it ALWAYS returns the `"imported"` arm.
   *
   * The `blockContext` surrounding-text anchor is preserved WITHOUT a schema
   * change by folding it into `reasonAdded` (there is no `blockContext` column and
   * no `source_locations` row for a selection). This keeps the anchor durable,
   * searchable, and visible in the inspector's "why added" provenance. It is anchor
   * text for a future jump-to-source, NOT a block-level mapping into a page we
   * never snapshotted.
   */
  importSelection(input: ImportSelectionInput): Promise<UrlImportResult> {
    const url = input.url.trim();
    // Defense in depth: the supplied URL still passes the scheme/SSRF guard. A
    // selection never fetches, but a garbage URL should not become provenance.
    this.assertImportableUrl(url);

    const sourceId = newElementId();
    const host = safeHost(url);
    const title = nonEmpty(input.title) ?? host ?? "Captured selection";
    const accessedAt = input.accessedAt ?? new Date().toISOString();
    const canonicalUrl = canonicalizeUrl(url);
    const reasonAdded = composeSelectionReason(input.reasonAdded, input.blockContext);
    const priority = this.resolvePriority(input.priority);

    const detail = this.db.transaction((tx) => {
      this.sources.createWithDocumentWithin(tx, {
        id: sourceId as ElementId,
        title,
        priority: priorityFromLabel(priority),
        status: "inbox",
        stage: "raw_source",
        url,
        canonicalUrl,
        originalUrl: url,
        accessedAt,
        // No snapshot — a selection is a fresh document, not a page capture.
        snapshotKey: null,
        reasonAdded,
        // Capture origin (T126): a selection capture comes from the extension.
        capturedVia: input.capturedVia ?? "extension",
        // The raw selection text → plainTextToProseMirrorDoc (stable block ids).
        body: input.selection,
      });
      return this.inbox.get(sourceId as ElementId);
    });

    const item = detail?.summary ?? this.inbox.list().find((i) => i.id === sourceId) ?? null;
    if (!item) {
      throw new Error("UrlImportService: created selection source not found in inbox");
    }
    return Promise.resolve({ status: "imported", id: sourceId, item });
  }

  /**
   * Parse + validate a URL against the scheme + SSRF guard; throws a
   * {@link UrlImportError} on rejection. Delegates to the shared {@link url-fetch}
   * guard (the SAME classification the worker uses) and re-wraps its
   * {@link UrlFetchError} as the public `UrlImportError`.
   */
  private assertImportableUrl(raw: string): URL {
    try {
      return assertFetchableUrl(raw, this.allowLoopback);
    } catch (err) {
      if (err instanceof UrlFetchError) throw UrlImportError.fromFetchError(err);
      throw err;
    }
  }

  /**
   * Fetch the page via the shared, DB-free {@link fetchImportablePage} (the SAME
   * implementation the background-runner worker uses off-main). Re-wraps a
   * {@link UrlFetchError} as the public `UrlImportError`. The inline path here is
   * kept for the M13 capture callers + tests; the renderer `importUrl` path now
   * runs this fetch in the WORKER (see {@link JobRunner}).
   */
  private async fetchPage(entered: string): Promise<{ html: string; finalUrl: string }> {
    try {
      return await fetchImportablePage(entered, {
        allowLoopback: this.allowLoopback,
        fetchImpl: this.fetchImpl,
      });
    } catch (err) {
      if (err instanceof UrlFetchError) throw UrlImportError.fromFetchError(err);
      throw err;
    }
  }

  /**
   * The shared step 2–6 body both `importFromUrl` + `importFromHtml` call:
   * mint id → Readability → sanitize → HTML→PM → write snapshots + create source
   * in ONE transaction → return the inbox summary.
   */
  private async runPipeline(input: PipelineInput): Promise<UrlImportResult> {
    // 2. Mint the source id up front so the vault path is known before the row.
    const sourceId = newElementId();

    // 3. Pure transforms (importers package): article → clean HTML fingerprint.
    // Image-bearing articles skip content-hash dedup because a text-only hash can
    // false-match two pages whose words are identical but figures differ.
    const article = extractArticle(input.html, { url: input.finalUrl });
    const fingerprintHtml = sanitizeArticleHtml(article.contentHtml);
    const hasArticleImageCandidates = /<img\b/i.test(input.html);

    // Title fallback chain: explicit override → Readability title → page <title>
    // → the host. Never empty (so the inbox row always has a label).
    const host = safeHost(input.finalUrl);
    const title =
      nonEmpty(input.titleOverride) ??
      nonEmpty(article.title) ??
      nonEmpty(article.pageTitle) ??
      host ??
      "Untitled web page";

    const accessedAt = input.accessedAt ?? new Date().toISOString();
    const canonicalUrl = canonicalizeUrl(input.finalUrl);

    // Prepare the snapshot bytes + hashes up front so dedup can compare the
    // cleaned-snapshot hash WITHOUT writing anything (a duplicate writes no files).
    const sourceDir = path.join(this.assetsDir, "sources", sourceId);
    const originalRel = `sources/${sourceId}/original.html`;
    const originalBytes = Buffer.from(input.html, "utf-8");
    const originalHash = sha256(originalBytes);
    const fingerprintHash = sha256(Buffer.from(fingerprintHtml, "utf-8"));

    // 3b. Dedup (T061) — BEFORE any vault write or DB row. Unless the user chose
    //     "import new version anyway", a live canonical-URL match OR a live
    //     cleaned-snapshot content-hash match returns the `"duplicate"` outcome
    //     and persists NOTHING (no file written, no row inserted). Canonical URL is
    //     the primary signal; the content hash is the same-article-different-URL
    //     backstop. Only live (non-soft-deleted) sources count.
    if (!input.forceNewVersion) {
      const duplicates = this.findDuplicates(
        canonicalUrl,
        fingerprintHash,
        !hasArticleImageCandidates,
      );
      if (duplicates.length > 0) {
        return { status: "duplicate", matches: duplicates.map(toDuplicateMatch) };
      }
    }

    // 4. Write the images/snapshots to the vault FIRST (outside the tx — bytes on
    // disk), then insert metadata/source rows in one transaction. Any failure
    // after this point removes the whole source vault dir, including images that
    // were downloaded before conversion or DB insertion failed.
    try {
      const localizedImages = await importArticleImages({
        html: article.contentHtml,
        articleUrl: input.finalUrl,
        sourceId: sourceId as ElementId,
        assetsDir: this.assetsDir,
        allowLoopback: this.allowLoopback,
        fetchImpl: this.fetchImpl,
      });
      const localizedCleanedHtml = sanitizeArticleHtml(localizedImages.html);
      const conversion: PlainTextConversion = htmlToProseMirrorDoc(localizedCleanedHtml);

      // When Readability found no body, note it so the user knows to read the
      // saved original.html snapshot (the capture is never lost). If the user also
      // supplied a reason, keep their intent first and append the diagnostic note
      // (rather than dropping it) so the inbox row still signals the empty body.
      const noBody = conversion.blocks.length === 0;
      const noBodyNote = "Readability found no article body";
      const userReason = nonEmpty(input.reasonAdded);
      const reasonAdded = userReason
        ? noBody
          ? `${userReason} — ${noBodyNote}`
          : userReason
        : noBody
          ? noBodyNote
          : null;

      const cleanedRel = `sources/${sourceId}/cleaned.html`;
      const cleanedBytes = Buffer.from(localizedCleanedHtml, "utf-8");
      const cleanedHash = sha256(cleanedBytes);

      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(path.join(this.assetsDir, originalRel), originalBytes);
      writeFileSync(path.join(this.assetsDir, cleanedRel), cleanedBytes);

      // 5. Create the source + its two snapshot-asset rows in ONE transaction so
      //    a failure rolls back the source, document, blocks, ops, AND asset rows
      //    together (no orphan source/asset). The snapshotKey points at cleaned.html.
      this.db.transaction((tx) => {
        this.sources.createWithDocumentWithin(tx, {
          id: sourceId as ElementId,
          title,
          priority: priorityFromLabel(input.priority),
          status: "inbox",
          stage: "raw_source",
          url: input.finalUrl,
          canonicalUrl,
          originalUrl: input.originalUrl,
          author: article.byline,
          accessedAt,
          snapshotKey: cleanedRel,
          reasonAdded,
          sourceType: "article",
          // Capture origin (T126): `extension` or `url` from the call site.
          capturedVia: input.capturedVia,
          conversion,
        });
        this.assetsRepo.createWithin(tx, {
          owningElementId: sourceId as ElementId,
          kind: "source_html",
          vaultRoot: "assets",
          relativePath: originalRel,
          contentHash: originalHash,
          mime: "text/html",
          size: originalBytes.byteLength,
        });
        this.assetsRepo.createWithin(tx, {
          owningElementId: sourceId as ElementId,
          kind: "source_html",
          vaultRoot: "assets",
          relativePath: cleanedRel,
          contentHash: cleanedHash,
          mime: "text/html",
          size: cleanedBytes.byteLength,
        });
        for (const asset of localizedImages.assetInputs) {
          this.assetsRepo.createWithin(tx, { ...asset.input, id: asset.id });
        }
      });
    } catch (err) {
      // If conversion, snapshot writes, or the transaction failed, best-effort
      // remove the partial vault dir so no orphan image/snapshot files linger.
      try {
        rmSync(sourceDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; surface the original error below.
      }
      throw err;
    }

    // 6. Return the fresh inbox summary (like importManualSource).
    const detail = this.inbox.get(sourceId as ElementId);
    const item = detail?.summary ?? this.inbox.list().find((i) => i.id === sourceId) ?? null;
    if (!item) {
      throw new Error("UrlImportService: created source not found in inbox");
    }
    return { status: "imported", id: sourceId, item };
  }

  /**
   * The dedup decision (T061): ALL live sources this import candidate duplicates,
   * newest first, or `[]`. Canonical URL is the primary signal (checked first; it
   * can match MULTIPLE sources once the user has explicitly imported new versions
   * under the same canonical URL); the cleaned-snapshot content hash is the
   * same-article-different-URL backstop (a single match). Only live
   * (non-soft-deleted) sources count. Returns the raw `SourceDuplicateMatch`es from
   * the typed `local-db` query.
   */
  private findDuplicates(
    canonicalUrl: string | null,
    cleanedHash: string,
    includeContentHash: boolean,
  ): readonly SourceDuplicateMatch[] {
    const byUrl = this.dedup.findSourcesByCanonicalUrl(canonicalUrl);
    if (byUrl.length > 0) return byUrl;
    if (!includeContentHash) return [];
    const byHash = this.dedup.findSourceBySnapshotHash(cleanedHash);
    return byHash ? [byHash] : [];
  }
}

/** Project a typed dedup-query match into the service's result shape. */
function toDuplicateMatch(match: SourceDuplicateMatch): UrlImportDuplicateMatch {
  return {
    elementId: match.elementId,
    title: match.title,
    status: match.status,
    accessedAt: match.accessedAt,
    matchedBy: match.matchedBy,
  };
}

/**
 * Compose the stored `reasonAdded` for a selection capture (T062): the user's
 * reason, plus — when present — the surrounding-text `blockContext` anchor on a
 * readable "Context:" line. Either, both, or neither may be present.
 */
function composeSelectionReason(
  reason: string | null | undefined,
  blockContext: string | null | undefined,
): string | null {
  const userReason = nonEmpty(reason);
  const context = nonEmpty(blockContext);
  if (userReason && context) return `${userReason}\n\nContext: ${context}`;
  if (userReason) return userReason;
  if (context) return `Context: ${context}`;
  return null;
}

/** Trim a string to a non-empty value, or `null`. */
function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The host of a URL (for a title fallback), or `null` when unparseable. */
function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
