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
    expect(settings).toEqual({
      dailyReviewBudget: 90,
      defaultDesiredRetention: 0.95,
      defaultTopicIntervalDays: 30,
      defaultSourcePriority: 0.875,
      burySiblings: false,
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

    // The card summary carries the lineage + the mapped numeric priority.
    expect(result.card.kind).toBe("qa");
    expect(result.card.stage).toBe("card_draft");
    expect(result.card.status).toBe("pending");
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

    // The review_states row exists but is UN-DUE (no FSRS math in M6).
    const rs = svc.repos.review.findReviewState(result.card.id as never);
    expect(rs?.dueAt).toBeNull();
    expect(rs?.fsrsState).toBe("new");

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
    expect(reopened?.element.stage).toBe("card_draft");
    expect(reopened?.element.parentId).toBe(extractId);
    expect(reopened?.element.sourceId).toBe(sourceId);
    expect(reopened?.card.prompt).toBe("Durable prompt?");
    expect(reopened?.card.answer).toBe("Durable answer.");
    // Still un-due after the restart (FSRS scheduling is M7).
    const rs = second.repos.review.findReviewState(cardId as never);
    expect(rs?.dueAt).toBeNull();
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
    // The deck is FSRS cards only — never an extract/source.
    expect(res.card?.kind === "qa" || res.card?.kind === "cloze").toBe(true);
    // The card ships its answer + lineage so reveal needs no round-trip.
    expect(res.card?.schedulerSignals.kind).toBe("fsrs");
    expect(typeof res.card?.prompt).toBe("string");

    svc.close();
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
      responseMs: 3200,
      asOf: ASOF,
    });

    // The durable review log was written with the response time + rating.
    expect(result.reviewLog.rating).toBe("good");
    expect(result.reviewLog.responseMs).toBe(3200);
    expect(result.reviewLog.elementId).toBe(cardId);

    // Exactly one new review_logs row.
    const afterLogs = svc.repos.review.listReviewLogs(cardId as never).length;
    expect(afterLogs).toBe(beforeLogs + 1);

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
    svc.reviewGrade({ cardId, rating: "again", responseMs: 8000, asOf: ASOF });
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
      svc.reviewGrade({ cardId: extract?.id ?? "", rating: "good", responseMs: 100, asOf: ASOF }),
    ).toThrow();
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
   * Create a due Q&A card and return its id. Cards are created un-due; we set
   * `review_states.due_at` to a past date so it enters the FSRS deck at `ASOF`.
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
    expect(() => svc.updateCard({ cardId: id, prompt: "x", answer: "y" })).toThrow();
    expect(() => svc.suspendCard({ cardId: id })).toThrow();
    expect(() => svc.deleteCard({ cardId: id })).toThrow();
    expect(() => svc.flagCard({ cardId: "el_missing", flagged: true })).toThrow();
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
      const { reviewState } = svc.reviewGrade({ cardId, rating, responseMs: 4000, asOf: at });
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
