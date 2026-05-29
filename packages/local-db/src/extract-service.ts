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
 *  - **mark done** — status `done` (`update_element`); the extract leaves the
 *    active rotation but its lineage stays intact.
 *  - **delete** — SOFT delete (`soft_delete_element`); never destroys user data,
 *    lineage rows remain valid, recoverable from the trash.
 *
 * Every action runs in ONE transaction together with its `operation_log` append
 * (the closed 15-op set — no new op types). The stage axis (`raw_extract`/
 * `clean_extract`/`atomic_statement`) is deliberately distinct from the status
 * axis; this service moves the stage, not the status, on an advance.
 */

import type {
  BlockId,
  DistillationStage,
  Element,
  ElementId,
  IsoTimestamp,
  Priority,
} from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";

/**
 * The ordered extract distillation chain this service walks. It is a strict
 * subset of {@link DistillationStage} — extracts only ever sit in these three
 * stages; `card_draft`+ belong to cards (M6), `raw_source`/`rough_topic` to
 * sources/topics.
 */
export const EXTRACT_STAGES = [
  "raw_extract",
  "clean_extract",
  "atomic_statement",
] as const satisfies readonly DistillationStage[];

/** An extract's distillation stage (the three steps of the chain above). */
export type ExtractStage = (typeof EXTRACT_STAGES)[number];

/** Type guard: is `value` one of the three extract distillation stages? */
export function isExtractStage(value: unknown): value is ExtractStage {
  return typeof value === "string" && (EXTRACT_STAGES as readonly string[]).includes(value);
}

/** The next stage in the chain, or `null` when already at `atomic_statement`. */
export function nextExtractStage(stage: ExtractStage): ExtractStage | null {
  const idx = EXTRACT_STAGES.indexOf(stage);
  if (idx < 0 || idx >= EXTRACT_STAGES.length - 1) return null;
  return EXTRACT_STAGES[idx + 1] as ExtractStage;
}

/**
 * The attention interval (DAYS) for an extract at a given stage + priority — the
 * MVP by-stage heuristic from `scheduling-and-priority.md`:
 *
 * ```txt
 *   raw_extract        +1..7d
 *   clean_extract      +3..14d
 *   atomic_statement   convert now, or +1d
 * ```
 *
 * Higher-priority extracts return sooner within each band so they are not buried;
 * T028's real attention scheduler will replace this formula. Kept here (not in a
 * React component) per the layering rule — same pattern as
 * {@link rawExtractIntervalDays} (T021).
 */
export function extractStageIntervalDays(stage: ExtractStage, priority: Priority): number {
  const band = priorityToLabel(priority); // A/B/C/D
  switch (stage) {
    case "raw_extract":
      // +1..7d
      return { A: 1, B: 3, C: 5, D: 7 }[band];
    case "clean_extract":
      // +3..14d
      return { A: 3, B: 6, C: 10, D: 14 }[band];
    case "atomic_statement":
      // card-ready: convert now, or come back tomorrow.
      return 1;
  }
}

/** The postpone interval (DAYS) for an extract by priority — pushes further out. */
export function postponeIntervalDays(priority: Priority): number {
  // Medium source action heuristic: +7..30d, sooner for higher priority.
  return { A: 7, B: 14, C: 21, D: 30 }[priorityToLabel(priority)];
}

/** Add `days` to an ISO timestamp, returning a new ISO timestamp. */
function addDays(fromIso: IsoTimestamp, days: number): IsoTimestamp {
  const ms = Date.parse(fromIso) + days * 86_400_000;
  return new Date(ms).toISOString() as IsoTimestamp;
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
    const priorCount = this.countPostpones(id);
    return this.db.transaction((tx) => {
      const dueAt = addDays(nowIso(), postponeIntervalDays(element.priority));
      const rescheduled = this.elements.rescheduleWithin(tx, id, dueAt, "scheduled", {
        postpone: true,
        postponeCount: priorCount + 1,
      });
      return { element: rescheduled };
    });
  }

  /**
   * Mark an extract done: status `done` via {@link ElementRepository.update}
   * (`update_element`). The extract leaves the active rotation; its body, anchor,
   * and lineage stay intact and recoverable.
   */
  markDone(id: ElementId): ExtractActionResult {
    this.requireExtract(id);
    return { element: this.elements.update(id, { status: "done" }) };
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
   * Count how many times this extract has been postponed, by scanning its
   * `reschedule_element` ops for the `postpone` marker. Read-only; this is the
   * schema-churn-free postpone counter the attention scheduler/analytics read.
   */
  countPostpones(id: ElementId): number {
    return new OperationLogRepository(this.db)
      .listForElement(id)
      .filter(
        (op) =>
          op.opType === "reschedule_element" &&
          typeof op.payload === "object" &&
          op.payload !== null &&
          (op.payload as { postpone?: unknown }).postpone === true,
      ).length;
  }
}
