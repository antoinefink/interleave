import { describe, expect, it } from "vitest";
import { isOperationType, OPERATION_TYPES } from "./operation-log";

describe("operation log vocabulary", () => {
  it("pins the closed set of persisted operation types", () => {
    expect(OPERATION_TYPES).toEqual([
      "create_element",
      "update_element",
      "soft_delete_element",
      "restore_element",
      "create_source",
      "update_document",
      "set_read_point",
      "create_extract",
      "create_card",
      "add_review_log",
      "reschedule_element",
      "add_relation",
      "remove_relation",
      "add_tag",
      "remove_tag",
    ]);
    expect(new Set(OPERATION_TYPES).size).toBe(OPERATION_TYPES.length);
  });

  it("guards canonical operation strings", () => {
    for (const value of OPERATION_TYPES) {
      expect(isOperationType(value)).toBe(true);
    }
    expect(isOperationType("delete_element")).toBe(false);
    expect(isOperationType("create-source")).toBe(false);
    expect(isOperationType(undefined)).toBe(false);
  });
});
