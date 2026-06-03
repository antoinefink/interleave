import { describe, expect, it } from "vitest";
import {
  ASSET_KINDS,
  CARD_KINDS,
  DISTILLATION_STAGES,
  ELEMENT_STATUSES,
  ELEMENT_TYPES,
  FSRS_STATES,
  isMarkType,
  JOB_STATUSES,
  JOB_TYPES,
  MARK_TYPES,
  OCR_PAGE_STATUSES,
  RELATION_TYPES,
  REVIEW_RATING_VALUE,
  REVIEW_RATINGS,
  VAULT_ROOTS,
} from "./enums";

const expectNoDuplicates = (values: readonly string[]) => {
  expect(new Set(values).size).toBe(values.length);
};

describe("persisted enum vocabularies", () => {
  it("pins the canonical element, status, stage, and relation values", () => {
    expect(ELEMENT_TYPES).toEqual([
      "source",
      "topic",
      "extract",
      "card",
      "task",
      "concept",
      "media_fragment",
      "synthesis_note",
    ]);
    expect(ELEMENT_STATUSES).toEqual([
      "inbox",
      "pending",
      "active",
      "scheduled",
      "done",
      "dismissed",
      "suspended",
      "deleted",
    ]);
    expect(DISTILLATION_STAGES).toEqual([
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
    expect(RELATION_TYPES).toEqual([
      "parent_child",
      "derived_from",
      "sibling_group",
      "concept_membership",
      "references",
    ]);
  });

  it("pins review, asset, vault, job, and OCR vocabularies", () => {
    expect(MARK_TYPES).toEqual(["highlight", "extracted_span", "processed_span", "cloze"]);
    expect(CARD_KINDS).toEqual(["qa", "cloze", "image_occlusion"]);
    expect(FSRS_STATES).toEqual(["new", "learning", "review", "relearning"]);
    expect(REVIEW_RATINGS).toEqual(["again", "hard", "good", "easy"]);
    expect(REVIEW_RATING_VALUE).toEqual({ again: 1, hard: 2, good: 3, easy: 4 });
    expect(ASSET_KINDS).toEqual([
      "source_html",
      "source_pdf",
      "source_epub",
      "import_archive",
      "snapshot",
      "image",
      "audio",
      "video",
      "export",
      "backup",
    ]);
    expect(VAULT_ROOTS).toEqual(["assets", "exports", "backups"]);
    expect(JOB_TYPES).toEqual([
      "url_import",
      "ocr",
      "epub_import",
      "embed",
      "ai",
      "cleanup",
      "vault_verify",
      "vault_gc",
      "fsrs_optimize",
    ]);
    expect(JOB_STATUSES).toEqual(["queued", "running", "succeeded", "failed", "cancelled"]);
    expect(OCR_PAGE_STATUSES).toEqual(["suggested", "accepted", "dismissed"]);
  });

  it("keeps every persisted tuple duplicate-free", () => {
    for (const values of [
      ELEMENT_TYPES,
      ELEMENT_STATUSES,
      DISTILLATION_STAGES,
      RELATION_TYPES,
      MARK_TYPES,
      CARD_KINDS,
      FSRS_STATES,
      REVIEW_RATINGS,
      ASSET_KINDS,
      VAULT_ROOTS,
      JOB_TYPES,
      JOB_STATUSES,
      OCR_PAGE_STATUSES,
    ]) {
      expectNoDuplicates(values);
    }
  });
});

describe("isMarkType", () => {
  it("accepts only canonical document mark strings", () => {
    for (const value of MARK_TYPES) {
      expect(isMarkType(value)).toBe(true);
    }
    expect(isMarkType("processed")).toBe(false);
    expect(isMarkType("highlight ")).toBe(false);
    expect(isMarkType(null)).toBe(false);
  });
});
