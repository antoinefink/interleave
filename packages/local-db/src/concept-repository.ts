/**
 * ConceptRepository (T041) — create / list / assign hierarchical **concepts**.
 *
 * A concept is DUAL-MODELED (the load-bearing invariant): it is a `concept`-type
 * {@link Element} (so it has an id/status/priority and logs `create_element`) PLUS
 * a `concepts` side-table row (`name`, `parentConceptId`) written in the SAME
 * transaction. This mirrors the seed factory's `createConcept`
 * (`packages/testing/src/factories.ts`) exactly — concept-membership edges in
 * `element_relations` reference `elements.id`, so the concept must exist as an
 * element for the FK to hold.
 *
 * Concept MEMBERSHIP of an element is a `concept_membership` edge in
 * `element_relations` (`from = member element`, `to = concept` — the direction the
 * seed records), assigned/removed through {@link ElementRepository.addRelation} /
 * `removeRelation` (which log `add_relation` / `remove_relation`). There are NO new
 * `operation_log` op types — concepts reuse the closed 15-op set
 * (`create_element` / `add_relation` / `remove_relation`).
 *
 * Read-only methods (`listConcepts`, `conceptsForElement`, `elementsForConcept`)
 * append nothing to the operation log. The renderer never instantiates this; the
 * Electron main/DB service composes it behind validated IPC (`concepts.*`).
 */

import type { ElementId, RelationId } from "@interleave/core";
import {
  coerceFsrsParams,
  DESIRED_RETENTION_MAX,
  DESIRED_RETENTION_MIN,
  PRIORITY_LABEL_VALUE,
} from "@interleave/core";
import { concepts, elementRelations, elements, type InterleaveDatabase } from "@interleave/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";

/** Arguments to create a new concept. */
export interface CreateConceptInput {
  /** Display name (1–256 chars; validated at the IPC boundary). */
  readonly name: string;
  /** Optional parent concept for the hierarchy; `null`/absent for a root concept. */
  readonly parentConceptId?: ElementId | null;
}

/** A concept as a flat summary (id + name + parent link). */
export interface ConceptSummary {
  readonly id: ElementId;
  readonly name: string;
  readonly parentConceptId: ElementId | null;
  /**
   * Per-concept FSRS desired-retention target (T079), or `null` = inherit the
   * band/global default. Surfaced so the inspector / concept editor can show + edit
   * it; the per-card scheduler factory reads it via {@link retentionTargets}.
   */
  readonly desiredRetention: number | null;
  /**
   * Per-concept optimized FSRS parameter set (T080) — the 21-number FSRS-6 `w`
   * vector, or `null` = inherit the global preset / `default_w`. Written ONLY by the
   * optimization apply; read by the per-card scheduler factory via the retention
   * resolver (`RetentionService.resolveParamsForCard`), which decodes a card's
   * concept presets through {@link conceptsForElement}.
   */
  readonly fsrsParams: number[] | null;
}

/**
 * A concept node for the filterbar + the read-only concept map: the concept plus
 * its cheap derived counts (direct children, and members via `concept_membership`
 * edges).
 */
export interface ConceptNode {
  readonly id: ElementId;
  readonly name: string;
  readonly parentConceptId: ElementId | null;
  /** Number of direct child concepts in the hierarchy. */
  readonly childCount: number;
  /** Number of LIVE (not soft-deleted) elements that are members of this concept. */
  readonly memberCount: number;
  /** Per-concept FSRS desired-retention target (T079), or `null` = inherit. */
  readonly desiredRetention: number | null;
  /** Per-concept optimized FSRS parameter set (T080), or `null` = inherit. */
  readonly fsrsParams: number[] | null;
}

export class ConceptRepository {
  private readonly elementRepo: ElementRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elementRepo = new ElementRepository(db);
  }

  /**
   * Decode the JSON-encoded `concepts.fsrs_params` TEXT column into a validated
   * 21-number FSRS-6 vector, or `null` (inherit) when absent/malformed. The
   * structural validity (`coerceFsrsParams`) is the same choke point the global
   * preset uses; a corrupt stored value degrades to `null` so it can never reach
   * FSRS (T080).
   */
  private decodeFsrsParams(raw: string | null | undefined): number[] | null {
    if (raw == null) return null;
    try {
      return coerceFsrsParams(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Create a concept — the `concept`-type element (via
   * {@link ElementRepository.createWithin}, so `create_element` is logged) AND its
   * `concepts` hierarchy row — in ONE transaction. Mirrors the seed factory's
   * `createConcept`. Validates that `parentConceptId`, when given, refers to an
   * existing live concept (and is not the concept itself — a fresh id can never be
   * its own parent, but the guard documents intent). Returns the flat summary.
   */
  createConcept(input: CreateConceptInput): ConceptSummary {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new Error("ConceptRepository.createConcept: name must be non-empty");
    }
    const parentConceptId = input.parentConceptId ?? null;

    return this.db.transaction((tx) => {
      // Validate the parent exists as a concept element + a concepts row (a
      // one-level parent check; the FK + this guard prevent dangling parents).
      if (parentConceptId) {
        const parentEl = tx.select().from(elements).where(eq(elements.id, parentConceptId)).get();
        const parentRow = tx.select().from(concepts).where(eq(concepts.id, parentConceptId)).get();
        if (parentEl?.type !== "concept" || parentEl.deletedAt || !parentRow) {
          throw new Error(
            `ConceptRepository.createConcept: parent concept ${parentConceptId} not found`,
          );
        }
      }

      // 1) The concept element (logs `create_element` on the same tx).
      const element = this.elementRepo.createWithin(tx, {
        type: "concept",
        status: "active",
        stage: "synthesis",
        priority: PRIORITY_LABEL_VALUE.B,
        title: name,
      });
      // 2) The concepts side-table row (the hierarchy link) — same transaction.
      // `desiredRetention`/`fsrsParams` default to `null` (inherit) on create.
      tx.insert(concepts).values({ id: element.id, name, parentConceptId }).run();

      return { id: element.id, name, parentConceptId, desiredRetention: null, fsrsParams: null };
    });
  }

  /** Fetch one concept summary by id, or `null`. */
  findById(id: ElementId): ConceptSummary | null {
    const row = this.db.select().from(concepts).where(eq(concepts.id, id)).get();
    if (!row) return null;
    return {
      id: row.id as ElementId,
      name: row.name,
      parentConceptId: (row.parentConceptId as ElementId | null) ?? null,
      desiredRetention: row.desiredRetention ?? null,
      fsrsParams: this.decodeFsrsParams(row.fsrsParams),
    };
  }

  /**
   * Build the canonical `memberElementId -> Set<liveConceptId>` membership map in
   * ONE pass — the single, reusable, NON-N+1 primitive every concept-membership
   * read/count is built on (this method, `listConcepts`, `elementsForConcept`, and
   * the drill-down faceted counts in {@link LibraryQuery}). It does exactly three
   * reads regardless of how many concepts/members exist:
   *
   *  1. all live (`deleted_at IS NULL`) element ids — the endpoint liveness set;
   *  2. the `type = 'concept'` subset of (1) — the live concept ids;
   *  3. every `concept_membership` edge (`from = member`, `to = concept`).
   *
   * It then folds the edges into a map, keeping ONLY edges whose BOTH endpoints are
   * live (a soft-deleted member or a soft-deleted concept drops out) and DEDUPing
   * duplicate edges (the value is a `Set`, so re-assigning the same pair never
   * double-counts). Callers can read members-of-a-concept by inverting, or
   * concepts-of-a-member directly — without a per-row `findById` query.
   */
  liveMembershipMap(): Map<ElementId, Set<ElementId>> {
    const liveElementIds = new Set(
      this.db
        .select({ id: elements.id })
        .from(elements)
        .where(isNull(elements.deletedAt))
        .all()
        .map((r) => r.id as ElementId),
    );
    const liveConceptIds = new Set(
      this.db
        .select({ id: elements.id })
        .from(elements)
        .where(and(eq(elements.type, "concept"), isNull(elements.deletedAt)))
        .all()
        .map((r) => r.id as ElementId),
    );
    const membershipRows = this.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.relationType, "concept_membership"))
      .all();

    // member element id -> set of LIVE concept ids it belongs to (Set dedups edges).
    const byMember = new Map<ElementId, Set<ElementId>>();
    for (const edge of membershipRows) {
      const memberId = edge.fromElementId as ElementId;
      const conceptId = edge.toElementId as ElementId;
      // Both endpoints must be live: a soft-deleted member never counts, and a
      // membership to a soft-deleted concept is dropped (matches `firstConceptName`).
      if (!liveElementIds.has(memberId) || !liveConceptIds.has(conceptId)) continue;
      let set = byMember.get(memberId);
      if (!set) {
        set = new Set<ElementId>();
        byMember.set(memberId, set);
      }
      set.add(conceptId);
    }
    return byMember;
  }

  /**
   * Build the canonical `memberElementId -> Set<liveConceptId>` membership map,
   * restricted to a caller-provided member-id universe. This keeps hot paths such
   * as `/search` facet counts bounded by their matched rows instead of scanning
   * every live element and membership edge in the library.
   */
  liveMembershipMapForMembers(memberIds: readonly ElementId[]): Map<ElementId, Set<ElementId>> {
    const uniqueMemberIds = [...new Set(memberIds)];
    if (uniqueMemberIds.length === 0) return new Map();

    const memberList = sql.join(
      uniqueMemberIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = this.db.all<{ memberId: string; conceptId: string }>(sql`
      SELECT DISTINCT er.from_element_id AS memberId, er.to_element_id AS conceptId
      FROM element_relations er
      JOIN elements me
        ON me.id = er.from_element_id
        AND me.deleted_at IS NULL
      JOIN elements ce
        ON ce.id = er.to_element_id
        AND ce.deleted_at IS NULL
        AND ce.type = 'concept'
      WHERE er.relation_type = 'concept_membership'
        AND er.from_element_id IN (${memberList})
    `);

    const byMember = new Map<ElementId, Set<ElementId>>();
    for (const row of rows) {
      const memberId = row.memberId as ElementId;
      const conceptId = row.conceptId as ElementId;
      let set = byMember.get(memberId);
      if (!set) {
        set = new Set<ElementId>();
        byMember.set(memberId, set);
      }
      set.add(conceptId);
    }
    return byMember;
  }

  /**
   * All concepts as a flat list of {@link ConceptNode} (the renderer builds the
   * hierarchy from `parentConceptId`), each with its direct-child count and a
   * member count from the live `concept_membership` edges. Concepts whose element
   * was soft-deleted are excluded.
   */
  listConcepts(): ConceptNode[] {
    // Live concept elements only (a soft-deleted concept element drops out).
    const liveConceptIds = new Set(
      this.db
        .select({ id: elements.id })
        .from(elements)
        .where(and(eq(elements.type, "concept"), isNull(elements.deletedAt)))
        .all()
        .map((r) => r.id as ElementId),
    );

    const conceptRows = this.db.select().from(concepts).all();
    const live = conceptRows.filter((r) => liveConceptIds.has(r.id as ElementId));

    // Direct-child counts (over live concepts only).
    const childCounts = new Map<ElementId, number>();
    for (const row of live) {
      const parent = (row.parentConceptId as ElementId | null) ?? null;
      if (parent && liveConceptIds.has(parent)) {
        childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
      }
    }

    // Member counts: invert the canonical membership map (member -> concepts) into
    // per-concept member counts. Reusing the ONE primitive guarantees `memberCount`
    // matches the drill-down `byConcept` counts (same dedup + soft-delete rules).
    const memberCounts = new Map<ElementId, number>();
    for (const conceptIds of this.liveMembershipMap().values()) {
      for (const conceptId of conceptIds) {
        memberCounts.set(conceptId, (memberCounts.get(conceptId) ?? 0) + 1);
      }
    }

    return live.map((row) => {
      const id = row.id as ElementId;
      return {
        id,
        name: row.name,
        parentConceptId: (row.parentConceptId as ElementId | null) ?? null,
        childCount: childCounts.get(id) ?? 0,
        memberCount: memberCounts.get(id) ?? 0,
        desiredRetention: row.desiredRetention ?? null,
        fsrsParams: this.decodeFsrsParams(row.fsrsParams),
      };
    });
  }

  /**
   * The per-concept FSRS desired-retention targets for the live DB (T079), keyed by
   * concept NAME (matching `QueueQuery`'s name-based concept filter and the resolver's
   * `byConcept` key type). Only LIVE concepts with a finite `desired_retention` appear.
   *
   * A concept NAME need not be unique (`queue-query.ts` documents this — multiple live
   * concepts can share a name). When several live concepts share a name with different
   * targets, they collapse DETERMINISTICALLY to the HIGHEST target among them
   * (`Math.max` by name) — never last-write-wins, which is order-dependent and could
   * silently under-protect a fragile concept. This keeps the resolver's "strictest
   * concept wins" rule consistent (the resolver also takes the highest among a card's
   * concepts). Read-only — appends no op.
   */
  retentionTargets(): Record<string, number> {
    const liveConceptIds = new Set(
      this.db
        .select({ id: elements.id })
        .from(elements)
        .where(and(eq(elements.type, "concept"), isNull(elements.deletedAt)))
        .all()
        .map((r) => r.id as ElementId),
    );
    const out: Record<string, number> = {};
    for (const row of this.db.select().from(concepts).all()) {
      if (!liveConceptIds.has(row.id as ElementId)) continue;
      const target = row.desiredRetention;
      if (typeof target !== "number" || !Number.isFinite(target)) continue;
      // Aggregate by NAME with Math.max so duplicate names collapse deterministically
      // to the strictest target (never order-dependent last-write-wins).
      const existing = out[row.name];
      out[row.name] = existing === undefined ? target : Math.max(existing, target);
    }
    return out;
  }

  /**
   * Set (or clear) a concept's per-concept FSRS desired-retention target (T079) — the
   * `concepts.desired_retention` column — in ONE transaction, logging `update_element`
   * on the OWNING `concept` element (the audit record; the column is the queryable
   * store the scheduler reads). A finite `value` is CLAMPED to the retention bounds at
   * this write choke point so a corrupt value can never reach the store; `null` clears
   * the override (inherit band/global). No new op type. Returns the refreshed summary.
   */
  setConceptRetention(conceptId: ElementId, value: number | null): ConceptSummary {
    const conceptEl = this.elementRepo.findById(conceptId);
    if (!conceptEl || conceptEl.deletedAt || conceptEl.type !== "concept") {
      throw new Error(`ConceptRepository.setConceptRetention: concept ${conceptId} not found`);
    }
    const next =
      value === null || !Number.isFinite(value)
        ? null
        : Math.min(DESIRED_RETENTION_MAX, Math.max(DESIRED_RETENTION_MIN, value));

    return this.db.transaction((tx) => {
      const before = tx.select().from(concepts).where(eq(concepts.id, conceptId)).get();
      const prev = before?.desiredRetention ?? null;
      tx.update(concepts).set({ desiredRetention: next }).where(eq(concepts.id, conceptId)).run();
      // Stamp + audit on the concept ELEMENT (no new op type — the column is the store).
      tx.update(elements).set({ updatedAt: nowIso() }).where(eq(elements.id, conceptId)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: conceptId,
        payload: { id: conceptId, desiredRetention: next, prev: { desiredRetention: prev } },
      });
      const row = tx.select().from(concepts).where(eq(concepts.id, conceptId)).get();
      if (!row) {
        throw new Error(
          `ConceptRepository.setConceptRetention: concept ${conceptId} missing after write`,
        );
      }
      return {
        id: row.id as ElementId,
        name: row.name,
        parentConceptId: (row.parentConceptId as ElementId | null) ?? null,
        desiredRetention: row.desiredRetention ?? null,
        fsrsParams: this.decodeFsrsParams(row.fsrsParams),
      };
    });
  }

  /**
   * Set (or clear) a concept's per-concept optimized FSRS parameter set (T080) — the
   * JSON-encoded `concepts.fsrs_params` TEXT column — in ONE transaction, logging
   * `update_element` on the OWNING `concept` element (the audit record; the column is
   * the queryable store the scheduler reads). `params` is a finite 21-number FSRS-6
   * vector (validated upstream by the OptimizationService via `@interleave/scheduler`
   * `sanitizeParams`); `null` clears it (inherit the global preset). No new op type.
   * Returns the refreshed summary.
   */
  setConceptFsrsParams(conceptId: ElementId, params: number[] | null): ConceptSummary {
    const conceptEl = this.elementRepo.findById(conceptId);
    if (!conceptEl || conceptEl.deletedAt || conceptEl.type !== "concept") {
      throw new Error(`ConceptRepository.setConceptFsrsParams: concept ${conceptId} not found`);
    }
    // Structural validation choke point: only a finite 21-number vector is stored.
    const validated = params === null ? null : coerceFsrsParams(params);
    const encoded = validated === null ? null : JSON.stringify(validated);

    return this.db.transaction((tx) => {
      const before = tx.select().from(concepts).where(eq(concepts.id, conceptId)).get();
      const prev = before?.fsrsParams ?? null;
      tx.update(concepts).set({ fsrsParams: encoded }).where(eq(concepts.id, conceptId)).run();
      tx.update(elements).set({ updatedAt: nowIso() }).where(eq(elements.id, conceptId)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: conceptId,
        // The op is the AUDIT (append-only); the column is the queryable store.
        payload: { id: conceptId, fsrsParams: validated, prev: { fsrsParams: prev } },
      });
      const row = tx.select().from(concepts).where(eq(concepts.id, conceptId)).get();
      if (!row) {
        throw new Error(
          `ConceptRepository.setConceptFsrsParams: concept ${conceptId} missing after write`,
        );
      }
      return {
        id: row.id as ElementId,
        name: row.name,
        parentConceptId: (row.parentConceptId as ElementId | null) ?? null,
        desiredRetention: row.desiredRetention ?? null,
        fsrsParams: this.decodeFsrsParams(row.fsrsParams),
      };
    });
  }

  /**
   * Assign an element to a concept — add the `concept_membership` edge
   * (`from = element`, `to = concept`) via {@link ElementRepository.addRelation},
   * logging `add_relation`. Idempotent: re-assigning the same pair is a no-op
   * (the existing edge is kept; no duplicate row, no second op).
   */
  assignConcept(elementId: ElementId, conceptId: ElementId): void {
    // Validate the concept by ELEMENT liveness, not just the side-table row: the
    // `concepts` row survives a soft-delete of the concept element, so `findById`
    // alone would let an edge to a dead concept be created. The whole read side
    // (liveMembershipMap, elementsForConcept, byConcept counts, firstConceptName)
    // already drops edges to dead concepts, so such an edge would be invisible — but
    // we refuse to create it at all, keeping the write side consistent with reads.
    const conceptEl = this.elementRepo.findById(conceptId);
    if (!conceptEl || conceptEl.deletedAt || conceptEl.type !== "concept") {
      throw new Error(`ConceptRepository.assignConcept: concept ${conceptId} not found`);
    }
    // Idempotency: skip when the membership already exists.
    const existing = this.elementRepo
      .listRelationsFrom(elementId)
      .find((r) => r.relationType === "concept_membership" && r.toElementId === conceptId);
    if (existing) return;
    this.elementRepo.addRelation({
      fromElementId: elementId,
      toElementId: conceptId,
      relationType: "concept_membership",
    });
  }

  /**
   * Unassign an element from a concept — remove the `concept_membership` edge via
   * {@link ElementRepository.removeRelation}, logging `remove_relation`. Idempotent:
   * unassigning a pair that isn't a member is a no-op.
   */
  unassignConcept(elementId: ElementId, conceptId: ElementId): void {
    const edge = this.elementRepo
      .listRelationsFrom(elementId)
      .find((r) => r.relationType === "concept_membership" && r.toElementId === conceptId);
    if (!edge) return;
    this.elementRepo.removeRelation(edge.id as RelationId);
  }

  /**
   * The LIVE concepts an element is a member of (resolves the `concept_membership`
   * edges), deduped, in first-seen edge order.
   *
   * Liveness is enforced over the concept endpoint the SAME way as
   * {@link liveMembershipMap} / {@link elementsForConcept} / {@link firstConceptName}:
   * a soft-deleted concept never surfaces — so the inspector's "member of" list and
   * the queue's concept-name filter agree with the Library drill-down counts (no
   * read shows a deleted concept while another hides it). Liveness is resolved with
   * ONE `findManyLive` over the candidate concept ids (NOT a `findById` per edge,
   * which has no soft-delete check), keeping this a constant number of queries.
   */
  conceptsForElement(elementId: ElementId): ConceptSummary[] {
    const conceptIds = this.elementRepo
      .listRelationsFrom(elementId)
      .filter((r) => r.relationType === "concept_membership")
      .map((r) => r.toElementId as ElementId);
    if (conceptIds.length === 0) return [];

    // One liveness read for all candidate concepts (a soft-deleted concept element
    // drops out; the side-table `concepts` row survives a soft-delete, so a raw
    // `findById` would wrongly include it).
    const liveConceptIds = new Set(
      this.elementRepo
        .findManyLive(conceptIds)
        .filter((el) => el.type === "concept")
        .map((el) => el.id as ElementId),
    );

    const out: ConceptSummary[] = [];
    const seen = new Set<ElementId>();
    for (const id of conceptIds) {
      if (seen.has(id) || !liveConceptIds.has(id)) continue;
      seen.add(id);
      const summary = this.findById(id);
      if (summary) out.push(summary);
    }
    return out;
  }

  /**
   * The NAME of the first LIVE concept an element is a member of (for the per-row
   * meta line on the queue / search rows / review face), or `null`. The ONE shared
   * "first membership walk" — it scans the membership edges in row order and
   * returns the FIRST whose concept element is live. A soft-deleted concept never
   * shows on a row, and (the fix) a dead concept earlier in the edge list does NOT
   * mask a live concept later in it — consistent with `liveMembershipMap`, where the
   * element is still a member of the live concept.
   */
  firstConceptName(elementId: ElementId): string | null {
    const memberships = this.elementRepo
      .listRelationsFrom(elementId)
      .filter((r) => r.relationType === "concept_membership");
    for (const membership of memberships) {
      const conceptEl = this.elementRepo.findById(membership.toElementId as ElementId);
      if (conceptEl && !conceptEl.deletedAt && conceptEl.type === "concept") {
        return conceptEl.title;
      }
    }
    return null;
  }

  /**
   * The {@link firstConceptName} of EVERY member, as a `Map<memberId, conceptName>`,
   * built in a CONSTANT number of reads (T100) — the batched counterpart the queue
   * uses to decorate thousands of rows without a per-row `firstConceptName` walk (the
   * N+1 that helped make `QueueQuery.list` take ~24s at 100k). Preserves the SAME
   * "first LIVE membership in edge order" semantics: it scans the
   * `concept_membership` edges in their stored row order and records, per member, the
   * title of the FIRST edge whose concept element is live. Read-only.
   */
  firstConceptNameMap(): Map<ElementId, string> {
    // Live concept id -> title, in one read.
    const conceptTitle = new Map<string, string>();
    for (const row of this.db
      .select({ id: elements.id, title: elements.title })
      .from(elements)
      .where(and(eq(elements.type, "concept"), isNull(elements.deletedAt)))
      .all()) {
      conceptTitle.set(row.id, row.title);
    }
    // Live (non-deleted) member ids, so a soft-deleted member never gets a name.
    const liveMemberIds = new Set(
      this.db
        .select({ id: elements.id })
        .from(elements)
        .where(isNull(elements.deletedAt))
        .all()
        .map((r) => r.id),
    );
    // Scan the membership edges in stored row order; the FIRST live-concept edge per
    // member wins (matches the single-row walk above).
    const firstName = new Map<ElementId, string>();
    for (const edge of this.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.relationType, "concept_membership"))
      .all()) {
      const memberId = edge.fromElementId as ElementId;
      if (firstName.has(memberId) || !liveMemberIds.has(memberId)) continue;
      const title = conceptTitle.get(edge.toElementId);
      if (title !== undefined) firstName.set(memberId, title);
    }
    return firstName;
  }

  /**
   * The LIVE element ids that are members of a concept (feeds concept filtering +
   * counts). Reads the `concept_membership` edges (`to = concept`) and keeps only
   * members whose element is not soft-deleted, deduped, in first-seen edge order.
   *
   * Liveness is resolved with ONE `deleted_at IS NULL` set read (NOT a `findById`
   * per edge), so this stays a constant number of queries regardless of member
   * count. The same soft-delete + dedup rules as {@link liveMembershipMap} apply —
   * a soft-deleted concept yields `[]` (no live concept set hit), matching the
   * member-count semantics so filtering and counts never disagree.
   */
  elementsForConcept(conceptId: ElementId): ElementId[] {
    // A soft-deleted concept has no live members (mirrors `liveMembershipMap`).
    const conceptEl = this.elementRepo.findById(conceptId);
    if (!conceptEl || conceptEl.deletedAt || conceptEl.type !== "concept") return [];

    const edges = this.db
      .select()
      .from(elementRelations)
      .where(
        and(
          eq(elementRelations.relationType, "concept_membership"),
          eq(elementRelations.toElementId, conceptId),
        ),
      )
      .all();
    if (edges.length === 0) return [];

    // One liveness read for all candidate members (no per-edge `findById`).
    const candidateIds = edges.map((e) => e.fromElementId as ElementId);
    const liveIds = new Set(
      this.elementRepo.findManyLive(candidateIds).map((el) => el.id as ElementId),
    );

    const out: ElementId[] = [];
    const seen = new Set<ElementId>();
    for (const edge of edges) {
      const memberId = edge.fromElementId as ElementId;
      if (seen.has(memberId) || !liveIds.has(memberId)) continue;
      seen.add(memberId);
      out.push(memberId);
    }
    return out;
  }
}
