/**
 * AiSuggestionRepository (T093/T094) — typed, transactional access to the
 * `ai_suggestions` DRAFT layer.
 *
 * The on-device AI runner (a DB-free `utilityProcess` worker running a local model OR
 * the user's own-key HTTP call) produces a DRAFT suggestion for a selected source span;
 * MAIN's apply handler persists it HERE as an INERT, REVIEWABLE row. A suggestion is
 * NEVER a scheduled element, NEVER in any queue, and NEVER auto-applied — a card-shaped
 * suggestion becomes a real card only on the user's explicit approve.
 *
 * **No `operation_log` op (documented invariant).** An `ai_suggestions` row is a
 * transient draft/infra artifact — exactly like a `jobs` row or an `ocr_pages` row, it
 * appends NO `operation_log` entry (mirroring the `AssetRepository` "asset rows have no
 * dedicated operation" note). Approving a card appends the existing
 * `create_element`/`create_card` ops through the normal `CardService` path; dismissing
 * a draft is a status flip with no op.
 *
 * **Grounding is stored separately from the model output (T094).** The verbatim source
 * quote (`selectedText`) lives in a DIFFERENT column from the model's generated text
 * (`suggestionText`); {@link groundingFor} resolves the stored span back to a
 * {@link SourceRef} (with a working jump-to-source + the human location label),
 * degrading to {@link EMPTY_SOURCE_REF} when the source is gone (the calm orphan case).
 */

import type {
  AiActionType,
  AiSuggestionKind,
  AiSuggestionStatus,
  BlockId,
  DraftCard,
  ElementId,
  SourceRef,
} from "@interleave/core";
import { EMPTY_SOURCE_REF } from "@interleave/core";
import { aiSuggestions, type InterleaveDatabase } from "@interleave/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { newRowId, nowIso } from "./ids";
import { deriveSourceLocationLabel } from "./source-location-label";
import { resolveSourceRef } from "./source-ref-query";
import type { DbClient } from "./types";

/** The grounding (T094) — which source span produced a suggestion. */
export interface AiSuggestionGrounding {
  /** The source element the span lives in (the jump-to-source target), or `null`. */
  readonly sourceElementId: ElementId | null;
  /** The source block ids the span covers. */
  readonly blockIds: readonly BlockId[];
  /** Start char offset within the first block, when available. */
  readonly startOffset: number | null;
  /** End char offset within the last block, when available. */
  readonly endOffset: number | null;
  /** The VERBATIM selected source quote — stored separately from the model output. */
  readonly selectedText: string;
}

/**
 * The grounding span resolved to a jump-to-source location (T094) — the data the
 * drafts panel needs to wire an in-app "jump to source" on an AI draft's refblock,
 * exactly like an extract/card. Framework-free; `db-service` maps it to the IPC
 * `LocationSummary`.
 */
export interface AiGroundingLocation {
  /** The source element the span lives in (the reader to open on jump). */
  readonly sourceElementId: ElementId;
  /** Ordered STABLE block ids the span covers (the scroll target is the first). */
  readonly blockIds: readonly BlockId[];
  /** Char offset within the first spanned block (caret target), or `null`. */
  readonly startOffset: number | null;
  /** Char offset within the last spanned block, or `null`. */
  readonly endOffset: number | null;
  /** The verbatim selected source quote. */
  readonly selectedText: string;
  /** The human location label (e.g. "¶ 3"), best-effort; `null` when underivable. */
  readonly label: string | null;
}

/** A persisted AI suggestion (the domain shape the repository returns). */
export interface AiSuggestion {
  readonly id: string;
  /** The extract/source the action ran ON (the action's owner; the lineage parent). */
  readonly owningElementId: ElementId;
  readonly action: AiActionType;
  readonly kind: AiSuggestionKind;
  readonly providerKind: string;
  /** The MODEL's generated text (NOT the source quote). */
  readonly suggestionText: string;
  /** Structured card drafts for the card-shaped actions; empty otherwise. */
  readonly cards: readonly DraftCard[];
  readonly grounding: AiSuggestionGrounding;
  readonly status: AiSuggestionStatus;
  readonly createdAt: string;
}

/** Arguments to {@link AiSuggestionRepository.create}. */
export interface CreateAiSuggestionInput {
  readonly owningElementId: ElementId;
  readonly action: AiActionType;
  readonly kind: AiSuggestionKind;
  readonly providerKind: string;
  readonly suggestionText: string;
  readonly cards?: readonly DraftCard[];
  readonly grounding: AiSuggestionGrounding;
}

function parseCards(raw: string | null): DraftCard[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as DraftCard[]) : [];
  } catch {
    return [];
  }
}

function parseBlockIds(raw: string | null): BlockId[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as BlockId[]) : [];
  } catch {
    return [];
  }
}

function rowToSuggestion(row: typeof aiSuggestions.$inferSelect): AiSuggestion {
  return {
    id: row.id,
    owningElementId: row.owningElementId as ElementId,
    action: row.action as AiActionType,
    kind: row.kind as AiSuggestionKind,
    providerKind: row.providerKind,
    suggestionText: row.suggestionText,
    cards: parseCards(row.cards),
    grounding: {
      sourceElementId: (row.sourceElementId as ElementId | null) ?? null,
      blockIds: parseBlockIds(row.sourceBlockIds),
      startOffset: row.startOffset ?? null,
      endOffset: row.endOffset ?? null,
      selectedText: row.selectedText,
    },
    status: row.status as AiSuggestionStatus,
    createdAt: row.createdAt,
  };
}

/**
 * The repositories {@link AiSuggestionRepository.groundingFor} reads — the
 * `resolveSourceRef` slice (`elements`/`sources`/`review`) plus `documents` for the
 * span-label derivation.
 */
type GroundingRepos = Parameters<typeof resolveSourceRef>[0] & {
  readonly documents: { listBlocks(id: ElementId): ReadonlyArray<unknown> };
};

export class AiSuggestionRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /**
   * Insert one draft suggestion in an EXISTING transaction (the apply-handler seam).
   * Writes NO `operation_log` entry — a suggestion row is transient draft/infra (see
   * the module docblock). The grounding columns store the source span SEPARATELY from
   * the model's `suggestionText`.
   */
  createWithin(tx: DbClient, input: CreateAiSuggestionInput): AiSuggestion {
    const id = newRowId();
    const createdAt = nowIso();
    tx.insert(aiSuggestions)
      .values({
        id,
        owningElementId: input.owningElementId,
        action: input.action,
        kind: input.kind,
        providerKind: input.providerKind,
        suggestionText: input.suggestionText,
        cards: input.cards && input.cards.length > 0 ? JSON.stringify(input.cards) : null,
        sourceElementId: input.grounding.sourceElementId,
        sourceBlockIds:
          input.grounding.blockIds.length > 0 ? JSON.stringify(input.grounding.blockIds) : null,
        startOffset: input.grounding.startOffset,
        endOffset: input.grounding.endOffset,
        selectedText: input.grounding.selectedText,
        status: "draft",
        createdAt,
      })
      .run();
    const row = tx.select().from(aiSuggestions).where(eq(aiSuggestions.id, id)).get();
    if (!row) throw new Error("AiSuggestionRepository.createWithin: row missing after insert");
    return rowToSuggestion(row);
  }

  /** Insert one draft suggestion (standalone transaction). NO `operation_log` op. */
  create(input: CreateAiSuggestionInput): AiSuggestion {
    return this.db.transaction((tx) => this.createWithin(tx, input));
  }

  /** Read one suggestion by id, or `null`. */
  findById(id: string): AiSuggestion | null {
    const row = this.db.select().from(aiSuggestions).where(eq(aiSuggestions.id, id)).get();
    return row ? rowToSuggestion(row) : null;
  }

  /**
   * The DRAFT suggestions for an element, newest first. By default returns only
   * `draft`-status rows (dismissed/approved are filtered out of the live drafts
   * panel); pass `{ includeAll: true }` to read every row (e.g. for an audit/test).
   */
  listForElement(
    owningElementId: ElementId,
    options: { includeAll?: boolean } = {},
  ): AiSuggestion[] {
    const where = options.includeAll
      ? eq(aiSuggestions.owningElementId, owningElementId)
      : and(eq(aiSuggestions.owningElementId, owningElementId), eq(aiSuggestions.status, "draft"));
    return this.db
      .select()
      .from(aiSuggestions)
      .where(where)
      .orderBy(desc(aiSuggestions.createdAt))
      .all()
      .map(rowToSuggestion);
  }

  /**
   * Live DRAFT suggestions for a bounded set of owning elements, grouped by owner
   * and newest first. This is the batch seam used by session-style read models so
   * they can decorate N visible items without issuing N `listForElement` reads.
   */
  listLiveForElements(owningElementIds: readonly ElementId[]): Map<ElementId, AiSuggestion[]> {
    const ids = [...new Set(owningElementIds)];
    const byOwner = new Map<ElementId, AiSuggestion[]>();
    if (ids.length === 0) return byOwner;

    const rows = this.db
      .select()
      .from(aiSuggestions)
      .where(and(inArray(aiSuggestions.owningElementId, ids), eq(aiSuggestions.status, "draft")))
      .orderBy(desc(aiSuggestions.createdAt))
      .all()
      .map(rowToSuggestion);

    for (const suggestion of rows) {
      const ownerId = suggestion.owningElementId;
      const list = byOwner.get(ownerId);
      if (list) list.push(suggestion);
      else byOwner.set(ownerId, [suggestion]);
    }
    return byOwner;
  }

  /** Flip a suggestion's status (`draft` → `approved` | `dismissed`). NO op. */
  setStatus(id: string, status: AiSuggestionStatus): { updated: boolean } {
    const result = this.db
      .update(aiSuggestions)
      .set({ status })
      .where(eq(aiSuggestions.id, id))
      .run();
    return { updated: result.changes > 0 };
  }

  /** Flip a suggestion's status within an existing transaction (the approve seam). */
  setStatusWithin(tx: DbClient, id: string, status: AiSuggestionStatus): void {
    tx.update(aiSuggestions).set({ status }).where(eq(aiSuggestions.id, id)).run();
  }

  /**
   * Consume one live draft inside a larger transaction, constrained by owner and
   * current draft status. Throws when the row is missing/stale/foreign so callers
   * can roll back the enclosing mutation.
   */
  consumeDraftWithin(
    tx: DbClient,
    input: {
      readonly id: string;
      readonly owningElementId: ElementId;
      readonly status: AiSuggestionStatus;
    },
  ): void {
    const result = tx
      .update(aiSuggestions)
      .set({ status: input.status })
      .where(
        and(
          eq(aiSuggestions.id, input.id),
          eq(aiSuggestions.owningElementId, input.owningElementId),
          eq(aiSuggestions.status, "draft"),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new Error("AiSuggestionRepository.consumeDraftWithin: draft is not live");
    }
  }

  /** Soft-dismiss a draft (status → `dismissed`); it leaves any queue (it was never in one). */
  softDismiss(id: string): { dismissed: boolean } {
    const { updated } = this.setStatus(id, "dismissed");
    return { dismissed: updated };
  }

  /**
   * Resolve a suggestion's GROUNDING (T094) to a {@link SourceRef} — the jump-to-source
   * target + the human location label + the verbatim quote. Resolves the owning source's
   * provenance through the SAME `resolveSourceRef` the inspector/review/library use, then
   * overlays the suggestion's OWN span (its block ids / label / verbatim `selectedText`),
   * so an AI draft's refblock reads exactly like an extract/card's. Degrades to
   * {@link EMPTY_SOURCE_REF} when the suggestion / its source is gone (the calm orphan
   * case) — never a throw or a broken link.
   */
  groundingFor(repos: GroundingRepos, suggestionId: string): SourceRef {
    const suggestion = this.findById(suggestionId);
    if (!suggestion) return EMPTY_SOURCE_REF;
    return this.resolveGroundingRef(repos, suggestion);
  }

  /** Resolve a loaded suggestion's grounding span to a {@link SourceRef} (shared seam). */
  private resolveGroundingRef(repos: GroundingRepos, suggestion: AiSuggestion): SourceRef {
    const g = suggestion.grounding;

    // The span's own human label (e.g. "¶ 3"), derived from its block ids + the source
    // document blocks. Best-effort: an unresolvable source yields no label.
    const label =
      g.sourceElementId && g.blockIds.length > 0
        ? this.deriveSpanLabel(repos, g.sourceElementId, g.blockIds)
        : null;

    // Resolve the owning source's provenance (title/url/author/…) from the source span's
    // source element (the jump-to-source target), else the owning element's lineage.
    const baseRef = g.sourceElementId
      ? resolveSourceRef(repos, g.sourceElementId)
      : resolveSourceRef(repos, suggestion.owningElementId);
    if (!baseRef) {
      // The source is gone — keep the verbatim quote so the user still sees what the
      // model commented on, but mark the link unavailable (the calm orphan case).
      return {
        ...EMPTY_SOURCE_REF,
        snippet: g.selectedText.length > 0 ? g.selectedText : null,
      };
    }

    return {
      ...baseRef,
      // The suggestion's OWN span wins for the location label + the verbatim quote — the
      // model commented on THIS exact span, not the whole source.
      locationLabel: label ?? baseRef.locationLabel,
      snippet: g.selectedText.length > 0 ? g.selectedText : baseRef.snippet,
    };
  }

  /**
   * Resolve a suggestion's grounding span to a {@link AiGroundingLocation} — the
   * jump-to-source target (source element id + ordered stable block ids + offsets +
   * the verbatim quote + the human label) the drafts panel uses to wire an in-app
   * "jump to source" exactly like an extract/card refblock (T094). Returns `null`
   * when the span has no block ids OR its source is gone/soft-deleted (the orphan
   * case, where the refblock shows the calm quote but offers no jump) — mirroring
   * {@link groundingFor}'s orphan degradation so a draft never offers a dead jump.
   */
  groundingLocationFor(repos: GroundingRepos, suggestionId: string): AiGroundingLocation | null {
    const suggestion = this.findById(suggestionId);
    if (!suggestion) return null;
    const g = suggestion.grounding;
    if (!g.sourceElementId || g.blockIds.length === 0) return null;
    // The source must still resolve — a soft-deleted source has no live reader to jump
    // into, so we offer no jump (the refblock already degrades to "source unavailable").
    if (!resolveSourceRef(repos, g.sourceElementId)) return null;
    const label = this.deriveSpanLabel(repos, g.sourceElementId, g.blockIds);
    return {
      sourceElementId: g.sourceElementId,
      blockIds: g.blockIds,
      startOffset: g.startOffset,
      endOffset: g.endOffset,
      selectedText: g.selectedText,
      label,
    };
  }

  /** Derive the human label for a span from its source document blocks (best-effort). */
  private deriveSpanLabel(
    repos: GroundingRepos,
    sourceElementId: ElementId,
    blockIds: readonly BlockId[],
  ): string | null {
    const firstBlockId = blockIds[0];
    if (!firstBlockId) return null;
    try {
      const blocks = repos.documents.listBlocks(sourceElementId) as ReadonlyArray<{
        stableBlockId: string;
        blockType: string;
        order: number;
      }>;
      const labelBlocks = blocks.map((b) => ({
        stableBlockId: b.stableBlockId,
        blockType: b.blockType,
        order: b.order,
      }));
      return deriveSourceLocationLabel(labelBlocks, firstBlockId);
    } catch {
      return null;
    }
  }
}
