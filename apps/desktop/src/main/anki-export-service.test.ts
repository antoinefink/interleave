/**
 * AnkiExportService integration tests (T070) — against a real temp-file SQLite DB +
 * temp `assetsDir`/download export dir. Authors cards via the normal pipeline, exports them
 * to an `.apkg`/CSV in the injected export dir, and — the load-bearing contract — ROUND-TRIPS the
 * `.apkg` back through `AnkiImportService` asserting the prompts/answers/cloze text +
 * the SOURCE REF survive (the source ref lands in the re-imported card's `sourceUri`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElementId } from "@interleave/core";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbService } from "./db-service";

let dir: string;
let dbPath: string;
let assetsDir: string;
let exportDestinationDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-ankiexp-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  exportDestinationDir = path.join(dir, "downloads");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(exportDestinationDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function openSvc(): DbService {
  const svc = new DbService();
  svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR, assetsDir, exportDestinationDir });
  return svc;
}

/** Author a source → extract → Q&A + cloze card pair, returning the card ids. */
function seedCards(svc: DbService): { qaId: ElementId; clozeId: ElementId } {
  const { element: source } = svc.repos.sources.createWithDocument({
    title: "Atlas of the World",
    priority: 0.625,
    status: "active",
    stage: "raw_source",
    url: "https://example.com/atlas",
    body: "The capital of France is Paris.",
  });
  const { element: extract } = svc.repos.sources.createExtract({
    sourceElementId: source.id,
    title: "Capital extract",
    priority: 0.625,
    stage: "atomic_statement",
    selectedText: "The capital of France is Paris.",
    blockIds: [],
    label: "¶1",
  });
  const qa = svc.createCard({
    extractId: extract.id,
    kind: "qa",
    prompt: "Capital of France?",
    answer: "Paris",
  });
  const cloze = svc.createCard({
    extractId: extract.id,
    kind: "cloze",
    cloze: "The capital of France is {{c1::Paris}}.",
    siblingGroupId: qa.card.siblingGroupId,
  });
  return { qaId: qa.card.id as ElementId, clozeId: cloze.card.id as ElementId };
}

describe("AnkiExportService (T070)", () => {
  it("exports selected cards to an .apkg in the injected export directory", async () => {
    const svc = openSvc();
    const { qaId, clozeId } = seedCards(svc);
    const result = await svc.ankiExportService.exportApkg({ cardIds: [qaId, clozeId] });
    expect(result.cardCount).toBe(2);
    expect(result.relativePath.endsWith(".apkg")).toBe(true);
    expect(fs.existsSync(result.absPath)).toBe(true);
    // The file lives under the main-process injected export dir (never a renderer-chosen path).
    expect(result.absPath.startsWith(exportDestinationDir)).toBe(true);
    svc.close();
  });

  it("exports CSV with the expected rows (fields + tags + source column)", async () => {
    const svc = openSvc();
    const { qaId } = seedCards(svc);
    const result = await svc.ankiExportService.exportCsv({ cardIds: [qaId] });
    expect(result.absPath.startsWith(exportDestinationDir)).toBe(true);
    const csv = fs.readFileSync(result.absPath, "utf8");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("Front,Back,Cloze,Tags,Source");
    // The data row carries the prompt/answer + the source ref (title — url).
    expect(lines[1]).toContain("Capital of France?");
    expect(lines[1]).toContain("Paris");
    expect(lines[1]).toContain("Atlas of the World");
    expect(lines[1]).toContain("https://example.com/atlas");
    svc.close();
  });

  it("round-trips: export to .apkg then import it back, source ref intact", async () => {
    const svc = openSvc();
    const { qaId, clozeId } = seedCards(svc);
    const exported = await svc.ankiExportService.exportApkg({ cardIds: [qaId, clozeId] });

    // Import the exported .apkg back into the SAME app (a fresh deck source).
    const imported = await svc.ankiImportService.importFromFile({ absPath: exported.absPath });
    expect(imported.cardCount).toBe(2);

    // The re-imported cards live under the new deck source; assert prompts/cloze + the
    // source ref survived the round-trip (the ref is in the re-imported card's sourceUri).
    const deckId = imported.item.id;
    const reimported = svc.repos.elements
      .listByType("card")
      .filter((c) => svc.repos.review.findCardById(c.id)?.element.sourceId === deckId);
    expect(reimported).toHaveLength(2);

    const qa = reimported.find((c) => svc.repos.review.findCardById(c.id)?.card.kind === "qa");
    const qaCard = svc.repos.review.findCardById(qa?.id as never);
    expect(qaCard?.card.prompt).toBe("Capital of France?");
    expect(qaCard?.card.answer).toBe("Paris");
    // The source ref round-tripped OUT to the Anki Source field and back IN to sourceUri.
    expect(qaCard?.card.sourceUri).toContain("Atlas of the World");
    expect(qaCard?.card.sourceUri).toContain("https://example.com/atlas");

    const cloze = reimported.find(
      (c) => svc.repos.review.findCardById(c.id)?.card.kind === "cloze",
    );
    const clozeCard = svc.repos.review.findCardById(cloze?.id as never);
    expect(clozeCard?.card.cloze).toBe("The capital of France is {{c1::Paris}}.");

    svc.close();
  });

  it("exports all live cards when all=true", async () => {
    const svc = openSvc();
    seedCards(svc);
    const result = await svc.exportAnki({ format: "apkg", all: true });
    expect(result.cardCount).toBe(2);
    expect(result.directoryLabel).toBe("Downloads");
    expect(result).not.toHaveProperty("absPath");
    const csv = await svc.exportAnki({ format: "csv", all: true });
    expect(csv.cardCount).toBe(2);
    expect(csv.directoryLabel).toBe("Downloads");
    expect(csv).not.toHaveProperty("absPath");
    svc.close();
  });

  it("rejects an empty selection with a typed error", async () => {
    const svc = openSvc();
    await expect(
      svc.exportAnki({ format: "apkg", cardIds: ["does-not-exist" as ElementId] }),
    ).rejects.toMatchObject({ code: "empty_selection" });
    svc.close();
  });
});
