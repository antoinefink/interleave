/**
 * ExtractService (T024) — extract review mode.
 *
 * After T021 lifts a fragment into an independent, attention-scheduled `extract`
 * element, the user processes that extract over time as a readable mini-topic.
 * This service owns the distillation ACTIONS on an existing extract — the domain
 * logic the extract view (`apps/web`) drives through the typed `extracts.*`
 * `window.appApi` surface, never from React:
 *
 *  - **advance stage** — walk `raw_extract → clean_extract → atomic_statement`,
 *    persisting the new `stage` (`update_element`) AND rescheduling the extract on
 *    the ATTENTION scheduler (`reschedule_element`) by the by-stage interval
 *    heuristic. A stage transition NEVER creates a card and NEVER touches FSRS —
 *    `atomic_statement` means "ready to become a card", not a card.
 *  - **rewrite** — save an edited body (`update_document`) via
 *    {@link DocumentRepository.upsert}; lineage/anchor untouched.
 *  - **trim** — a body cleanup (collapse runs of whitespace + drop filler) that is
 *    just a rewrite of the cleaned text (`update_document`).
 *  - **postpone** — reschedule further out (`reschedule_element`) and record a
 *    postpone marker in the op payload so the attention scheduler (T028) +
 *    stagnation analytics (T084) can count postpones WITHOUT a schema migration.
 *  - **mark done** — status `done` + clear active due (`update_element`); the extract
 *    leaves the active rotation but its lineage stays intact.
 *  - **delete** — SOFT delete (`soft_delete_element`); never destroys user data,
 *    lineage rows remain valid, recoverable from the trash.
 *
 * Every action runs in ONE transaction together with its `operation_log` append
 * (the closed 15-op set — no new op types). The stage axis (`raw_extract`/
 * `clean_extract`/`atomic_statement`) is deliberately distinct from the status
 * axis; this service moves the stage, not the status, on an advance.
 */

import type { BlockId, Element, ElementId, ExtractFate, Priority } from "@interleave/core";
import {
  elementRelations,
  elements as elementsTable,
  type InterleaveDatabase,
} from "@interleave/db";
import {
  addDays,
  EXTRACT_STAGES,
  type ExtractStage,
  extractStageIntervalDays,
  isExtractStage,
  nextExtractStage,
  postponeIntervalForPriority,
} from "@interleave/scheduler";
import { and, eq, isNull } from "drizzle-orm";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient } from "./types";

// The extract stage chain + interval math is the attention scheduler's concern and
// now lives ONCE in `@interleave/scheduler` (T028). These re-exports keep the
// historical import sites (`@interleave/local-db`, the M4 tests) working without a
// second copy of the math — `extract-service.ts` consumes the scheduler, never
// re-derives intervals.
export {
  EXTRACT_STAGES,
  type ExtractStage,
  extractStageIntervalDays,
  isExtractStage,
  nextExtractStage,
};

/**
 * The base postpone interval (DAYS) for an extract by priority — pushes further out.
 * A thin re-export of the scheduler's `postponeIntervalForPriority(priority, 0)`
 * (the postpone-count-zero base) so the historical `postponeIntervalDays` symbol
 * keeps its meaning; the GROWTH with postpone count is applied in
 * {@link ExtractService.postpone} via the scheduler.
 */
export function postponeIntervalDays(priority: Priority): number {
  return postponeIntervalForPriority(priority, 0);
}

/**
 * Collapse runs of whitespace and trim leading/trailing space from each line —
 * the conservative "trim whitespace & filler" the kit's Trim button promises. It
 * never deletes words; it only normalizes spacing so a raw paste reads cleanly.
 */
export function trimExtractText(text: string): string {
  return text
    .split(/\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The result of an extract action — the updated element (+ optional body text). */
export interface ExtractActionResult {
  readonly element: Element;
  /** The new plain-text body after a rewrite/trim, when the body changed. */
  readonly plainText?: string;
}

/** Direct user-settable extract fates. `synthesized` is owned by synthesis-note lineage. */
export type DirectExtractFate = Exclude<ExtractFate, "synthesized">;

/** Arguments to rewrite/trim an extract's body. */
export interface RewriteExtractInput {
  readonly elementId: ElementId;
  /** The new ProseMirror document JSON (built renderer-side). */
  readonly prosemirrorJson: unknown;
  /** The flattened plain-text mirror (computed renderer-side). */
  readonly plainText: string;
  /** The ordered stable block list (preserves the stable ids), when present. */
  readonly blocks?: readonly { blockType: string; order: number; stableBlockId: string }[];
}

export class ExtractService {
  private readonly elements: ElementRepository;
  private readonly documents: DocumentRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.documents = new DocumentRepository(db);
  }

  /** Load an extract element by id, throwing when it is missing or not an extract. */
  private requireExtract(id: ElementId): Element {
    const element = this.elements.findById(id);
    if (!element || element.deletedAt) {
      throw new Error(`ExtractService: extract ${id} not found`);
    }
    if (element.type !== "extract") {
      throw new Error(`ExtractService: element ${id} is a ${element.type}, not an extract`);
    }
    return element;
  }

  /**
   * Advance an extract one step along `raw_extract → clean_extract →
   * atomic_statement`, in ONE transaction: persist the new `stage`
   * (`update_element`) and reschedule it on the ATTENTION scheduler
   * (`reschedule_element`) by the by-stage interval. Throws when the extract is
   * already at `atomic_statement` (nothing to advance). Does NOT create a card and
   * does NOT touch FSRS — `atomic_statement` is "card-ready", not a card.
   */
  advanceStage(id: ElementId): ExtractActionResult {
    const element = this.requireExtract(id);
    if (!isExtractStage(element.stage)) {
      throw new Error(
        `ExtractService.advanceStage: extract ${id} has non-extract stage ${element.stage}`,
      );
    }
    const next = nextExtractStage(element.stage);
    if (!next) {
      throw new Error(`ExtractService.advanceStage: extract ${id} is already atomic_statement`);
    }
    return this.setStage(id, next);
  }

  /**
   * Set an extract's stage to an explicit step in the chain (used by the stepper
   * which can move to any stage), rescheduling it on the attention scheduler. One
   * transaction; logs `update_element` + `reschedule_element`.
   */
  setStage(id: ElementId, stage: ExtractStage): ExtractActionResult {
    const element = this.requireExtract(id);
    this.assertNotFated(element, "setStage");
    return this.db.transaction((tx) => {
      // Persist the new stage first (update_element), then reschedule on the
      // attention scheduler (reschedule_element). Because both run on the SAME tx,
      // the reschedule re-reads the row with the new stage already applied, so the
      // returned element reflects BOTH the new stage and the new due date.
      this.elements.updateWithin(tx, id, { stage });
      const dueAt = addDays(nowIso(), extractStageIntervalDays(stage, element.priority));
      const rescheduled = this.elements.rescheduleWithin(tx, id, dueAt, "scheduled");
      return { element: rescheduled };
    });
  }

  /**
   * Rewrite (or trim) an extract's body: upsert the new ProseMirror body + stable
   * blocks via {@link DocumentRepository.upsert} (logs `update_document`). The
   * lineage/anchor + scheduling are untouched — editing the text is not a stage
   * move. Returns the unchanged element + the new plain text.
   */
  rewrite(input: RewriteExtractInput): ExtractActionResult {
    const element = this.requireExtract(input.elementId);
    this.documents.upsert({
      elementId: input.elementId,
      prosemirrorJson: input.prosemirrorJson,
      plainText: input.plainText,
      ...(input.blocks
        ? {
            blocks: input.blocks.map((b) => ({
              blockType: b.blockType,
              order: b.order,
              stableBlockId: b.stableBlockId as BlockId,
            })),
          }
        : {}),
    });
    return { element, plainText: input.plainText };
  }

  /**
   * Postpone an extract: reschedule it further out on the attention scheduler and
   * record a `postpone` marker + the running postpone count in the
   * `reschedule_element` op payload, so the attention scheduler (T028) and
   * stagnation analytics (T084) can read the postpone history WITHOUT a schema
   * migration. One transaction; logs `reschedule_element`.
   */
  postpone(id: ElementId): ExtractActionResult {
    const element = this.requireExtract(id);
    this.assertNotFated(element, "postpone");
    const priorCount = this.countPostpones(id);
    return this.db.transaction((tx) => {
      // The interval GROWS with the running postpone count (stagnation recedes):
      // the first postpone (priorCount 0) is the base window; each further postpone
      // pushes further out, per `@interleave/scheduler`. Single source of truth.
      const dueAt = addDays(nowIso(), postponeIntervalForPriority(element.priority, priorCount));
      const rescheduled = this.elements.rescheduleWithin(tx, id, dueAt, "scheduled", {
        postpone: true,
        postponeCount: priorCount + 1,
      });
      return { element: rescheduled };
    });
  }

  /**
   * Mark an extract done: status `done` and clear active due via
   * {@link ElementRepository.update} (`update_element`). The extract leaves the
   * active rotation; its body, anchor, and lineage stay intact and recoverable.
   */
  markDone(id: ElementId): ExtractActionResult {
    this.requireExtract(id);
    return { element: this.elements.update(id, { status: "done", dueAt: null }) };
  }

  /**
   * Mark an extract as honorably terminal without making a card. This is one
   * `update_element` patch so undo restores status, due date, parked state, and fate
   * together. Direct users cannot set `synthesized`; that fate is maintained by
   * `SynthesisService` when a live synthesis note references the extract.
   */
  setFate(id: ElementId, fate: DirectExtractFate): ExtractActionResult {
    if ((fate as ExtractFate) === "synthesized") {
      throw new Error(
        "ExtractService.setFate: synthesized fate is maintained by synthesis-note lineage",
      );
    }
    this.requireExtract(id);
    return {
      element: this.elements.update(id, {
        status: "done",
        dueAt: null,
        parkedAt: null,
        extractFate: fate,
      }),
    };
  }

  /**
   * Return a fated extract to active distillation work. This avoids the ambiguous
   * `done` + no-fate state by scheduling it immediately in the attention queue.
   */
  reactivateFate(id: ElementId): ExtractActionResult {
    const element = this.requireExtract(id);
    if (element.extractFate === "synthesized" && this.hasLiveSynthesisReference(id)) {
      throw new Error(
        "ExtractService.reactivateFate: unlink the extract from live synthesis notes before reactivating it",
      );
    }
    return {
      element: this.elements.update(id, {
        status: "scheduled",
        dueAt: nowIso(),
        parkedAt: null,
        extractFate: null,
      }),
    };
  }

  /**
   * Cache synthesized fate from authoritative synthesis-note lineage. Callers must
   * only invoke this while adding/removing a live `references` edge.
   */
  setSynthesizedFateWithin(tx: DbClient, id: ElementId): Element {
    const element = this.requireExtract(id);
    if (element.extractFate !== null) return element;
    return this.elements.updateWithin(tx, id, {
      status: "done",
      dueAt: null,
      parkedAt: null,
      extractFate: "synthesized",
    });
  }

  clearSynthesizedFateWithin(tx: DbClient, id: ElementId): Element {
    const element = this.requireExtract(id);
    if (element.extractFate !== "synthesized") return element;
    return this.elements.updateWithin(tx, id, {
      status: "scheduled",
      dueAt: nowIso(),
      parkedAt: null,
      extractFate: null,
    });
  }

  clearSynthesizedFateCacheWithin(tx: DbClient, id: ElementId): Element {
    const element = this.elements.findById(id);
    if (!element) {
      throw new Error(`ExtractService: extract ${id} not found`);
    }
    if (element.type !== "extract") {
      throw new Error(`ExtractService: element ${id} is a ${element.type}, not an extract`);
    }
    if (element.extractFate !== "synthesized") return element;
    if (element.deletedAt) {
      return this.elements.updateWithin(tx, id, { extractFate: null });
    }
    return this.elements.updateWithin(tx, id, {
      status: "scheduled",
      dueAt: nowIso(),
      parkedAt: null,
      extractFate: null,
    });
  }

  /**
   * SOFT-delete an extract (`soft_delete_element`): `deletedAt` + status `deleted`,
   * never a hard DELETE. User data is never destroyed; lineage references remain
   * valid (children keep pointing at it) and it is restorable from the trash.
   */
  delete(id: ElementId): ExtractActionResult {
    this.requireExtract(id);
    return { element: this.elements.softDelete(id) };
  }

  /**
   * Count how many times this extract has been postponed — delegates to the ONE
   * canonical {@link OperationLogRepository.countPostpones} (the schema-churn-free
   * marker scan), so the marker shape lives in a single place.
   */
  countPostpones(id: ElementId): number {
    return new OperationLogRepository(this.db).countPostpones(id);
  }

  private hasLiveSynthesisReference(id: ElementId): boolean {
    const row = this.db
      .select({ id: elementRelations.id })
      .from(elementRelations)
      .innerJoin(elementsTable, eq(elementRelations.fromElementId, elementsTable.id))
      .where(
        and(
          eq(elementRelations.toElementId, id),
          eq(elementRelations.relationType, "references"),
          eq(elementsTable.type, "synthesis_note"),
          isNull(elementsTable.deletedAt),
        ),
      )
      .get();
    return row != null;
  }

  private assertNotFated(element: Element, action: string): void {
    if (element.extractFate === null) return;
    throw new Error(
      `ExtractService.${action}: reactivate the extract before continuing distillation work`,
    );
  }
}
