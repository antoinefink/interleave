import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { assets, operationLog, retirementSuggestionDismissals, settings } from "./system";

describe("system schema", () => {
  it("keeps asset vault metadata out of SQLite blob storage", () => {
    const columns = getTableColumns(assets);

    expect(getTableName(assets)).toBe("assets");
    expect(Object.keys(columns)).toEqual([
      "id",
      "owningElementId",
      "kind",
      "vaultRoot",
      "relativePath",
      "contentHash",
      "mime",
      "size",
      "width",
      "height",
      "durationMs",
      "createdAt",
    ]);
    expect(columns.relativePath.name).toBe("relative_path");
    expect(columns.durationMs.name).toBe("duration_ms");
  });

  it("pins append-only operation log and settings tables", () => {
    expect(getTableName(operationLog)).toBe("operation_log");
    expect(Object.keys(getTableColumns(operationLog))).toEqual([
      "id",
      "opType",
      "payload",
      "elementId",
      "createdAt",
    ]);
    expect(getTableName(settings)).toBe("settings");
    expect(Object.keys(getTableColumns(settings))).toEqual(["key", "value"]);
  });

  it("pins retirement-suggestion dismissal memory", () => {
    expect(getTableName(retirementSuggestionDismissals)).toBe("retirement_suggestion_dismissals");
    expect(Object.keys(getTableColumns(retirementSuggestionDismissals))).toEqual([
      "sourceElementId",
      "signalHash",
      "dismissedAt",
    ]);
  });
});
