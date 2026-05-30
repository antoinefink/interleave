/**
 * ElementRepository (T008) — CRUD for the universal `Element` primitive.
 *
 * Every source, topic, extract, card, task, concept, media fragment, and
 * synthesis note IS an `elements` row, so this is the most-used repository. It
 * owns the soft-delete (`deleted_at`) and restore semantics for the whole app —
 * user data is never destroyed; it is moved to the trash and recoverable.
 *
 * Every mutation here runs inside a SQLite transaction together with an
 * `operation_log` append (`create_element`, `update_element`,
 * `soft_delete_element`, `restore_element`, `reschedule_element`), so the data
 * change and its command-shaped log row commit or roll back atomically. IDs are
 * minted in this layer (never by SQLite), and `createdAt`/`updatedAt` are stamped
 * here so the timestamp format is consistent across the codebase.
 */

import type {
  DistillationStage,
  Element,
  ElementId,
  ElementRelation,
  ElementStatus,
  ElementType,
  IsoTimestamp,
  Priority,
  RelationId,
  RelationType,
  SiblingGroupId,
} from "@interleave/core";
import {
  type ElementTagRow,
  elementRelations,
  elements,
  elementTags,
  type InterleaveDatabase,
  tags,
} from "@interleave/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { newElementId, newRelationId, newRowId, nowIso } from "./ids";
import { rowToElement } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient } from "./types";

/** Arguments to add a typed lineage/relationship edge. */
export interface AddRelationInput {
  readonly fromElementId: ElementId;
  readonly toElementId: ElementId;
  readonly relationType: RelationType;
  /** Set when `relationType` is `sibling_group`; groups interfering siblings. */
  readonly siblingGroupId?: SiblingGroupId | null;
}

/** Fields required to create a new element. */
export interface CreateElementInput {
  readonly type: ElementType;
  readonly status: ElementStatus;
  readonly stage: DistillationStage;
  readonly priority: Priority;
  readonly title: string;
  readonly dueAt?: IsoTimestamp | null;
  readonly parentId?: ElementId | null;
  readonly sourceId?: ElementId | null;
  /** Optional explicit id (e.g. when a side-table is created first). */
  readonly id?: ElementId;
}

/** Patchable fields on an existing element (lineage fields are immutable here). */
export interface UpdateElementInput {
  readonly status?: ElementStatus;
  readonly stage?: DistillationStage;
  readonly priority?: Priority;
  readonly title?: string;
  readonly dueAt?: IsoTimestamp | null;
}

export class ElementRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /** Insert an element + log `create_element`, atomically. Returns the row. */
  create(input: CreateElementInput): Element {
    return this.db.transaction((tx) => this.createWithin(tx, input));
  }

  /**
   * Insert an element using an existing transaction — used by side-table
   * repositories (sources, cards, …) that create the element and its side-table
   * row in ONE transaction. Logs `create_element` on the same `tx`.
   */
  createWithin(tx: DbClient, input: CreateElementInput): Element {
    const id = input.id ?? newElementId();
    const ts = nowIso();
    const element: Element = {
      id,
      type: input.type,
      status: input.status,
      stage: input.stage,
      priority: input.priority,
      dueAt: input.dueAt ?? null,
      title: input.title,
      parentId: input.parentId ?? null,
      sourceId: input.sourceId ?? null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
    tx.insert(elements)
      .values({
        id: element.id,
        type: element.type,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        dueAt: element.dueAt,
        title: element.title,
        parentId: element.parentId,
        sourceId: element.sourceId,
        createdAt: element.createdAt,
        updatedAt: element.updatedAt,
        deletedAt: null,
      })
      .run();
    new OperationLogRepository(tx).append(tx, {
      opType: "create_element",
      elementId: id,
      payload: { element },
    });
    return element;
  }

  /** Fetch one element by id (including soft-deleted), or `null`. */
  findById(id: ElementId): Element | null {
    const row = this.db.select().from(elements).where(eq(elements.id, id)).get();
    return row ? rowToElement(row) : null;
  }

  /** List live (not soft-deleted) elements of a given type. */
  listByType(type: ElementType): Element[] {
    return this.db
      .select()
      .from(elements)
      .where(and(eq(elements.type, type), isNull(elements.deletedAt)))
      .all()
      .map(rowToElement);
  }

  /** List live elements with a given status. */
  listByStatus(status: ElementStatus): Element[] {
    return this.db
      .select()
      .from(elements)
      .where(and(eq(elements.status, status), isNull(elements.deletedAt)))
      .all()
      .map(rowToElement);
  }

  /** List live direct children of a parent element. */
  listChildren(parentId: ElementId): Element[] {
    return this.db
      .select()
      .from(elements)
      .where(and(eq(elements.parentId, parentId), isNull(elements.deletedAt)))
      .all()
      .map(rowToElement);
  }

  /** List live elements belonging to a given source (lineage root). */
  listBySource(sourceId: ElementId): Element[] {
    return this.db
      .select()
      .from(elements)
      .where(and(eq(elements.sourceId, sourceId), isNull(elements.deletedAt)))
      .all()
      .map(rowToElement);
  }

  /** Apply a patch + log `update_element`, atomically. Returns the new row. */
  update(id: ElementId, patch: UpdateElementInput): Element {
    return this.db.transaction((tx) => this.updateWithin(tx, id, patch));
  }

  /**
   * Set an element's numeric {@link Priority} + log `update_element`, atomically
   * (T027). A thin, named alias over {@link update} for the universal raise / lower
   * / set-priority write path: priority is first-class on EVERY element type
   * (source/extract/card/task/topic/synthesis_note), so this works for any of them.
   * The band math lives in `@interleave/core` (`raisePriority`/`lowerPriority`/
   * `priorityFromLabel`); this layer just persists the resulting numeric value.
   */
  setPriority(id: ElementId, priority: Priority): Element {
    return this.update(id, { priority });
  }

  /**
   * Apply a patch using an EXISTING transaction, logging `update_element` on the
   * SAME `tx`. The tx-composable seam {@link ExtractService} (T024) uses to move an
   * extract's stage AND reschedule it in ONE transaction (stage update +
   * reschedule + both op rows commit together).
   */
  updateWithin(tx: DbClient, id: ElementId, patch: UpdateElementInput): Element {
    const updatedAt = nowIso();
    const set: Record<string, unknown> = { updatedAt };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.stage !== undefined) set.stage = patch.stage;
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;

    tx.update(elements).set(set).where(eq(elements.id, id)).run();
    const row = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!row) throw new Error(`ElementRepository.update: element ${id} not found`);
    new OperationLogRepository(tx).append(tx, {
      opType: "update_element",
      elementId: id,
      payload: { id, patch },
    });
    return rowToElement(row);
  }

  /**
   * Set the next due time + log `reschedule_element`, atomically. This is the
   * generic "process this again later" hook used by the attention scheduler and
   * the FSRS review flow alike (the scheduler decides the date elsewhere).
   */
  reschedule(id: ElementId, dueAt: IsoTimestamp | null): Element {
    return this.db.transaction((tx) => this.rescheduleWithin(tx, id, dueAt));
  }

  /**
   * Set the next due time using an EXISTING transaction, logging
   * `reschedule_element` on the SAME `tx`. Optionally also updates `status` (e.g.
   * `pending` → `scheduled` when an extract gets its first attention due date). The
   * tx-composable seam {@link ExtractionService} (T021) uses to give a new extract
   * its initial attention `due_at` inside the single extraction transaction.
   */
  rescheduleWithin(
    tx: DbClient,
    id: ElementId,
    dueAt: IsoTimestamp | null,
    status?: ElementStatus,
    /**
     * Extra, command-specific fields merged into the `reschedule_element` op
     * payload. The attention scheduler (T024 postpone) records a `postpone` marker
     * + running count here so the postpone history is queryable WITHOUT a schema
     * migration (the closed op set is unchanged — this only enriches the payload).
     */
    opExtras?: Readonly<Record<string, unknown>>,
  ): Element {
    const updatedAt = nowIso();
    const set: Record<string, unknown> = { dueAt, updatedAt };
    if (status !== undefined) set.status = status;
    tx.update(elements).set(set).where(eq(elements.id, id)).run();
    const row = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!row) throw new Error(`ElementRepository.reschedule: element ${id} not found`);
    new OperationLogRepository(tx).append(tx, {
      opType: "reschedule_element",
      elementId: id,
      payload: { id, dueAt, ...(status !== undefined ? { status } : {}), ...(opExtras ?? {}) },
    });
    return rowToElement(row);
  }

  /**
   * Soft-delete: set `deletedAt` + status `deleted`, never DELETE the row, and
   * log `soft_delete_element`. The element moves to the trash and stays
   * recoverable; lineage references remain valid.
   */
  softDelete(id: ElementId): Element {
    return this.db.transaction((tx) => {
      const ts = nowIso();
      tx.update(elements)
        .set({ deletedAt: ts, status: "deleted", updatedAt: ts })
        .where(eq(elements.id, id))
        .run();
      const row = tx.select().from(elements).where(eq(elements.id, id)).get();
      if (!row) throw new Error(`ElementRepository.softDelete: element ${id} not found`);
      new OperationLogRepository(tx).append(tx, {
        opType: "soft_delete_element",
        elementId: id,
        payload: { id, deletedAt: ts },
      });
      return rowToElement(row);
    });
  }

  /**
   * Restore a soft-deleted element to the given status (default `active`), clear
   * `deletedAt`, and log `restore_element`.
   */
  restore(id: ElementId, status: ElementStatus = "active"): Element {
    return this.db.transaction((tx) => {
      const ts = nowIso();
      tx.update(elements)
        .set({ deletedAt: null, status, updatedAt: ts })
        .where(eq(elements.id, id))
        .run();
      const row = tx.select().from(elements).where(eq(elements.id, id)).get();
      if (!row) throw new Error(`ElementRepository.restore: element ${id} not found`);
      new OperationLogRepository(tx).append(tx, {
        opType: "restore_element",
        elementId: id,
        payload: { id, status },
      });
      return rowToElement(row);
    });
  }

  /** Live (not soft-deleted) elements whose ids are in `ids`, preserving none of the order. */
  findManyLive(ids: readonly ElementId[]): Element[] {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(elements)
      .where(and(inArray(elements.id, ids as ElementId[]), isNull(elements.deletedAt)))
      .all()
      .map(rowToElement);
  }

  /**
   * Add a typed edge between two elements + log `add_relation`, atomically.
   * Lineage is modeled as explicit rows (not implicit nesting), and sibling
   * groups keep interfering cloze/Q&A siblings from being shown back-to-back.
   */
  addRelation(input: AddRelationInput): ElementRelation {
    return this.db.transaction((tx) => this.addRelationWithin(tx, input));
  }

  /**
   * Add a typed edge using an EXISTING transaction, logging `add_relation` on the
   * SAME `tx`. The tx-composable seam {@link ExtractionService} (T021) uses to record
   * the `derived_from` extract→source/parent edge inside the single extraction
   * transaction.
   */
  addRelationWithin(tx: DbClient, input: AddRelationInput): ElementRelation {
    const id: RelationId = newRelationId();
    const createdAt = nowIso();
    tx.insert(elementRelations)
      .values({
        id,
        fromElementId: input.fromElementId,
        toElementId: input.toElementId,
        relationType: input.relationType,
        siblingGroupId: input.siblingGroupId ?? null,
        createdAt,
      })
      .run();
    new OperationLogRepository(tx).append(tx, {
      opType: "add_relation",
      elementId: input.fromElementId,
      payload: { id, ...input },
    });
    return {
      id,
      fromElementId: input.fromElementId,
      toElementId: input.toElementId,
      relationType: input.relationType,
      siblingGroupId: input.siblingGroupId ?? null,
      createdAt,
    };
  }

  /** Remove a relation edge by id + log `remove_relation`, atomically. */
  removeRelation(id: RelationId): void {
    this.db.transaction((tx) => {
      const row = tx.select().from(elementRelations).where(eq(elementRelations.id, id)).get();
      tx.delete(elementRelations).where(eq(elementRelations.id, id)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "remove_relation",
        elementId: (row?.fromElementId as ElementId | undefined) ?? null,
        payload: { id },
      });
    });
  }

  /** All outgoing edges from an element. */
  listRelationsFrom(fromElementId: ElementId): ElementRelation[] {
    return this.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.fromElementId, fromElementId))
      .all()
      .map((row) => ({
        id: row.id as RelationId,
        fromElementId: row.fromElementId as ElementId,
        toElementId: row.toElementId as ElementId,
        relationType: row.relationType as RelationType,
        siblingGroupId: (row.siblingGroupId as SiblingGroupId | null) ?? null,
        createdAt: row.createdAt,
      }));
  }

  /**
   * Attach a tag (by name, created on demand) to an element + log `add_tag`,
   * atomically. Idempotent: re-tagging is a no-op on the join.
   */
  addTag(elementId: ElementId, tagName: string): void {
    this.db.transaction((tx) => this.addTagWithin(tx, elementId, tagName));
  }

  /**
   * Attach a tag using an EXISTING transaction, logging `add_tag` on the SAME `tx`.
   * The tx-composable seam {@link ExtractionService} (T021) uses to inherit the
   * source's tags onto a new extract inside the single extraction transaction.
   * Idempotent: re-tagging is a no-op on the join.
   */
  addTagWithin(tx: DbClient, elementId: ElementId, tagName: string): void {
    let tagRow = tx.select().from(tags).where(eq(tags.name, tagName)).get();
    if (!tagRow) {
      const tagId = newRowId();
      tx.insert(tags).values({ id: tagId, name: tagName }).run();
      tagRow = { id: tagId, name: tagName };
    }
    tx.insert(elementTags).values({ elementId, tagId: tagRow.id }).onConflictDoNothing().run();
    new OperationLogRepository(tx).append(tx, {
      opType: "add_tag",
      elementId,
      payload: { elementId, tagId: tagRow.id, tagName },
    });
  }

  /** Detach a tag (by name) from an element + log `remove_tag`, atomically. */
  removeTag(elementId: ElementId, tagName: string): void {
    this.db.transaction((tx) => {
      const tagRow = tx.select().from(tags).where(eq(tags.name, tagName)).get();
      if (!tagRow) return;
      tx.delete(elementTags)
        .where(and(eq(elementTags.elementId, elementId), eq(elementTags.tagId, tagRow.id)))
        .run();
      new OperationLogRepository(tx).append(tx, {
        opType: "remove_tag",
        elementId,
        payload: { elementId, tagId: tagRow.id, tagName },
      });
    });
  }

  /** Tag names attached to an element. */
  listTags(elementId: ElementId): string[] {
    const rows: ElementTagRow[] = this.db
      .select()
      .from(elementTags)
      .where(eq(elementTags.elementId, elementId))
      .all();
    if (rows.length === 0) return [];
    const tagIds = rows.map((r) => r.tagId);
    return this.db
      .select()
      .from(tags)
      .where(inArray(tags.id, tagIds))
      .all()
      .map((t) => t.name);
  }
}
