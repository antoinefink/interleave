/**
 * SynthesisService (T095) — incremental writing / synthesis notes.
 *
 * A synthesis note is the EXISTING core `synthesis_note`-type {@link Element}
 * (`enums.ts`, stage `synthesis`) — there is NO parallel object model and NO new
 * table. It is the "incremental writing" counterpart to incremental reading: a
 * long-lived writing/thinking surface that COLLECTS linked extracts/cards (via
 * explicit `references` edges) and is SCHEDULED TO RETURN for refinement on the
 * ATTENTION scheduler (NEVER FSRS — a synthesis note is processed, not recalled).
 * This service is the transactional composition seam that makes the type actually
 * creatable + editable + linkable + schedulable; the renderer drives it through the
 * typed `synthesis.*` `window.appApi` surface, never from React.
 *
 * INVARIANTS (load-bearing, see the T095 spec + CLAUDE.md):
 *  - **Element + document, NOT a new table.** {@link create} writes the
 *    `synthesis_note`-type element ({@link ElementRepository.createWithin} →
 *    `create_element`) and (when a body is supplied) the 1:1 `documents` body
 *    ({@link DocumentRepository.upsertWithin} → `update_document`) — all on ONE `tx`.
 *    No side-table is introduced (the decision: reuse `elements.updated_at` + the op
 *    log for "last refined at").
 *  - **`references`, not `derived_from`.** {@link linkElement} adds a `references`
 *    edge note→target (an extract or card) via {@link ElementRepository.addRelationWithin}
 *    (`add_relation`). The collected extracts/cards are REFERENCED material — they are
 *    NOT children/descendants of the note, so each keeps its own `card → extract →
 *    source` lineage intact. {@link unlinkElement} removes the edge (`remove_relation`).
 *  - **Attention, never FSRS.** {@link scheduleReturn} reschedules on the attention
 *    scheduler (`SchedulerService.scheduleAt` → `reschedule_element`, status →
 *    `scheduled`). It NEVER writes a `review_states` row (asserted in a test). The
 *    two-scheduler split holds: a synthesis note is not a card.
 *  - **No new op types, no new element type.** create → `create_element`; edit body →
 *    `update_document`; link → `add_relation`; unlink → `remove_relation`; schedule →
 *    `reschedule_element`. The closed 15-op set is unchanged; `synthesis_note` already
 *    exists in `ELEMENT_TYPES`.
 *  - **Soft-delete only; survives restart.** Delete reuses the element soft-delete path.
 *
 * The renderer never instantiates this; the Electron main/DB service composes it
 * behind the validated `synthesis.*` IPC surface.
 */

import type { BlockId, Element, ElementId, ElementRelation, Priority } from "@interleave/core";
import { DEFAULT_PRIORITY } from "@interleave/core";
import {
  elementRelations,
  elements as elementsTable,
  type InterleaveDatabase,
} from "@interleave/db";
import type { ScheduleChoice } from "@interleave/scheduler";
import { and, eq, isNull, ne } from "drizzle-orm";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ExtractService } from "./extract-service";
import { SchedulerService } from "./scheduler-service";
import { SettingsRepository } from "./settings-repository";
import type { DbClient } from "./types";

/** The distillation stage a synthesis note sits in (the `synthesis` stage). */
export const SYNTHESIS_STAGE = "synthesis" as const;

/** Element types a synthesis note is allowed to collect (reference). */
const LINKABLE_TARGET_TYPES = ["extract", "card"] as const;

/** One ordered stable block to persist with a synthesis note's body. */
export interface SynthesisBlockInput {
  readonly blockType: string;
  readonly order: number;
  readonly stableBlockId: string;
}

/** Arguments to create a synthesis note. */
export interface CreateSynthesisInput {
  /** Display title (the working thesis / question being woven together). */
  readonly title: string;
  /** Explicit priority; default = the configured default source priority, else `C`. */
  readonly priority?: Priority;
  /** Optional initial ProseMirror body JSON (built renderer-side). */
  readonly bodyJson?: unknown;
  /** The flattened plain-text mirror of `bodyJson` (computed renderer-side). */
  readonly bodyPlainText?: string;
  /** The ordered stable block list for `bodyJson` (preserves the stable ids). */
  readonly blocks?: readonly SynthesisBlockInput[];
}

/** Arguments to (re)save a synthesis note's body. */
export interface EditSynthesisBodyInput {
  readonly noteId: ElementId;
  /** The new ProseMirror document JSON (built renderer-side). */
  readonly prosemirrorJson: unknown;
  /** The flattened plain-text mirror (computed renderer-side). */
  readonly plainText: string;
  /** The ordered stable block list (preserves the stable ids), when present. */
  readonly blocks?: readonly SynthesisBlockInput[];
}

/** A referenced extract/card collected into a synthesis note. */
export interface SynthesisLinkedElement {
  readonly id: ElementId;
  readonly type: string;
  readonly title: string;
  readonly stage: string;
  readonly priority: Priority;
  /** The `element_relations` row id (so the renderer can unlink it precisely). */
  readonly relationId: string;
}

/** The full synthesis-note read: the note element + its linked material + due date. */
export interface SynthesisData {
  readonly element: Element;
  /** The extracts/cards this note references (the collected material). */
  readonly linked: readonly SynthesisLinkedElement[];
  /** The next attention return date (`elements.due_at`), or `null` when unscheduled. */
  readonly dueAt: string | null;
}

/** The result of a create — the new synthesis-note element. */
export interface SynthesisCreateResult {
  readonly element: Element;
}

/** The result of a link/unlink mutation — the refreshed synthesis-note read. */
export interface SynthesisLinkResult {
  readonly data: SynthesisData;
}

export class SynthesisService {
  private readonly elements: ElementRepository;
  private readonly documents: DocumentRepository;
  private readonly extracts: ExtractService;
  private readonly scheduler: SchedulerService;
  private readonly settings: SettingsRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.documents = new DocumentRepository(db);
    this.extracts = new ExtractService(db);
    this.scheduler = new SchedulerService(db);
    this.settings = new SettingsRepository(db);
  }

  /**
   * Create a synthesis note — the `synthesis_note`-type element + (optionally) an
   * initial `documents` body — in ONE transaction (`create_element` + `update_document`).
   * Status `pending` (it is a live writing surface but not yet on the attention
   * scheduler — {@link scheduleReturn} schedules its first return), stage
   * {@link SYNTHESIS_STAGE}. Priority defaults to the configured default source
   * priority. NEVER writes FSRS.
   */
  create(input: CreateSynthesisInput): SynthesisCreateResult {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new Error("SynthesisService.create: title must be non-empty");
    }
    const priority = input.priority ?? this.defaultPriority();
    const hasBody = input.bodyJson !== undefined;
    return this.db.transaction((tx) => {
      const element = this.elements.createWithin(tx, {
        type: "synthesis_note",
        status: "pending",
        stage: SYNTHESIS_STAGE,
        priority,
        title,
      });
      if (hasBody) {
        this.documents.upsertWithin(tx, {
          elementId: element.id,
          prosemirrorJson: input.bodyJson ?? { type: "doc", content: [] },
          plainText: input.bodyPlainText ?? "",
          ...(input.blocks ? { blocks: this.toBlockInputs(input.blocks) } : {}),
        });
      }
      return { element };
    });
  }

  /**
   * Link an extract/card INTO a synthesis note — add a `references` edge note→target
   * (`add_relation`), in ONE transaction. The target must be a live `extract` or
   * `card` (referenced material, not a child); a synthesis note may not reference
   * itself (a cycle) or a non-extract/non-card. Idempotent: a duplicate link (the
   * edge already exists) is a NO-OP that appends no op and returns the current read.
   */
  linkElement(noteId: ElementId, targetId: ElementId): SynthesisLinkResult {
    this.requireSynthesisNote(noteId);
    if (noteId === targetId) {
      throw new Error("SynthesisService.linkElement: a synthesis note cannot reference itself");
    }
    const target = this.elements.findById(targetId);
    if (!target || target.deletedAt) {
      throw new Error(`SynthesisService.linkElement: target ${targetId} not found`);
    }
    if (!isLinkableTarget(target.type)) {
      throw new Error(
        `SynthesisService.linkElement: target ${targetId} is a ${target.type} — only extracts/cards can be collected`,
      );
    }
    this.db.transaction((tx) => {
      // Idempotent: a `references` edge note→target already present is a no-op.
      const existing = tx
        .select({ id: elementRelations.id })
        .from(elementRelations)
        .where(
          and(
            eq(elementRelations.fromElementId, noteId),
            eq(elementRelations.toElementId, targetId),
            eq(elementRelations.relationType, "references"),
          ),
        )
        .get();
      if (existing) return;
      if (target.type === "extract") {
        this.extracts.setSynthesizedFateWithin(tx, targetId);
      }
      this.elements.addRelationWithin(tx, {
        fromElementId: noteId,
        toElementId: targetId,
        relationType: "references",
      });
    });
    return { data: this.requireData(noteId) };
  }

  /**
   * Unlink a referenced extract/card from a synthesis note — remove the `references`
   * edge (`remove_relation`). A no-op when the edge is absent (no op appended,
   * mirroring {@link ElementRepository.removeRelation}). Returns the refreshed read.
   */
  unlinkElement(noteId: ElementId, targetId: ElementId): SynthesisLinkResult {
    this.requireSynthesisNote(noteId);
    const target = this.elements.findById(targetId);
    this.db.transaction((tx) => {
      const edge = tx
        .select({ id: elementRelations.id })
        .from(elementRelations)
        .where(
          and(
            eq(elementRelations.fromElementId, noteId),
            eq(elementRelations.toElementId, targetId),
            eq(elementRelations.relationType, "references"),
          ),
        )
        .get();
      if (!edge) return;
      const shouldClearSynthesizedFate =
        target?.type === "extract" && !this.hasLiveSynthesisReference(tx, targetId, noteId);
      if (shouldClearSynthesizedFate) {
        this.extracts.clearSynthesizedFateCacheWithin(tx, targetId);
      }
      this.elements.removeRelationWithin(tx, edge.id as ElementRelation["id"]);
    });
    return { data: this.requireData(noteId) };
  }

  /**
   * Upsert a synthesis note's ProseMirror body (`update_document`) via
   * {@link DocumentRepository.upsert}, preserving stable block ids (so the note's
   * own text can later be extracted-from / searched / embedded). Lineage + schedule
   * are untouched — editing the text is not a stage move or a reschedule.
   */
  editBody(input: EditSynthesisBodyInput): SynthesisData {
    this.requireSynthesisNote(input.noteId);
    this.documents.upsert({
      elementId: input.noteId,
      prosemirrorJson: input.prosemirrorJson,
      plainText: input.plainText,
      ...(input.blocks ? { blocks: this.toBlockInputs(input.blocks) } : {}),
    });
    return this.requireData(input.noteId);
  }

  /**
   * Schedule a synthesis note to RETURN for refinement on the ATTENTION scheduler —
   * tomorrow / next week / next month / a manual date — via
   * {@link SchedulerService.scheduleAt} (`reschedule_element`, status → `scheduled`),
   * in ONE transaction. It NEVER writes a `review_states` row (the two-scheduler
   * split): a synthesis note is processed, not recalled. Reuses the EXISTING
   * attention reschedule rather than duplicating it.
   */
  scheduleReturn(noteId: ElementId, when: ScheduleChoice): SynthesisData {
    this.requireSynthesisNote(noteId);
    // `SchedulerService.scheduleAt` rejects cards by construction; a synthesis note is
    // an attention item, so this routes through the attention path (never FSRS).
    this.scheduler.scheduleAt(noteId, when);
    return this.requireData(noteId);
  }

  /**
   * SOFT-delete a synthesis note (`soft_delete_element`): never destroys user data;
   * the `references` edges remain valid and it is restorable from the trash.
   */
  delete(noteId: ElementId): Element {
    this.requireSynthesisNote(noteId);
    return this.db.transaction((tx) => {
      for (const targetId of this.liveExtractTargetsForNoteWithin(tx, noteId)) {
        if (!this.hasLiveSynthesisReference(tx, targetId, noteId)) {
          this.extracts.clearSynthesizedFateCacheWithin(tx, targetId);
        }
      }
      return this.elements.softDeleteWithin(tx, noteId);
    });
  }

  /** The full synthesis-note read (element + linked material + due date), or `null`. */
  get(noteId: ElementId): SynthesisData | null {
    const element = this.elements.findById(noteId);
    if (!element || element.deletedAt || element.type !== "synthesis_note") return null;
    return this.dataFor(element);
  }

  // ---- internals --------------------------------------------------------------

  /** The default priority a new synthesis note inherits (configured default, else `C`). */
  private defaultPriority(): Priority {
    try {
      return this.settings.getAppSettings().defaultSourcePriority;
    } catch {
      return DEFAULT_PRIORITY;
    }
  }

  /** Load a live `synthesis_note` element, throwing when missing/deleted/wrong type. */
  private requireSynthesisNote(id: ElementId): Element {
    const element = this.elements.findById(id);
    if (!element || element.deletedAt) {
      throw new Error(`SynthesisService: synthesis note ${id} not found`);
    }
    if (element.type !== "synthesis_note") {
      throw new Error(`SynthesisService: element ${id} is a ${element.type}, not a synthesis_note`);
    }
    return element;
  }

  /** {@link get}, but throws when the id is unknown (post-mutation refresh read). */
  private requireData(id: ElementId): SynthesisData {
    const data = this.get(id);
    if (!data) throw new Error(`SynthesisService: synthesis note ${id} missing after mutation`);
    return data;
  }

  /** Whether any live synthesis note still references `targetId`. */
  private hasLiveSynthesisReference(
    tx: DbClient,
    targetId: ElementId,
    excludingNoteId?: ElementId,
  ): boolean {
    const conditions = [
      eq(elementRelations.toElementId, targetId),
      eq(elementRelations.relationType, "references"),
      eq(elementsTable.type, "synthesis_note"),
      isNull(elementsTable.deletedAt),
    ];
    if (excludingNoteId) {
      conditions.push(ne(elementRelations.fromElementId, excludingNoteId));
    }
    const row = tx
      .select({ id: elementRelations.id })
      .from(elementRelations)
      .innerJoin(elementsTable, eq(elementRelations.fromElementId, elementsTable.id))
      .where(and(...conditions))
      .get();
    return row != null;
  }

  /** Live extract targets referenced by a synthesis note, de-duplicated by target id. */
  private liveExtractTargetsForNoteWithin(tx: DbClient, noteId: ElementId): ElementId[] {
    const rows = tx
      .select({ targetId: elementRelations.toElementId })
      .from(elementRelations)
      .innerJoin(elementsTable, eq(elementRelations.toElementId, elementsTable.id))
      .where(
        and(
          eq(elementRelations.fromElementId, noteId),
          eq(elementRelations.relationType, "references"),
          eq(elementsTable.type, "extract"),
        ),
      )
      .all();
    return [...new Set(rows.map((row) => row.targetId as ElementId))];
  }

  /** Build a {@link SynthesisData} for a known-live synthesis-note element. */
  private dataFor(element: Element): SynthesisData {
    const edges = this.elements
      .listRelationsFrom(element.id)
      .filter((r: ElementRelation) => r.relationType === "references");
    const linked: SynthesisLinkedElement[] = [];
    for (const edge of edges) {
      const target = this.elements.findById(edge.toElementId);
      if (!target || target.deletedAt) continue; // a deleted target drops out of the panel
      if (!isLinkableTarget(target.type)) continue;
      linked.push({
        id: target.id,
        type: target.type,
        title: target.title,
        stage: target.stage,
        priority: target.priority,
        relationId: edge.id,
      });
    }
    // Stable order: newest link last (creation order ≈ relation id mint order is not
    // guaranteed, so sort by the target's creation time for a deterministic panel).
    linked.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { element, linked, dueAt: element.dueAt };
  }

  /** Map the contract's block inputs to the document repository's shape. */
  private toBlockInputs(blocks: readonly SynthesisBlockInput[]) {
    return blocks.map((b) => ({
      blockType: b.blockType,
      order: b.order,
      stableBlockId: b.stableBlockId as BlockId,
    }));
  }
}

/** Whether `type` is an extract/card a synthesis note may collect (reference). */
function isLinkableTarget(type: string): boolean {
  return (LINKABLE_TARGET_TYPES as readonly string[]).includes(type);
}
