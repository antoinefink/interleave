/**
 * DbService persistence tests (T007).
 *
 * These exercise the real main-process DB service against a temporary on-disk
 * SQLite file (not in-memory) so the persistence guarantee is genuine: a setting
 * written through the service is still there after the service is closed and a
 * NEW service reopens the same file — the unit-level analogue of the Playwright
 * "survives an app restart" check. No Electron is involved; the service has no
 * Electron dependency.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElementId } from "@interleave/core";
import { MIGRATIONS_DIR, openDatabase } from "@interleave/db";
import { seedDemoCollection } from "@interleave/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BlockProcessingListResult,
  type BlockProcessingSummaryResult,
  type SearchQueryRequest,
  SourcesUpdateReliabilityRequestSchema,
} from "../shared/contract";
import { DbService } from "./db-service";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-dbsvc-"));
  dbPath = path.join(dir, "app.sqlite");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("DbService", () => {
  it("opens the DB, runs migrations, and reports a healthy status", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    expect(svc.isOpen).toBe(true);
    expect(svc.isMigrated).toBe(true);
    expect(svc.ping()).toBe(true);

    const status = svc.getStatus();
    expect(status.open).toBe(true);
    expect(status.migrated).toBe(true);
    // On-disk DB → WAL; foreign_keys enforced; busy_timeout from the pragmas.
    expect(status.journalMode).toBe("wal");
    expect(status.foreignKeys).toBe(1);
    expect(status.busyTimeoutMs).toBe(5000);
    expect(status.appliedMigrations).toBeGreaterThan(0);

    svc.close();
    expect(svc.isOpen).toBe(false);
  });

  it("creates the SQLite file on open", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(fs.existsSync(dbPath)).toBe(true);
    svc.close();
  });

  it("round-trips a setting and parses its JSON value", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const written = svc.updateSetting("daily.budget", 42);
    expect(written).toEqual({ key: "daily.budget", value: 42 });

    const read = svc.getSettings("daily.budget");
    expect(read.settings["daily.budget"]).toBe(42);

    svc.close();
  });

  it("overwrites an existing setting (upsert) rather than duplicating", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    svc.updateSetting("theme", "dark");
    svc.updateSetting("theme", "system");
    expect(svc.getSettings("theme").settings.theme).toBe("system");

    // No key omitted → all settings; exactly one row for the key.
    const all = svc.getSettings();
    expect(all.settings.theme).toBe("system");

    svc.close();
  });

  it("persists settings across a full close + reopen (restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    first.updateSetting("default.priority", "B");
    first.updateSetting("retention", 0.9);
    first.close();

    // A brand-new service opening the SAME file must see the values.
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const read = second.getSettings();
    expect(read.settings["default.priority"]).toBe("B");
    expect(read.settings.retention).toBe(0.9);
    second.close();
  });

  it("does not re-create the schema on reopen (migrations are idempotent)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const firstCount = first.getStatus().appliedMigrations;
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(second.getStatus().appliedMigrations).toBe(firstCount);
    second.close();
  });

  it("throws when a query is attempted before open", () => {
    const svc = new DbService();
    expect(() => svc.getStatus()).toThrow(/not open/);
  });

  it("blocks ordinary DB access while local data replacement requires restart", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    svc.beginLocalDataReplacement();
    expect(() => svc.getStatus()).toThrow(/restart Interleave/);
    expect(() => svc.repos).toThrow(/restart Interleave/);

    svc.abortLocalDataReplacement();
    expect(svc.getStatus().open).toBe(true);

    svc.completeLocalDataReplacement();
    expect(svc.localDataRestartRequired).toBe(true);
    expect(() => svc.getStatus()).toThrow(/restart Interleave/);
    svc.close();
  });

  it("stores and reads complex JSON-serializable values", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const value = { layout: "qwerty", flags: [true, false], nested: { n: 1 } };
    svc.updateSetting("keyboard", value);
    expect(svc.getSettings("keyboard").settings.keyboard).toEqual(value);

    svc.close();
  });

  it("never surfaces capture.* pairing secrets through getSettings (T062)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    // The capture server persists these through the raw settings repo. They are
    // pairing plumbing — the renderer must only ever receive them via the
    // explicit capture.getPairing() path, never the generic settings dump.
    svc.updateSetting("capture.token", "super-secret-token");
    svc.updateSetting("capture.allowedOrigin", "chrome-extension://abc");
    svc.updateSetting("capture.port", 7777);
    svc.updateSetting("capture.enabled", true);
    // A normal user setting lives in the same table and MUST still be visible.
    svc.updateSetting("theme", "dark");

    // No-key dump: capture keys dropped, ordinary keys intact.
    const all = svc.getSettings().settings;
    expect(all["capture.token"]).toBeUndefined();
    expect(all["capture.allowedOrigin"]).toBeUndefined();
    expect(all["capture.port"]).toBeUndefined();
    expect(all["capture.enabled"]).toBeUndefined();
    expect(all.theme).toBe("dark");

    // Single-key read of a capture key resolves to an empty result, not the secret.
    expect(svc.getSettings("capture.token").settings["capture.token"]).toBeUndefined();
    expect(svc.getSettings("capture.token").settings).toEqual({});

    svc.close();
  });

  it("reads the typed AppSettings with defaults on a fresh DB (T011)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const { settings } = svc.getAppSettings();
    expect(settings.dailyReviewBudget).toBe(60);
    expect(settings.defaultDesiredRetention).toBe(0.9);
    expect(settings.defaultTopicIntervalDays).toBe(7);
    expect(settings.keyboardLayout).toBe("qwerty");
    expect(settings.theme).toBe("dark");

    svc.close();
  });

  it("updates the typed AppSettings, coercing/clamping (T011)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const { settings } = svc.updateAppSettings({
      dailyReviewBudget: 120,
      keyboardLayout: "vim",
      theme: "system",
    });
    expect(settings.dailyReviewBudget).toBe(120);
    expect(settings.keyboardLayout).toBe("vim");
    expect(settings.theme).toBe("system");
    // Untouched fields keep their defaults.
    expect(settings.defaultTopicIntervalDays).toBe(7);

    svc.close();
  });

  // -------------------------------------------------------------------------
  // Source provenance derivation (T014) — no remote fetching.
  // -------------------------------------------------------------------------

  /** Read the raw `sources` provenance row for an element id straight from SQLite. */
  function readSourceRow(svc: DbService, id: string) {
    return svc.raw.sqlite
      .prepare(
        "SELECT url, canonical_url, original_url, accessed_at, snapshot_key FROM sources WHERE element_id = ?",
      )
      .get(id) as {
      url: string | null;
      canonical_url: string | null;
      original_url: string | null;
      accessed_at: string | null;
      snapshot_key: string | null;
    };
  }

  it("derives canonical_url, keeps original_url verbatim, auto-stamps accessed_at, leaves snapshot_key null (T014)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const before = Date.now();
    const messyUrl = "https://EXAMPLE.com/post/?utm_source=newsletter&id=42#section-2";
    const { id } = svc.importManualSource({ title: "Provenance source", url: messyUrl });

    const row = readSourceRow(svc, id);
    // original_url preserves the as-entered URL verbatim.
    expect(row.original_url).toBe(messyUrl);
    expect(row.url).toBe(messyUrl);
    // canonical_url is the normalized form (host lowercased, tracking + fragment
    // stripped, trailing slash trimmed) — `id=42` is a real param and is kept.
    expect(row.canonical_url).toBe("https://example.com/post?id=42");
    // accessed_at is auto-stamped to "now" (a valid ISO timestamp around import).
    expect(row.accessed_at).not.toBeNull();
    const stamped = Date.parse(row.accessed_at as string);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
    // No snapshot is fetched in M2.
    expect(row.snapshot_key).toBeNull();

    svc.close();
  });

  it("honors an explicit accessedAt and a urlless source (T014)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const explicit = "2026-01-15T00:00:00.000Z";
    const { id } = svc.importManualSource({ title: "Hand-dated note", accessedAt: explicit });
    const row = readSourceRow(svc, id);
    expect(row.accessed_at).toBe(explicit);
    // No URL → no canonical/original URL, but accessed_at is still set.
    expect(row.url).toBeNull();
    expect(row.canonical_url).toBeNull();
    expect(row.original_url).toBeNull();

    svc.close();
  });

  it("uses the configured default source priority when manual imports omit priority", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    svc.updateAppSettings({ defaultSourcePriority: 0.875 });

    const { id: defaultedId } = svc.importManualSource({ title: "Default priority source" });
    const { id: explicitId } = svc.importManualSource({
      title: "Explicit low priority source",
      priority: "D",
    });

    expect(svc.getInboxItem(defaultedId).detail?.summary.priority).toBe(0.875);
    expect(svc.getInboxItem(explicitId).detail?.summary.priority).toBe(0.125);

    svc.close();
  });

  it("surfaces derived provenance through the inbox detail (T014)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const body = `First paragraph.\n\n${"word ".repeat(900)}final word`;
    const { id } = svc.importManualSource({
      title: "Visible provenance",
      url: "https://example.com/a?fbclid=x",
      body,
    });
    const { detail } = svc.getInboxItem(id);
    expect(detail?.provenance.canonicalUrl).toBe("https://example.com/a");
    expect(detail?.provenance.originalUrl).toBe("https://example.com/a?fbclid=x");
    expect(detail?.provenance.accessedAt).not.toBeNull();
    expect(detail?.summary.srcType).toBe("Web article");
    expect(detail?.bodyDoc).toMatchObject({ type: "doc" });
    expect(JSON.stringify(detail?.bodyDoc)).toContain("final word");
    expect(detail?.bodyText).toBe(body);
    expect(detail?.bodyText).toContain("final word");
    expect(detail?.bodyPreview?.length).toBeLessThan(body.length);

    svc.close();
  });

  it("keeps URL-backed source labels in triage response summaries", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const { id } = svc.importManualSource({
      title: "URL-backed inbox item",
      url: "https://example.com/imported-blog-post",
    });
    const result = svc.triageInboxItem({
      id,
      action: { kind: "setPriority", priority: "A" },
    });

    expect(result.item?.srcType).toBe("Web article");
    expect(result.item?.priority).toBe(0.875);

    svc.close();
  });

  it("rejects stale inbox triage without mutating non-inbox or deleted sources", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const { id: acceptedId } = svc.importManualSource({ title: "Already accepted" });
    expect(
      svc.triageInboxItem({
        id: acceptedId,
        action: { kind: "accept" },
      }).item?.status,
    ).toBe("active");
    expect(() =>
      svc.triageInboxItem({
        id: acceptedId,
        action: { kind: "accept" },
      }),
    ).toThrow("Inbox item is no longer available.");
    const accepted = svc.repos.elements.findById(acceptedId as never);
    expect(accepted?.status).toBe("active");
    expect(accepted?.dueAt).not.toBeNull();

    const { id: deletedId } = svc.importManualSource({ title: "Deleted stale item" });
    svc.triageInboxItem({ id: deletedId, action: { kind: "delete" } });
    const deletedBefore = svc.repos.elements.findById(deletedId as never);
    expect(deletedBefore?.status).toBe("deleted");
    expect(deletedBefore?.deletedAt).not.toBeNull();
    expect(() =>
      svc.triageInboxItem({
        id: deletedId,
        action: { kind: "accept" },
      }),
    ).toThrow("Inbox item is no longer available.");
    const deletedAfter = svc.repos.elements.findById(deletedId as never);
    expect(deletedAfter?.status).toBe("deleted");
    expect(deletedAfter?.deletedAt).toBe(deletedBefore?.deletedAt);

    svc.close();
  });

  it("read-now accept activates an inbox source with an attention return date", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const { id } = svc.importManualSource({
      title: "Started source",
      body: "First paragraph.\n\nSecond paragraph.",
    });
    const result = svc.triageInboxItem({
      id,
      action: { kind: "accept" },
    });

    expect(result.deleted).toBe(false);
    expect(result.item?.status).toBe("active");
    expect(svc.listInbox().items.map((item) => item.id)).not.toContain(id);

    const element = svc.repos.elements.findById(id as never);
    expect(element?.status).toBe("active");
    expect(element?.dueAt).not.toBeNull();
    expect(Date.parse(element?.dueAt ?? "")).toBeGreaterThan(Date.now());

    const ops = svc.repos.operationLog.listForElement(id as never);
    expect(ops[0]?.opType).toBe("reschedule_element");
    expect(ops[0]?.payload).toMatchObject({
      action: "activate",
      status: "active",
      prevStatus: "inbox",
      prevDueAt: null,
    });

    svc.close();
  });

  it("persists derived provenance across a close + reopen (T014 restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { id } = first.importManualSource({
      title: "Durable provenance",
      url: "https://example.com/x?utm_medium=email",
    });
    const accessed = readSourceRow(first, id).accessed_at;
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const row = readSourceRow(second, id);
    expect(row.canonical_url).toBe("https://example.com/x");
    expect(row.original_url).toBe("https://example.com/x?utm_medium=email");
    expect(row.accessed_at).toBe(accessed);
    expect(row.snapshot_key).toBeNull();
    second.close();
  });

  // -------------------------------------------------------------------------
  // Source-reliability metadata (T091).
  // -------------------------------------------------------------------------

  it("updateSourceReliability writes the four fields + returns provenance (T091)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const { id } = svc.importManualSource({ title: "Reliable source" });
    // A fresh source has no reliability badge.
    let data = svc.getInspectorData(id).data;
    expect(data?.provenance?.reliabilityTier).toBeNull();

    const { provenance } = svc.updateSourceReliability({
      sourceId: id,
      sourceType: "paper",
      reliabilityTier: "primary",
      confidence: "high",
      reliabilityNotes: "Peer reviewed.",
    });
    expect(provenance.sourceType).toBe("paper");
    expect(provenance.reliabilityTier).toBe("primary");
    expect(provenance.confidence).toBe("high");
    expect(provenance.reliabilityNotes).toBe("Peer reviewed.");

    // The inspector reflects it; the op is the existing update_element (no new op type).
    data = svc.getInspectorData(id).data;
    expect(data?.provenance?.reliabilityTier).toBe("primary");
    const ops = svc.raw.sqlite
      .prepare("SELECT op_type FROM operation_log WHERE element_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(id) as { op_type: string };
    expect(ops.op_type).toBe("update_element");

    svc.close();
  });

  it("updateSourceReliability persists across a close + reopen (T091 restart)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { id } = first.importManualSource({ title: "Durable reliability" });
    first.updateSourceReliability({
      sourceId: id,
      reliabilityTier: "secondary",
      confidence: "low",
    });
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const data = second.getInspectorData(id).data;
    expect(data?.provenance?.reliabilityTier).toBe("secondary");
    expect(data?.provenance?.confidence).toBe("low");
    second.close();
  });

  it("the reliability IPC schema rejects a bad enum + an oversized note (T091)", () => {
    // Bad enum value.
    expect(() =>
      SourcesUpdateReliabilityRequestSchema.parse({ sourceId: "x", reliabilityTier: "quaternary" }),
    ).toThrow();
    // Oversized note (> 2048 chars).
    expect(() =>
      SourcesUpdateReliabilityRequestSchema.parse({
        sourceId: "x",
        reliabilityNotes: "z".repeat(2049),
      }),
    ).toThrow();
    // An empty patch (no fields) is rejected by the refine.
    expect(() => SourcesUpdateReliabilityRequestSchema.parse({ sourceId: "x" })).toThrow();
    // A valid patch parses.
    expect(
      SourcesUpdateReliabilityRequestSchema.parse({
        sourceId: "x",
        reliabilityTier: "primary",
        confidence: "high",
      }),
    ).toMatchObject({ reliabilityTier: "primary", confidence: "high" });
  });

  it("keeps the import path fetch-free: the DB service imports no network module (T014)", () => {
    // The provenance derivation must work fully offline. Guard against a future
    // edit accidentally pulling a fetcher into the import path by asserting the
    // DB-service source references no HTTP/network import.
    const src = fs.readFileSync(path.join(__dirname, "db-service.ts"), "utf8");
    expect(src).not.toMatch(/from "node:https?"/);
    expect(src).not.toMatch(/require\(["']node:https?["']\)/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/from "(node-fetch|undici|axios|got)"/);
  });

  // -------------------------------------------------------------------------
  // Source reader document load (T018) — extracted-span display anchors.
  // -------------------------------------------------------------------------

  it("getDocument returns the body + the source's extracted block ids (T018)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    // Seed the demo collection: the source has a child extract anchored at the
    // definition paragraph block (`blk_def_p1`).
    expect(svc.seedIfEmpty()).toBe(true);

    // Find the seeded source id by type.
    const source = svc.raw.sqlite
      .prepare("SELECT id FROM elements WHERE type = 'source' AND parent_id IS NULL LIMIT 1")
      .get() as { id: string } | undefined;
    expect(source).toBeDefined();

    const result = svc.getDocument({ elementId: source?.id ?? "" });
    expect(result.document).not.toBeNull();
    expect(result.document?.plainText.length).toBeGreaterThan(0);
    // The extract + sub-extract both anchor at the definition block; the list is
    // DISTINCT, so it appears exactly once.
    expect(result.extractedBlockIds).toContain("blk_def_p1");
    expect(result.extractedBlockIds.filter((b) => b === "blk_def_p1")).toHaveLength(1);

    svc.close();
  });

  it("getDocument returns [] extracted block ids for a source with no extracts (T018)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { id } = svc.importManualSource({
      title: "Lonely source",
      body: "A paragraph with no extracts yet.",
    });
    const result = svc.getDocument({ elementId: id });
    expect(result.document).not.toBeNull();
    expect(result.extractedBlockIds).toEqual([]);
    svc.close();
  });

  it("getDocument returns null body + [] anchors for an unknown element (T018)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const result = svc.getDocument({ elementId: "el_does_not_exist" });
    expect(result.document).toBeNull();
    expect(result.extractedBlockIds).toEqual([]);
    svc.close();
  });

  it("persists the typed AppSettings across a full close + reopen (T011 restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    first.updateAppSettings({
      dailyReviewBudget: 90,
      defaultDesiredRetention: 0.95,
      defaultTopicIntervalDays: 30,
      defaultSourcePriority: 0.875,
      burySiblings: false,
      keyboardLayout: "dvorak",
      theme: "light",
    });
    first.close();

    // A brand-new service opening the SAME file must see every value (incl. the
    // T039 burySiblings toggle).
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { settings } = second.getAppSettings();
    // The IPC-facing read PROJECTS the own-keys to `*Configured` booleans (T087/T093) —
    // the plaintext `aiApiKey`/`embeddingApiKey` are NEVER returned to the renderer.
    expect(settings).toEqual({
      dailyReviewBudget: 90,
      defaultDesiredRetention: 0.95,
      defaultTopicIntervalDays: 30,
      defaultSourcePriority: 0.875,
      burySiblings: false,
      trashRetentionDays: 30,
      balanceWarnings: true,
      importBalanceFactor: 1.5,
      keyboardLayout: "dvorak",
      theme: "light",
      displayName: "",
      retentionByBand: {},
      retentionByBandEnabled: false,
      fsrsParamsGlobal: null,
      semanticSearchEnabled: false,
      embeddingProvider: "local",
      embeddingApiKeyConfigured: false,
      embeddingModelId: "local:all-MiniLM-L6-v2",
      embeddingModelDownloaded: false,
      aiEnabled: false,
      aiProviderKind: "local",
      aiManagedProxyEnabled: false,
      aiModelDownloaded: false,
      aiLocalModelId: "local:Llama-3.2-3B-Instruct-Q4_K_M",
      aiKeyConfigured: false,
    });
    expect(settings).not.toHaveProperty("aiApiKey");
    expect(settings).not.toHaveProperty("embeddingApiKey");
    second.close();
  });

  // -------------------------------------------------------------------------
  // elements.setPriority (T027) — the universal priority write path.
  // -------------------------------------------------------------------------

  it("setElementPriority set/raise/lower produces the expected numeric value for a source, extract, and card (T027)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    // Priority is first-class on EVERY element type — create one of each.
    const source = svc.repos.elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.375, // C
      title: "A source",
    });
    const extract = svc.repos.elements.create({
      type: "extract",
      status: "scheduled",
      stage: "raw_extract",
      priority: 0.375, // C
      title: "An extract",
    });
    const card = svc.repos.elements.create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: 0.375, // C
      title: "A card",
    });

    // set → store the label's representative numeric value (A = 0.875).
    const setRes = svc.setElementPriority({
      id: source.id,
      action: { kind: "set", priority: "A" },
    });
    expect(setRes.element?.priority).toBe(0.875);
    expect(setRes.element?.priorityLabel).toBe("A");

    // raise → step UP one band (C → B = 0.625) on an extract.
    const raiseRes = svc.setElementPriority({ id: extract.id, action: { kind: "raise" } });
    expect(raiseRes.element?.priority).toBe(0.625);
    expect(raiseRes.element?.priorityLabel).toBe("B");

    // lower → step DOWN one band (C → D = 0.125) on a card (priority is universal).
    const lowerRes = svc.setElementPriority({ id: card.id, action: { kind: "lower" } });
    expect(lowerRes.element?.priority).toBe(0.125);
    expect(lowerRes.element?.priorityLabel).toBe("D");

    // The numeric values are actually persisted on the elements rows.
    expect(svc.repos.elements.findById(source.id)?.priority).toBe(0.875);
    expect(svc.repos.elements.findById(extract.id)?.priority).toBe(0.625);
    expect(svc.repos.elements.findById(card.id)?.priority).toBe(0.125);

    svc.close();
  });

  it("setElementPriority clamps raise at A and lower at D (T027)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const top = svc.repos.elements.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.875, // A
      title: "Top",
    });
    const bottom = svc.repos.elements.create({
      type: "task",
      status: "active",
      stage: "rough_topic",
      priority: 0.125, // D
      title: "Bottom",
    });

    // Raising A is a no-op; lowering D is a no-op.
    expect(
      svc.setElementPriority({ id: top.id, action: { kind: "raise" } }).element?.priority,
    ).toBe(0.875);
    expect(
      svc.setElementPriority({ id: bottom.id, action: { kind: "lower" } }).element?.priority,
    ).toBe(0.125);

    svc.close();
  });

  it("setElementPriority appends exactly one update_element op per change (no new op type) (T027)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const el = svc.repos.elements.create({
      type: "extract",
      status: "scheduled",
      stage: "raw_extract",
      priority: 0.375,
      title: "Op-logged",
    });

    const countUpdateOps = () =>
      svc.repos.operationLog.listForElement(el.id).filter((o) => o.opType === "update_element")
        .length;

    const before = countUpdateOps();
    svc.setElementPriority({ id: el.id, action: { kind: "raise" } });
    expect(countUpdateOps()).toBe(before + 1);
    svc.setElementPriority({ id: el.id, action: { kind: "set", priority: "D" } });
    expect(countUpdateOps()).toBe(before + 2);

    svc.close();
  });

  it("setElementPriority returns null for an unknown / soft-deleted element (T027)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    expect(
      svc.setElementPriority({ id: "el_missing", action: { kind: "raise" } }).element,
    ).toBeNull();

    const el = svc.repos.elements.create({
      type: "extract",
      status: "scheduled",
      stage: "raw_extract",
      priority: 0.375,
      title: "Doomed",
    });
    svc.repos.elements.softDelete(el.id);
    expect(svc.setElementPriority({ id: el.id, action: { kind: "raise" } }).element).toBeNull();

    svc.close();
  });

  it("persists a priority change across a full close + reopen (T027 restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const el = first.repos.elements.create({
      type: "extract",
      status: "scheduled",
      stage: "raw_extract",
      priority: 0.375, // C
      title: "Durable priority",
    });
    first.setElementPriority({ id: el.id, action: { kind: "set", priority: "A" } });
    first.close();

    // A brand-new service opening the SAME file must see the raised priority.
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(second.repos.elements.findById(el.id)?.priority).toBe(0.875);
    second.close();
  });

  // -------------------------------------------------------------------------
  // queue.act / queue.undo (T030) — in-place per-row queue actions.
  // -------------------------------------------------------------------------

  it("actOnQueueItem raise/lower returns the refreshed in-place row (T030)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const extract = svc.repos.elements.create({
      type: "extract",
      status: "scheduled",
      stage: "raw_extract",
      priority: 0.375, // C
      title: "An extract",
      dueAt: "2020-01-01T00:00:00.000Z", // already due
    });

    const res = svc.actOnQueueItem({ id: extract.id, action: { kind: "raise" } });
    expect(res.removed).toBe(false);
    expect(res.undo).toBeNull();
    // The row stays in place with its NEW priority band (C → B = 0.625).
    expect(res.item?.priority).toBe(0.625);
    expect(svc.repos.elements.findById(extract.id)?.priority).toBe(0.625);

    svc.close();
  });

  it("actOnQueueItem markDone/dismiss removes the row + carries an undo recipe (T030)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const extract = svc.repos.elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.625,
      title: "Doomed extract",
    });

    const done = svc.actOnQueueItem({ id: extract.id, action: { kind: "markDone" } });
    expect(done.removed).toBe(true);
    expect(done.item).toBeNull();
    expect(done.undo).toEqual({ kind: "status", previousStatus: "active" });
    expect(svc.repos.elements.findById(extract.id)?.status).toBe("done");

    // Undo re-sets the prior status; the restored summary comes back.
    const undone = svc.undoQueueAction({ id: extract.id, undo: done.undo as never });
    expect(svc.repos.elements.findById(extract.id)?.status).toBe("active");
    expect(undone.item?.id).toBe(extract.id);

    svc.close();
  });

  it("actOnQueueItem delete is SOFT + undoable through queue.undo (T030)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const extract = svc.repos.elements.create({
      type: "extract",
      status: "scheduled",
      stage: "raw_extract",
      priority: 0.625,
      title: "Soft-deletable extract",
    });

    const del = svc.actOnQueueItem({ id: extract.id, action: { kind: "delete" } });
    expect(del.removed).toBe(true);
    expect(del.undo).toEqual({ kind: "restore", previousStatus: "scheduled" });
    // SOFT: the row is still present with deletedAt set (never hard-deleted).
    const deleted = svc.repos.elements.findById(extract.id);
    expect(deleted?.deletedAt).toBeTruthy();
    expect(deleted?.status).toBe("deleted");

    // Undo restores it to its prior status.
    svc.undoQueueAction({ id: extract.id, undo: del.undo as never });
    const restored = svc.repos.elements.findById(extract.id);
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.status).toBe("scheduled");

    svc.close();
  });

  it("a postponed item survives a full close + reopen (T030 restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const extract = first.repos.elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.625,
      title: "Durably postponed",
      dueAt: "2020-01-01T00:00:00.000Z",
    });
    first.actOnQueueItem({ id: extract.id, action: { kind: "postpone" } });
    const postponedDue = first.repos.elements.findById(extract.id)?.dueAt;
    expect(postponedDue).toBeTruthy();
    expect(Date.parse(postponedDue as string)).toBeGreaterThan(Date.parse("2020-01-01"));
    first.close();

    // A brand-new service opening the SAME file must see the postponed schedule —
    // the item is still scheduled (not lost) after the restart.
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const reopened = second.repos.elements.findById(extract.id);
    expect(reopened?.status).toBe("scheduled");
    expect(reopened?.dueAt).toBe(postponedDue);
    second.close();
  });

  // -------------------------------------------------------------------------
  // queue.schedule (T028) — explicit tomorrow / next-week / next-month / manual.
  // -------------------------------------------------------------------------

  it("scheduleQueueItem pins an attention item to an explicit future return (T028)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const extract = svc.repos.elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.625,
      title: "Schedulable extract",
      dueAt: "2020-01-01T00:00:00.000Z",
    });

    const before = Date.now();
    const res = svc.scheduleQueueItem({ id: extract.id, choice: { kind: "nextWeek" } });
    expect(res.intervalDays).toBe(7);
    expect(Date.parse(res.dueAt)).toBeGreaterThan(before);
    // It recedes from the due set (a future date), so no in-place row comes back.
    expect(res.item).toBeNull();

    // Persisted: status `scheduled`, the new due ~7 days out.
    const persisted = svc.repos.elements.findById(extract.id);
    expect(persisted?.status).toBe("scheduled");
    expect(persisted?.dueAt).toBe(res.dueAt);
    const days = Math.round((Date.parse(res.dueAt) - before) / 86_400_000);
    expect(days).toBe(7);

    svc.close();
  });

  it("scheduleQueueItem normalizes a manual date to canonical ISO (T028)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const extract = svc.repos.elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.625,
      title: "Manually scheduled extract",
    });

    const res = svc.scheduleQueueItem({
      id: extract.id,
      choice: { kind: "manual", date: "2026-07-01T09:00:00Z" },
    });
    expect(res.dueAt).toBe("2026-07-01T09:00:00.000Z");
    expect(svc.repos.elements.findById(extract.id)?.status).toBe("scheduled");

    svc.close();
  });

  it("scheduleQueueItem REJECTS a card — cards schedule on FSRS, not the attention seam (T028)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { extractId } = seedSourceAndExtract(svc);
    const { card } = svc.createCard({
      extractId,
      kind: "qa",
      prompt: "What is intelligence?",
      answer: "Skill-acquisition efficiency.",
    });
    expect(() => svc.scheduleQueueItem({ id: card.id, choice: { kind: "tomorrow" } })).toThrow(
      /card/i,
    );
    svc.close();
  });

  it("an explicitly-scheduled item survives a full close + reopen (T028 restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const extract = first.repos.elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.625,
      title: "Durably scheduled",
      dueAt: "2020-01-01T00:00:00.000Z",
    });
    const { dueAt } = first.scheduleQueueItem({ id: extract.id, choice: { kind: "nextMonth" } });
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const reopened = second.repos.elements.findById(extract.id);
    expect(reopened?.status).toBe("scheduled");
    expect(reopened?.dueAt).toBe(dueAt);
    second.close();
  });

  // -------------------------------------------------------------------------
  // cards.create (T032) — author a card from an extract (the M6 keystone).
  // -------------------------------------------------------------------------

  /** Seed a source + an extract anchored at its first block; return both ids. */
  function seedSourceAndExtract(svc: DbService): { extractId: string; sourceId: string } {
    const { id: sourceId } = svc.importManualSource({
      title: "On the Measure of Intelligence",
      priority: "A",
      body: "The definition paragraph.\n\nAnother paragraph.",
    });
    const blockId = (
      svc.raw.sqlite
        .prepare("SELECT stable_block_id AS b FROM document_blocks WHERE document_id = ? LIMIT 1")
        .get(sourceId) as { b: string }
    ).b;
    const { extract } = svc.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph.",
      blockIds: [blockId],
      startOffset: 0,
      endOffset: 25,
    });
    return { extractId: extract.id, sourceId };
  }

  function blockRowsFor(svc: DbService, sourceId: string): { id: string; order: number }[] {
    return svc.raw.sqlite
      .prepare(
        'SELECT stable_block_id AS id, "order" FROM document_blocks WHERE document_id = ? ORDER BY "order"',
      )
      .all(sourceId) as { id: string; order: number }[];
  }

  function expectZeroBlockProcessingSummary(
    result: BlockProcessingListResult | BlockProcessingSummaryResult,
    sourceElementId: string,
  ) {
    expect(result.summary).toMatchObject({
      sourceElementId,
      totalBlocks: 0,
      processedBlocks: 0,
      terminalBlocks: 0,
      unresolvedBlocks: 0,
      highPriorityUnresolvedBlocks: 0,
      extractedBlockCount: 0,
      extractedOutputCount: 0,
      ignoredBlocks: 0,
      ignoredRatio: 0,
      terminalRatio: 1,
      staleAfterEditBlocks: 0,
      legacyProjectedBlocks: 0,
      canMarkDoneWithoutConfirmation: true,
      stateCounts: {
        unread: 0,
        read: 0,
        extracted: 0,
        ignored: 0,
        processed_without_output: 0,
        needs_later: 0,
        stale_after_edit: 0,
      },
    });
  }

  it("block processing persists across reopen and turns stale after a source edit", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { id: sourceId } = first.importManualSource({
      title: "Block processing source",
      priority: "A",
      body: "First paragraph.\n\nSecond paragraph.",
    });
    const blocks = blockRowsFor(first, sourceId);

    expect(first.listBlockProcessing({ sourceElementId: sourceId }).summary).toMatchObject({
      totalBlocks: 2,
      processedBlocks: 0,
      unresolvedBlocks: 2,
    });
    first.markBlockProcessed({ sourceElementId: sourceId, stableBlockId: blocks[0]?.id ?? "" });
    expect(first.getBlockProcessingSummary({ sourceElementId: sourceId }).summary).toMatchObject({
      processedBlocks: 1,
      unresolvedBlocks: 1,
    });
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(second.getBlockProcessingSummary({ sourceElementId: sourceId }).summary).toMatchObject({
      processedBlocks: 1,
      unresolvedBlocks: 1,
    });

    second.saveDocument({
      elementId: sourceId,
      prosemirrorJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { blockId: blocks[0]?.id },
            content: [{ type: "text", text: "First paragraph, edited." }],
          },
          {
            type: "paragraph",
            attrs: { blockId: blocks[1]?.id },
            content: [{ type: "text", text: "Second paragraph." }],
          },
        ],
      },
      plainText: "First paragraph, edited.\n\nSecond paragraph.",
      blocks: blocks.map((block) => ({
        blockType: "paragraph",
        order: block.order,
        stableBlockId: block.id,
      })),
    });
    expect(second.listBlockProcessing({ sourceElementId: sourceId }).blocks[0]?.state).toBe(
      "stale_after_edit",
    );
    second.close();
  });

  it("read-only block processing requests return empty results for missing, deleted, and non-source ids", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const missingId = "el_missing_block_processing_source";

    const { id: deletedSourceId } = svc.importManualSource({
      title: "Deleted block processing source",
      priority: "A",
      body: "Already processed paragraph.\n\nUnprocessed paragraph.",
    });
    const deletedBlocks = blockRowsFor(svc, deletedSourceId);
    svc.markBlockProcessed({
      sourceElementId: deletedSourceId,
      stableBlockId: deletedBlocks[0]?.id ?? "",
    });
    svc.repos.elements.softDelete(deletedSourceId as ElementId);

    const nonSource = svc.repos.elements.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.625,
      title: "Not a source",
    });

    for (const sourceElementId of [missingId, deletedSourceId, nonSource.id]) {
      const listResult = svc.listBlockProcessing({ sourceElementId });
      expect(listResult.blocks).toEqual([]);
      expectZeroBlockProcessingSummary(listResult, sourceElementId);
      expectZeroBlockProcessingSummary(
        svc.getBlockProcessingSummary({ sourceElementId }),
        sourceElementId,
      );
    }

    svc.close();
  });

  it("block processing mutations still reject missing, deleted, non-source, and wrong-source blocks", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const { id: liveSourceId } = svc.importManualSource({
      title: "Live block processing source",
      priority: "B",
      body: "Live source paragraph.",
    });
    const { id: otherSourceId } = svc.importManualSource({
      title: "Other block processing source",
      priority: "B",
      body: "Other source paragraph.",
    });
    const { id: deletedSourceId } = svc.importManualSource({
      title: "Deleted strict block processing source",
      priority: "B",
      body: "Deleted source paragraph.",
    });
    const liveBlockId = blockRowsFor(svc, liveSourceId)[0]?.id ?? "";
    const otherBlockId = blockRowsFor(svc, otherSourceId)[0]?.id ?? "";
    const deletedBlockId = blockRowsFor(svc, deletedSourceId)[0]?.id ?? "";
    svc.repos.elements.softDelete(deletedSourceId as ElementId);
    const nonSource = svc.repos.elements.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.625,
      title: "Not a source",
    });

    const processingRowsBefore = (
      svc.raw.sqlite.prepare("SELECT COUNT(*) AS count FROM source_block_processing").get() as {
        count: number;
      }
    ).count;
    const operationRowsBefore = (
      svc.raw.sqlite.prepare("SELECT COUNT(*) AS count FROM operation_log").get() as {
        count: number;
      }
    ).count;
    const markMethods = [
      svc.markBlockIgnored.bind(svc),
      svc.markBlockProcessed.bind(svc),
      svc.markBlockNeedsLater.bind(svc),
      svc.markBlockUnread.bind(svc),
    ];

    for (const mark of markMethods) {
      expect(() =>
        mark({ sourceElementId: "el_missing_block_processing_source", stableBlockId: liveBlockId }),
      ).toThrow(/source .* not found/);
      expect(() =>
        mark({ sourceElementId: deletedSourceId, stableBlockId: deletedBlockId }),
      ).toThrow(/source .* not found/);
      expect(() => mark({ sourceElementId: nonSource.id, stableBlockId: liveBlockId })).toThrow(
        /source .* not found/,
      );
      expect(() => mark({ sourceElementId: liveSourceId, stableBlockId: otherBlockId })).toThrow(
        /does not belong to source/,
      );
    }

    expect(
      (
        svc.raw.sqlite.prepare("SELECT COUNT(*) AS count FROM source_block_processing").get() as {
          count: number;
        }
      ).count,
    ).toBe(processingRowsBefore);
    expect(
      (
        svc.raw.sqlite.prepare("SELECT COUNT(*) AS count FROM operation_log").get() as {
          count: number;
        }
      ).count,
    ).toBe(operationRowsBefore);

    svc.close();
  });

  it("createCard (qa) maps the A/B/C/D label → numeric priority and round-trips lineage (T032)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { extractId, sourceId } = seedSourceAndExtract(svc);

    const result = svc.createCard({
      extractId,
      kind: "qa",
      prompt: "How does Chollet define intelligence?",
      answer: "As skill-acquisition efficiency over a scope of tasks.",
      priority: "A", // label → numeric mapping happens main-side
    });

    // The card summary carries the lineage + the mapped numeric priority. The
    // authored card is first-scheduled into active rotation (T036), so it can be
    // reviewed straight away.
    expect(result.card.kind).toBe("qa");
    expect(result.card.stage).toBe("active_card");
    expect(result.card.status).toBe("active");
    expect(result.card.priority).toBe(0.875); // "A"
    expect(result.card.parentId).toBe(extractId);
    expect(result.card.sourceId).toBe(sourceId);
    expect(result.card.siblingGroupId).toBeTruthy();
    // The extract has a source-location anchor, so the card inherited it.
    expect(result.sourceLocationId).toBeTruthy();

    // The cards row was written with the inherited anchor.
    const cardRow = svc.repos.review.findCardById(result.card.id as never);
    expect(cardRow?.card.kind).toBe("qa");
    expect(cardRow?.card.sourceLocationId).toBe(result.sourceLocationId);

    // The review_states row exists and is first-scheduled DUE (so the card enters
    // the deck) but still fsrsState "new" — the first grade runs the interval math.
    const rs = svc.repos.review.findReviewState(result.card.id as never);
    expect(rs?.dueAt).not.toBeNull();
    expect(rs?.fsrsState).toBe("new");

    svc.close();
  });

  it("a freshly authored card enters the review session deck with no prior grade (T036 first-schedule)", () => {
    // Regression guard for the core-loop gap: an authored card must be first-
    // scheduled so it actually surfaces in /review. Walk the SAME `session.next`
    // seam the renderer uses — no direct grade, no manual due-date poke. Before the
    // fix the card was parked un-due and never appeared here.
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { extractId } = seedSourceAndExtract(svc);

    const { card } = svc.createCard({
      extractId,
      kind: "qa",
      prompt: "What enters the deck?",
      answer: "A freshly authored card.",
    });

    // It is due now (created with a real dueAt) and surfaces via the session seam.
    const asOf = "2099-01-01T00:00:00.000Z";
    const seen: string[] = [];
    let found = false;
    for (let i = 0; i < 200; i++) {
      const res = svc.reviewSessionNext({ asOf, exclude: seen });
      if (!res.card) break;
      if (res.card.id === card.id) {
        found = true;
        break;
      }
      seen.push(res.card.id);
    }
    expect(found).toBe(true);

    // And it can be graded straight away (the first grade runs the real FSRS math),
    // advancing the FSRS state out of "new" and writing a durable review log.
    const before = svc.repos.review.listReviewLogs(card.id as never).length;
    const graded = svc.gradeCard(card.id as never, "good", 1200, asOf);
    expect(graded.reviewState.reps).toBe(1);
    expect(graded.reviewState.fsrsState).not.toBe("new");
    expect(svc.repos.review.listReviewLogs(card.id as never).length).toBe(before + 1);

    svc.close();
  });

  it("createCard (cloze) stores the canonical cloze text and groups a sibling pair (T032)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { extractId } = seedSourceAndExtract(svc);

    const qa = svc.createCard({ extractId, kind: "qa", prompt: "Q?", answer: "A." });
    const cloze = svc.createCard({
      extractId,
      kind: "cloze",
      cloze: "Intelligence is {{c1::skill-acquisition efficiency}}.",
      siblingGroupId: qa.card.siblingGroupId, // thread the prior sibling's group id
    });

    // The cloze card stores the canonical numbered text.
    const clozeRow = svc.repos.review.findCardById(cloze.card.id as never);
    expect(clozeRow?.card.cloze).toContain("{{c1::skill-acquisition efficiency}}");
    // Both cards joined the SAME sibling group.
    expect(cloze.card.siblingGroupId).toBe(qa.card.siblingGroupId);

    svc.close();
  });

  it("createCard (multi-cloze) persists a cloze document_mark per deletion, listable via the bridge (T034)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { extractId } = seedSourceAndExtract(svc);

    const { card } = svc.createCard({
      extractId,
      kind: "cloze",
      cloze: "Memory moves from the {{c1::hippocampus}} to the {{c2::neocortex}}.",
    });

    // The renderer-facing read path returns the two cloze marks, each tagged with
    // its clozeIndex, keyed by the card's stable block id (re-anchorable on render).
    const { marks } = svc.listDocumentMarks({ elementId: card.id, markType: "cloze" });
    expect(marks.length).toBe(2);
    const indices = marks
      .map((m) => (m.attrs as { clozeIndex?: number } | null)?.clozeIndex)
      .sort();
    expect(indices).toEqual([1, 2]);
    // All marks anchor to the SAME (single) block id.
    expect(new Set(marks.map((m) => m.blockId)).size).toBe(1);

    svc.close();
  });

  it("a cloze card + its marks survive a full close + reopen (T034 restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { extractId } = seedSourceAndExtract(first);
    const { card } = first.createCard({
      extractId,
      kind: "cloze",
      cloze: "Both {{c1::cats}} and {{c2::dogs}} are mammals.",
    });
    const cardId = card.id;
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const reopened = second.repos.review.findCardById(cardId as never);
    expect(reopened?.card.kind).toBe("cloze");
    expect(reopened?.card.cloze).toBe("Both {{c1::cats}} and {{c2::dogs}} are mammals.");
    const { marks } = second.listDocumentMarks({ elementId: cardId, markType: "cloze" });
    expect(marks.length).toBe(2);
    second.close();
  });

  it("createCard rejects an unknown / soft-deleted extract (T032)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    expect(() =>
      svc.createCard({ extractId: "el_missing", kind: "qa", prompt: "Q?", answer: "A." }),
    ).toThrow(/not found/);

    svc.close();
  });

  it("a created card survives a full close + reopen with lineage intact (T032 restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { extractId, sourceId } = seedSourceAndExtract(first);
    const { card } = first.createCard({
      extractId,
      kind: "qa",
      prompt: "Durable prompt?",
      answer: "Durable answer.",
    });
    const cardId = card.id;
    first.close();

    // A brand-new service opening the SAME file must see the card + its lineage.
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const reopened = second.repos.review.findCardById(cardId as never);
    expect(reopened?.element.type).toBe("card");
    expect(reopened?.element.stage).toBe("active_card");
    expect(reopened?.element.parentId).toBe(extractId);
    expect(reopened?.element.sourceId).toBe(sourceId);
    expect(reopened?.card.prompt).toBe("Durable prompt?");
    expect(reopened?.card.answer).toBe("Durable answer.");
    // First-scheduled due, and that survives the restart (FSRS scheduling is M7).
    const rs = second.repos.review.findReviewState(cardId as never);
    expect(rs?.dueAt).not.toBeNull();
    expect(rs?.fsrsState).toBe("new");
    second.close();
  });
});

// ---------------------------------------------------------------------------
// Review session (T037) — the FSRS review loop over the typed surface.
// ---------------------------------------------------------------------------

describe("DbService — review session (T037)", () => {
  /** A future clock so the seeded Q&A card (dueAt 2026-06-03) reads as due. */
  const ASOF = "2027-06-01T12:00:00.000Z";

  /**
   * The seeded due Q&A card id (it has two reviews → a real future dueAt). Excludes
   * the seeded LEECH card (also a Q&A) so this is deterministic — the leech is the
   * cleanup view's fixture (T040), not the plain review fixture.
   */
  function seededDueCardId(svc: DbService): string {
    const row = svc.raw.sqlite
      .prepare(
        `SELECT e.id AS id FROM elements e
         JOIN cards c ON c.element_id = e.id
         WHERE c.kind = 'qa' AND c.is_leech = 0 AND e.deleted_at IS NULL LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (!row) throw new Error("seeded Q&A card not found");
    return row.id;
  }

  /** The ids of all due cards in the FSRS deck at `asOf` (walks the session). */
  function dueDeckIds(svc: DbService, asOf: string): string[] {
    const ids: string[] = [];
    // Walk the deck via `session.next({ exclude })` until it is exhausted (the same
    // seam the renderer uses); bounded so a bug can never loop forever.
    for (let i = 0; i < 500; i++) {
      const res = svc.reviewSessionNext({ asOf, exclude: ids });
      if (!res.card) break;
      ids.push(res.card.id);
    }
    return ids;
  }

  it("reviewSessionNext returns the due card carrying the full card view (cards only)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const res = svc.reviewSessionNext({ asOf: ASOF });
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(res.card).not.toBeNull();
    const card = res.card;
    if (!card) throw new Error("no card");
    // The deck is FSRS cards only — never an extract/source.
    expect(card.kind === "qa" || card.kind === "cloze").toBe(true);
    expect(card.schedulerSignals.kind).toBe("fsrs");
    expect(typeof card.prompt).toBe("string");
    expect(card.prompt.length).toBeGreaterThan(0);
    // The load-bearing M7 contract: the reveal payload + lineage RIDE with the
    // card so reveal needs no DB round-trip. A Q&A card ships a non-empty
    // `answer`; a cloze card ships non-empty `cloze` text. Whichever it is, the
    // card carries its source lineage (resolved sourceRef + provenance title).
    if (card.kind === "qa") {
      expect(typeof card.answer).toBe("string");
      expect((card.answer ?? "").length).toBeGreaterThan(0);
    } else {
      expect(typeof card.cloze).toBe("string");
      expect((card.cloze ?? "").length).toBeGreaterThan(0);
    }
    // Source lineage rides with the card (card → source location → source).
    expect(card.sourceRef).not.toBeNull();
    expect(card.sourceTitle).not.toBeNull();

    svc.close();
  });

  it("reviewCard fetches ONE card's full reveal-ready view by id (T031 inline reveal)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);

    // Fetch the SAME reveal-ready view by id (not soonest-due) — what the process
    // loop needs to reveal the card under its frozen-order cursor.
    const { card } = svc.reviewCard({ cardId, asOf: ASOF });
    expect(card).not.toBeNull();
    if (!card) throw new Error("no card");
    expect(card.id).toBe(cardId);
    expect(card.schedulerSignals.kind).toBe("fsrs");
    expect(typeof card.prompt).toBe("string");
    expect(card.prompt.length).toBeGreaterThan(0);
    // It carries the full reveal payload (a Q&A card ships a non-empty answer).
    expect(typeof card.answer).toBe("string");
    expect((card.answer ?? "").length).toBeGreaterThan(0);

    // PURE: no review log was written by the fetch (it is read-only).
    const before = svc.repos.review.listReviewLogs(cardId as never).length;
    svc.reviewCard({ cardId, asOf: ASOF });
    expect(svc.repos.review.listReviewLogs(cardId as never).length).toBe(before);

    // A non-card / unknown id yields `null` (never an attention element).
    expect(svc.reviewCard({ cardId: "elem_does_not_exist", asOf: ASOF }).card).toBeNull();

    svc.close();
  });

  it("reviewCard carries the expiry block for an expired seeded card and null for a fresh one (T090)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    // The seeded Q&A card carries a PAST valid_until/review_by (2020) → expired.
    const expiredId = seededDueCardId(svc);
    const { card } = svc.reviewCard({ cardId: expiredId, asOf: ASOF });
    expect(card?.expiry).not.toBeNull();
    expect(card?.expiry?.status).toBe("expired");
    expect(card?.expiry?.validUntil).toBe("2020-01-01");
    expect(card?.expiry?.jurisdiction).toBe("global");

    // A brand-new card with no lifetime carries `expiry: null` (no banner).
    const fresh = svc.repos.review.createCard({
      kind: "qa",
      title: "No-lifetime card",
      priority: 0.5,
      prompt: "q",
      answer: "a",
    });
    const { card: freshView } = svc.reviewCard({ cardId: fresh.element.id, asOf: ASOF });
    expect(freshView?.expiry).toBeNull();

    svc.close();
  });

  it("setCardLifetime round-trips the six fields (one update_element) and the inspector reads the derived status (T090)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);

    const opsBefore = svc.repos.operationLog
      .listForElement(cardId as never)
      .filter((o) => o.opType === "update_element").length;

    const res = svc.setCardLifetime({
      cardId,
      factStability: "volatile",
      validUntil: "2099-01-01",
      reviewBy: "2099-01-01",
      jurisdiction: "EU",
      softwareVersion: "React 19",
    });
    // Future dates → the derived status is fresh now.
    expect(res.lifetime.status).toBe("fresh");
    expect(res.lifetime.factStability).toBe("volatile");
    expect(res.lifetime.softwareVersion).toBe("React 19");

    // Exactly one new update_element op (no new op type).
    const opsAfter = svc.repos.operationLog
      .listForElement(cardId as never)
      .filter((o) => o.opType === "update_element").length;
    expect(opsAfter).toBe(opsBefore + 1);

    // The inspector reflects the new lifetime + derived status.
    const data = svc.getInspectorData(cardId).data;
    expect(data?.lifetime?.factStability).toBe("volatile");
    expect(data?.lifetime?.validUntil).toBe("2099-01-01");
    expect(data?.lifetime?.status).toBe("fresh");

    // Survives a service close + reopen (the unit-level "app restart").
    svc.close();
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const after = second.getInspectorData(cardId).data;
    expect(after?.lifetime?.softwareVersion).toBe("React 19");
    expect(after?.lifetime?.jurisdiction).toBe("EU");
    second.close();
  });

  it("reviewPreview returns four ordered intervals and mutates nothing", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);

    const before = svc.repos.review.findReviewState(cardId as never);
    const { intervals } = svc.reviewPreview({ cardId, asOf: ASOF });
    expect(intervals).not.toBeNull();
    if (!intervals) throw new Error("no intervals");
    // Non-decreasing scheduled days across again → hard → good → easy.
    expect(intervals.again.scheduledDays).toBeLessThanOrEqual(intervals.hard.scheduledDays);
    expect(intervals.hard.scheduledDays).toBeLessThanOrEqual(intervals.good.scheduledDays);
    expect(intervals.good.scheduledDays).toBeLessThanOrEqual(intervals.easy.scheduledDays);
    // Each carries a human label.
    expect(intervals.good.label.length).toBeGreaterThan(0);
    // PURE: the persisted state is unchanged by a preview.
    const after = svc.repos.review.findReviewState(cardId as never);
    expect(after?.dueAt).toBe(before?.dueAt);
    expect(after?.reps).toBe(before?.reps);

    svc.close();
  });

  it("reviewGrade advances review_states, appends one review_logs row, logs add_review_log", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);

    const beforeState = svc.repos.review.findReviewState(cardId as never);
    const beforeLogs = svc.repos.review.listReviewLogs(cardId as never).length;
    const beforeOps = svc.raw.sqlite
      .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'add_review_log'")
      .get() as { n: number };

    const result = svc.reviewGrade({
      cardId,
      rating: "good",
      promptMs: 1400,
      responseMs: 3200,
      asOf: ASOF,
    });

    // The durable review log was written with the prompt time, response time, and rating.
    expect(result.reviewLog.rating).toBe("good");
    expect(result.reviewLog.promptMs).toBe(1400);
    expect(result.reviewLog.responseMs).toBe(3200);
    expect(result.reviewLog.elementId).toBe(cardId);

    // Exactly one new review_logs row.
    const afterLogs = svc.repos.review.listReviewLogs(cardId as never);
    expect(afterLogs).toHaveLength(beforeLogs + 1);
    expect(afterLogs[0]?.promptMs).toBe(1400);

    // review_states advanced: reps incremented, dueAt moved forward, elements.dueAt synced.
    const afterState = svc.repos.review.findReviewState(cardId as never);
    expect(afterState?.reps).toBe((beforeState?.reps ?? 0) + 1);
    expect(afterState?.dueAt).toBe(result.reviewState.dueAt);
    expect(afterState?.lastReviewedAt).toBe(ASOF);
    const cardEl = svc.repos.elements.findById(cardId as never);
    expect(cardEl?.dueAt).toBe(result.reviewState.dueAt);

    // Exactly one new add_review_log operation-log entry (one transaction).
    const afterOps = svc.raw.sqlite
      .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'add_review_log'")
      .get() as { n: number };
    expect(afterOps.n).toBe(beforeOps.n + 1);

    svc.close();
  });

  it("reviewGrade records zero promptMs from a normalized legacy IPC request", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);

    const result = svc.reviewGrade({
      cardId,
      rating: "good",
      promptMs: 0,
      responseMs: 2100,
      asOf: ASOF,
    });

    expect(result.reviewLog.promptMs).toBe(0);
    expect(svc.repos.review.listReviewLogs(cardId as never)[0]?.promptMs).toBe(0);

    svc.close();
  });

  it("grades across all four ratings produce ordered next intervals (again < good < easy)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);

    // Read the four previews up front (pure) and assert the ordering FSRS guarantees.
    const { intervals } = svc.reviewPreview({ cardId, asOf: ASOF });
    if (!intervals) throw new Error("no intervals");
    expect(intervals.again.scheduledDays).toBeLessThan(intervals.easy.scheduledDays);
    expect(intervals.again.scheduledDays).toBeLessThanOrEqual(intervals.good.scheduledDays);

    // Grading 'again' increments lapses (a failed review).
    const lapsesBefore = svc.repos.review.findReviewState(cardId as never)?.lapses ?? 0;
    svc.reviewGrade({ cardId, rating: "again", promptMs: 0, responseMs: 8000, asOf: ASOF });
    const lapsesAfter = svc.repos.review.findReviewState(cardId as never)?.lapses ?? 0;
    expect(lapsesAfter).toBe(lapsesBefore + 1);

    svc.close();
  });

  it("the rescheduling survives a close + reopen (restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(first.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(first);
    const { reviewState } = first.reviewGrade({
      cardId,
      rating: "good",
      promptMs: 0,
      responseMs: 2100,
      asOf: ASOF,
    });
    const persistedDue = reviewState.dueAt;
    first.close();

    // A brand-new service on the SAME file sees the advanced due date + the log.
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const state = second.repos.review.findReviewState(cardId as never);
    expect(state?.dueAt).toBe(persistedDue);
    expect(second.repos.review.listReviewLogs(cardId as never).length).toBeGreaterThan(0);
    second.close();
  });

  it("reviewGrade rejects a non-card element (FSRS is cards only)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const extract = svc.raw.sqlite
      .prepare("SELECT id FROM elements WHERE type = 'extract' AND deleted_at IS NULL LIMIT 1")
      .get() as { id: string } | undefined;
    expect(extract).toBeDefined();
    expect(() =>
      svc.reviewGrade({
        cardId: extract?.id ?? "",
        rating: "good",
        promptMs: 0,
        responseMs: 100,
        asOf: ASOF,
      }),
    ).toThrow();
    svc.close();
  });

  it("reviewGrade throws on a garbage asOf clock — never persists an Invalid Date", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);

    const beforeState = svc.repos.review.findReviewState(cardId as never);
    const beforeLogs = svc.repos.review.listReviewLogs(cardId as never).length;

    // The IPC contract rejects this; the scheduler-side `toClock` guard is the
    // matching defense so even a bypassed call can never write an Invalid Date.
    for (const asOf of ["not-a-date", "", "yesterday"]) {
      expect(() =>
        svc.reviewGrade({ cardId, rating: "good", promptMs: 0, responseMs: 100, asOf }),
      ).toThrow();
    }

    // Nothing was mutated: no Invalid Date in review_states/elements.due_at, no log row.
    const afterState = svc.repos.review.findReviewState(cardId as never);
    expect(afterState?.dueAt).toBe(beforeState?.dueAt);
    expect(afterState?.reps).toBe(beforeState?.reps);
    expect(svc.repos.review.listReviewLogs(cardId as never).length).toBe(beforeLogs);
    const cardEl = svc.repos.elements.findById(cardId as never);
    // A valid (or null) due date — never the literal "Invalid Date".
    expect(cardEl?.dueAt === null || !Number.isNaN(Date.parse(cardEl?.dueAt ?? ""))).toBe(true);

    svc.close();
  });

  it("reviewSessionNext caps the session at the dailyReviewBudget setting", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    // There is at least one due card unbounded.
    expect(svc.reviewSessionNext({ asOf: ASOF }).total).toBeGreaterThanOrEqual(1);

    // Pin the budget to its minimum (10) so the cap is exercised deterministically
    // without seeding hundreds of cards. The budget bounds the WHOLE session, so
    // the surfaceable remainder is `budget − seen`.
    svc.updateAppSettings({ dailyReviewBudget: 10 });
    expect(svc.getAppSettings().settings.dailyReviewBudget).toBe(10);

    // With 9 cards already seen this session, the cap leaves room for exactly one
    // more card to surface — the seeded due card still appears.
    const seen9 = Array.from({ length: 9 }, (_, i) => `seen-card-${i}`);
    const withRoom = svc.reviewSessionNext({ asOf: ASOF, exclude: seen9 });
    expect(withRoom.card).not.toBeNull();
    expect(withRoom.total).toBe(1);
    expect(withRoom.remaining).toBe(0);

    // Once the budget is fully consumed (10 seen), no further card is surfaced even
    // though the FSRS due deck is non-empty — the budget is the deck cap.
    const seen10 = Array.from({ length: 10 }, (_, i) => `seen-card-${i}`);
    const exhausted = svc.reviewSessionNext({ asOf: ASOF, exclude: seen10 });
    expect(exhausted.card).toBeNull();
    expect(exhausted.total).toBe(0);
    expect(exhausted.remaining).toBe(0);

    svc.close();
  });

  // --- T039: sibling burying in the review session ---

  /**
   * Create a due Q&A card and return its id. Built via the low-level
   * `ReviewRepository.createCard` (no first-schedule), so we set
   * `review_states.due_at` to an explicit date so it enters the FSRS deck at `ASOF`.
   */
  function seedDueCard(svc: DbService, title: string, dueAt: string): string {
    const { element } = svc.repos.review.createCard({
      kind: "qa",
      title,
      priority: 0.625,
      prompt: `${title}?`,
      answer: `${title}.`,
      stage: "active_card",
    });
    svc.raw.sqlite
      .prepare("UPDATE review_states SET due_at = ? WHERE element_id = ?")
      .run(dueAt, element.id);
    return element.id;
  }

  it("buries siblings: two cards from one group are never returned back-to-back", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    // Fresh DB (no seed) so the deck is exactly these three cards.
    const sib1 = seedDueCard(svc, "Sibling 1", "2027-05-01T00:00:00.000Z");
    const sib2 = seedDueCard(svc, "Sibling 2", "2027-05-01T00:00:01.000Z");
    const other = seedDueCard(svc, "Unrelated", "2027-05-01T00:00:02.000Z");
    svc.repos.elements.addRelation({
      fromElementId: sib1 as never,
      toElementId: sib2 as never,
      relationType: "sibling_group",
      siblingGroupId: "sib_group_test" as never,
    });
    svc.repos.elements.addRelation({
      fromElementId: sib2 as never,
      toElementId: sib1 as never,
      relationType: "sibling_group",
      siblingGroupId: "sib_group_test" as never,
    });

    // First card: the soonest-due sibling (and it carries its group id forward).
    const first = svc.reviewSessionNext({ asOf: ASOF });
    expect(first.card?.id).toBe(sib1);
    expect(first.card?.siblingGroupId).toBe("sib_group_test");

    // Next: sib1's group is "recent" → sib2 is buried; the unrelated card surfaces
    // even though sib2 is due sooner.
    const second = svc.reviewSessionNext({
      asOf: ASOF,
      exclude: [sib1],
      recentSiblingGroups: [first.card?.siblingGroupId ?? ""],
    });
    expect(second.card?.id).toBe(other);
    expect(second.card?.siblingGroupId).toBeNull();

    svc.close();
  });

  it("disabling burySiblings restores adjacency (natural due order)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const sib1 = seedDueCard(svc, "Sibling 1", "2027-05-01T00:00:00.000Z");
    const sib2 = seedDueCard(svc, "Sibling 2", "2027-05-01T00:00:01.000Z");
    seedDueCard(svc, "Unrelated", "2027-05-01T00:00:02.000Z");
    for (const [from, to] of [
      [sib1, sib2],
      [sib2, sib1],
    ] as const) {
      svc.repos.elements.addRelation({
        fromElementId: from as never,
        toElementId: to as never,
        relationType: "sibling_group",
        siblingGroupId: "sib_group_test" as never,
      });
    }

    // Persist the setting OFF — the session reads it when the request omits the flag.
    svc.updateAppSettings({ burySiblings: false });
    expect(svc.getAppSettings().settings.burySiblings).toBe(false);

    const first = svc.reviewSessionNext({ asOf: ASOF });
    expect(first.card?.id).toBe(sib1);
    // Burying OFF → sib2 (next soonest) is adjacent to sib1 despite the recent group.
    const second = svc.reviewSessionNext({
      asOf: ASOF,
      exclude: [sib1],
      recentSiblingGroups: [first.card?.siblingGroupId ?? ""],
    });
    expect(second.card?.id).toBe(sib2);

    svc.close();
  });

  it("the persisted burySiblings setting drives the default (no per-request flag)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const sib1 = seedDueCard(svc, "Sibling 1", "2027-05-01T00:00:00.000Z");
    const sib2 = seedDueCard(svc, "Sibling 2", "2027-05-01T00:00:01.000Z");
    const other = seedDueCard(svc, "Unrelated", "2027-05-01T00:00:02.000Z");
    for (const [from, to] of [
      [sib1, sib2],
      [sib2, sib1],
    ] as const) {
      svc.repos.elements.addRelation({
        fromElementId: from as never,
        toElementId: to as never,
        relationType: "sibling_group",
        siblingGroupId: "sib_group_test" as never,
      });
    }

    // Setting defaults ON: with no per-request flag, sib2 is buried after sib1.
    const first = svc.reviewSessionNext({ asOf: ASOF });
    const buriedSecond = svc.reviewSessionNext({
      asOf: ASOF,
      exclude: [sib1],
      recentSiblingGroups: [first.card?.siblingGroupId ?? ""],
    });
    expect(buriedSecond.card?.id).toBe(other);

    svc.close();
  });

  // --- T038: in-review card repair (edit / suspend / delete / flag) ---

  it("updateCard edits the Q&A body, logs update_element, and preserves lineage + review state", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);

    const beforeState = svc.repos.review.findReviewState(cardId as never);
    const beforeLogs = svc.repos.review.listReviewLogs(cardId as never).length;
    const beforeLocation = svc.repos.review.findCardById(cardId as never)?.card.sourceLocationId;
    const beforeOps = (
      svc.raw.sqlite
        .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'update_element'")
        .get() as { n: number }
    ).n;

    const result = svc.updateCard({
      cardId,
      prompt: "Edited prompt at the moment of failure?",
      answer: "Edited answer.",
    });

    // The body changed; lineage (source-location anchor) is intact.
    expect(result.card.prompt).toBe("Edited prompt at the moment of failure?");
    expect(result.card.answer).toBe("Edited answer.");
    const after = svc.repos.review.findCardById(cardId as never);
    expect(after?.card.prompt).toBe("Edited prompt at the moment of failure?");
    expect(after?.card.sourceLocationId).toBe(beforeLocation);
    expect(beforeLocation).toBeTruthy();

    // The FSRS review state + the append-only logs are NOT touched by an edit.
    const afterState = svc.repos.review.findReviewState(cardId as never);
    expect(afterState?.dueAt).toBe(beforeState?.dueAt);
    expect(afterState?.reps).toBe(beforeState?.reps);
    expect(svc.repos.review.listReviewLogs(cardId as never).length).toBe(beforeLogs);

    // Exactly one new update_element op (one transaction).
    const afterOps = (
      svc.raw.sqlite
        .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'update_element'")
        .get() as { n: number }
    ).n;
    expect(afterOps).toBe(beforeOps + 1);

    svc.close();
  });

  it("updateCard rejects emptying a Q&A card's required fields", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);
    expect(() => svc.updateCard({ cardId, prompt: "" })).toThrow();
    svc.close();
  });

  it("suspendCard sets status suspended and drops the card out of the due deck", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);

    // The card is in the due deck before suspending.
    const before = dueDeckIds(svc, ASOF);
    expect(before).toContain(cardId);

    const result = svc.suspendCard({ cardId });
    expect(result.card.status).toBe("suspended");
    expect(svc.repos.elements.findById(cardId as never)?.status).toBe("suspended");

    // It no longer appears in the due-card deck (dueCards excludes suspended).
    const after = dueDeckIds(svc, ASOF);
    expect(after).not.toContain(cardId);
    // But its review state + logs survive (recoverable).
    expect(svc.repos.review.findReviewState(cardId as never)).not.toBeNull();

    svc.close();
  });

  it("deleteCard soft-deletes (status deleted, deletedAt set) and logs soft_delete_element", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);

    const beforeOps = (
      svc.raw.sqlite
        .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'soft_delete_element'")
        .get() as { n: number }
    ).n;

    const result = svc.deleteCard({ cardId });
    expect(result.card.status).toBe("deleted");
    expect(result.card.deleted).toBe(true);
    const el = svc.repos.elements.findById(cardId as never);
    expect(el?.status).toBe("deleted");
    expect(el?.deletedAt).toBeTruthy();

    const afterOps = (
      svc.raw.sqlite
        .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'soft_delete_element'")
        .get() as { n: number }
    ).n;
    expect(afterOps).toBe(beforeOps + 1);

    svc.close();
  });

  it("flagCard toggles a non-destructive flag (via update_element) without destroying the card", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);

    const beforeOps = (
      svc.raw.sqlite
        .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'update_element'")
        .get() as { n: number }
    ).n;

    const flagged = svc.flagCard({ cardId, flagged: true, reason: "ambiguous pronoun" });
    expect(flagged.card.flagged).toBe(true);
    // The card is NOT destroyed and stays live in the deck (a flag is advisory).
    expect(svc.repos.elements.findById(cardId as never)?.status).not.toBe("deleted");
    expect(dueDeckIds(svc, ASOF)).toContain(cardId);
    // The flag rides on the review card view so it resurfaces visibly.
    expect(svc.reviewSessionNext({ asOf: ASOF }).card?.flagged).toBe(true);

    // Un-flagging clears it (the latest marker wins).
    const cleared = svc.flagCard({ cardId, flagged: false });
    expect(cleared.card.flagged).toBe(false);

    // Two update_element ops (flag + un-flag); no other op type used.
    const afterOps = (
      svc.raw.sqlite
        .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'update_element'")
        .get() as { n: number }
    ).n;
    expect(afterOps).toBe(beforeOps + 2);

    svc.close();
  });

  it("a card edit + flag survive a close + reopen (T038 restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(first.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(first);
    first.updateCard({ cardId, prompt: "Durable edited prompt?", answer: "Durable answer." });
    first.flagCard({ cardId, flagged: true });
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const reopened = second.repos.review.findCardById(cardId as never);
    expect(reopened?.card.prompt).toBe("Durable edited prompt?");
    expect(second.reviewSessionNext({ asOf: ASOF }).card?.flagged).toBe(true);
    second.close();
  });

  it("repair commands reject a non-card / unknown element (cards only)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const extract = svc.raw.sqlite
      .prepare("SELECT id FROM elements WHERE type = 'extract' AND deleted_at IS NULL LIMIT 1")
      .get() as { id: string } | undefined;
    expect(extract).toBeDefined();
    const id = extract?.id ?? "";
    const opCount = () =>
      (
        svc.raw.sqlite
          .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE element_id = ?")
          .get(id) as { n: number }
      ).n;
    const opsBefore = opCount();

    expect(() => svc.updateCard({ cardId: id, prompt: "x", answer: "y" })).toThrow();
    expect(() => svc.suspendCard({ cardId: id })).toThrow();
    expect(() => svc.deleteCard({ cardId: id })).toThrow();
    expect(() => svc.markLeechCard({ cardId: id, leech: true })).toThrow();
    expect(() => svc.flagCard({ cardId: "el_missing", flagged: true })).toThrow();
    expect(() => svc.markLeechCard({ cardId: "el_missing", leech: true })).toThrow();

    // The rejected markLeech must NOT leak a mutation or an op-log entry: the up-front
    // card-ness guard rolls back before any write, so the extract's `update_element`
    // op count is unchanged (no `{ isLeech }` op for a non-card).
    expect(opCount()).toBe(opsBefore);
    svc.close();
  });

  // --- T040: leech detection + cleanup view ---

  /** The seeded leech card id (the demo collection ships one with 4 lapses). */
  function seededLeechCardId(svc: DbService): string {
    const row = svc.raw.sqlite
      .prepare(
        `SELECT e.id AS id FROM elements e
         JOIN cards c ON c.element_id = e.id
         WHERE c.is_leech = 1 AND e.deleted_at IS NULL LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (!row) throw new Error("seeded leech card not found");
    return row.id;
  }

  it("grading a card to its 4th lapse flags it a leech in the same transaction", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    // Fresh DB so the deck is exactly this card.
    const cardId = seedDueCard(svc, "Lapsing fact", "2027-05-01T00:00:00.000Z");

    expect(svc.repos.review.isCardLeech(cardId as never)).toBe(false);
    expect(svc.reviewSessionNext({ asOf: ASOF }).card?.leech).toBe(false);

    // Graduate to `review`, then lapse it four times (FSRS counts a lapse only on a
    // `review`-state fail), recovering with `good` between fails.
    let at = "2027-05-02T00:00:00.000Z";
    const grade = (rating: "again" | "good" | "easy") => {
      const { reviewState } = svc.reviewGrade({
        cardId,
        rating,
        promptMs: 0,
        responseMs: 4000,
        asOf: at,
      });
      at = reviewState.dueAt
        ? new Date(Date.parse(reviewState.dueAt) + 86_400_000).toISOString()
        : at;
    };
    grade("easy"); // new → review
    for (let i = 0; i < 4; i++) {
      grade("again"); // lapse
      if (i < 3) grade("good"); // recover so it can lapse again
    }

    const state = svc.repos.review.findReviewState(cardId as never);
    expect(state?.lapses).toBeGreaterThanOrEqual(4);
    expect(svc.repos.review.isCardLeech(cardId as never)).toBe(true);
    // The leech rides back on the review card view (the banner/badge become real).
    const view = svc.reviewSessionNext({ asOf: ASOF }).card;
    expect(view?.leech).toBe(true);
    expect(view?.lapses).toBeGreaterThanOrEqual(4);

    svc.close();
  });

  it("reviewLeeches lists only leech cards (with lapse count + source)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const leechId = seededLeechCardId(svc);
    const { cards } = svc.reviewLeeches();
    expect(cards.length).toBeGreaterThanOrEqual(1);
    const found = cards.find((c) => c.id === leechId);
    expect(found).toBeDefined();
    expect(found?.lapses).toBeGreaterThanOrEqual(4);
    // Lineage source title rides along for the cleanup view.
    expect(found?.sourceTitle).toBe("On the Measure of Intelligence");
    // Every listed card is actually a leech.
    for (const c of cards) {
      expect(svc.repos.review.isCardLeech(c.id as never)).toBe(true);
    }
    // The non-leech seeded Q&A card is NOT listed.
    expect(cards.some((c) => c.id === seededDueCardId(svc))).toBe(false);

    svc.close();
  });

  it("addCardContext's note re-appears on the reviewLeeches read (and survives reopen)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(first.seedIfEmpty()).toBe(true);
    const leechId = seededLeechCardId(first);

    // Before any context note the read surface carries `null`.
    expect(first.reviewLeeches().cards.find((c) => c.id === leechId)?.context).toBeNull();

    // Add a clarifying note; the write returns it transiently.
    const note = "In the context of the ARC-AGI benchmark.";
    expect(first.addCardContext({ cardId: leechId, note }).context).toBe(note);

    // The note now rides the leech list read — i.e. it is surfaced, not write-only.
    expect(first.reviewLeeches().cards.find((c) => c.id === leechId)?.context).toBe(note);
    first.close();

    // It is op-log-derived, so it survives a close + reopen (restart analogue).
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(second.reviewLeeches().cards.find((c) => c.id === leechId)?.context).toBe(note);

    // A later add-context REPLACES the surfaced note.
    const updated = "As of the 2024 ARC-AGI results.";
    second.addCardContext({ cardId: leechId, note: updated });
    expect(second.reviewLeeches().cards.find((c) => c.id === leechId)?.context).toBe(updated);
    second.close();
  });

  it("markLeech toggles the durable flag via update_element (manual mark / un-leech)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);
    expect(svc.repos.review.isCardLeech(cardId as never)).toBe(false);

    const beforeOps = (
      svc.raw.sqlite
        .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'update_element'")
        .get() as { n: number }
    ).n;

    const marked = svc.markLeechCard({ cardId, leech: true });
    expect(marked.card.leech).toBe(true);
    expect(svc.repos.review.isCardLeech(cardId as never)).toBe(true);
    expect(svc.reviewLeeches().cards.some((c) => c.id === cardId)).toBe(true);

    const cleared = svc.markLeechCard({ cardId, leech: false });
    expect(cleared.card.leech).toBe(false);
    expect(svc.reviewLeeches().cards.some((c) => c.id === cardId)).toBe(false);

    const afterOps = (
      svc.raw.sqlite
        .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'update_element'")
        .get() as { n: number }
    ).n;
    // Two toggles → two update_element ops; no new op type.
    expect(afterOps).toBe(beforeOps + 2);

    svc.close();
  });

  it("a leech flag + remediation survive a close + reopen (T040 restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(first.seedIfEmpty()).toBe(true);
    const leechId = seededLeechCardId(first);
    expect(first.reviewLeeches().cards.some((c) => c.id === leechId)).toBe(true);
    // Remediate: suspend it from the cleanup view.
    first.suspendCard({ cardId: leechId });
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    // The leech flag persisted (still listed — the cleanup view keeps suspended
    // cards) and the suspension persisted.
    const still = second.reviewLeeches().cards.find((c) => c.id === leechId);
    expect(still).toBeDefined();
    expect(still?.status).toBe("suspended");
    expect(second.repos.review.isCardLeech(leechId as never)).toBe(true);
    second.close();
  });

  // -------------------------------------------------------------------------
  // concepts.* / tags.*  (T041)
  // -------------------------------------------------------------------------

  /** Find the seeded top-level extract id (it carries the seeded tags + concept). */
  function seededExtractId(svc: DbService): string {
    const row = svc.raw.sqlite
      .prepare(
        "SELECT id FROM elements WHERE type = 'extract' AND title = 'Intelligence = skill-acquisition efficiency' LIMIT 1",
      )
      .get() as { id: string } | undefined;
    return row?.id ?? "";
  }

  it("concepts.create builds a hierarchy and concepts.list returns it with member counts (T041)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    // The seed already created Cognition → Intelligence; create a fresh root + child.
    const parent = svc.createConcept({ name: "Methods" }).concept;
    const child = svc.createConcept({ name: "Spacing", parentConceptId: parent.id }).concept;
    expect(child.parentConceptId).toBe(parent.id);

    const list = svc.listConcepts().concepts;
    const names = list.map((c) => c.name).sort();
    expect(names).toEqual(["Cognition", "Intelligence", "Methods", "Spacing"]);
    // The seeded "Intelligence" concept has the source + extract as members.
    const intelligence = list.find((c) => c.name === "Intelligence");
    expect(intelligence?.memberCount).toBe(2);
    const cognition = list.find((c) => c.name === "Cognition");
    expect(cognition?.childCount).toBe(1);

    svc.close();
  });

  it("concepts.create rejects an empty name and a bad parent (T041)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(() => svc.createConcept({ name: "   " })).toThrow();
    expect(() => svc.createConcept({ name: "Orphan", parentConceptId: "nope" })).toThrow(
      /parent concept/,
    );
    svc.close();
  });

  it("concepts.assign/unassign + tags.add/remove return the element's organize state and log the right ops (T041)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const extractId = seededExtractId(svc);
    const concept = svc.createConcept({ name: "Spacing" }).concept;

    const assigned = svc.assignConcept({ elementId: extractId, conceptId: concept.id });
    expect(assigned.element?.concepts.map((c) => c.name)).toContain("Spacing");

    const tagged = svc.addTag({ elementId: extractId, tag: "new-tag" });
    expect(tagged.element?.tags).toContain("new-tag");

    // Idempotent re-assign / re-tag.
    svc.assignConcept({ elementId: extractId, conceptId: concept.id });
    svc.addTag({ elementId: extractId, tag: "new-tag" });

    const unassigned = svc.unassignConcept({ elementId: extractId, conceptId: concept.id });
    expect(unassigned.element?.concepts.map((c) => c.name)).not.toContain("Spacing");
    const untagged = svc.removeTag({ elementId: extractId, tag: "new-tag" });
    expect(untagged.element?.tags).not.toContain("new-tag");

    // The correct EXISTING ops were logged on the extract (no new op types).
    const opTypes = svc.repos.operationLog.listForElement(extractId as never).map((o) => o.opType);
    expect(opTypes).toEqual(
      expect.arrayContaining(["add_relation", "remove_relation", "add_tag", "remove_tag"]),
    );

    svc.close();
  });

  it("tags.list returns live usage counts; the queue filters by concept and tag (T041)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const extractId = seededExtractId(svc);

    // The seed tagged the extract `machine-learning` + `definitions`.
    const tagNames = svc.listAllTags().tags.map((t) => t.name);
    expect(tagNames).toEqual(expect.arrayContaining(["machine-learning", "definitions"]));

    // Make the extract due on the attention scheduler so it is in the queue, then
    // filter by its seeded concept (Intelligence) and tag (definitions).
    svc.repos.elements.reschedule(extractId as never, "2026-05-29T08:00:00.000Z" as never);
    const asOf = "2026-05-30T12:00:00.000Z";

    const byConcept = svc.listQueue({ asOf, concept: "Intelligence" }).items.map((i) => i.id);
    expect(byConcept).toContain(extractId);

    const byTag = svc.listQueue({ asOf, tag: "definitions" }).items.map((i) => i.id);
    expect(byTag).toContain(extractId);

    // A non-matching concept/tag excludes it.
    expect(svc.listQueue({ asOf, concept: "Nope" }).items.map((i) => i.id)).not.toContain(
      extractId,
    );
    expect(svc.listQueue({ asOf, tag: "nope" }).items.map((i) => i.id)).not.toContain(extractId);

    svc.close();
  });

  it("a concept assignment + a tag survive a full close + reopen (T041 restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(first.seedIfEmpty()).toBe(true);
    const extractId = seededExtractId(first);
    const concept = first.createConcept({ name: "Persisted" }).concept;
    first.assignConcept({ elementId: extractId, conceptId: concept.id });
    first.addTag({ elementId: extractId, tag: "persisted-tag" });
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const data = second.getInspectorData(extractId);
    expect(data.data?.concepts.map((c) => c.name)).toContain("Persisted");
    expect(data.data?.tags).toContain("persisted-tag");
    second.close();
  });

  // -------------------------------------------------------------------------
  // search.*  (T042 — local FTS5 full-text search)
  // -------------------------------------------------------------------------

  it("search.query finds + ranks seeded source/extract/card and enriches each row (T042)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    // The seed has "intelligence" in the source title + body, the extract
    // title/body, and the card prompt/answer (so all three types match).
    expect(svc.seedIfEmpty()).toBe(true);

    const { results } = svc.search({ q: "intelligence" });
    expect(results.length).toBeGreaterThan(0);
    // All three searchable types are represented.
    const types = new Set(results.map((r) => r.type));
    expect(types).toContain("source");
    expect(types).toContain("extract");
    expect(types).toContain("card");

    // Each row is enriched: priority label + (for extract/card) the owning source.
    for (const r of results) {
      expect(["A", "B", "C", "D"]).toContain(r.priorityLabel);
    }
    const extract = results.find((r) => r.type === "extract");
    expect(extract?.sourceTitle).toBe("On the Measure of Intelligence");

    // The query layer narrows by type.
    const onlyCards = svc.search({ q: "intelligence", type: "card" }).results;
    expect(onlyCards.length).toBeGreaterThan(0);
    expect(onlyCards.every((r) => r.type === "card")).toBe(true);

    svc.close();
  });

  it("search.query returns DRILL-DOWN filterbar counts that match chip-selected lists", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    // The seeded "Intelligence" concept has the source + extract as members (the
    // matching card is NOT a member — memberCount is 2). The drill-down chip count
    // must equal the rows you'd get if that concept were selected alongside the SAME
    // keyword/type — NOT the global memberCount.
    const intelligence = svc.listConcepts().concepts.find((c) => c.name === "Intelligence");
    expect(intelligence).toBeDefined();
    const conceptId = intelligence?.id ?? "";
    const assertCountsMatchChipSelections = (request: SearchQueryRequest) => {
      const counts = svc.search(request).counts;
      for (const type of ["source", "extract", "card"] as const) {
        expect(counts.byType[type]).toBe(svc.search({ ...request, type }).results.length);
      }
      for (const priorityLabel of ["A", "B", "C", "D"] as const) {
        expect(counts.byPriority[priorityLabel]).toBe(
          svc.search({ ...request, priorityLabel }).results.length,
        );
      }
      expect(counts.byConcept[conceptId] ?? 0).toBe(
        svc.search({ ...request, conceptId }).results.length,
      );
    };

    // No type filter: 2 of the keyword matches are members of Intelligence.
    const all = svc.search({ q: "intelligence" });
    expect(all.counts.byConcept[conceptId]).toBe(2);
    // And selecting that concept yields exactly those 2 rows (the HARD INVARIANT).
    expect(svc.search({ q: "intelligence", conceptId }).results.length).toBe(2);
    assertCountsMatchChipSelections({ q: "intelligence" });

    // TYPE=extract: the chip drops to 1 (only the extract member), matching the list.
    const onlyExtracts = svc.search({ q: "intelligence", type: "extract" });
    expect(onlyExtracts.counts.byConcept[conceptId]).toBe(1);
    expect(svc.search({ q: "intelligence", type: "extract", conceptId }).results.length).toBe(1);
    assertCountsMatchChipSelections({ q: "intelligence", type: "extract" });

    // TYPE=card: the chip is 0 (the card is not a member) — no surprise-empty list.
    const onlyCards = svc.search({ q: "intelligence", type: "card" });
    expect(onlyCards.counts.byConcept[conceptId] ?? 0).toBe(0);
    expect(svc.search({ q: "intelligence", type: "card", conceptId }).results.length).toBe(0);

    // CONCEPT selected: type counts respect that active concept while dropping only type.
    assertCountsMatchChipSelections({ q: "intelligence", conceptId });

    // All three facets active: every dimension still drops only itself.
    const tripleSeed = svc.search({ q: "intelligence", conceptId }).results[0];
    expect(tripleSeed).toBeDefined();
    assertCountsMatchChipSelections({
      q: "intelligence",
      type: tripleSeed?.type ?? "source",
      conceptId,
      priorityLabel: tripleSeed?.priorityLabel ?? "A",
    });

    // An empty query yields no counts (search returns [] for an empty keyword).
    expect(svc.search({ q: "" }).counts.byConcept).toEqual({});
    expect(svc.search({ q: "" }).counts.byType).toEqual({ source: 0, extract: 0, card: 0 });
    expect(svc.search({ q: "" }).counts.byPriority).toEqual({ A: 0, B: 0, C: 0, D: 0 });

    svc.close();
  });

  it("search.query can skip drill-down counts for compact lookup surfaces", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const { results, counts } = svc.search({
      q: "intelligence",
      type: "source",
      limit: 8,
      includeCounts: false,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.type === "source")).toBe(true);
    expect(counts).toEqual({
      byType: { source: 0, extract: 0, card: 0 },
      byConcept: {},
      byPriority: { A: 0, B: 0, C: 0, D: 0 },
    });

    svc.close();
  });

  it("search.query validates the payload, filters by tag, and returns [] for an empty query (T042)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    // Empty / whitespace → no results, no throw.
    expect(svc.search({ q: "" }).results).toEqual([]);
    expect(svc.search({ q: "   " }).results).toEqual([]);

    // The seed tagged the extract `definitions`; a tag filter narrows to it.
    const tagged = svc.search({ q: "intelligence", tag: "definitions" }).results;
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.some((r) => r.type === "extract")).toBe(true);
    // A non-matching tag excludes everything.
    expect(svc.search({ q: "intelligence", tag: "no-such-tag" }).results).toEqual([]);

    svc.close();
  });

  it("semantic.search counts drop the active type filter even in FTS-only degrade", async () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const semantic = await svc.semanticSearch({ q: "intelligence", type: "source" });
    expect(semantic.mode).toBe("disabled");
    expect(semantic.results.length).toBeGreaterThan(0);
    expect(semantic.results.every((r) => r.type === "source")).toBe(true);
    for (const type of ["source", "extract", "card"] as const) {
      expect(semantic.counts.byType[type]).toBe(
        svc.search({ q: "intelligence", type }).results.length,
      );
    }

    svc.close();
  });

  it("search excludes soft-deleted elements and survives a close + reopen (T042 restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(first.seedIfEmpty()).toBe(true);

    const before = first.search({ q: "intelligence" }).results;
    expect(before.length).toBeGreaterThan(0);
    first.close();

    // Reopen the SAME file: the FTS index persisted in the SQLite file.
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const after = second.search({ q: "intelligence" }).results;
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());

    // Soft-delete the seeded source → it leaves the index (the trigger fires).
    const sourceId = after.find((r) => r.type === "source")?.id ?? "";
    expect(sourceId).not.toBe("");
    second.repos.elements.softDelete(sourceId as never);
    const afterDelete = second.search({ q: "intelligence" }).results.map((r) => r.id);
    expect(afterDelete).not.toContain(sourceId);

    second.close();
  });

  it("a card search row's snippet is matched prompt/answer text, not the element ULID (T042)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const cardRow = svc.search({ q: "intelligence", type: "card" }).results[0];
    expect(cardRow).toBeDefined();
    // Regression: column-0 `snippet` returned the UNINDEXED element_id (the ULID).
    expect(cardRow?.snippet).not.toBe(cardRow?.id);
    expect((cardRow?.snippet ?? "").length).toBeGreaterThan(0);
    // The excerpt actually contains the matched term from the prompt/answer.
    expect((cardRow?.snippet ?? "").toLowerCase()).toContain("intelligence");

    svc.close();
  });

  it("soft-deleting a CARD removes it from search results (T042, card_fts trigger)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const cardId = svc.search({ q: "intelligence", type: "card" }).results[0]?.id ?? "";
    expect(cardId).not.toBe("");
    svc.repos.elements.softDelete(cardId as never);

    const afterCards = svc.search({ q: "intelligence", type: "card" }).results.map((r) => r.id);
    expect(afterCards).not.toContain(cardId);
    // And the underlying card_fts row was physically dropped (no index drift).
    const remaining = svc.raw.sqlite
      .prepare("SELECT element_id FROM card_fts WHERE element_id = ?")
      .all(cardId) as unknown[];
    expect(remaining).toHaveLength(0);

    svc.close();
  });

  // -------------------------------------------------------------------------
  // library.browse()  (Library route — facet-driven browse-everything read)
  // -------------------------------------------------------------------------

  it("library.browse lists ALL live elements with no facets + per-facet counts (no keyword)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const { items, counts } = svc.libraryBrowse({});
    // The browse-first default returns the whole live collection (no keyword needed).
    expect(items.length).toBeGreaterThan(0);
    expect(counts.all).toBe(items.length);
    // The seed includes a source, extracts, and cards — all surface.
    const types = new Set(items.map((r) => r.type));
    expect(types).toContain("source");
    expect(types).toContain("extract");
    expect(types).toContain("card");
    // The inbox source (status `inbox`) is also browsable (search would never return it).
    expect(counts.byStatus.inbox ?? 0).toBeGreaterThan(0);
  });

  it("library.browse enriches each row like a search/queue row (scheduler, due, concept, refblock)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const { items } = svc.libraryBrowse({});
    for (const r of items) {
      expect(["A", "B", "C", "D"]).toContain(r.priorityLabel);
      // The load-bearing scheduler split: cards are FSRS, everything else attention.
      expect(r.scheduler.kind).toBe(r.type === "card" ? "fsrs" : "attention");
      expect(["overdue", "today", "soon"]).toContain(r.due);
      expect(r.dueLabel.length).toBeGreaterThan(0);
    }
    // An extract/card carries its owning source (the refblock provenance).
    const extract = items.find((r) => r.type === "extract");
    expect(extract?.sourceTitle).toBe("On the Measure of Intelligence");
  });

  it("library.browse carries linked-element routing fields for verification tasks", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const card = svc.libraryBrowse({ types: ["card"] }).items[0];
    expect(card).toBeDefined();
    const task = svc.createTask({
      taskType: "find_better_source",
      title: "Find better source: this item",
      linkedElementId: card?.id as never,
      dueChoice: { kind: "tomorrow" },
    }).task;

    const row = svc.libraryBrowse({ types: ["task"] }).items.find((item) => item.id === task.id);
    expect(row?.linkedElementId).toBe(card?.id);
    expect(row?.linkedElementType).toBe("card");

    svc.close();
  });

  it("library.browse Zod-validates the payload and narrows by type / status / priority / concept", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    // Type facet.
    const onlyCards = svc.libraryBrowse({ types: ["card"] }).items;
    expect(onlyCards.length).toBeGreaterThan(0);
    expect(onlyCards.every((r) => r.type === "card")).toBe(true);

    // Status facet — the seeded inbox source narrows to `inbox`.
    const inbox = svc.libraryBrowse({ statuses: ["inbox"] }).items;
    expect(inbox.length).toBeGreaterThan(0);
    expect(inbox.every((r) => r.status === "inbox")).toBe(true);

    // Priority facet — A-band only.
    const aBand = svc.libraryBrowse({ priorityLabel: "A" }).items;
    expect(aBand.every((r) => r.priorityLabel === "A")).toBe(true);

    // Concept facet — assign the seeded source to a fresh concept, then narrow.
    const all = svc.libraryBrowse({}).items;
    const sourceRow = all.find((r) => r.type === "source");
    expect(sourceRow).toBeDefined();
    const concept = svc.repos.concepts.createConcept({ name: "Browse Topic" });
    svc.repos.concepts.assignConcept(sourceRow?.id as never, concept.id);
    const byConcept = svc.libraryBrowse({ conceptId: concept.id }).items;
    expect(byConcept.map((r) => r.id)).toEqual([sourceRow?.id]);
  });

  it("library.browse carries DRILL-DOWN byConcept counts that match the filtered list end-to-end", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    // Build a concept whose members span types: one source + one extract + one card.
    const all = svc.libraryBrowse({}).items;
    const source = all.find((r) => r.type === "source");
    const extract = all.find((r) => r.type === "extract");
    const card = all.find((r) => r.type === "card");
    expect(source && extract && card).toBeTruthy();
    const concept = svc.repos.concepts.createConcept({ name: "Drilldown" });
    svc.repos.concepts.assignConcept(source?.id as never, concept.id);
    svc.repos.concepts.assignConcept(extract?.id as never, concept.id);
    svc.repos.concepts.assignConcept(card?.id as never, concept.id);

    // No type filter: the chip count is the full 3 members (the Map volume).
    const noFilter = svc.libraryBrowse({});
    expect(noFilter.counts.byConcept[concept.id]).toBe(3);

    // TYPE=Extracts: the drill-down chip count must equal the visible extract rows,
    // AND equal the rows when the concept is ALSO selected (the hard invariant).
    const withType = svc.libraryBrowse({ types: ["extract"] });
    const intersection = svc.libraryBrowse({ types: ["extract"], conceptId: concept.id });
    expect(withType.counts.byConcept[concept.id]).toBe(intersection.items.length);
    expect(intersection.items.map((r) => r.id)).toEqual([extract?.id]);
  });

  it("library.browse survives a close + reopen (restart analogue) and excludes soft-deleted", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(first.seedIfEmpty()).toBe(true);
    const before = first
      .libraryBrowse({})
      .items.map((r) => r.id)
      .sort();
    expect(before.length).toBeGreaterThan(0);
    first.close();

    // Reopen the SAME file — the browse re-lists the persisted elements.
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const after = second
      .libraryBrowse({})
      .items.map((r) => r.id)
      .sort();
    expect(after).toEqual(before);

    // Soft-deleting a row drops it from the next browse.
    const sourceId = second.libraryBrowse({ types: ["source"] }).items[0]?.id ?? "";
    expect(sourceId).not.toBe("");
    second.repos.elements.softDelete(sourceId as never);
    const afterDelete = second.libraryBrowse({}).items.map((r) => r.id);
    expect(afterDelete).not.toContain(sourceId);

    second.close();
  });
});

// ---------------------------------------------------------------------------
// Targeted review modes (T096) — a chosen card subset reviewed OUTSIDE scheduling.
// ---------------------------------------------------------------------------

describe("DbService — review modes (T096)", () => {
  /** A future clock so the seeded due card stays due; an explicit far-future card is NOT due. */
  const ASOF = "2027-06-01T12:00:00.000Z";

  /** The seeded DUE Q&A (non-leech, non-retired) card id with a past due_at. */
  function seededDueCardId(svc: DbService): string {
    const row = svc.raw.sqlite
      .prepare(
        `SELECT e.id AS id FROM elements e
         JOIN cards c ON c.element_id = e.id
         JOIN review_states rs ON rs.element_id = e.id
         WHERE c.kind = 'qa' AND c.is_leech = 0 AND c.is_retired = 0
           AND e.deleted_at IS NULL AND rs.due_at IS NOT NULL AND rs.due_at <= ? LIMIT 1`,
      )
      .get(ASOF) as { id: string } | undefined;
    if (!row) throw new Error("seeded due Q&A card not found");
    return row.id;
  }

  it("reviewModeDeck (concept) returns reveal-ready views for a chosen subset, including a NOT-due card", async () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const dueCard = seededDueCardId(svc);
    // Force a SECOND card far into the FUTURE so it is NOT due (would not appear in
    // the daily session) — the load-bearing "outside scheduling" case.
    const futureCard = svc.raw.sqlite
      .prepare(
        `SELECT e.id AS id FROM elements e
         JOIN cards c ON c.element_id = e.id
         JOIN review_states rs ON rs.element_id = e.id
         WHERE c.kind = 'qa' AND c.is_leech = 0 AND c.is_retired = 0
           AND e.deleted_at IS NULL AND e.id != ? LIMIT 1`,
      )
      .get(dueCard) as { id: string } | undefined;
    if (!futureCard) throw new Error("need a second seeded card");
    svc.raw.sqlite
      .prepare("UPDATE review_states SET due_at = ? WHERE element_id = ?")
      .run("2099-01-01T00:00:00.000Z", futureCard.id);

    // Assign BOTH cards to a fresh concept.
    const concept = svc.createConcept({ name: "Mode subset" }).concept;
    svc.assignConcept({ elementId: dueCard, conceptId: concept.id });
    svc.assignConcept({ elementId: futureCard.id, conceptId: concept.id });

    const result = await svc.reviewModeDeck({
      selector: { kind: "concept", conceptId: concept.id as never },
      asOf: ASOF,
    });
    const ids = result.deck.map((c) => c.id);
    expect(ids).toContain(dueCard);
    // The NOT-due card IS in the mode deck (it would be absent from the daily session).
    expect(ids).toContain(futureCard.id);
    expect(result.label).toBe("Concept");
    // The views are reveal-ready: the answer is present (the renderer hides it until reveal).
    const view = result.deck.find((c) => c.id === dueCard);
    expect(view?.schedulerSignals.kind).toBe("fsrs");
    expect(view?.answer ?? view?.cloze).toBeTruthy();

    // The not-due card is NOT in the daily due session — proving the selection differs.
    const dueIds: string[] = [];
    for (let i = 0; i < 500; i++) {
      const res = svc.reviewSessionNext({ asOf: ASOF, exclude: dueIds });
      if (!res.card) break;
      dueIds.push(res.card.id);
    }
    expect(dueIds).not.toContain(futureCard.id);

    svc.close();
  });

  it("grading a NOT-due mode card writes exactly one review_logs row + advances FSRS (unchanged grade path)", async () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    // A card pushed far into the future — NOT due, but selectable in a mode.
    const cardId = seededDueCardId(svc);
    svc.raw.sqlite
      .prepare("UPDATE review_states SET due_at = ? WHERE element_id = ?")
      .run("2099-01-01T00:00:00.000Z", cardId);
    const concept = svc.createConcept({ name: "Gradable" }).concept;
    svc.assignConcept({ elementId: cardId, conceptId: concept.id });

    // It appears in the mode deck though it is not due.
    const deck = await svc.reviewModeDeck({
      selector: { kind: "concept", conceptId: concept.id as never },
      asOf: ASOF,
    });
    expect(deck.deck.map((c) => c.id)).toContain(cardId);

    const beforeState = svc.repos.review.findReviewState(cardId as never);
    const beforeLogs = svc.repos.review.listReviewLogs(cardId as never).length;
    const beforeOps = svc.raw.sqlite
      .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'add_review_log'")
      .get() as { n: number };

    // Grade it through the UNCHANGED review.grade path.
    const result = svc.reviewGrade({
      cardId,
      rating: "good",
      promptMs: 0,
      responseMs: 1500,
      asOf: ASOF,
    });

    // Exactly one new review_logs row + one add_review_log op, FSRS advanced.
    expect(svc.repos.review.listReviewLogs(cardId as never).length).toBe(beforeLogs + 1);
    const afterState = svc.repos.review.findReviewState(cardId as never);
    expect(afterState?.reps).toBe((beforeState?.reps ?? 0) + 1);
    expect(afterState?.dueAt).toBe(result.reviewState.dueAt);
    const cardEl = svc.repos.elements.findById(cardId as never);
    expect(cardEl?.dueAt).toBe(result.reviewState.dueAt);
    const afterOps = svc.raw.sqlite
      .prepare("SELECT COUNT(*) AS n FROM operation_log WHERE op_type = 'add_review_log'")
      .get() as { n: number };
    expect(afterOps.n).toBe(beforeOps.n + 1);

    svc.close();
  });

  it("reviewModeCount returns the subset size + label (cheap, agrees with the deck)", async () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(svc);
    const concept = svc.createConcept({ name: "Counted" }).concept;
    svc.assignConcept({ elementId: cardId, conceptId: concept.id });

    const count = await svc.reviewModeCount({
      selector: { kind: "concept", conceptId: concept.id as never },
      asOf: ASOF,
    });
    const deck = await svc.reviewModeDeck({
      selector: { kind: "concept", conceptId: concept.id as never },
      asOf: ASOF,
    });
    expect(count.total).toBe(deck.deck.length);
    expect(count.label).toBe("Concept");

    svc.close();
  });

  it("semantic mode degrades to keyword when semantics are disabled (no model, no network)", async () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    // Pick a real card and use a word from its prompt as the query.
    const card = svc.raw.sqlite
      .prepare(
        `SELECT c.prompt AS prompt FROM cards c JOIN elements e ON e.id = c.element_id
         WHERE c.kind = 'qa' AND e.deleted_at IS NULL AND c.prompt IS NOT NULL LIMIT 1`,
      )
      .get() as { prompt: string } | undefined;
    const term = (card?.prompt ?? "the").split(/\s+/).find((w) => w.length > 3) ?? "the";

    // Semantics are OFF by default in the seed — the semantic mode must equal keyword.
    const keyword = await svc.reviewModeDeck({
      selector: { kind: "search", query: term },
      asOf: ASOF,
    });
    const semantic = await svc.reviewModeDeck({
      selector: { kind: "semantic", query: term },
      asOf: ASOF,
    });
    expect(semantic.deck.map((c) => c.id)).toEqual(keyword.deck.map((c) => c.id));

    svc.close();
  });

  it("a graded mode card's rescheduling survives a close + reopen (restart analogue)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(first.seedIfEmpty()).toBe(true);
    const cardId = seededDueCardId(first);
    first.raw.sqlite
      .prepare("UPDATE review_states SET due_at = ? WHERE element_id = ?")
      .run("2099-01-01T00:00:00.000Z", cardId);
    const { reviewState } = first.reviewGrade({
      cardId,
      rating: "good",
      promptMs: 0,
      responseMs: 2100,
      asOf: ASOF,
    });
    const logsBefore = first.repos.review.listReviewLogs(cardId as never).length;
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(second.repos.review.findReviewState(cardId as never)?.dueAt).toBe(reviewState.dueAt);
    expect(second.repos.review.listReviewLogs(cardId as never).length).toBe(logsBefore);
    second.close();
  });
});

// ---------------------------------------------------------------------------
// Source/reference display (T043) — the enriched refblock on cards/extracts.
// ---------------------------------------------------------------------------

describe("DbService — source reference (T043)", () => {
  /** A future clock so the seeded Q&A card reads as due (mirrors the review tests). */
  const ASOF = "2027-06-01T12:00:00.000Z";

  function seededExtractId(svc: DbService): string {
    const row = svc.raw.sqlite
      .prepare(`SELECT id FROM elements WHERE type = 'extract' AND deleted_at IS NULL LIMIT 1`)
      .get() as { id: string } | undefined;
    if (!row) throw new Error("seeded extract not found");
    return row.id;
  }

  it("resolves the enriched sourceRef (title/url/author/date/location) for a seeded card", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const res = svc.reviewSessionNext({ asOf: ASOF });
    expect(res.card).not.toBeNull();
    const ref = res.card?.sourceRef;
    expect(ref).not.toBeNull();
    // Provenance resolved from the `sources` row (the seed's Chollet paper).
    expect(ref?.sourceTitle).toBe("On the Measure of Intelligence");
    expect(ref?.url).toBe("https://arxiv.org/abs/1911.01547");
    expect(ref?.author).toBe("François Chollet");
    expect(ref?.publishedAt).toBe("2019-11-05T00:00:00.000Z");
    // Location resolved from the card's `source_locations` anchor (the extract's loc).
    expect(ref?.locationLabel).toBe("Definition · ¶1");
    expect(ref?.snippet).toBeTruthy();
    // Lineage points back at the owning source element.
    expect(ref?.sourceElementId).toBeTruthy();

    svc.close();
  });

  it("resolves the enriched sourceRef for a seeded extract via the inspector payload", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const extractId = seededExtractId(svc);
    const data = svc.getInspectorData(extractId).data;
    expect(data).not.toBeNull();
    const ref = data?.sourceRef;
    expect(ref?.sourceTitle).toBe("On the Measure of Intelligence");
    expect(ref?.author).toBe("François Chollet");
    expect(ref?.url).toBe("https://arxiv.org/abs/1911.01547");
    expect(ref?.locationLabel).toBe("Definition · ¶1");
    expect(ref?.snippet).toContain("skill-acquisition efficiency");

    svc.close();
  });

  it("a source's own inspector sourceRef points at itself (its own provenance)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const source = svc.raw.sqlite
      .prepare("SELECT id FROM elements WHERE type = 'source' AND parent_id IS NULL LIMIT 1")
      .get() as { id: string };
    const ref = svc.getInspectorData(source.id).data?.sourceRef;
    expect(ref?.sourceElementId).toBe(source.id);
    expect(ref?.sourceTitle).toBe("On the Measure of Intelligence");
    expect(ref?.author).toBe("François Chollet");
    // A source has no location of its own.
    expect(ref?.locationLabel).toBeNull();

    svc.close();
  });

  it("degrades to a placeholder ref when an extract's source is soft-deleted (no throw)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const extractId = seededExtractId(svc);
    const before = svc.getInspectorData(extractId).data?.sourceRef;
    const sourceId = before?.sourceElementId;
    expect(sourceId).toBeTruthy();

    // Soft-delete the owning source → the extract's ref must degrade calmly, not throw.
    svc.repos.elements.softDelete(sourceId as never);
    const ref = svc.getInspectorData(extractId).data?.sourceRef;
    expect(ref).not.toBeNull();
    // The source title/provenance drop to null (a calm "source unavailable"); the
    // location snippet remains (it is the element's own anchor, not the source).
    expect(ref?.sourceTitle).toBeNull();
    expect(ref?.author).toBeNull();
    expect(ref?.url).toBeNull();
    expect(ref?.sourceElementId).toBeNull();
    expect(ref?.snippet).toBeTruthy();

    svc.close();
  });
});

describe("DbService — trash & undo (T044)", () => {
  it("lists trashed elements, restores them to the prior status, and survives reopen", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { id } = first.importManualSource({ title: "Disposable note", priority: "C" });
    // Move it to active, then delete it (origin status should be `active`).
    first.repos.elements.update(id as never, { status: "active" });
    first.repos.elements.softDelete(id as never);

    let trash = first.listTrash();
    expect(trash.items).toHaveLength(1);
    expect(trash.items[0]?.id).toBe(id);
    expect(trash.items[0]?.originStatus).toBe("active");
    first.close();

    // Reopen the SAME file — the trash list persists (the unit-level restart check).
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    trash = second.listTrash();
    expect(trash.items).toHaveLength(1);

    const restored = second.restoreFromTrash({ id });
    expect(restored.item?.status).toBe("active");
    expect(second.listTrash().items).toHaveLength(0);
    second.close();
  });

  it("purges and empties the trash (the only hard delete)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const a = svc.importManualSource({ title: "One" }).id;
    const b = svc.importManualSource({ title: "Two" }).id;
    svc.repos.elements.softDelete(a as never);
    svc.repos.elements.softDelete(b as never);
    expect(svc.listTrash().items).toHaveLength(2);

    expect(svc.purgeFromTrash({ id: a }).purged).toBe(1);
    expect(svc.listTrash().items).toHaveLength(1);
    // The element is truly gone (hard delete).
    expect(svc.repos.elements.findById(a as never)).toBeNull();

    expect(svc.emptyTrash().purged).toBe(1);
    expect(svc.listTrash().items).toHaveLength(0);
    svc.close();
  });

  it("undoLastOperation reverses the last op (delete → restore) from anywhere", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { id } = svc.importManualSource({ title: "Undo me", priority: "B" });
    svc.repos.elements.update(id as never, { status: "active" });
    svc.repos.elements.softDelete(id as never);
    expect(svc.repos.elements.findById(id as never)?.deletedAt).not.toBeNull();

    const res = svc.undoLastOperation();
    expect(res.undone).toBe(true);
    expect(res.opType).toBe("soft_delete_element");
    expect(svc.repos.elements.findById(id as never)?.deletedAt).toBeNull();
    expect(svc.repos.elements.findById(id as never)?.status).toBe("active");
    svc.close();
  });

  it("undoLastOperation returns { undone: false } on a non-invertible last op", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    // A bare create leaves `create_element` as the last op — not inverted by the MVP.
    svc.importManualSource({ title: "Just created" });
    const res = svc.undoLastOperation();
    expect(res.undone).toBe(false);
    expect(res.reason).toBeTruthy();
    svc.close();
  });

  it("undoLastOperation on a card FLAG (marker update_element) reports false and leaves the flag set", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { element } = svc.repos.review.createCard({
      kind: "qa",
      title: "Define recall",
      priority: 0.625,
      prompt: "Define recall?",
      answer: "Active retrieval.",
      stage: "active_card",
    });
    const flagged = svc.flagCard({
      cardId: element.id,
      flagged: true,
      reason: "ambiguous pronoun",
    });
    expect(flagged.card.flagged).toBe(true);
    const opCount = () =>
      (svc.raw.sqlite.prepare("SELECT COUNT(*) AS n FROM operation_log").get() as { n: number }).n;
    const opsBefore = opCount();

    // The flag marker carries no pre-image — undo must NOT report a phantom success
    // and must NOT append an inverting op.
    const res = svc.undoLastOperation();
    expect(res.undone).toBe(false);
    expect(res.reason).toBeTruthy();
    expect(opCount()).toBe(opsBefore);
    // The flag is still set (re-flagging to the same value reads true, latest marker wins).
    expect(svc.flagCard({ cardId: element.id, flagged: true }).card.flagged).toBe(true);
    svc.close();
  });

  it("undoLastOperation on a card POSTPONE restores review_states.due_at so the card is due again", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { element } = svc.repos.review.createCard({
      kind: "qa",
      title: "Define interleaving",
      priority: 0.625,
      prompt: "Define interleaving?",
      answer: "Mixing topics across a session.",
      stage: "active_card",
    });
    const dueAt = "2026-05-29T00:00:00.000Z";
    svc.raw.sqlite
      .prepare("UPDATE review_states SET due_at = ? WHERE element_id = ?")
      .run(dueAt, element.id);

    // Postpone the card → its FSRS due defers forward and it leaves the due deck.
    svc.actOnQueueItem({ id: element.id, action: { kind: "postpone" } });
    expect(svc.repos.review.findReviewState(element.id)?.dueAt).not.toBe(dueAt);

    // Global undo restores BOTH stores; the card returns to the FSRS due queue.
    const res = svc.undoLastOperation();
    expect(res.undone).toBe(true);
    expect(res.opType).toBe("reschedule_element");
    expect(svc.repos.review.findReviewState(element.id)?.dueAt).toBe(dueAt);
    expect(
      svc.repos.queue.dueCards("2026-06-01T00:00:00.000Z" as never).map((c) => c.id),
    ).toContain(element.id);
    svc.close();
  });
});

describe("DbService — analytics (T045)", () => {
  /** A future clock so the seeded due cards register as due. */
  const ASOF = "2027-06-01T12:00:00.000Z";

  function seededDueQaCardId(svc: DbService): string {
    const row = svc.raw.sqlite
      .prepare(
        `SELECT e.id AS id FROM elements e
         JOIN cards c ON c.element_id = e.id
         WHERE c.kind = 'qa' AND c.is_leech = 0 AND e.deleted_at IS NULL LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (!row) throw new Error("seeded Q&A card not found");
    return row.id;
  }

  it("getAnalytics returns the shape with a per-day spark and the due/leech counts", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const summary = svc.getAnalytics({ asOf: ASOF, windowDays: 30 });
    expect(summary.windowDays).toBe(30);
    expect(summary.reviewsByDay).toHaveLength(30);
    // The seed has a leech card and a couple of due cards.
    expect(summary.leeches).toBeGreaterThanOrEqual(1);
    expect(summary.dueCards).toBeGreaterThanOrEqual(1);
    // Defaults apply when called bare.
    const bare = svc.getAnalytics();
    expect(bare.windowDays).toBe(30);
    svc.close();
  });

  it("a fresh grade increments the review total and reflects the rating in retention; survives reopen", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(first.seedIfEmpty()).toBe(true);
    const cardId = seededDueQaCardId(first);

    const before = first.getAnalytics({ asOf: ASOF });
    // Grade `again` — a failure that drags retention down.
    first.reviewGrade({ cardId, rating: "again", promptMs: 0, responseMs: 4000, asOf: ASOF });
    const after = first.getAnalytics({ asOf: ASOF });
    expect(after.reviewsTotal).toBe(before.reviewsTotal + 1);
    first.close();

    // Reopen the SAME file — the numbers are recomputed from durable review_logs.
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const persisted = second.getAnalytics({ asOf: ASOF });
    expect(persisted.reviewsTotal).toBe(after.reviewsTotal);
    second.close();
  });

  it("a fresh grade appears in review activity and survives reopen", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(first.seedIfEmpty()).toBe(true);
    const cardId = seededDueQaCardId(first);

    const before = first.getReviewActivity({ asOf: ASOF, year: 2027 });
    const beforeDay = before.days.find((day) => day.date === "2027-06-01")?.count ?? 0;
    first.reviewGrade({ cardId, rating: "good", promptMs: 0, responseMs: 900, asOf: ASOF });
    const after = first.getReviewActivity({ asOf: ASOF, year: 2027 });
    const afterDay = after.days.find((day) => day.date === "2027-06-01")?.count ?? 0;
    expect(after.totalReviews).toBe(before.totalReviews + 1);
    expect(afterDay).toBe(beforeDay + 1);
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const persisted = second.getReviewActivity({ asOf: ASOF, year: 2027 });
    const persistedDay = persisted.days.find((day) => day.date === "2027-06-01")?.count ?? 0;
    expect(persisted.totalReviews).toBe(after.totalReviews);
    expect(persistedDay).toBe(afterDay);
    second.close();
  });

  it("getReviewActivity returns the calendar-year activity shape from the analytics service", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const domainActivity = {
      asOf: ASOF,
      year: 2026,
      minYear: 2025,
      maxYear: 2027,
      previousYear: 2025,
      nextYear: 2027,
      days: [
        { date: "2026-01-01", count: 0 },
        { date: "2026-01-02", count: 3 },
      ],
      reviewsTotal: 3,
    };
    const computeReviewActivity = vi.fn(() => domainActivity);
    Object.defineProperty(svc.repos.analytics, "computeReviewActivity", {
      configurable: true,
      value: computeReviewActivity,
    });

    expect(svc.getReviewActivity({ asOf: ASOF, year: 2026 })).toEqual({
      asOf: domainActivity.asOf,
      year: domainActivity.year,
      minYear: domainActivity.minYear,
      maxYear: domainActivity.maxYear,
      previousYear: domainActivity.previousYear,
      nextYear: domainActivity.nextYear,
      days: domainActivity.days,
      totalReviews: domainActivity.reviewsTotal,
    });
    expect(computeReviewActivity).toHaveBeenCalledWith(ASOF, { year: 2026 });
    svc.close();
  });
});

describe("DbService — balance (T046)", () => {
  /** A future clock so the seeded forward-due cards register as due-this-week. */
  const ASOF = "2027-06-01T12:00:00.000Z";

  it("getBalance returns the four weekly counts + the imbalance judgment", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);

    const balance = svc.getBalance({ asOf: ASOF, windowDays: 7 });
    expect(balance.windowDays).toBe(7);
    // The four headline numbers are present and non-negative.
    expect(balance.sourcesImported).toBeGreaterThanOrEqual(0);
    expect(balance.extractsCreated).toBeGreaterThanOrEqual(0);
    expect(balance.cardsCreated).toBeGreaterThanOrEqual(0);
    expect(balance.reviewsDueThisWeek).toBeGreaterThanOrEqual(0);
    expect(balance.inboxSources).toBeGreaterThanOrEqual(0);
    expect(balance.dueQueueItems).toBeGreaterThanOrEqual(0);
    expect(["ok", "warn", "danger"]).toContain(balance.severity);
    expect(balance.imbalanced).toBe(balance.severity !== "ok");

    // Defaults apply when called bare (7-day window).
    expect(svc.getBalance().windowDays).toBe(7);
    svc.close();
  });

  it("flags an imbalanced week of many imports with no processed output (advisory only)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    // Import 10 sources with NO extracts/cards in the window — a zero-output week
    // at 2× the import floor escalates to `danger` per the documented rule.
    for (let i = 0; i < 10; i++) {
      svc.importManualSource({ title: `Imported ${i}`, priority: "C" });
    }
    const now = new Date().toISOString();
    const balance = svc.getBalance({ asOf: now, windowDays: 7 });
    expect(balance.sourcesImported).toBeGreaterThanOrEqual(10);
    expect(balance.extractsCreated).toBe(0);
    expect(balance.cardsCreated).toBe(0);
    expect(balance.inboxSources).toBeGreaterThanOrEqual(10);
    expect(balance.dueQueueItems).toBe(0);
    expect(balance.imbalanced).toBe(true);
    expect(balance.severity).toBe("danger");
    svc.close();
  });

  it("reads the importBalanceFactor setting and round-trips it (it gates the rule)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    // 6 imports (just over the floor) with no output → at least a warn.
    for (let i = 0; i < 6; i++) svc.importManualSource({ title: `Src ${i}`, priority: "C" });
    const now = new Date().toISOString();
    expect(svc.getBalance({ asOf: now }).imbalanced).toBe(true);

    // The factor setting round-trips through the typed settings surface and is the
    // value getBalance reads (a zero-output week still alarms because the floor +
    // zero-output rule dominate — the factor only tunes the non-zero-output ratio).
    svc.updateAppSettings({ importBalanceFactor: 5 });
    expect(svc.getAppSettings().settings.importBalanceFactor).toBe(5);
    expect(svc.getBalance({ asOf: now }).imbalanced).toBe(true);
    svc.close();
  });
});

describe("DbService — source yield (T083)", () => {
  const ASOF = "2026-06-01T12:00:00.000Z";

  it("listSourceYield round-trips the ranked rollup shape and survives reopen", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(first.seedIfEmpty()).toBe(true);

    const summary = first.listSourceYield({ asOf: ASOF });
    // The seed has at least one source (the demo + math/code sources).
    expect(summary.rows.length).toBeGreaterThanOrEqual(1);
    // Sorted lowest-yield first (ascending score).
    const scores = summary.rows.map((r) => r.yieldScore);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    // Every row carries the rollup fields + a band.
    const row = summary.rows[0];
    expect(row).toBeDefined();
    if (row) {
      expect(typeof row.readPct).toBe("number");
      expect(row.readPct).toBeGreaterThanOrEqual(0);
      expect(row.readPct).toBeLessThanOrEqual(1);
      expect(row.extractsCreated).toBeGreaterThanOrEqual(0);
      expect(row.cardsCreated).toBeGreaterThanOrEqual(0);
      expect(["high", "medium", "low", "neutral"]).toContain(row.yieldBand);
    }
    expect(summary.lowYieldCount).toBeGreaterThanOrEqual(0);

    // The demo source has a read-point at the 3rd of 4 blocks → readPct = 3/4 = 0.75,
    // and produced extracts + cards via the sourceId lineage.
    const demo = summary.rows.find((r) => r.source.title === "On the Measure of Intelligence");
    expect(demo).toBeDefined();
    if (demo) {
      expect(demo.readPct).toBeCloseTo(0.75);
      expect(demo.extractsCreated).toBeGreaterThanOrEqual(1);
      expect(demo.cardsCreated).toBeGreaterThanOrEqual(1);
      // The seed flags a leech card under this source.
      expect(demo.leeches).toBeGreaterThanOrEqual(1);
    }

    // Defaults apply when called bare.
    expect(first.listSourceYield().rows.length).toBeGreaterThanOrEqual(1);
    first.close();

    // Reopen the SAME file — the rollup recomputes from the durable tables.
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const persisted = second.listSourceYield({ asOf: ASOF });
    const demo2 = persisted.rows.find((r) => r.source.title === "On the Measure of Intelligence");
    expect(demo2?.readPct).toBeCloseTo(0.75);
    expect(demo2?.cardsCreated).toBe(demo?.cardsCreated);
    second.close();
  });
});

describe("DbService — extract stagnation (T084)", () => {
  /** A far-future `asOf` so a never-advanced extract reads as stale. */
  function farFutureAsOf(): string {
    return new Date(Date.now() + 60 * 86_400_000).toISOString();
  }

  it("listStagnantExtracts round-trips the scan shape and survives reopen", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    // Seed a source + a top-level extract, then postpone it 3× (≥ threshold).
    const { id: sourceId } = first.importManualSource({
      title: "On the Measure of Intelligence",
      priority: "B",
      body: "The definition paragraph.\n\nAnother paragraph.",
    });
    const blockId = (
      first.raw.sqlite
        .prepare("SELECT stable_block_id AS b FROM document_blocks WHERE document_id = ? LIMIT 1")
        .get(sourceId) as { b: string }
    ).b;
    const { extract } = first.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph.",
      blockIds: [blockId],
      startOffset: 0,
      endOffset: 25,
    });
    for (let i = 0; i < 3; i++) first.postponeExtract({ id: extract.id });

    const summary = first.listStagnantExtracts({ asOf: farFutureAsOf() });
    expect(summary.stagnantCount).toBe(1);
    const row = summary.rows[0];
    expect(row).toBeDefined();
    if (row) {
      expect(row.extract.id).toBe(extract.id);
      expect(row.postponeCount).toBe(3);
      expect(row.childCount).toBe(0);
      expect(row.reasons).toContain("postponed-repeatedly");
      expect(["rewrite", "convert", "postpone", "delete"]).toContain(row.suggestion);
    }

    // Defaults apply when called bare (asOf=now → the just-created extract is not yet stale).
    expect(first.listStagnantExtracts().stagnantCount).toBe(0);
    first.close();

    // Reopen the SAME file — the scan recomputes from the durable op-log markers.
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const persisted = second.listStagnantExtracts({ asOf: farFutureAsOf() });
    expect(persisted.stagnantCount).toBe(1);
    expect(persisted.rows[0]?.extract.id).toBe(extract.id);
    expect(persisted.rows[0]?.postponeCount).toBe(3);
    second.close();
  });
});

describe("DbService — backup support (T047)", () => {
  it("getSchemaVersion returns the latest applied Drizzle migration tag", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    // Derive the expected tag from the staged `_journal.json` (the source of truth)
    // rather than a literal, so this never re-rots when a later migration lands (it
    // previously pinned `0026_reflective_magma`, stale once the T100 `0027` migration
    // landed).
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const expectedTag = journal.entries.at(-1)?.tag;
    expect(svc.getSchemaVersion(MIGRATIONS_DIR)).toBe(expectedTag);
    svc.close();
  });

  it("getBackupCounts counts elements/sources/extracts/cards/assets", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const counts = svc.getBackupCounts();
    expect(counts.elements).toBeGreaterThan(0);
    expect(counts.sources).toBeGreaterThan(0);
    expect(counts.extracts).toBeGreaterThan(0);
    expect(counts.cards).toBeGreaterThan(0);
    // The demo seed writes asset METADATA rows.
    expect(counts.assets).toBeGreaterThanOrEqual(0);
    svc.close();
  });

  it("backupDatabaseTo writes a consistent snapshot with the same row counts", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(svc.seedIfEmpty()).toBe(true);
    const sourceCount = (
      svc.raw.sqlite.prepare("SELECT COUNT(*) AS n FROM elements").get() as {
        n: number;
      }
    ).n;

    const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-snap-"));
    const snapPath = path.join(snapDir, "snapshot.sqlite");
    try {
      svc.backupDatabaseTo(snapPath);
      expect(fs.existsSync(snapPath)).toBe(true);
      // VACUUM INTO emits a self-contained file with no -wal/-shm siblings.
      expect(fs.existsSync(`${snapPath}-wal`)).toBe(false);

      const snap = openDatabase(snapPath);
      try {
        const snapCount = (
          snap.sqlite.prepare("SELECT COUNT(*) AS n FROM elements").get() as {
            n: number;
          }
        ).n;
        expect(snapCount).toBe(sourceCount);
      } finally {
        snap.sqlite.close();
      }
    } finally {
      fs.rmSync(snapDir, { recursive: true, force: true });
      svc.close();
    }
  });
});

describe("DbService — desired retention by priority/concept (T079)", () => {
  let dir: string;
  let dbPath: string;
  const ASOF = "2026-06-15T00:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-retention-"));
    dbPath = path.join(dir, "app.sqlite");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Author a `qa` card and force a MATURED review state (so `good` gives a multi-day interval). */
  function maturedCard(svc: DbService, priority: number): string {
    const { element } = svc.repos.review.createCard({
      kind: "qa",
      title: "Matured",
      priority,
      prompt: "Q",
      answer: "A",
    });
    svc.raw.sqlite
      .prepare(
        `UPDATE review_states SET stability = 30, difficulty = 5, reps = 5, fsrs_state = 'review',
         last_reviewed_at = '2026-05-16T00:00:00.000Z', due_at = ? WHERE element_id = ?`,
      )
      .run(ASOF, element.id);
    return element.id;
  }

  const intervalDays = (svc: DbService, cardId: string): number => {
    const { reviewState } = svc.gradeCard(cardId as never, "good", 1000, ASOF);
    return (Date.parse(reviewState.dueAt ?? ASOF) - Date.parse(ASOF)) / 86_400_000;
  };

  it("a per-card override changes the scheduled interval on the next grade (higher → shorter)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const high = maturedCard(svc, 0.375);
    const low = maturedCard(svc, 0.375);
    svc.setRetentionCard({ cardId: high, target: 0.95 });
    svc.setRetentionCard({ cardId: low, target: 0.85 });

    // Higher resolved target → shorter interval (the resolved retention reaches FSRS).
    expect(intervalDays(svc, high)).toBeLessThan(intervalDays(svc, low));
    svc.close();
  });

  it("resolves by priority band, by concept membership, and clamps a below-floor override UP", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    svc.updateAppSettings({
      defaultDesiredRetention: 0.9,
      retentionByBandEnabled: true,
      retentionByBand: { A: 0.93 },
    });

    // Band: an A-priority card with no concept/override resolves to the A band.
    const bandCard = maturedCard(svc, 0.875);
    expect(svc.resolveRetentionFor({ cardId: bandCard })).toEqual({ target: 0.93, source: "band" });

    // Concept: setting a concept target + assigning it wins over the band.
    const conceptCard = maturedCard(svc, 0.875);
    const created = svc.createConcept({ name: "Fragile" });
    svc.setRetentionConcept({ conceptId: created.concept.id, target: 0.96 });
    svc.assignConcept({ elementId: conceptCard, conceptId: created.concept.id });
    expect(svc.resolveRetentionFor({ cardId: conceptCard })).toEqual({
      target: 0.96,
      source: "concept",
    });

    // A below-floor per-card override is clamped UP to the floor (cannot self-retire).
    const overrideCard = maturedCard(svc, 0.125);
    svc.setRetentionCard({ cardId: overrideCard, target: 0.01 });
    expect(svc.resolveRetentionFor({ cardId: overrideCard })).toEqual({
      target: 0.8,
      source: "card",
    });
    svc.close();
  });

  it("retention.setConcept logs update_element and changes the resolved target", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const card = maturedCard(svc, 0.375);
    const created = svc.createConcept({ name: "Fragile" });
    svc.assignConcept({ elementId: card, conceptId: created.concept.id });

    // Before: inherits global (no per-concept target yet).
    expect(svc.resolveRetentionFor({ cardId: card }).source).toBe("global");

    svc.setRetentionConcept({ conceptId: created.concept.id, target: 0.94 });
    const ops = svc.repos.operationLog.listForElement(created.concept.id as never);
    expect(ops.some((o) => o.opType === "update_element")).toBe(true);
    expect(svc.resolveRetentionFor({ cardId: card })).toEqual({ target: 0.94, source: "concept" });
    svc.close();
  });

  it("targets + the resolved scheduling SURVIVE a close + reopen (restart)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    first.updateAppSettings({ retentionByBandEnabled: true, retentionByBand: { A: 0.93 } });
    const card = maturedCard(first, 0.875);
    const created = first.createConcept({ name: "Durable" });
    first.setRetentionConcept({ conceptId: created.concept.id, target: 0.95 });
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    // The band target persisted.
    const retention = second.getRetention();
    expect(retention.byBandEnabled).toBe(true);
    expect(retention.byBand.A).toBeCloseTo(0.93, 6);
    // The per-concept target persisted + still resolves for an A-band card.
    expect(second.resolveRetentionFor({ cardId: card })).toEqual({ target: 0.93, source: "band" });
    expect(
      second.getRetention().byConcept.find((c) => c.conceptId === created.concept.id)?.target,
    ).toBeCloseTo(0.95, 6);
    second.close();
  });
});

describe("DbService — FSRS parameter optimization (T080)", () => {
  let dir: string;
  let dbPath: string;
  const ASOF = "2026-06-15T00:00:00.000Z";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-optimize-"));
    dbPath = path.join(dir, "app.sqlite");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function maturedCard(svc: DbService): string {
    const { element } = svc.repos.review.createCard({
      kind: "qa",
      title: "Matured",
      priority: 0.375,
      prompt: "Q",
      answer: "A",
    });
    svc.raw.sqlite
      .prepare(
        `UPDATE review_states SET stability = 30, difficulty = 5, reps = 5, fsrs_state = 'review',
         last_reviewed_at = '2026-05-16T00:00:00.000Z', due_at = ? WHERE element_id = ?`,
      )
      .run(ASOF, element.id);
    return element.id;
  }

  const intervalDays = (svc: DbService, cardId: string): number => {
    const { reviewState } = svc.gradeCard(cardId as never, "good", 1000, ASOF);
    return (Date.parse(reviewState.dueAt ?? ASOF) - Date.parse(ASOF)) / 86_400_000;
  };

  // A valid, in-bounds 21-number FSRS-6 vector that schedules a CLEARLY different
  // `good` interval than the ts-fsrs `default_w`. The decay `w[20]` is 0.8 (the FSRS-6
  // ceiling) so the vector round-trips through `clipParameters`/`checkParameters`
  // UNCHANGED — the stored value equals exactly what we applied.
  const STEEP_W = [
    0.4, 1.2, 3.1, 15.7, 7.2, 0.6, 1.0, 0.05, 1.5, 0.1, 1.0, 2.0, 0.05, 0.3, 1.5, 0.2, 3.0, 0.5,
    0.6, 0.1, 0.8,
  ];

  it("applyOptimization (global) is read by schedulerForCard → changes the scheduled interval", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const baseline = maturedCard(svc);
    const baselineInterval = intervalDays(svc, baseline);

    svc.applyOptimization({ scope: { scope: "global" }, params: STEEP_W });
    const afterCard = maturedCard(svc);
    const afterInterval = intervalDays(svc, afterCard);

    // The applied params reached FSRS via the scheduler factory → different interval.
    expect(afterInterval).not.toBeCloseTo(baselineInterval, 1);
    expect(svc.getAppSettings().settings.fsrsParamsGlobal).toEqual(STEEP_W);
    svc.close();
  });

  it("a concept preset OVERRIDES the global preset for a member card (queryable store)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    svc.applyOptimization({ scope: { scope: "global" }, params: STEEP_W });

    const card = maturedCard(svc);
    const created = svc.createConcept({ name: "Tuned" });
    svc.assignConcept({ elementId: card, conceptId: created.concept.id });
    // The concept preset (the ts-fsrs default-ish w) overrides the steep global one.
    const conceptW = [
      0.21, 1.26, 2.3, 8.27, 6.4, 0.83, 2.28, 0.05, 1.6, 0.13, 1.0, 2.1, 0.05, 0.3, 2.6, 0.2, 3.4,
      0.5, 0.6, 0.1, 0.15,
    ];
    svc.applyOptimization({
      scope: { scope: "concept", conceptId: created.concept.id },
      params: conceptW,
    });

    const stored = svc.repos.concepts.findById(created.concept.id as never)?.fsrsParams;
    expect(stored).toEqual(conceptW);
    svc.close();
  });

  it("suggestOptimization is read-only; insufficient history yields sufficientData false", async () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    maturedCard(svc);
    const before = svc.getAppSettings().settings.fsrsParamsGlobal;
    const suggestion = await svc.suggestOptimization({ scope: { scope: "global" } });
    expect(suggestion.sufficientData).toBe(false);
    expect(suggestion.params).toHaveLength(21);
    expect(suggestion.method).toBe("history-calibration");
    // Nothing was persisted by the suggest (no runner attached → inline fit).
    expect(svc.getAppSettings().settings.fsrsParamsGlobal).toEqual(before);
    svc.close();
  });

  it("applied global params SURVIVE a close + reopen (restart)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    first.applyOptimization({ scope: { scope: "global" }, params: STEEP_W });
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(second.getAppSettings().settings.fsrsParamsGlobal).toEqual(STEEP_W);
    second.close();
  });
});

// ---------------------------------------------------------------------------
// cards.retire / cards.unretire / cards.retired (T082) — mature-card retirement.
// ---------------------------------------------------------------------------

describe("DbService — mature-card retirement (T082)", () => {
  /** Author a card from a fresh source+extract (first-scheduled DUE); return its id. */
  function seedDueCard(svc: DbService): string {
    const { id: sourceId } = svc.importManualSource({
      title: "On the Measure of Intelligence",
      priority: "A",
      body: "The definition paragraph.\n\nAnother paragraph.",
    });
    const blockId = (
      svc.raw.sqlite
        .prepare("SELECT stable_block_id AS b FROM document_blocks WHERE document_id = ? LIMIT 1")
        .get(sourceId) as { b: string }
    ).b;
    const { extract } = svc.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph.",
      blockIds: [blockId],
      startOffset: 0,
      endOffset: 25,
    });
    const { card } = svc.createCard({
      extractId: extract.id,
      kind: "qa",
      prompt: "What can be retired?",
      answer: "A low-value mature card.",
    });
    return card.id;
  }

  it("retireCard flips the flag, drops the card from review, and is reversible (T082)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const cardId = seedDueCard(svc);
    const asOf = "2099-01-01T00:00:00.000Z";

    // Surfaceable before retiring.
    expect(svc.repos.queue.dueCards(asOf as never).map((c) => c.id)).toContain(cardId);

    const retired = svc.retireCard({ cardId });
    expect(retired.card.retired).toBe(true);
    // Gone from the due read (the flag, not the status).
    expect(svc.repos.queue.dueCards(asOf as never).map((c) => c.id)).not.toContain(cardId);

    // The inspector surfaces the retired state + the card is NOT soft-deleted.
    const insp = svc.getInspectorData(cardId);
    expect(insp.data?.review?.isRetired).toBe(true);
    expect(insp.data?.element.status).not.toBe("deleted");

    // Un-retire returns it to the deck.
    const back = svc.unretireCard({ cardId });
    expect(back.card.retired).toBe(false);
    expect(svc.repos.queue.dueCards(asOf as never).map((c) => c.id)).toContain(cardId);
    svc.close();
  });

  it("cardsRetired lists only live retired cards with stability + lineage (T082)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const retiredId = seedDueCard(svc);
    const liveId = seedDueCard(svc);

    expect(svc.cardsRetired().cards).toHaveLength(0);
    svc.retireCard({ cardId: retiredId });

    const list = svc.cardsRetired().cards;
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(retiredId);
    expect(list.map((c) => c.id)).not.toContain(liveId);
    expect(typeof list[0]?.stability).toBe("number");
    // Lineage source title travels with the inventory row.
    expect(list[0]?.sourceTitle).toBe("On the Measure of Intelligence");
    svc.close();
  });

  it("the retired count is reflected in analytics (T082)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const cardId = seedDueCard(svc);
    expect(svc.getAnalytics().retired).toBe(0);
    svc.retireCard({ cardId });
    expect(svc.getAnalytics().retired).toBe(1);
    svc.close();
  });

  it("retired state SURVIVES a close + reopen (restart), preserving review state (T082)", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const cardId = seedDueCard(first);
    const stateBefore = first.repos.review.findReviewState(cardId as never);
    first.retireCard({ cardId });
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    expect(second.cardsRetired().cards.map((c) => c.id)).toContain(cardId);
    expect(second.getInspectorData(cardId).data?.review?.isRetired).toBe(true);
    // The FSRS memory state is intact across restart (retire never touched it).
    const stateAfter = second.repos.review.findReviewState(cardId as never);
    expect(stateAfter?.dueAt).toBe(stateBefore?.dueAt);
    expect(stateAfter?.stability).toBe(stateBefore?.stability);
    second.close();
  });
});

describe("DbService tasks.* (T092 — verification tasks)", () => {
  it("createTask returns a TaskSummary with the resolved linkedElement and inherits priority", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const demo = seedDemoCollection(svc.repos, svc.raw.db);

    // The seed already links a `verify_claim` task to this card; a DIFFERENT kind
    // (`find_better_source`) is allowed on the same card (the partial index only dedups
    // by (linked_element_id, task_type)).
    const res = svc.createTask({
      taskType: "find_better_source",
      title: "Find a peer-reviewed source",
      note: "Check the 2024 revision",
      linkedElementId: demo.qaCard.element.id,
    });
    expect(res.task.taskType).toBe("find_better_source");
    expect(res.task.note).toBe("Check the 2024 revision");
    expect(res.task.linkedElement?.id).toBe(demo.qaCard.element.id);
    expect(res.task.linkedElement?.type).toBe("card");
    // Inherited from the A-priority seeded card.
    expect(res.task.priority).toBe(demo.qaCard.element.priority);
    svc.close();
  });

  it("list returns the seeded verify task; complete moves it out of the open set", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const demo = seedDemoCollection(svc.repos, svc.raw.db);

    const before = svc.listTasks({ linkedElementId: demo.qaCard.element.id });
    expect(before.tasks.map((t) => t.id)).toContain(demo.verifyTask.id);

    const done = svc.completeTask({ id: demo.verifyTask.id });
    expect(done.task.status).toBe("done");
    const after = svc.listTasks({ linkedElementId: demo.qaCard.element.id });
    expect(after.tasks.map((t) => t.id)).not.toContain(demo.verifyTask.id);
    svc.close();
  });

  it("generateFromExpiry creates a task for the expired seeded card and is idempotent", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    seedDemoCollection(svc.repos, svc.raw.db);

    const first = svc.generateVerificationTasks({});
    // The seeded Q&A card is expired (past valid_until) → update_outdated_card.
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(first.tasks.some((t) => t.taskType === "update_outdated_card")).toBe(true);

    const second = svc.generateVerificationTasks({});
    expect(second.created).toBe(0);
    svc.close();
  });

  it("createTask / verify task SURVIVES a close + reopen (restart) with its link intact", () => {
    const first = new DbService();
    first.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const demo = seedDemoCollection(first.repos, first.raw.db);
    const taskId = demo.verifyTask.id;
    const cardId = demo.qaCard.element.id;
    first.close();

    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const open = second.listTasks({ linkedElementId: cardId });
    expect(open.tasks.map((t) => t.id)).toContain(taskId);
    expect(open.tasks.find((t) => t.id === taskId)?.linkedElement?.id).toBe(cardId);
    second.close();
  });
});

// ---------------------------------------------------------------------------
// ai.listAiSuggestions → AiSuggestionView.groundingLocation (T094) — the IPC
// jump-to-source field. The underlying resolver has its own repo unit tests; here
// we pin the DbService MAPPING that threads it across the wire: a draft with a live
// grounding source carries a `LocationSummary` jump target (source element id +
// ordered stable block ids + offsets + derived label + verbatim quote, page/region
// null for a block source), and the orphan case (soft-deleted source) maps to null
// so the drafts panel shows no jump affordance.
// ---------------------------------------------------------------------------

describe("DbService — listAiSuggestions grounding location (T094)", () => {
  /** Seed a source + extract, attach one draft AI suggestion grounded on the first block. */
  function seedDraftWithGrounding(svc: DbService): {
    sourceId: string;
    extractId: string;
    blockId: string;
    suggestionId: string;
    locationLabel: string | null;
  } {
    const { id: sourceId } = svc.importManualSource({
      title: "On the Measure of Intelligence",
      priority: "A",
      body: "The definition paragraph.\n\nAnother paragraph.",
    });
    const blockId = (
      svc.raw.sqlite
        .prepare("SELECT stable_block_id AS b FROM document_blocks WHERE document_id = ? LIMIT 1")
        .get(sourceId) as { b: string }
    ).b;
    const { extract, location } = svc.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph.",
      blockIds: [blockId],
      startOffset: 0,
      endOffset: 25,
    });
    const created = svc.repos.aiSuggestions.create({
      owningElementId: extract.id as never,
      action: "suggest_qa",
      kind: "card_qa",
      providerKind: "anthropic",
      suggestionText: "MODEL: a Q&A about the definition",
      cards: [{ kind: "qa", prompt: "What is the definition?", answer: "Skill efficiency." }],
      grounding: {
        sourceElementId: sourceId as never,
        blockIds: [blockId as never],
        startOffset: 0,
        endOffset: 25,
        selectedText: "The definition paragraph.",
      },
    });
    return {
      sourceId,
      extractId: extract.id,
      blockId,
      suggestionId: created.id,
      locationLabel: location.label,
    };
  }

  it("maps groundingLocation to a jump-to-source LocationSummary on the originating block", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { extractId, sourceId, blockId, locationLabel } = seedDraftWithGrounding(svc);

    const { suggestions } = svc.listAiSuggestions({ elementId: extractId });
    expect(suggestions).toHaveLength(1);
    const view = suggestions[0];
    if (!view) throw new Error("expected one suggestion");

    // The wire field is populated (not the orphan null) and resolves the live span.
    const loc = view.groundingLocation;
    expect(loc).not.toBeNull();
    // Jump lands on the originating block of the source the model commented on.
    expect(loc?.sourceElementId).toBe(sourceId);
    expect(loc?.blockIds).toEqual([blockId]);
    expect(loc?.startOffset).toBe(0);
    expect(loc?.endOffset).toBe(25);
    // Verbatim quote + derived label travel with the jump target. The draft resolves
    // the SAME paragraph label as an extract anchored on that same block.
    expect(loc?.selectedText).toBe("The definition paragraph.");
    expect(loc?.label).toMatch(/^¶\d+$/);
    expect(loc?.label).toBe(locationLabel);
    // A block-anchored source has no page/region (those are PDF-only).
    expect(loc?.page).toBeNull();
    expect(loc?.region).toBeNull();
    // The model output stays SEPARATE from the source quote (T093 invariant, still intact).
    expect(view.text).toBe("MODEL: a Q&A about the definition");
    expect(view.grounding.snippet).toBe("The definition paragraph.");

    svc.close();
  });

  it("maps groundingLocation to null when the grounding source is soft-deleted (orphan)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { extractId, sourceId } = seedDraftWithGrounding(svc);

    // No live reader to jump into → the refblock must degrade to no jump affordance.
    svc.repos.elements.softDelete(sourceId as never);

    const { suggestions } = svc.listAiSuggestions({ elementId: extractId });
    expect(suggestions).toHaveLength(1);
    const view = suggestions[0];
    if (!view) throw new Error("expected one suggestion");
    expect(view.groundingLocation).toBeNull();
    // The verbatim quote is still preserved on the grounding ref for context.
    expect(view.grounding.snippet).toBe("The definition paragraph.");

    svc.close();
  });
});

describe("DbService synthesis-note wiring (T095)", () => {
  it("creates, links, edits, schedules + reads a synthesis note through the IPC seam (survives reopen)", () => {
    let noteId: string;
    {
      const svc = new DbService();
      svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
      const demo = seedDemoCollection(svc.repos, svc.raw.db);
      const extractId = demo.extract.element.id;
      const cardId = demo.qaCard.element.id;

      // create → a `synthesis_note` element, stage `synthesis`, status `pending`.
      const created = svc.createSynthesisNote({ title: "Weaving intelligence definitions" });
      noteId = created.element.id;
      expect(created.element.type).toBe("synthesis_note");
      expect(created.element.stage).toBe("synthesis");

      // link an extract + a card (references edges); idempotent on a duplicate.
      svc.linkSynthesisElement({ noteId, targetId: extractId });
      const linked = svc.linkSynthesisElement({ noteId, targetId: cardId });
      expect(linked.data.linked.map((l) => l.id).sort()).toEqual([extractId, cardId].sort());
      const dup = svc.linkSynthesisElement({ noteId, targetId: cardId });
      expect(dup.data.linked).toHaveLength(2); // no duplicate

      // editBody persists the body.
      svc.editSynthesisBody({
        noteId,
        prosemirrorJson: { type: "doc", content: [{ type: "paragraph" }] },
        plainText: "First synthesis pass.",
        blocks: [{ blockType: "paragraph", order: 0, stableBlockId: "blk_syn_0" }],
      });

      // scheduleReturn → ATTENTION scheduler (scheduled, a future due date), NEVER FSRS.
      const scheduled = svc.scheduleSynthesisReturn({ noteId, when: { kind: "nextWeek" } });
      expect(scheduled.data.element.status).toBe("scheduled");
      expect(scheduled.data.dueAt).toBeTruthy();
      // No review_states row was written (the two-scheduler split).
      const rs = svc.repos.review.findReviewState(noteId as never);
      expect(rs).toBeNull();

      svc.close();
    }

    // Reopen the SAME file: the note + its links + body + schedule all persisted.
    {
      const svc = new DbService();
      svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
      const { data } = svc.getSynthesisNote({ noteId });
      expect(data).not.toBeNull();
      expect(data?.element.type).toBe("synthesis_note");
      expect(data?.element.status).toBe("scheduled");
      expect(data?.linked).toHaveLength(2);
      expect(data?.dueAt).toBeTruthy();
      svc.close();
    }
  });
});

describe("DbService maintenance reads (T099)", () => {
  it("returns typed report payloads over a seeded collection (with a vault dir)", async () => {
    const assetsDir = path.join(dir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR, assetsDir });
    seedDemoCollection(svc.repos, svc.raw.db);

    const report = await svc.getMaintenanceReport();
    expect(typeof report.duplicateCount).toBe("number");
    expect(typeof report.cardsWithoutSourcesCount).toBe("number");
    expect(typeof report.orphanFileCount).toBe("number");
    expect(report.integrity).toBeNull();

    const dup = svc.getMaintenanceDuplicates();
    expect(Array.isArray(dup.sourceClusters)).toBe(true);
    expect(Array.isArray(dup.cardClusters)).toBe(true);

    const sourceless = svc.getMaintenanceCardsWithoutSources();
    expect(Array.isArray(sourceless.rows)).toBe(true);

    const broken = await svc.getMaintenanceBrokenSources();
    expect(Array.isArray(broken.rows)).toBe(true);

    const low = svc.getMaintenanceLowValue();
    expect(Array.isArray(low.rows)).toBe(true);

    const integrity = await svc.getMaintenanceIntegrity();
    expect(integrity.db.ok).toBe(true);
    expect(integrity.db.foreignKeyViolations).toBe(0);

    svc.close();
  });
});
