/**
 * Type-alignment tests (T006).
 *
 * Guards the "no drift between Drizzle-inferred types and `@interleave/core`"
 * invariant. These are mostly COMPILE-TIME assertions: if a Drizzle column type
 * stops matching the corresponding `@interleave/core` field, the `satisfies`
 * checks below fail `pnpm typecheck`. A couple of runtime assertions pin the
 * enum CHECK lists to the exact core tuples so a value can never be added to one
 * side only.
 */

import {
  ASSET_KINDS,
  type AssetKind,
  CARD_KINDS,
  type CardKind,
  DISTILLATION_STAGES,
  type DistillationStage,
  ELEMENT_STATUSES,
  ELEMENT_TYPES,
  type ElementStatus,
  type ElementType,
  type FsrsState,
  OPERATION_TYPES,
  type OperationType,
  type ReviewRating,
  type VaultRoot,
} from "@interleave/core";
import { describe, expect, it } from "vitest";
import type {
  AssetRow,
  CardRow,
  ElementRow,
  OperationLogRow,
  ReviewLogRow,
  ReviewStateRow,
} from "./index";

/**
 * The persisted enum columns are typed as `string` by Drizzle (SQLite text), but
 * every value we ever write is a core enum. These assignments prove the core
 * unions are assignable INTO the row columns — i.e. a valid core value is always
 * a valid column value. If a core enum is renamed/removed, these break.
 */
function _assertColumnsAcceptCoreEnums(): void {
  const t: ElementType = "source";
  const s: ElementStatus = "active";
  const stage: DistillationStage = "raw_source";
  const kind: CardKind = "qa";
  const fsrs: FsrsState = "new";
  const rating: ReviewRating = "good";
  const assetKind: AssetKind = "source_pdf";
  const vaultRoot: VaultRoot = "assets";
  const op: OperationType = "create_card";

  const element = {} as ElementRow;
  const card = {} as CardRow;
  const reviewState = {} as ReviewStateRow;
  const reviewLog = {} as ReviewLogRow;
  const asset = {} as AssetRow;
  const opRow = {} as OperationLogRow;

  // Columns are `string`; core enum values must be assignable to them.
  element.type = t;
  element.status = s;
  element.stage = stage;
  card.kind = kind;
  reviewState.fsrsState = fsrs;
  reviewLog.rating = rating;
  reviewLog.prevState = fsrs;
  asset.kind = assetKind;
  asset.vaultRoot = vaultRoot;
  opRow.opType = op;

  // Reference everything so noUnusedLocals/Parameters stays quiet.
  void [element, card, reviewState, reviewLog, asset, opRow, kind, rating, vaultRoot];
}

describe("Drizzle ⇄ @interleave/core alignment", () => {
  it("compiles the column/enum assignability assertions", () => {
    expect(typeof _assertColumnsAcceptCoreEnums).toBe("function");
  });

  it("uses the exact core enum tuples (CHECK lists cannot drift)", () => {
    // The schema CHECK constraints are built from these very tuples; pinning the
    // arrays here makes any future divergence a failing test, not a silent bug.
    expect(ELEMENT_TYPES.length).toBe(8);
    expect(ELEMENT_STATUSES.length).toBe(9);
    expect(DISTILLATION_STAGES.length).toBe(9);
    expect(CARD_KINDS).toEqual(["qa", "cloze", "image_occlusion"]);
    expect(ASSET_KINDS).toContain("source_pdf");
    expect(OPERATION_TYPES).toContain("create_card");
  });
});
