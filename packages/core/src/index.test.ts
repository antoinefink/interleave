import { describe, expect, it } from "vitest";
import {
  CARD_KINDS,
  CORE_PACKAGE,
  DISTILLATION_STAGES,
  ELEMENT_STATUSES,
  ELEMENT_TYPES,
  isOperationType,
  OPERATION_TYPES,
} from "./index";

/**
 * Package-surface tests (T005). These guard the two things most likely to break
 * silently and most expensive to fix later: (1) the package name constant, and
 * (2) the canonical enum/op-type values, which are persisted and synced verbatim
 * — a casual rename here is a data migration, so we pin the exact strings.
 */
describe("@interleave/core surface", () => {
  it("exposes the package name constant", () => {
    expect(CORE_PACKAGE).toBe("@interleave/core");
  });

  it("pins the element types to the canonical vocabulary", () => {
    expect([...ELEMENT_TYPES]).toEqual([
      "source",
      "topic",
      "extract",
      "card",
      "task",
      "concept",
      "media_fragment",
      "synthesis_note",
    ]);
  });

  it("pins the lifecycle statuses to the canonical vocabulary", () => {
    expect([...ELEMENT_STATUSES]).toEqual([
      "inbox",
      "pending",
      "active",
      "scheduled",
      "done",
      "parked",
      "dismissed",
      "suspended",
      "deleted",
    ]);
  });

  it("pins the card kinds to the canonical vocabulary (incl. image_occlusion, T071)", () => {
    expect([...CARD_KINDS]).toEqual(["qa", "cloze", "image_occlusion"]);
  });

  it("pins the distillation stages to the canonical vocabulary", () => {
    expect([...DISTILLATION_STAGES]).toEqual([
      "raw_source",
      "rough_topic",
      "raw_extract",
      "clean_extract",
      "atomic_statement",
      "card_draft",
      "active_card",
      "mature_card",
      "synthesis",
    ]);
  });

  it("pins the operation-log command types to the canonical vocabulary", () => {
    expect([...OPERATION_TYPES]).toEqual([
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
  });

  it("recognizes valid op types and rejects others", () => {
    expect(isOperationType("create_element")).toBe(true);
    expect(isOperationType("reschedule_element")).toBe(true);
    expect(isOperationType("frobnicate")).toBe(false);
    expect(isOperationType(42)).toBe(false);
    expect(isOperationType(undefined)).toBe(false);
  });
});
