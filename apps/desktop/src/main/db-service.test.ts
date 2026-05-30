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
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    svc.updateSetting("theme", "light");
    expect(svc.getSettings("theme").settings.theme).toBe("light");

    // No key omitted → all settings; exactly one row for the key.
    const all = svc.getSettings();
    expect(all.settings.theme).toBe("light");

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

  it("stores and reads complex JSON-serializable values", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const value = { layout: "qwerty", flags: [true, false], nested: { n: 1 } };
    svc.updateSetting("keyboard", value);
    expect(svc.getSettings("keyboard").settings.keyboard).toEqual(value);

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
      theme: "light",
    });
    expect(settings.dailyReviewBudget).toBe(120);
    expect(settings.keyboardLayout).toBe("vim");
    expect(settings.theme).toBe("light");
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

  it("surfaces derived provenance through the inbox detail (T014)", () => {
    const svc = new DbService();
    svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR });

    const { id } = svc.importManualSource({
      title: "Visible provenance",
      url: "https://example.com/a?fbclid=x",
    });
    const { detail } = svc.getInboxItem(id);
    expect(detail?.provenance.canonicalUrl).toBe("https://example.com/a");
    expect(detail?.provenance.originalUrl).toBe("https://example.com/a?fbclid=x");
    expect(detail?.provenance.accessedAt).not.toBeNull();

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
      keyboardLayout: "dvorak",
      theme: "light",
    });
    first.close();

    // A brand-new service opening the SAME file must see every value.
    const second = new DbService();
    second.open(dbPath, { migrationsDir: MIGRATIONS_DIR });
    const { settings } = second.getAppSettings();
    expect(settings).toEqual({
      dailyReviewBudget: 90,
      defaultDesiredRetention: 0.95,
      defaultTopicIntervalDays: 30,
      defaultSourcePriority: 0.875,
      keyboardLayout: "dvorak",
      theme: "light",
    });
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
});
