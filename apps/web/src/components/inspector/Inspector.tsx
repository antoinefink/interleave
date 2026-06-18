/**
 * Universal element inspector (T010) — the shell's right panel.
 *
 * One consistent view of ANY selected element's metadata, lineage, and scheduler
 * signals, rebuilt from the kit's inspector (design/kit + design-system.md) with
 * the shared primitives. Priority is editable here (T027) — the universal
 * raise/lower/set write path every element type shares; the rest is read-only
 * until the relevant features land.
 *
 * Data flows STRICTLY through the typed `window.appApi` bridge: the renderer asks
 * the Electron main process (`inspector.list()` / `inspector.get(id)`), which
 * composes the `packages/local-db` repositories behind validated IPC. The
 * renderer never touches SQLite, Node, or the filesystem. The selected element id
 * comes from the shared `useSelection()` state that the rest of the app sets;
 * when nothing is selected, a small picker (also bridge-fed) lets the user pick
 * one — until screens (queue/inbox/reader) drive the selection in later
 * milestones.
 *
 * The load-bearing two-scheduler split is honored: a card shows the FSRS chip +
 * stat readout (brain, retrievability %, stability days, `--sched-fsrs`), while
 * sources/extracts/topics/tasks/synthesis notes show the attention chip (gauge,
 * stage, postponed ×N, `--sched-attn`).
 */

import { taskTypeLabel } from "@interleave/core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appApi,
  type ConceptNode,
  type ConfidenceLevelInput,
  type ElementSummary,
  type ElementsSetPriorityAction,
  type FactLifetimeSummary,
  type FactStability,
  type InspectorData,
  isDesktop,
  type LineageData,
  type LineageItem,
  type LineageNode,
  type PriorityLabel as PriorityLabelType,
  type QueueScheduleChoice,
  type ReliabilityTierInput,
  type SemanticRelatedItem,
  type SemanticRelatedResult,
  type SourceProvenance,
  type SourceTypeInput,
  type TaskSummary,
  type TaskType,
  type TopicFallowRequest,
  type TopicFallowResult,
  type TopicKnowledgeStateGetRequest,
  type TopicKnowledgeStateSubject,
  type TopicUnfallowRequest,
} from "../../lib/appApi";
// The inbox triage section is screen-specific UI; the inspector renders it only when
// gated to an inbox source (see InspectorBody). Importing a `pages/` section into this
// shared component mirrors the established precedent of `components/queue/DoneIntentMenu`
// importing from `pages/queue/`. The cross-tree state channel itself stays UI-only via
// the shell-level `inboxTriagePanel` context (no shell -> pages dependency).
import { InboxTriageSection } from "../../pages/inbox/InboxTriageSection";
import { useNavigateToLocation } from "../../reader/navigateToLocation";
import { ReviewModeButton } from "../../review/ReviewModeButton";
import "../../review/review.css";
import { isScopeActive } from "../../shell/activeScope";
import { useInboxTriagePanel } from "../../shell/inboxTriagePanel";
import { useLibraryInspectorPanel } from "../../shell/libraryInspectorPanel";
import { useSelection } from "../../shell/selection";
import { ConflictSection } from "../ConflictSection";
import { ExternalUrlLink } from "../ExternalUrlLink";
import { Icon } from "../Icon";
import type { ContextMenuPosition } from "../menu/types";
import { requestQueueRefresh } from "../queue/queueRefresh";
import { ScheduleMenu } from "../queue/ScheduleMenu";
import { RefBlock } from "../RefBlock";
import "./inspector.css";
import { LineageContextMenu } from "./LineageContextMenu";
import { LineageTree } from "./LineageTree";
import {
  ConceptTag,
  FsrsStats,
  MetaRow,
  Prio,
  priorityLabel,
  ScheduleReasonLine,
  SchedulerChip,
  Status,
  stageLabel,
  statusLabel,
  Tag,
  TypeIcon,
  typeLabel,
} from "./primitives";

/**
 * A window event any screen can dispatch (via {@link requestInspectorRefresh})
 * after a mutation so the inspector re-fetches the selected element + picker list
 * WITHOUT a navigation/reload — e.g. T021 extraction adds a child extract that
 * should appear in "Extracts from this source" immediately. UI-only signal: it
 * carries no data; the panel re-reads through `window.appApi`.
 */
export const INSPECTOR_REFRESH_EVENT = "interleave:inspector-refresh";

/** Ask the inspector to re-fetch its current selection (after a mutation). */
export function requestInspectorRefresh(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(INSPECTOR_REFRESH_EVENT));
  }
}

/** Format an ISO timestamp as a short, locale-independent date, or a dash. */
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

function defaultFallowDate(current?: string | null): string {
  if (current) {
    const t = Date.parse(current);
    if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  }
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 14);
  return date.toISOString().slice(0, 10);
}

function dateInputToIso(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/**
 * Compare provenance URLs as user-facing locations. Canonicalization often only
 * removes a trailing slash; keep query/hash differences because those can point
 * at a meaningfully different imported URL.
 */
function comparableProvenanceUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "");
    const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
    return `${url.protocol.toLowerCase()}//${auth}${url.host.toLowerCase()}${path}${url.search}${url.hash}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function sameProvenanceUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return comparableProvenanceUrl(a) === comparableProvenanceUrl(b);
}

/** Format an ISO timestamp as a compact attention-scheduler recency label. */
function seenLabel(iso: string | null): string {
  if (!iso) return "Not seen yet";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return `Seen ${iso}`;

  const seen = new Date(t);
  const today = new Date();
  const seenDay = new Date(seen.getFullYear(), seen.getMonth(), seen.getDate()).getTime();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = Math.round((todayDay - seenDay) / dayMs);
  if (diff === 0) return "Seen today";
  if (diff === 1) return "Seen yesterday";
  if (diff > 1 && diff < 7) return `Seen ${diff}d ago`;
  return `Seen ${fmtDate(iso)}`;
}

function headerStateLine(
  element: InspectorData["element"],
  review: InspectorData["review"],
): string {
  const parts = [
    typeLabel(element.type),
    priorityLabel(element.priority),
    statusLabel(element.status),
    stageLabel(element.stage),
  ];
  if (review?.isRetired) parts.push("Retired");
  return parts.join(" · ");
}

/** A clickable lineage row that re-selects the target element and may open its detail surface. */
function LineageRow({ item, onOpen }: { item: LineageItem; onOpen: (item: LineageItem) => void }) {
  return (
    <button
      type="button"
      className="tree-node"
      data-testid="lineage-row"
      data-element-id={item.id}
      onClick={() => onOpen(item)}
    >
      <TypeIcon type={item.type} />
      <span className="tree-node__title">{item.title}</span>
    </button>
  );
}

/** The selection picker shown when nothing is selected (bridge-fed). */
function ElementPicker({
  elements,
  onSelect,
}: {
  elements: readonly ElementSummary[];
  onSelect: (id: string) => void;
}) {
  if (elements.length === 0) {
    return <p className="insp-empty">No elements yet. Import a source to get started.</p>;
  }
  return (
    <div className="insp-picker" data-testid="element-picker">
      {elements.map((el) => (
        <button
          key={el.id}
          type="button"
          className="insp-picker__item"
          data-testid="element-picker-item"
          data-element-type={el.type}
          onClick={() => onSelect(el.id)}
        >
          <TypeIcon type={el.type} />
          <span className="insp-picker__title">{el.title}</span>
          <Prio priority={el.priority} />
        </button>
      ))}
    </div>
  );
}

/** The four labels for the segmented priority control (high → low). */
const PRIORITY_BANDS: readonly PriorityLabelType[] = ["A", "B", "C", "D"];

/**
 * The editable A/B/C/D priority control (T027) — the universal write path. An
 * inline segmented chip group (`set` a label) plus raise/lower steppers (`raise`/
 * `lower` one band). Every change goes through `elements.setPriority`
 * (`update_element`); the parent re-reads on success so the badge updates without
 * a reload. Disabled while a request is in flight to avoid double-submits.
 */
function PriorityControl({
  priority,
  busy,
  onSetPriority,
}: {
  priority: number;
  busy: boolean;
  onSetPriority: (action: ElementsSetPriorityAction) => void;
}) {
  const current = priorityLabel(priority);
  return (
    <div className="prio-edit" data-testid="inspector-priority">
      <button
        type="button"
        className="prio-edit__step"
        data-testid="inspector-priority-raise"
        title="Raise priority one band"
        aria-label="Raise priority"
        disabled={busy || current === "A"}
        onClick={() => onSetPriority({ kind: "raise" })}
      >
        <Icon name="arrowUp" size={14} />
      </button>
      <fieldset className="prio-edit__seg" aria-label="Set priority">
        {PRIORITY_BANDS.map((band) => {
          const active = current === band;
          return (
            <button
              key={band}
              type="button"
              className="prio-edit__btn"
              data-testid={`inspector-priority-${band}`}
              aria-pressed={active}
              disabled={busy}
              onClick={() => onSetPriority({ kind: "set", priority: band })}
            >
              <span
                className="prio-edit__dot"
                style={{ background: `var(--prio-${band.toLowerCase()})` }}
              />
              {band}
            </button>
          );
        })}
      </fieldset>
      <button
        type="button"
        className="prio-edit__step"
        data-testid="inspector-priority-lower"
        title="Lower priority one band"
        aria-label="Lower priority"
        disabled={busy || current === "D"}
        onClick={() => onSetPriority({ kind: "lower" })}
      >
        <Icon name="arrowDown" size={14} />
      </button>
    </div>
  );
}

function FallowSection({
  element,
  busy,
  onFallow,
  onUnfallow,
}: {
  element: ElementSummary;
  busy: boolean;
  onFallow: (request: TopicFallowRequest) => Promise<TopicFallowResult>;
  onUnfallow: (request: TopicUnfallowRequest) => Promise<TopicFallowResult>;
}) {
  const [date, setDate] = useState(() => defaultFallowDate(element.fallowUntil));
  const [reason, setReason] = useState(element.fallowReason ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const fallowUntil = element.fallowUntil ?? null;
  const untilMs = fallowUntil ? Date.parse(fallowUntil) : Number.NaN;
  const state = fallowUntil
    ? Number.isFinite(untilMs) && untilMs > Date.now()
      ? "active"
      : "returned"
    : "none";
  const requestedIso = date ? dateInputToIso(date) : "";
  const requestedMs = requestedIso ? Date.parse(requestedIso) : Number.NaN;
  const canSubmit = Number.isFinite(requestedMs) && requestedMs > Date.now() && !busy;

  useEffect(() => {
    setDate(defaultFallowDate(element.fallowUntil));
    setReason(element.fallowReason ?? "");
    setMessage(null);
  }, [element.fallowUntil, element.fallowReason]);

  const submit = async () => {
    if (!canSubmit) return;
    setMessage(null);
    try {
      const result = await onFallow({
        topicId: element.id,
        fallowUntil: requestedIso,
        fallowReason: reason.trim() || null,
      });
      setMessage(
        result.skipped.length > 0
          ? `Rest skipped: ${result.skipped.map((skip) => skip.reason).join(", ")}`
          : "Topic resting.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const clear = async () => {
    if (busy) return;
    setMessage(null);
    try {
      const result = await onUnfallow({ topicId: element.id });
      setMessage(
        result.skipped.length > 0
          ? `Clear skipped: ${result.skipped.map((skip) => skip.reason).join(", ")}`
          : "Topic returned.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="insp-sec" data-testid="fallow-section">
      <div className="insp-sec__title">
        <span>Topic rest</span>
        <span className={`insp-fallow__state insp-fallow__state--${state}`}>
          {state === "active" ? "Resting" : state === "returned" ? "Returned" : "Not resting"}
        </span>
      </div>
      <div className="insp-fallow">
        {fallowUntil ? (
          <div className="insp-fallow__current" data-testid="fallow-current">
            <Icon name="pause" size={14} />
            <span>Back {fmtDate(fallowUntil)}</span>
            {element.fallowReason ? <span>{element.fallowReason}</span> : null}
          </div>
        ) : null}
        <div className="insp-fallow__form">
          <label className="insp-fallow__field">
            <span>Return</span>
            <input
              type="date"
              value={date}
              disabled={busy}
              data-testid="fallow-date"
              onChange={(event) => setDate(event.currentTarget.value)}
            />
          </label>
          <label className="insp-fallow__field">
            <span>Reason</span>
            <input
              type="text"
              maxLength={240}
              value={reason}
              disabled={busy}
              data-testid="fallow-reason"
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </label>
        </div>
        <div className="insp-fallow__actions">
          <button
            type="button"
            className="insp-fallow__btn"
            disabled={!canSubmit}
            data-testid="fallow-apply"
            onClick={() => void submit()}
          >
            <Icon name="calendar" size={13} />
            Rest topic
          </button>
          {state !== "none" ? (
            <button
              type="button"
              className="insp-fallow__btn"
              disabled={busy}
              data-testid="fallow-clear"
              onClick={() => void clear()}
            >
              <Icon name="return" size={13} />
              Clear rest
            </button>
          ) : null}
        </div>
        <p className="insp-fallow__note">Card reviews continue while attention work rests.</p>
        {message ? (
          <p className="insp-fallow__message" data-testid="fallow-message">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Concepts + tags organize section (T041) — assign/unassign hierarchical concepts
 * (`ConceptTag` pills + a picker) and add/remove flat tags (`Tag` pills + an
 * input). Every change goes through the typed `concepts.*` / `tags.*` bridge
 * commands (logging `add_relation`/`remove_relation`/`add_tag`/`remove_tag`); the
 * parent re-reads on success so the inspector reflects the change. UI orchestration
 * only — no SQL, no membership math, in the renderer.
 */
function OrganizeSection({
  elementId,
  concepts,
  tags,
  allConcepts,
  onChanged,
}: {
  elementId: string;
  concepts: readonly { id: string; name: string }[];
  tags: readonly string[];
  allConcepts: readonly ConceptNode[];
  onChanged: () => void;
}) {
  const [tagDraft, setTagDraft] = useState("");
  const [conceptDraft, setConceptDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Inline "create a new concept" affordance (T041): a name + optional parent,
  // toggled open so the common (assign-existing) path stays one click.
  const [creating, setCreating] = useState(false);
  const [newConceptName, setNewConceptName] = useState("");
  const [newConceptParent, setNewConceptParent] = useState("");

  const assignedIds = new Set(concepts.map((c) => c.id));
  const assignable = allConcepts.filter((c) => !assignedIds.has(c.id));

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        onChanged();
      } finally {
        setBusy(false);
      }
    },
    [busy, onChanged],
  );

  const onAddTag = () => {
    const tag = tagDraft.trim();
    if (!tag) return;
    void run(async () => {
      await appApi.addTag({ elementId, tag });
      setTagDraft("");
    });
  };

  const onAssignConcept = () => {
    if (!conceptDraft) return;
    void run(async () => {
      await appApi.assignConcept({ elementId, conceptId: conceptDraft });
      setConceptDraft("");
    });
  };

  // Create a new concept (optionally under a parent) AND assign it to this
  // element in one flow, so a fresh DB with no concepts has a real path to make
  // one. Both calls go through the typed bridge (`concepts.create` logs
  // `create_element`; `concepts.assign` logs `add_relation`).
  const onCreateConcept = () => {
    const name = newConceptName.trim();
    if (!name) return;
    void run(async () => {
      const res = await appApi.createConcept({
        name,
        ...(newConceptParent ? { parentConceptId: newConceptParent } : {}),
      });
      await appApi.assignConcept({ elementId, conceptId: res.concept.id });
      setNewConceptName("");
      setNewConceptParent("");
      setCreating(false);
    });
  };

  return (
    <>
      {/* Concepts. */}
      <div className="insp-sec" data-testid="concepts-section">
        <div className="insp-sec__title">Concepts</div>
        <div className="insp-organize">
          {concepts.length > 0 ? (
            <div className="insp-organize__row" data-testid="concept-pills">
              {concepts.map((c) => (
                <span
                  key={c.id}
                  className="insp-organize__chip"
                  data-testid="concept-pill"
                  data-concept-id={c.id}
                >
                  <ConceptTag name={c.name} />
                  <button
                    type="button"
                    className="insp-chip-del"
                    data-testid="concept-remove"
                    aria-label={`Remove concept ${c.name}`}
                    disabled={busy}
                    onClick={() =>
                      run(() => appApi.unassignConcept({ elementId, conceptId: c.id }))
                    }
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="insp-empty">No concepts.</p>
          )}
          {assignable.length > 0 && (
            <div className="insp-add">
              <select
                className="insp-add__select"
                data-testid="concept-picker"
                aria-label="Assign concept"
                value={conceptDraft}
                disabled={busy}
                onChange={(e) => setConceptDraft(e.target.value)}
              >
                <option value="">Assign concept…</option>
                {assignable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.parentConceptId ? `↳ ${c.name}` : c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="insp-add__btn"
                data-testid="concept-assign"
                disabled={busy || !conceptDraft}
                onClick={onAssignConcept}
              >
                Assign
              </button>
            </div>
          )}

          {/* Create a brand-new concept (T041) — the only path to make one on a
              fresh DB, so the assign picker is never a dead end. Optional parent
              builds the hierarchy. */}
          {creating ? (
            <div className="insp-organize__create" data-testid="concept-create">
              <div className="insp-add">
                <input
                  className="insp-add__input"
                  data-testid="concept-create-name"
                  // biome-ignore lint/a11y/noAutofocus: opening the create form is an explicit user action
                  autoFocus
                  placeholder="New concept name…"
                  value={newConceptName}
                  disabled={busy}
                  onChange={(e) => setNewConceptName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onCreateConcept();
                    } else if (e.key === "Escape") {
                      setCreating(false);
                    }
                  }}
                />
              </div>
              <div className="insp-add">
                <select
                  className="insp-add__select"
                  data-testid="concept-create-parent"
                  aria-label="Parent concept (optional)"
                  value={newConceptParent}
                  disabled={busy}
                  onChange={(e) => setNewConceptParent(e.target.value)}
                >
                  <option value="">No parent (root)</option>
                  {allConcepts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.parentConceptId ? `↳ ${c.name}` : c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="insp-add__btn"
                  data-testid="concept-create-submit"
                  disabled={busy || newConceptName.trim().length === 0}
                  onClick={onCreateConcept}
                >
                  Create
                </button>
                <button
                  type="button"
                  className="insp-add__btn"
                  data-testid="concept-create-cancel"
                  disabled={busy}
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="insp-organize__new"
              data-testid="concept-new"
              disabled={busy}
              onClick={() => setCreating(true)}
            >
              <Icon name="plus" size={12} /> New concept…
            </button>
          )}
        </div>
      </div>

      {/* Tags. */}
      <div className="insp-sec" data-testid="tags-section">
        <div className="insp-sec__title">Tags</div>
        <div className="insp-organize">
          {tags.length > 0 ? (
            <div className="insp-organize__row" data-testid="tag-pills">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="insp-organize__chip"
                  data-testid="tag-pill"
                  data-tag={tag}
                >
                  <Tag name={tag} />
                  <button
                    type="button"
                    className="insp-chip-del"
                    data-testid="tag-remove"
                    aria-label={`Remove tag ${tag}`}
                    disabled={busy}
                    onClick={() => run(() => appApi.removeTag({ elementId, tag }))}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="insp-empty">No tags.</p>
          )}
          <div className="insp-add">
            <input
              className="insp-add__input"
              data-testid="tag-input"
              placeholder="Add a tag…"
              value={tagDraft}
              disabled={busy}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAddTag();
                }
              }}
            />
            <button
              type="button"
              className="insp-add__btn"
              data-testid="tag-add"
              disabled={busy || tagDraft.trim().length === 0}
              onClick={onAddTag}
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** Element types that carry an exportable document body (T068 Markdown export). */
const EXPORTABLE_TYPES = new Set<ElementSummary["type"]>([
  "source",
  "topic",
  "extract",
  "synthesis_note",
]);

/**
 * Types whose lineage subtree can hold cards — the "Review this branch" affordance
 * (T096) is offered on these (a `source`/`topic`/`extract` root reviews the cards
 * under it, outside scheduling). A `card`/`task`/`concept` has no reviewable subtree.
 */
const BRANCH_REVIEWABLE_TYPES = new Set<ElementSummary["type"]>(["source", "topic", "extract"]);

/** Element types expected to preserve source evidence even when the source is missing. */
const SOURCE_LINEAGE_TYPES = new Set<ElementSummary["type"]>(["extract", "card", "media_fragment"]);

function visibleLineageNodes(
  nodes: readonly LineageNode[],
  showDeleted: boolean,
): readonly LineageNode[] {
  if (showDeleted) return nodes;

  const visible: LineageNode[] = [];
  const deletedDepths: number[] = [];
  for (const node of nodes) {
    while (deletedDepths.length > 0 && node.depth <= (deletedDepths.at(-1) ?? -1)) {
      deletedDepths.pop();
    }
    if (node.deleted) {
      deletedDepths.push(node.depth);
      continue;
    }
    visible.push({ ...node, depth: Math.max(0, node.depth - deletedDepths.length) });
  }
  return visible;
}

function deletedAncestorCount(nodes: readonly LineageNode[]): number {
  const stack: LineageNode[] = [];
  for (const node of nodes) {
    while (stack.length > node.depth) stack.pop();
    if (node.active) return stack.filter((ancestor) => ancestor.deleted).length;
    stack[node.depth] = node;
  }
  return 0;
}

type AttentionScheduler = InspectorData["scheduler"] & { kind: "attention" };

function isAttentionScheduler(
  scheduler: InspectorData["scheduler"],
): scheduler is AttentionScheduler {
  return scheduler.kind === "attention";
}

/**
 * "Export to Markdown" action (T068) — serializes the element's stored document
 * body to a `.md` in Downloads (MAIN owns the path) and surfaces
 * the written location. Read-only on the DB (no mutation). Desktop-only; renders
 * nothing in a bare renderer.
 */
function ExportMarkdownSection({ elementId }: { elementId: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!isDesktop()) return null;

  const onExport = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await appApi.exportDocumentMarkdown({ elementId });
      setDone(`${result.directoryLabel}/${result.relativePath}`);
    } catch (e) {
      setError(e instanceof Error ? friendlyExportError(e.message) : "Could not export.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="insp-sec" data-testid="export-section">
      <div className="insp-sec__title">Export</div>
      <button
        type="button"
        className="insp-add__btn"
        data-testid="export-markdown"
        disabled={busy}
        onClick={() => void onExport()}
      >
        <Icon name={busy ? "clock" : "download"} size={12} className={busy ? "animate-spin" : ""} />
        {busy ? "Exporting…" : "Export to Markdown"}
      </button>
      {done ? (
        <p className="insp-empty" data-testid="export-done">
          Exported to {done}
        </p>
      ) : null}
      {error ? (
        <p className="insp-empty" data-testid="export-error" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Map a thrown export `code: message` line to a friendly message. */
function friendlyExportError(message: string): string {
  const sep = message.indexOf(":");
  const code = sep > 0 ? message.slice(0, sep).trim() : "";
  if (code === "not_supported") return "This element has no document to export.";
  return "Could not export to Markdown.";
}

/** The export scope the Anki section offers: just this card, a concept, or all cards. */
type AnkiExportScope = { kind: "card" } | { kind: "concept"; id: string } | { kind: "all" };

/**
 * "Export to Anki" action (T070) — exports cards to an Anki-compatible `.apkg` (or CSV)
 * in Downloads, carrying the source reference OUT to Anki. The scope
 * selector mirrors the spec: this card, a concept the card belongs to, or all cards. The
 * `conceptId`/`all` scopes are resolved MAIN-side by the export service. Read-only on the
 * DB. Desktop-only.
 */
function ExportAnkiSection({
  cardId,
  concepts,
}: {
  cardId: string;
  concepts: readonly { id: string; name: string }[];
}) {
  const [scope, setScope] = useState<AnkiExportScope>({ kind: "card" });
  const [busy, setBusy] = useState<"apkg" | "csv" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!isDesktop()) return null;

  const onExport = async (format: "apkg" | "csv") => {
    if (busy) return;
    setBusy(format);
    setError(null);
    setDone(null);
    try {
      const request =
        scope.kind === "all"
          ? { format, all: true }
          : scope.kind === "concept"
            ? { format, conceptId: scope.id }
            : { format, cardIds: [cardId] };
      const result = await appApi.exportAnki(request);
      setDone(
        `${result.directoryLabel}/${result.relativePath} · ${result.cardCount} card${
          result.cardCount === 1 ? "" : "s"
        }`,
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message.replace(/^[a-z_]+:\s*/, "") : "Could not export to Anki.",
      );
    } finally {
      setBusy(null);
    }
  };

  // Build the scope options: this card always; one per assigned concept; all cards.
  const scopeOptions: { value: string; label: string; scope: AnkiExportScope }[] = [
    { value: "card", label: "This card", scope: { kind: "card" } },
    ...concepts.map((c) => ({
      value: `concept:${c.id}`,
      label: `Concept: ${c.name}`,
      scope: { kind: "concept" as const, id: c.id },
    })),
    { value: "all", label: "All cards", scope: { kind: "all" } },
  ];
  const selectedValue =
    scope.kind === "concept" ? `concept:${scope.id}` : scope.kind === "all" ? "all" : "card";

  return (
    <div className="insp-sec" data-testid="export-anki-section">
      <div className="insp-sec__title">Export to Anki</div>
      <select
        className="insp-add__select"
        data-testid="export-anki-scope"
        aria-label="Export scope"
        value={selectedValue}
        disabled={busy != null}
        onChange={(e) => {
          const next = scopeOptions.find((o) => o.value === e.target.value);
          if (next) setScope(next.scope);
        }}
        style={{ marginBottom: 6, width: "100%" }}
      >
        {scopeOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="insp-export-actions">
        <span className="insp-export-actions__label">Export as</span>
        <button
          type="button"
          className="insp-add__btn"
          data-testid="export-anki-apkg"
          disabled={busy != null}
          onClick={() => void onExport("apkg")}
        >
          <Icon
            name={busy === "apkg" ? "clock" : "download"}
            size={12}
            className={busy === "apkg" ? "animate-spin" : ""}
          />
          {busy === "apkg" ? "Exporting…" : ".apkg"}
        </button>
        <button
          type="button"
          className="insp-add__btn"
          data-testid="export-anki-csv"
          disabled={busy != null}
          onClick={() => void onExport("csv")}
        >
          <Icon
            name={busy === "csv" ? "clock" : "download"}
            size={12}
            className={busy === "csv" ? "animate-spin" : ""}
          />
          {busy === "csv" ? "Exporting…" : "CSV"}
        </button>
      </div>
      {done ? (
        <p className="insp-empty" data-testid="export-anki-done">
          Exported to {done}
        </p>
      ) : null}
      {error ? (
        <p
          className="insp-empty"
          data-testid="export-anki-error"
          style={{ color: "var(--danger)" }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Human label for which rule resolved a card's retention (T079). */
const RETENTION_SOURCE_LABEL: Record<string, string> = {
  card: "per-card override",
  concept: "concept target",
  band: "priority band",
  global: "global default",
};

/**
 * The card's RESOLVED FSRS desired-retention target + which rule won (T079) — a
 * read-only inspector row backed by `retention.resolveFor`. FSRS schedules the card
 * against this value; the source tells the user WHY (per-card override → concept →
 * band → global). Card-only; re-fetched when the inspected card changes.
 */
function ResolvedRetentionRow({ cardId }: { cardId: string }) {
  const [target, setTarget] = useState<number | null>(null);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await appApi.resolveRetentionFor({ cardId });
        if (cancelled) return;
        setTarget(result.target);
        setSource(result.source);
      } catch {
        if (!cancelled) {
          setTarget(null);
          setSource(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cardId]);
  if (target === null) return null;
  return (
    <MetaRow k="Target retention">
      <span data-testid="inspector-resolved-retention">{Math.round(target * 100)}%</span>
      {source ? (
        <span className="text-text-3" data-testid="inspector-resolved-retention-source">
          {" "}
          · {RETENTION_SOURCE_LABEL[source] ?? source}
        </span>
      ) : null}
    </MetaRow>
  );
}

function maturityPct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function maturityStatusLabel(
  status: TopicKnowledgeStateSubject["graduationState"]["status"],
): string {
  switch (status) {
    case "graduated":
      return "Mature";
    case "near_graduation":
      return "Near mature";
    case "needs_attention":
      return "Needs attention";
    case "building":
      return "Building";
    case "insufficient_evidence":
      return "Insufficient evidence";
  }
}

function TopicMaturitySection({ topicId }: { topicId: string }) {
  const [subject, setSubject] = useState<TopicKnowledgeStateSubject | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const request: TopicKnowledgeStateGetRequest & {
      readonly order?: "needs_attention" | "default";
    } = {
      subjectType: "topic",
      subjectId: topicId,
      limit: 1,
      order: "default",
    };
    setLoading(true);
    void appApi
      .getTopicKnowledgeState(request)
      .then((res) => {
        if (cancelled) return;
        setSubject(res.subjects[0] ?? null);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setSubject(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [topicId]);

  return (
    <div className="insp-sec insp-maturity" data-testid="topic-maturity-section">
      <div className="insp-sec__title">
        <span>Knowledge state</span>
        {subject ? (
          <span
            className={`insp-maturity__status insp-maturity__status--${subject.graduationState.status}`}
            data-testid="topic-maturity-status"
          >
            {maturityStatusLabel(subject.graduationState.status)}
          </span>
        ) : null}
      </div>
      {loading && !subject ? (
        <p className="insp-empty" data-testid="topic-maturity-loading">
          Loading maturity…
        </p>
      ) : error ? (
        <p className="insp-empty text-danger" data-testid="topic-maturity-error">
          {error}
        </p>
      ) : subject ? (
        <>
          <div className="insp-maturity__grid">
            <div className="insp-maturity__metric">
              <span>{maturityPct(subject.funnel.extractedOfRead)}</span>
              <small>extracted / read</small>
            </div>
            <div className="insp-maturity__metric">
              <span>{maturityPct(subject.funnel.matureOfCarded)}</span>
              <small>
                {subject.funnel.mature}/{subject.funnel.carded} mature
              </small>
            </div>
            <div className="insp-maturity__metric">
              <span>{maturityPct(subject.retention.measuredRetention)}</span>
              <small>target {maturityPct(subject.retention.retentionTarget)}</small>
            </div>
          </div>
          <div className="insp-maturity__buckets" data-testid="topic-maturity-buckets">
            <span>Young {subject.stability.young}</span>
            <span>Maturing {subject.stability.maturing}</span>
            <span>Mature {subject.stability.mature}</span>
            <span>Retired {subject.stability.retired}</span>
          </div>
          {subject.staleness.staleItems > 0 || subject.staleness.needsReverify > 0 ? (
            <p className="insp-maturity__note" data-testid="topic-maturity-flags">
              {subject.staleness.staleItems} stale · {subject.staleness.needsReverify} need reverify
            </p>
          ) : null}
          <p className="insp-maturity__note">{subject.graduationState.reason}</p>
          {subject.graduationState.status === "needs_attention" ? (
            <div className="insp-branch-review" data-testid="topic-maturity-weak-cta">
              <ReviewModeButton
                selector={{ kind: "branch", rootId: topicId }}
                hideWhileLoading
                icon="target"
                label={(n) => `Review ${n} weak-topic card${n === 1 ? "" : "s"}`}
                testId="topic-maturity-review"
              />
            </div>
          ) : null}
        </>
      ) : (
        <p className="insp-empty" data-testid="topic-maturity-empty">
          No maturity receipt yet.
        </p>
      )}
    </div>
  );
}

/** The human label for an expiry status badge (T090). */
const EXPIRY_STATUS_LABEL: Record<FactLifetimeSummary["status"], string> = {
  fresh: "Fresh",
  due_for_review: "Due for review",
  expired: "Expired",
};
/** The badge modifier class for an expiry status (T090). */
const EXPIRY_STATUS_CLASS: Record<FactLifetimeSummary["status"], string> = {
  fresh: "badge--fresh",
  due_for_review: "badge--due-for-review",
  expired: "badge--expired",
};
/** The fact-stability options for the picker (T090). */
const STABILITY_OPTIONS: readonly { value: FactStability; label: string }[] = [
  { value: "stable", label: "Stable" },
  { value: "slow", label: "Slow-changing" },
  { value: "volatile", label: "Volatile" },
];

/**
 * The card's EXPIRY section (T090) — the claim-lifetime editor. Shows the DERIVED
 * expiry status as a badge + `MetaRow`s for `valid_from`/`valid_until`/`review_by`/
 * `jurisdiction`/`software_version`/`fact_stability`, with inline edit controls that
 * call `cards.setLifetime` (one `update_element`; "expired" stays a derived attribute,
 * never a status). Card-only. When no lifetime is set it offers an "Add expiry"
 * affordance; opening the editor reveals the fields. On apply the inspector re-reads
 * (`onChanged`) so the badge + the review banner reflect the new lifetime.
 */
export function ExpirySection({
  cardId,
  lifetime,
  onChanged,
}: {
  cardId: string;
  lifetime: FactLifetimeSummary;
  onChanged: () => void;
}) {
  const anySet =
    lifetime.factStability !== null ||
    !!lifetime.validFrom ||
    !!lifetime.validUntil ||
    !!lifetime.reviewBy ||
    !!lifetime.jurisdiction ||
    !!lifetime.softwareVersion;

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Draft fields seeded from the current lifetime; only opened on demand.
  const [factStability, setFactStability] = useState<FactStability | "">(
    lifetime.factStability ?? "",
  );
  const [validFrom, setValidFrom] = useState(lifetime.validFrom ?? "");
  const [validUntil, setValidUntil] = useState(lifetime.validUntil ?? "");
  const [reviewBy, setReviewBy] = useState(lifetime.reviewBy ?? "");
  const [jurisdiction, setJurisdiction] = useState(lifetime.jurisdiction ?? "");
  const [softwareVersion, setSoftwareVersion] = useState(lifetime.softwareVersion ?? "");

  const openEditor = useCallback(() => {
    setFactStability(lifetime.factStability ?? "");
    setValidFrom(lifetime.validFrom ?? "");
    setValidUntil(lifetime.validUntil ?? "");
    setReviewBy(lifetime.reviewBy ?? "");
    setJurisdiction(lifetime.jurisdiction ?? "");
    setSoftwareVersion(lifetime.softwareVersion ?? "");
    setError(null);
    setEditing(true);
  }, [lifetime]);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await appApi.setCardLifetime({
        cardId,
        factStability: factStability === "" ? null : factStability,
        validFrom,
        validUntil,
        reviewBy,
        jurisdiction,
        softwareVersion,
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    cardId,
    factStability,
    validFrom,
    validUntil,
    reviewBy,
    jurisdiction,
    softwareVersion,
    onChanged,
  ]);

  return (
    <div className="insp-sec" data-testid="expiry-section">
      <div className="insp-sec__title">
        <span>Expiry</span>
        <span
          className={`badge ${EXPIRY_STATUS_CLASS[lifetime.status]}`}
          data-testid="inspector-expiry-badge"
          data-expiry-status={lifetime.status}
        >
          <Icon name={lifetime.status === "expired" ? "hourglass" : "calendar"} size={11} />
          {EXPIRY_STATUS_LABEL[lifetime.status]}
        </span>
      </div>

      {!editing ? (
        <>
          {anySet ? (
            <div className="meta-list">
              <MetaRow k="Valid from">{lifetime.validFrom || "—"}</MetaRow>
              <MetaRow k="Valid until">{lifetime.validUntil || "—"}</MetaRow>
              <MetaRow k="Review by">{lifetime.reviewBy || "—"}</MetaRow>
              <MetaRow k="Jurisdiction">{lifetime.jurisdiction || "—"}</MetaRow>
              <MetaRow k="Version">{lifetime.softwareVersion || "—"}</MetaRow>
              <MetaRow k="Stability">
                {lifetime.factStability
                  ? (STABILITY_OPTIONS.find((o) => o.value === lifetime.factStability)?.label ??
                    lifetime.factStability)
                  : "—"}
              </MetaRow>
            </div>
          ) : (
            <p className="insp-empty" data-testid="inspector-expiry-empty">
              No expiry set — this fact never goes stale.
            </p>
          )}
          <button
            type="button"
            className="insp-add__btn"
            data-testid="inspector-expiry-edit"
            onClick={openEditor}
            style={{ marginTop: 8 }}
          >
            <Icon name="calendar" size={13} />
            {anySet ? "Edit expiry" : "Add expiry"}
          </button>
        </>
      ) : (
        <div className="meta-list">
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Valid until</span>
            <input
              className="insp-add__input"
              data-testid="inspector-expiry-valid-until"
              placeholder="YYYY-MM-DD"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
            />
          </div>
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Review by</span>
            <input
              className="insp-add__input"
              data-testid="inspector-expiry-review-by"
              placeholder="YYYY-MM-DD"
              value={reviewBy}
              onChange={(e) => setReviewBy(e.target.value)}
            />
          </div>
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Valid from</span>
            <input
              className="insp-add__input"
              data-testid="inspector-expiry-valid-from"
              placeholder="YYYY-MM-DD"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
          </div>
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Stability</span>
            <select
              className="insp-add__select"
              data-testid="inspector-expiry-stability"
              value={factStability}
              onChange={(e) => setFactStability(e.target.value as FactStability | "")}
            >
              <option value="">Unspecified</option>
              {STABILITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Jurisdiction</span>
            <input
              className="insp-add__input"
              data-testid="inspector-expiry-jurisdiction"
              placeholder="US-CA / EU / global"
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
            />
          </div>
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Version</span>
            <input
              className="insp-add__input"
              data-testid="inspector-expiry-version"
              placeholder="React 19 / Postgres 18"
              value={softwareVersion}
              onChange={(e) => setSoftwareVersion(e.target.value)}
            />
          </div>
          <div className="insp-add" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="insp-add__btn"
              data-testid="inspector-expiry-apply"
              disabled={busy}
              onClick={() => void save()}
            >
              <Icon name="check" size={13} />
              Apply
            </button>
            <button
              type="button"
              className="insp-add__btn"
              data-testid="inspector-expiry-cancel"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
          {error ? (
            <span className="text-danger" data-testid="inspector-expiry-error">
              {error}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The verification-task kinds the "Create task" picker offers (T092). */
const TASK_TYPE_OPTIONS: readonly { value: TaskType; label: string }[] = [
  { value: "verify_claim", label: "Verify claim" },
  { value: "find_better_source", label: "Find better source" },
  { value: "update_outdated_card", label: "Update outdated card" },
  { value: "check_current_version", label: "Check current version" },
  { value: "custom", label: "Custom task" },
];

/**
 * The "Maintenance" section (T092) — the open verification TASKS protecting a
 * card/extract/source, with complete/postpone per task, plus a "Create verification
 * task" control (kind picker + note + a tomorrow/next-week/next-month schedule). A
 * `task` is the EXISTING core element type, ATTENTION-scheduled (never FSRS); creating
 * one logs `create_element` + `add_relation`, completing/postponing logs
 * `reschedule_element` — all through the typed `tasks.*` `window.appApi`. The list is
 * fetched on mount + after every mutation (and via the external `refreshTick`), so a
 * task generated from expiry or created on the review banner shows up here too.
 */
export function MaintenanceSection({
  elementId,
  elementTitle,
  onChanged,
  refreshTick = 0,
}: {
  elementId: string;
  elementTitle: string;
  onChanged: () => void;
  refreshTick?: number;
}) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [taskType, setTaskType] = useState<TaskType>("verify_claim");
  const [note, setNote] = useState("");
  const [dueChoice, setDueChoice] = useState<"tomorrow" | "nextWeek" | "nextMonth">("tomorrow");

  const load = useCallback(() => {
    if (!isDesktop()) return;
    appApi
      .listTasks({ linkedElementId: elementId })
      .then((res) => setTasks([...res.tasks]))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [elementId]);

  // Re-load on element change + on the external refresh tick (post-mutation elsewhere).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick is a deliberate re-fetch trigger
  useEffect(() => {
    load();
  }, [load, refreshTick]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await fn();
        load();
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, load, onChanged],
  );

  const onCreate = () => {
    void run(async () => {
      await appApi.createTask({
        taskType,
        title: taskTitleFor(taskType, elementTitle),
        ...(note.trim() ? { note: note.trim() } : {}),
        linkedElementId: elementId,
        dueChoice: { kind: dueChoice },
      });
      setNote("");
      setTaskType("verify_claim");
      setDueChoice("tomorrow");
      setCreating(false);
    });
  };

  return (
    <div className="insp-sec" data-testid="maintenance-section">
      <div className="insp-sec__title">
        <span>Maintenance</span>
        <span className="insp-sec__count" data-testid="maintenance-count">
          {tasks.length}
        </span>
      </div>

      {tasks.length > 0 ? (
        <div className="insp-task-list" data-testid="maintenance-task-list">
          {tasks.map((t) => (
            <div
              className="insp-task"
              data-testid="maintenance-task"
              data-task-id={t.id}
              key={t.id}
            >
              <div className="insp-task__main">
                <span className="insp-task__kind">
                  <Icon name="task" size={13} /> {taskTypeLabel(t.taskType)}
                </span>
                {t.note ? <span className="insp-task__note">{t.note}</span> : null}
              </div>
              <div className="insp-task__acts">
                <button
                  type="button"
                  className="insp-task__act"
                  data-testid="maintenance-complete"
                  title="Complete"
                  aria-label="Complete task"
                  disabled={busy}
                  onClick={() => run(() => appApi.completeTask({ id: t.id }))}
                >
                  <Icon name="check" size={13} />
                </button>
                <button
                  type="button"
                  className="insp-task__act"
                  data-testid="maintenance-postpone"
                  title="Postpone"
                  aria-label="Postpone task"
                  disabled={busy}
                  onClick={() => run(() => appApi.postponeTask({ id: t.id }))}
                >
                  <Icon name="postpone" size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="insp-empty" data-testid="maintenance-empty">
          No open maintenance tasks.
        </p>
      )}

      {creating ? (
        <div className="meta-list" style={{ marginTop: 8 }}>
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Task</span>
            <select
              className="insp-add__select"
              data-testid="maintenance-type"
              value={taskType}
              onChange={(e) => setTaskType(e.target.value as TaskType)}
            >
              {TASK_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Note</span>
            <input
              className="insp-add__input"
              data-testid="maintenance-note"
              placeholder="What needs checking?"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Schedule</span>
            <select
              className="insp-add__select"
              data-testid="maintenance-due"
              value={dueChoice}
              onChange={(e) =>
                setDueChoice(e.target.value as "tomorrow" | "nextWeek" | "nextMonth")
              }
            >
              <option value="tomorrow">Tomorrow</option>
              <option value="nextWeek">Next week</option>
              <option value="nextMonth">Next month</option>
            </select>
          </div>
          <div className="insp-add" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="insp-add__btn"
              data-testid="maintenance-create-save"
              disabled={busy}
              onClick={onCreate}
            >
              <Icon name="check" size={13} />
              Create task
            </button>
            <button
              type="button"
              className="insp-add__btn"
              data-testid="maintenance-create-cancel"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="insp-add__btn insp-add__btn--inline"
          data-testid="maintenance-create"
          onClick={() => setCreating(true)}
          style={{ marginTop: 8 }}
        >
          <Icon name="plus" size={13} />
          Create verification task
        </button>
      )}

      {error ? (
        <span className="text-danger" data-testid="maintenance-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function taskTitleFor(taskType: TaskType, elementTitle: string): string {
  const target = elementTitle.trim() || "this item";
  return `${taskTypeLabel(taskType)}: ${target}`.slice(0, 256);
}

/** The source-type options for the reliability picker (T091). */
const SOURCE_TYPE_OPTIONS: readonly { value: SourceTypeInput; label: string }[] = [
  { value: "paper", label: "Paper" },
  { value: "book", label: "Book" },
  { value: "article", label: "Article" },
  { value: "docs", label: "Docs" },
  { value: "reference", label: "Reference" },
  { value: "blog", label: "Blog" },
  { value: "forum", label: "Forum" },
  { value: "video", label: "Video" },
  { value: "dataset", label: "Dataset" },
  { value: "personal_note", label: "Personal note" },
  { value: "other", label: "Other" },
];
/** The reliability-tier options (T091). */
const TIER_OPTIONS: readonly { value: ReliabilityTierInput; label: string }[] = [
  { value: "primary", label: "Primary" },
  { value: "secondary", label: "Secondary" },
  { value: "tertiary", label: "Tertiary" },
];
/** The confidence options (T091). */
const CONFIDENCE_OPTIONS: readonly { value: ConfidenceLevelInput; label: string }[] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];
const TYPE_LABEL: Record<SourceTypeInput, string> = Object.fromEntries(
  SOURCE_TYPE_OPTIONS.map((o) => [o.value, o.label]),
) as Record<SourceTypeInput, string>;
/** The badge class for a reliability tier / uncertainty (mirrors the RefBlock helper). */
function reliabilityBadgeClass(
  tier: ReliabilityTierInput | null,
  confidence: ConfidenceLevelInput | null,
  notes: string | null,
): string {
  const uncertain = confidence === "low" || (notes != null && notes.trim() !== "");
  if (uncertain) return "badge--uncertain";
  if (tier === "primary") return "badge--tier-primary";
  if (tier === "secondary") return "badge--tier-secondary";
  if (tier === "tertiary") return "badge--tier-tertiary";
  return "badge--reliability";
}

/**
 * The source's RELIABILITY section (T091) — the trust-metadata editor for a `source`.
 * Shows the tier/type/confidence as a badge + `MetaRow`s and the free-text notes, with
 * inline edit controls (three enum pickers + a notes textarea) that call
 * `sources.updateReliability` (one `update_element`; reliability is provenance, not
 * lineage). Source-only. When nothing is set it offers an "Add reliability" affordance.
 * On apply the inspector re-reads (`onChanged`) so the badge + the card refblocks derived
 * from this source reflect the new reliability.
 */
export function ReliabilitySection({
  sourceId,
  provenance,
  onChanged,
}: {
  sourceId: string;
  provenance: SourceProvenance;
  onChanged: () => void;
}) {
  const anySet =
    provenance.sourceType !== null ||
    provenance.reliabilityTier !== null ||
    provenance.confidence !== null ||
    (provenance.reliabilityNotes ?? "") !== "";

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<SourceTypeInput | "">(provenance.sourceType ?? "");
  const [tier, setTier] = useState<ReliabilityTierInput | "">(provenance.reliabilityTier ?? "");
  const [confidence, setConfidence] = useState<ConfidenceLevelInput | "">(
    provenance.confidence ?? "",
  );
  const [notes, setNotes] = useState(provenance.reliabilityNotes ?? "");

  const openEditor = useCallback(() => {
    setSourceType(provenance.sourceType ?? "");
    setTier(provenance.reliabilityTier ?? "");
    setConfidence(provenance.confidence ?? "");
    setNotes(provenance.reliabilityNotes ?? "");
    setError(null);
    setEditing(true);
  }, [provenance]);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await appApi.updateSourceReliability({
        sourceId,
        sourceType: sourceType === "" ? null : sourceType,
        reliabilityTier: tier === "" ? null : tier,
        confidence: confidence === "" ? null : confidence,
        reliabilityNotes: notes,
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, sourceId, sourceType, tier, confidence, notes, onChanged]);

  // The calm one-line badge label ("Primary source · high confidence"), mirroring the
  // core `formatSourceRef` summary so the inspector + the refblock read identically.
  const badgeLabel = (() => {
    const parts: string[] = [];
    if (provenance.reliabilityTier) {
      const tw = { primary: "Primary", secondary: "Secondary", tertiary: "Tertiary" }[
        provenance.reliabilityTier
      ];
      parts.push(`${tw} source`);
    } else if (provenance.sourceType) {
      parts.push(TYPE_LABEL[provenance.sourceType]);
    }
    if (provenance.confidence) parts.push(`${provenance.confidence} confidence`);
    return parts.length > 0 ? parts.join(" · ") : "Source notes";
  })();
  const uncertain =
    provenance.confidence === "low" || (provenance.reliabilityNotes ?? "").trim() !== "";

  return (
    <div className="insp-sec" data-testid="reliability-section">
      <div className="insp-sec__title">
        <span>Reliability</span>
        {anySet ? (
          <span
            className={`badge ${reliabilityBadgeClass(
              provenance.reliabilityTier,
              provenance.confidence,
              provenance.reliabilityNotes,
            )}`}
            data-testid="inspector-reliability-badge"
            data-reliability-tier={provenance.reliabilityTier ?? ""}
            data-reliability-confidence={provenance.confidence ?? ""}
          >
            <Icon name={uncertain ? "warning" : "shield"} size={11} />
            {badgeLabel}
          </span>
        ) : null}
      </div>

      {!editing ? (
        <>
          {anySet ? (
            <div className="meta-list">
              <MetaRow k="Type">
                {provenance.sourceType ? TYPE_LABEL[provenance.sourceType] : "—"}
              </MetaRow>
              <MetaRow k="Tier">
                {provenance.reliabilityTier
                  ? (TIER_OPTIONS.find((o) => o.value === provenance.reliabilityTier)?.label ??
                    provenance.reliabilityTier)
                  : "—"}
              </MetaRow>
              <MetaRow k="Confidence">
                {provenance.confidence
                  ? (CONFIDENCE_OPTIONS.find((o) => o.value === provenance.confidence)?.label ??
                    provenance.confidence)
                  : "—"}
              </MetaRow>
              {provenance.reliabilityNotes ? (
                <div className="meta-row meta-row--stack">
                  <span className="meta-key">Notes</span>
                  <span data-testid="inspector-reliability-notes">
                    {provenance.reliabilityNotes}
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="insp-empty" data-testid="inspector-reliability-empty">
              No reliability set — add the source's tier, type, and confidence.
            </p>
          )}
          <button
            type="button"
            className="insp-add__btn"
            data-testid="inspector-reliability-edit"
            onClick={openEditor}
            style={{ marginTop: 8 }}
          >
            <Icon name="shield" size={13} />
            {anySet ? "Edit reliability" : "Add reliability"}
          </button>
        </>
      ) : (
        <div className="meta-list">
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Tier</span>
            <select
              className="insp-add__select"
              data-testid="inspector-reliability-tier"
              value={tier}
              onChange={(e) => setTier(e.target.value as ReliabilityTierInput | "")}
            >
              <option value="">Unspecified</option>
              {TIER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Type</span>
            <select
              className="insp-add__select"
              data-testid="inspector-reliability-type"
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as SourceTypeInput | "")}
            >
              <option value="">Unspecified</option>
              {SOURCE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Confidence</span>
            <select
              className="insp-add__select"
              data-testid="inspector-reliability-confidence"
              value={confidence}
              onChange={(e) => setConfidence(e.target.value as ConfidenceLevelInput | "")}
            >
              <option value="">Unspecified</option>
              {CONFIDENCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Notes</span>
            <textarea
              className="insp-add__input"
              data-testid="inspector-reliability-notes-input"
              placeholder="Caveats / known biases"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="insp-add" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="insp-add__btn"
              data-testid="inspector-reliability-apply"
              disabled={busy}
              onClick={() => void save()}
            >
              <Icon name="check" size={13} />
              Apply
            </button>
            <button
              type="button"
              className="insp-add__btn"
              data-testid="inspector-reliability-cancel"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
          {error ? (
            <span className="text-danger" data-testid="inspector-reliability-error">
              {error}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The card's RETIREMENT row (T082) — shows whether the card is currently retired and
 * a Retire / Un-retire toggle. Retiring removes a low-value mature card from active
 * review gracefully (reversibly), kept for reference; un-retiring returns it to the
 * normal due read at its existing due date. Card-only; backed by `cards.retire` /
 * `cards.unretire` (each `update_element`, never a delete). On success the inspector
 * re-reads (`onChanged`) so the row + the header badge update without a reload.
 */
function RetirementRow({
  cardId,
  isRetired,
  onChanged,
}: {
  cardId: string;
  isRetired: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isRetired) {
        await appApi.unretireCard({ cardId });
      } else {
        await appApi.retireCard({ cardId });
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, isRetired, cardId, onChanged]);
  return (
    <MetaRow k="Retirement">
      <div className="insp-retire">
        <span className="insp-retire__state" data-testid="inspector-retired-state">
          {isRetired ? (
            <>
              <span className="insp-retire__dot insp-retire__dot--retired" />
              Retired · kept for reference
            </>
          ) : (
            <>
              <span className="insp-retire__dot insp-retire__dot--active" />
              Active
            </>
          )}
        </span>
        <button
          type="button"
          className="insp-add__btn"
          data-testid="inspector-retire-toggle"
          disabled={busy}
          onClick={() => void toggle()}
        >
          <Icon name={isRetired ? "restore" : "archive"} size={13} />
          {isRetired ? "Un-retire" : "Retire"}
        </button>
      </div>
      {error ? (
        <span className="text-danger" data-testid="inspector-retire-error">
          {" "}
          · {error}
        </span>
      ) : null}
    </MetaRow>
  );
}

/** One clickable related-item row (a similar extract, a duplicate, or a sibling source). */
function RelatedRow({
  item,
  onSelect,
}: {
  item: SemanticRelatedItem;
  onSelect: (id: string) => void;
}) {
  const isDuplicate = item.kind === "duplicate";
  // A local "dismiss" so a flagged duplicate can be hidden for this session. A
  // PERSISTED "not a duplicate" mark is DEFERRED to a later task (T088 surfaces,
  // it never mutates lineage / writes a relation) — see the section docblock.
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const pct = item.similarity != null ? `${Math.round(item.similarity * 100)}%` : null;
  return (
    <div
      className={`related-row${isDuplicate ? " related-row--duplicate" : ""}`}
      data-testid={isDuplicate ? "related-duplicate-row" : "related-similar-row"}
      data-element-id={item.id}
    >
      <button
        type="button"
        className="related-row__main"
        data-testid="related-row-select"
        onClick={() => onSelect(item.id)}
        title={item.title}
      >
        <TypeIcon type={item.type} />
        <span className="related-row__title">{item.title || "Untitled"}</span>
        {isDuplicate ? (
          <span className="related-row__badge" data-testid="related-duplicate-badge">
            possible duplicate
          </span>
        ) : null}
        {pct ? <span className="related-row__sim">{pct}</span> : null}
      </button>
      {isDuplicate ? (
        <button
          type="button"
          className="related-row__dismiss"
          data-testid="related-duplicate-dismiss"
          aria-label="Dismiss duplicate suggestion"
          title="Dismiss (this session)"
          onClick={() => setDismissed(true)}
        >
          <Icon name="x" size={13} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Related section (T088) — DERIVED similar extracts / possible duplicates /
 * prerequisite concepts / sibling sources for the selected element, fetched through
 * the typed `semantic.related` bridge. Everything is a read-only suggestion over the
 * `vec0` store + the concept lineage — no relations are written, no lineage mutated.
 *
 * Graceful degrade: when `semanticAvailable` is false (sqlite-vec unavailable or
 * not indexed) the vector buckets (similar/duplicates) hide and a calm availability
 * hint shows, while the concept + sibling-source buckets STILL resolve from lineage.
 * Pure UI: one command, no SQL/vectors in React.
 */
export function RelatedSection({
  elementId,
  onSelect,
}: {
  elementId: string;
  onSelect: (id: string) => void;
}) {
  const [related, setRelated] = useState<SemanticRelatedResult | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    appApi
      .semanticRelated({ elementId })
      .then((res) => {
        if (!cancelled) setRelated(res);
      })
      .catch(() => {
        if (!cancelled) setRelated(null);
      });
    return () => {
      cancelled = true;
    };
  }, [elementId]);

  if (!related) return null;

  const { similar, duplicates, prerequisiteConcepts, siblingSources, semanticAvailable } = related;
  const hasAnything =
    similar.length > 0 ||
    duplicates.length > 0 ||
    prerequisiteConcepts.length > 0 ||
    siblingSources.length > 0;

  // Nothing to show AND semantics are available with nothing nearby → skip the
  // section entirely (keep the inspector calm). When vector search is unavailable
  // we still show the hint so the user knows similarity suggestions are currently missing.
  if (!hasAnything && semanticAvailable) return null;

  return (
    <div className="insp-sec" data-testid="related-section">
      <div className="insp-sec__title">Related</div>

      {duplicates.length > 0 ? (
        <div className="related-bucket" data-testid="related-duplicates">
          <div className="related-bucket__label">Possible duplicates</div>
          {duplicates.map((item) => (
            <RelatedRow key={item.id} item={item} onSelect={onSelect} />
          ))}
        </div>
      ) : null}

      {similar.length > 0 ? (
        <div className="related-bucket" data-testid="related-similar">
          <div className="related-bucket__label">Similar extracts</div>
          {similar.map((item) => (
            <RelatedRow key={item.id} item={item} onSelect={onSelect} />
          ))}
        </div>
      ) : null}

      {prerequisiteConcepts.length > 0 ? (
        <div className="related-bucket" data-testid="related-prereqs">
          <div className="related-bucket__label">Prerequisite concepts</div>
          <div className="related-bucket__concepts" data-testid="related-prereq-concepts">
            {prerequisiteConcepts.map((c) => (
              <ConceptTag key={c.id} name={c.name} />
            ))}
          </div>
        </div>
      ) : null}

      {siblingSources.length > 0 ? (
        <div className="related-bucket" data-testid="related-siblings">
          <div className="related-bucket__label">Sibling sources</div>
          {siblingSources.map((item) => (
            <RelatedRow key={item.id} item={item} onSelect={onSelect} />
          ))}
        </div>
      ) : null}

      {!semanticAvailable ? (
        <p className="insp-empty" data-testid="related-degrade-hint">
          Similarity suggestions are unavailable until the local semantic index is ready.
        </p>
      ) : null}
    </div>
  );
}

function AttentionSummary({
  scheduler,
  busy,
  onSchedule,
}: {
  scheduler: InspectorData["scheduler"] & { kind: "attention" };
  busy: boolean;
  onSchedule: (choice: QueueScheduleChoice) => void;
}) {
  return (
    <div className="attention-summary" data-testid="attention-summary">
      <div className="attention-summary__main">
        <span>{seenLabel(scheduler.lastProcessedAt)}</span>
        {scheduler.postponed === 0 ? <span>Postponed 0x</span> : null}
      </div>
      {scheduler.yield ? (
        <div className="attention-summary__yield" data-testid="inspector-yield">
          <span data-testid="inspector-yield-read">
            {Math.round(scheduler.yield.readPct * 100)}% read
          </span>
          <span>
            {scheduler.yield.extractsCreated} extract
            {scheduler.yield.extractsCreated === 1 ? "" : "s"}
          </span>
          <span>
            {scheduler.yield.cardsCreated} card{scheduler.yield.cardsCreated === 1 ? "" : "s"}
          </span>
        </div>
      ) : null}
      <div className="attention-summary__actions">
        <ScheduleMenu disabled={busy} onSchedule={onSchedule} />
      </div>
    </div>
  );
}

function SourceLineageSection({
  source,
  sourceRef,
  location,
  onOpenLineageItem,
  onJumpToLocation,
}: {
  source: LineageItem | null;
  sourceRef: InspectorData["sourceRef"];
  location: InspectorData["location"];
  onOpenLineageItem: (item: LineageItem) => void;
  onJumpToLocation: (location: NonNullable<InspectorData["location"]>) => void;
}) {
  const quote = location?.selectedText || sourceRef?.snippet || "";
  const canJump = Boolean(location && location.blockIds.length > 0);
  const hasSourceContext = Boolean(source || sourceRef || location);
  const showLocationLabel = Boolean(location?.label);

  if (!hasSourceContext) {
    return (
      <div className="insp-sec" data-testid="source-lineage-section">
        <div className="insp-sec__title">Source lineage</div>
        <p className="insp-empty">Source unavailable.</p>
      </div>
    );
  }

  return (
    <div className="insp-sec source-lineage" data-testid="source-lineage-section">
      <div className="insp-sec__title">
        <span>Source lineage</span>
        {canJump && location ? (
          <button
            type="button"
            className="insp-jump"
            data-testid="location-jump"
            title="Open the source and scroll to this paragraph"
            onClick={() => onJumpToLocation(location)}
          >
            <Icon name="external" size={13} /> Jump to source
          </button>
        ) : null}
      </div>

      {source ? (
        <div className="tree" data-testid="source-lineage-source">
          <LineageRow item={source} onOpen={onOpenLineageItem} />
        </div>
      ) : sourceRef?.sourceTitle ? (
        <div className="source-lineage__title" data-testid="source-lineage-source-title">
          {sourceRef.sourceTitle}
        </div>
      ) : null}

      {quote ? (
        <blockquote className="insp-quote" data-testid="source-lineage-quote">
          {quote}
        </blockquote>
      ) : null}

      {sourceRef ? (
        <RefBlock ref={sourceRef} testId="inspector-refblock" showSnippet={false} />
      ) : (
        <p className="insp-empty">Source reference unavailable.</p>
      )}

      {location ? (
        <div className="meta-list source-lineage__location" data-testid="source-lineage-location">
          {showLocationLabel ? <MetaRow k="Location">{location.label}</MetaRow> : null}
          {location.blockIds.length > 0 ? (
            <MetaRow k="Blocks">{location.blockIds.length}</MetaRow>
          ) : null}
          {location.startOffset !== null || location.endOffset !== null ? (
            <MetaRow k="Offsets">
              {location.startOffset ?? "—"}-{location.endOffset ?? "—"}
            </MetaRow>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The full metadata view for one inspected element. */
/** Short date for the relocated "Parked {date}" context line (matches the Library detail column). */
function formatParkedDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

function InspectorBody({
  data,
  lineage,
  allConcepts,
  onSelect,
  onOpenLineageItem,
  onPickLineageNode,
  onRestoreTombstone,
  onRestoreAncestors,
  restoringId,
  onJumpToLocation,
  onSetPriority,
  onFallowTopic,
  onUnfallowTopic,
  onScheduleAttention,
  onOrganizeChanged,
  priorityBusy,
  scheduleBusy,
  refreshTick,
}: {
  data: InspectorData;
  lineage: LineageData | null;
  allConcepts: readonly ConceptNode[];
  onSelect: (id: string) => void;
  onOpenLineageItem: (item: LineageItem) => void;
  onPickLineageNode: (node: LineageNode) => void;
  /** Restore one tombstone node from the lineage tree (T135 / U2) — restores its chain. */
  onRestoreTombstone: (node: LineageNode) => void;
  /** Restore the FOCUSED element's tombstoned ancestor chain (root-first) for the R3 hint. */
  onRestoreAncestors: () => void;
  /** The tombstone id whose restore is in flight (its control shows busy). */
  restoringId: string | null;
  onJumpToLocation: (location: NonNullable<InspectorData["location"]>) => void;
  onSetPriority: (action: ElementsSetPriorityAction) => void;
  onFallowTopic: (request: TopicFallowRequest) => Promise<TopicFallowResult>;
  onUnfallowTopic: (request: TopicUnfallowRequest) => Promise<TopicFallowResult>;
  onScheduleAttention: (elementId: string, choice: QueueScheduleChoice) => void;
  onOrganizeChanged: () => void;
  priorityBusy: boolean;
  scheduleBusy: boolean;
  refreshTick: number;
}) {
  const {
    element,
    scheduler,
    parent,
    children,
    source,
    provenance,
    location,
    sourceRef,
    tags,
    concepts,
    review,
    lifetime,
  } = data;
  // The relocated inbox triage cluster (buttons + provenance-aware priority picker
  // + suggestions) renders above Properties ONLY when an inbox source with a
  // matching published payload is inspected — keeping inbox behavior off every
  // other route that shares this universal inspector. When active, the generic
  // Properties "Set priority" row is suppressed to avoid a duplicate control
  // (the relocated picker is the provenance-aware one — see InboxTriageSection).
  const { panel: inboxTriagePanel, registerSection, registerReadNowButton } = useInboxTriagePanel();
  const showInboxTriage =
    inboxTriagePanel !== null &&
    inboxTriagePanel.targetId === element.id &&
    element.type === "source";
  // The relocated Library controls (Open + parked actions + context lines), moved
  // out of the deleted Library detail column. Rendered ONLY when a Library screen
  // has published a payload for the element this inspector is showing — gated on
  // the inspector's own loaded `element.id`, so the controls cannot leak onto
  // other routes (queue / reader / review / card).
  const { panel: libraryPanel } = useLibraryInspectorPanel();
  const showLibraryControls = libraryPanel !== null && libraryPanel.targetId === element.id;
  const [lineageDeletedVisibility, setLineageDeletedVisibility] = useState<{
    elementId: string;
    showDeleted: boolean;
  } | null>(null);
  // The right-clicked lineage node + cursor position driving the LineageContextMenu (U6).
  const [lineageMenu, setLineageMenu] = useState<{
    node: LineageNode;
    position: ContextMenuPosition;
  } | null>(null);
  const showDeletedLineage =
    lineageDeletedVisibility?.elementId === element.id
      ? lineageDeletedVisibility.showDeleted
      : false;
  const currentLineage = lineage?.elementId === element.id ? lineage : null;
  const redactCardSourceContext = element.type === "card" && isScopeActive("review");
  const showSourceLineage =
    !redactCardSourceContext &&
    element.type !== "source" &&
    (SOURCE_LINEAGE_TYPES.has(element.type) || Boolean(source || sourceRef || location));
  const deletedLineageCount = currentLineage?.nodes.filter((n) => n.deleted).length ?? 0;
  const hasDeletedLineage = deletedLineageCount > 0;
  const lineageNodes = useMemo(
    () => (currentLineage ? visibleLineageNodes(currentLineage.nodes, showDeletedLineage) : []),
    [currentLineage, showDeletedLineage],
  );
  const tombstonedAncestorCount = useMemo(() => {
    if (!currentLineage) return 0;
    return deletedAncestorCount(currentLineage.nodes);
  }, [currentLineage]);
  return (
    <div className="insp" data-testid="inspector-content" data-element-type={element.type}>
      {/* Header: identity + one compact state line. */}
      <div className="insp-head">
        <TypeIcon type={element.type} lg />
        <div style={{ minWidth: 0 }}>
          <h2 className="insp-head__title" data-testid="inspector-title">
            {element.title}
          </h2>
          <div className="insp-head__state" data-testid="inspector-state-line">
            {headerStateLine(element, review)}
          </div>
        </div>
      </div>

      {/* Inbox triage (relocated from the inbox preview rail) — gated to an inbox
          source with a matching published payload, above Properties. */}
      {showInboxTriage && inboxTriagePanel ? (
        <InboxTriageSection
          panel={inboxTriagePanel}
          registerSection={registerSection}
          registerReadNowButton={registerReadNowButton}
        />
      ) : null}

      {/* Library controls (relocated from the deleted Library detail column) —
          gated to the Library-selected element. Context lines + parked-source
          quick-actions + the primary Open action. */}
      {showLibraryControls && libraryPanel ? (
        <div className="insp-sec insp-library" data-testid="inspector-library-actions">
          {libraryPanel.parkedAt ? (
            <div className="insp-library__reason" data-testid="inspector-parked-date">
              Parked {formatParkedDate(libraryPanel.parkedAt)}
            </div>
          ) : null}
          {libraryPanel.notInQueueReason ? (
            <div className="insp-library__reason" data-testid="inspector-queue-reason">
              {libraryPanel.notInQueueReason}
            </div>
          ) : null}
          {libraryPanel.parked ? (
            <div className="insp-library__parked" data-testid="inspector-parked-actions">
              <button
                type="button"
                className="insp-add__btn"
                data-testid="inspector-parked-inbox"
                disabled={libraryPanel.parked.busy}
                onClick={libraryPanel.parked.onMoveToInbox}
              >
                <Icon name="inbox" size={13} />
                Move to inbox
              </button>
              <button
                type="button"
                className="insp-add__btn"
                data-testid="inspector-parked-schedule"
                disabled={libraryPanel.parked.busy}
                onClick={libraryPanel.parked.onQueueSoon}
              >
                <Icon name="clock" size={13} />
                Queue soon
              </button>
              <button
                type="button"
                className="insp-add__btn"
                data-testid="inspector-parked-dismiss"
                disabled={libraryPanel.parked.busy}
                onClick={libraryPanel.parked.onDismiss}
              >
                <Icon name="x" size={13} />
                Dismiss
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="insp-add__btn insp-add__btn--accent"
            data-testid="inspector-open-element"
            onClick={libraryPanel.onOpen}
          >
            <Icon name="external" size={13} />
            {libraryPanel.openLabel}
          </button>
        </div>
      ) : null}

      {/* Properties: the editable control surface. */}
      <div className="insp-sec">
        <div className="insp-sec__title">Properties</div>
        <div className="meta-list">
          <MetaRow k="Type">
            <span data-testid="meta-type">{typeLabel(element.type)}</span>
          </MetaRow>
          <MetaRow k="Status">
            <Status status={element.status} />
          </MetaRow>
          <MetaRow k="Priority">
            <span data-testid="meta-priority">
              {priorityLabel(element.priority)} · {element.priority.toFixed(3)}
            </span>
          </MetaRow>
          {/* Full-width row: the A/B/C/D editor needs the whole body width to lay
              out ↑ A B C D ↓ on one calm line. In the 2-column MetaRow the ~147px
              value cell is too narrow and the last band ("D") clips at the fixed
              296px inspector edge — so the label sits on its own line and the
              control spans below it. The control's own flex-wrap is the safety net.
              Suppressed for an inbox source whose triage section is active above —
              that section's picker is the provenance-aware one (avoids a duplicate). */}
          {showInboxTriage ? null : (
            <div className="meta-row meta-row--stack">
              <span className="meta-key">Set priority</span>
              <PriorityControl
                priority={element.priority}
                busy={priorityBusy}
                onSetPriority={onSetPriority}
              />
            </div>
          )}
          <MetaRow k="Due">
            <span data-testid="meta-due">{fmtDate(element.dueAt)}</span>
          </MetaRow>
        </div>
      </div>

      {element.type === "topic" ? (
        <FallowSection
          key={element.id}
          element={element}
          busy={scheduleBusy}
          onFallow={onFallowTopic}
          onUnfallow={onUnfallowTopic}
        />
      ) : null}

      {element.type === "topic" ? (
        <TopicMaturitySection key={`${element.id}:${refreshTick}`} topicId={element.id} />
      ) : null}

      {/* Scheduler — the FSRS vs attention split, surfaced explicitly. */}
      <div className="insp-sec" data-testid="scheduler-section">
        <div className="insp-sec__title">
          <span>{scheduler.kind === "fsrs" ? "Recall (FSRS)" : "Attention"}</span>
          <SchedulerChip scheduler={scheduler} />
        </div>
        {/* T123 content-staleness advisory — distinct from the T090 topic-knowledge
            "N need reverify" count above; this is THIS element's own body drift. */}
        {scheduler.needsReverify ? (
          <p className="insp-reverify" data-testid="inspector-reverify">
            <Icon name="warning" size={13} /> Source content changed — re-verify this item
          </p>
        ) : null}
        <ScheduleReasonLine scheduler={scheduler} className="insp-schedule-reason" />
        {scheduler.kind === "fsrs" ? (
          review ? (
            <FsrsStats scheduler={scheduler} />
          ) : (
            <p className="insp-empty" data-testid="fsrs-review-missing">
              Review state unavailable.
            </p>
          )
        ) : isAttentionScheduler(scheduler) ? (
          <AttentionSummary
            scheduler={scheduler}
            busy={scheduleBusy}
            onSchedule={(choice) => onScheduleAttention(element.id, choice)}
          />
        ) : (
          <p className="insp-empty">Scheduler unavailable.</p>
        )}
      </div>

      {/* Source provenance (only on sources). */}
      {provenance && (
        <div className="insp-sec">
          <div className="insp-sec__title">Source</div>
          <div className="meta-list">
            <MetaRow k="Author">{provenance.author ?? "—"}</MetaRow>
            <MetaRow k="URL">
              {provenance.url ? (
                <ExternalUrlLink testId="provenance-url" url={provenance.url} />
              ) : (
                "—"
              )}
            </MetaRow>
            {provenance.canonicalUrl &&
            !sameProvenanceUrl(provenance.url, provenance.canonicalUrl) ? (
              <MetaRow k="Canonical URL">
                <ExternalUrlLink testId="provenance-canonical-url" url={provenance.canonicalUrl} />
              </MetaRow>
            ) : null}
            {provenance.originalUrl &&
            !sameProvenanceUrl(provenance.originalUrl, provenance.url) ? (
              <MetaRow k="Original URL">
                <ExternalUrlLink testId="provenance-original-url" url={provenance.originalUrl} />
              </MetaRow>
            ) : null}
            <MetaRow k="Published">{fmtDate(provenance.publishedAt)}</MetaRow>
            <MetaRow k="Accessed">
              <span data-testid="provenance-accessed-at">{fmtDate(provenance.accessedAt)}</span>
            </MetaRow>
            {provenance.reasonAdded && <MetaRow k="Reason">{provenance.reasonAdded}</MetaRow>}
          </div>
        </div>
      )}

      {/* Source reliability (T091) — the trust-metadata editor, sources only. Tier /
          type / confidence / notes as a badge + editable rows; a source with no
          reliability data offers an "Add reliability" affordance. The badge flows down
          to every card/extract refblock derived from this source. */}
      {provenance && (
        <ReliabilitySection
          sourceId={provenance.elementId}
          provenance={provenance}
          onChanged={onOrganizeChanged}
        />
      )}

      {/* Source lineage — source/title/quote/citation/location + one jump action. */}
      {showSourceLineage && (
        <SourceLineageSection
          source={source}
          sourceRef={sourceRef}
          location={location}
          onOpenLineageItem={onOpenLineageItem}
          onJumpToLocation={onJumpToLocation}
        />
      )}

      {/* Export utilities — lower priority than properties, scheduler, and lineage. */}
      {EXPORTABLE_TYPES.has(element.type) && <ExportMarkdownSection elementId={element.id} />}
      {element.type === "card" && <ExportAnkiSection cardId={element.id} concepts={concepts} />}

      {/* Parent (lineage up). */}
      {!redactCardSourceContext && parent && (
        <div className="insp-sec" data-testid="parent-section">
          <div className="insp-sec__title">Parent</div>
          <div className="tree">
            <LineageRow item={parent} onOpen={onOpenLineageItem} />
          </div>
        </div>
      )}

      {/* Children (lineage down). */}
      <div className="insp-sec" data-testid="children-section">
        <div className="insp-sec__title">
          <span>Children</span>
          <span className="insp-sec__count">{children.length}</span>
        </div>
        {children.length > 0 ? (
          <div className="tree">
            {children.map((child) => (
              <LineageRow key={child.id} item={child} onOpen={onOpenLineageItem} />
            ))}
          </div>
        ) : (
          <p className="insp-empty">No children yet.</p>
        )}
      </div>

      {/* Lineage (T023): the full navigable tree — source → extract → sub-extract
          → card — rooted at the lineage root, with the active element highlighted.
          Clicking any node navigates there (up OR down the chain). */}
      {!redactCardSourceContext && currentLineage && currentLineage.nodes.length > 0 && (
        <div className="insp-sec" data-testid="lineage-section">
          <div className="insp-sec__title">
            <span>Lineage</span>
            <span className="insp-sec__tools">
              {hasDeletedLineage ? (
                <button
                  type="button"
                  className="insp-lineage-toggle"
                  data-testid="lineage-deleted-toggle"
                  aria-expanded={showDeletedLineage}
                  onClick={() =>
                    setLineageDeletedVisibility({
                      elementId: element.id,
                      showDeleted: !showDeletedLineage,
                    })
                  }
                >
                  <Icon name={showDeletedLineage ? "eye" : "trash"} size={11} />
                  {showDeletedLineage ? "Hide deleted" : `Show deleted (${deletedLineageCount})`}
                </button>
              ) : null}
              <span className="insp-sec__count">{lineageNodes.length}</span>
            </span>
          </div>
          {/* R3 — when an ANCESTOR (a node ABOVE the focused element) in its chain is a
              tombstone, show a single-line hint with an inline Restore that walks the
              tombstoned ANCESTOR chain (root-first) up to a live root via
              `restoreAncestorChain` — restoring ONLY that chain, never sibling/cousin or
              descendant tombstones. Ancestors precede the active node in the flattened,
              depth-ordered lineage, so we count deleted nodes BEFORE it (a deleted
              descendant or the focused node itself is NOT an "ancestor deleted" case). */}
          {showDeletedLineage && tombstonedAncestorCount > 0 ? (
            <p className="insp-empty insp-ancestor-deleted" data-testid="lineage-ancestor-deleted">
              <Icon name="trash" size={12} />
              <span>
                {tombstonedAncestorCount === 1
                  ? "An ancestor of this item is deleted."
                  : `${tombstonedAncestorCount} ancestors of this item are deleted.`}
              </span>
              <button
                type="button"
                className="insp-jump insp-jump--lineage-restore"
                data-testid="lineage-ancestor-restore"
                disabled={restoringId === element.id}
                onClick={() => onRestoreAncestors()}
              >
                <Icon name="restore" size={12} />
                {restoringId === element.id ? "Restoring…" : "Restore"}
              </button>
            </p>
          ) : null}
          <LineageTree
            nodes={lineageNodes}
            onPick={onPickLineageNode}
            onRestore={onRestoreTombstone}
            restoringId={restoringId}
            onNodeContextMenu={(node, position) => setLineageMenu({ node, position })}
          />
          {/* U6 — the in-app right-click menu for a lineage node. Inspector owns the
              target state; Open navigates away (onPickLineageNode) so close explicitly,
              while mutations refresh the surface via requestInspectorRefresh. */}
          <LineageContextMenu
            target={lineageMenu}
            onClose={() => setLineageMenu(null)}
            onOpen={(node) => {
              setLineageMenu(null);
              onPickLineageNode(node);
            }}
            onAfterMutation={requestInspectorRefresh}
          />
          {/* T096 — review the CARDS in this branch (lineage subtree) as a targeted
              session. For a source/topic/extract root this reviews its cards outside
              scheduling; omitted when the subtree has no live cards. */}
          {BRANCH_REVIEWABLE_TYPES.has(element.type) ? (
            <div className="insp-branch-review" data-testid="inspector-branch-review">
              <ReviewModeButton
                selector={{ kind: "branch", rootId: element.id }}
                hideWhileLoading
                icon="layers"
                label={(n) =>
                  element.type === "source"
                    ? `Review ${n} card${n === 1 ? "" : "s"} in this source`
                    : `Review ${n} card${n === 1 ? "" : "s"} in this branch`
                }
                testId="inspector-review-branch"
              />
            </div>
          ) : null}
        </div>
      )}

      {/* Related (T088): derived similar/duplicate/prereq/sibling suggestions over
          the vec0 store + concept lineage. Read-only — no relations written. */}
      <RelatedSection elementId={element.id} onSelect={onSelect} />

      {/* Possible conflicts (T089): derived, HEURISTIC, SUGGESTIVE flags — highly-
          similar neighbors that also carry an opposing/superseding signal. Never
          authoritative; writes nothing. In the inspector it is always safe to show
          (no hidden-answer face to leak). Hides when nothing conflicts. */}
      {(element.type === "card" || element.type === "extract") && (
        <ConflictSection elementId={element.id} onOpen={onSelect} />
      )}

      {/* Review metadata (cards only). */}
      {review && (
        <div className="insp-sec" data-testid="review-section">
          <div className="insp-sec__title">Review</div>
          <div className="meta-list">
            <MetaRow k="Due">{fmtDate(review.dueAt)}</MetaRow>
            <MetaRow k="State">{review.fsrsState}</MetaRow>
            <MetaRow k="Reps">{review.reps}</MetaRow>
            <MetaRow k="Lapses">{review.lapses}</MetaRow>
            <MetaRow k="Reviews">{review.logCount}</MetaRow>
            <MetaRow k="Last review">{fmtDate(review.lastReviewedAt)}</MetaRow>
            {element.type === "card" ? <ResolvedRetentionRow cardId={element.id} /> : null}
            {element.type === "card" ? (
              <RetirementRow
                cardId={element.id}
                isRetired={review.isRetired}
                onChanged={onOrganizeChanged}
              />
            ) : null}
          </div>
        </div>
      )}

      {/* Expiry / claim-lifetime (T090) — cards only. The derived expiry status badge +
          the six lifetime fields with inline edit controls (cards.setLifetime). A card
          with no lifetime shows an "Add expiry" affordance; "expired" is a derived
          attribute (never a status). */}
      {element.type === "card" && lifetime ? (
        <ExpirySection cardId={element.id} lifetime={lifetime} onChanged={onOrganizeChanged} />
      ) : null}

      {/* Maintenance / verification tasks (T092) — on protectable elements (card /
          extract / source): list the open tasks watching this element + a "Create
          verification task" control. Tasks are attention-scheduled `task` elements; a
          task generated from this card's expiry (or created on the review banner) also
          surfaces here. */}
      {(element.type === "card" || element.type === "extract" || element.type === "source") && (
        <MaintenanceSection
          elementId={element.id}
          elementTitle={element.title}
          onChanged={onOrganizeChanged}
          refreshTick={refreshTick}
        />
      )}

      {/* Concepts + tags (T041) — assign/unassign + add/remove, through the bridge. */}
      <OrganizeSection
        elementId={element.id}
        concepts={concepts}
        tags={tags}
        allConcepts={allConcepts}
        onChanged={onOrganizeChanged}
      />
    </div>
  );
}

/**
 * The inspector panel. Owns the fetch (through `window.appApi`) for the selected
 * element and the picker list; renders the metadata view, the picker, or a
 * graceful "desktop only" / empty / loading state.
 */
export function Inspector() {
  const { selectedId, select } = useSelection();
  const navigate = useNavigate();
  const navigateToLocation = useNavigateToLocation();
  const desktop = isDesktop();
  const [data, setData] = useState<InspectorData | null>(null);
  const [lineage, setLineage] = useState<LineageData | null>(null);
  const [elements, setElements] = useState<readonly ElementSummary[]>([]);
  const [allConcepts, setAllConcepts] = useState<readonly ConceptNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  // The tombstone whose restore is in flight (T135 / U2) — its inline Restore control
  // shows a busy state; cleared on settle.
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  // Bumped by the `INSPECTOR_REFRESH_EVENT` so the panel re-fetches the selected
  // element + the picker list after a mutation elsewhere (e.g. T021 extraction adds
  // a child extract) — surfacing the new lineage WITHOUT a navigation/reload.
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onRefresh = () => setRefreshTick((t) => t + 1);
    window.addEventListener(INSPECTOR_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(INSPECTOR_REFRESH_EVENT, onRefresh);
  }, []);

  // Load the picker list once (and whenever desktop availability / refresh changes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick is a deliberate re-fetch trigger
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    appApi
      .listInspectableElements()
      .then((res) => {
        if (!cancelled) setElements(res.elements);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    // The concept list feeds the inspector's "Assign concept" picker (T041).
    appApi
      .listConcepts()
      .then((res) => {
        if (!cancelled) setAllConcepts(res.concepts);
      })
      .catch(() => {
        if (!cancelled) setAllConcepts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // Fetch the selected element's full payload + its lineage tree through the
  // bridge. Both are read-only `window.appApi` reads; the lineage tree (T023) is
  // computed main-side and crosses IPC as flat nodes (the renderer only renders +
  // navigates). A lineage failure degrades silently — the rest of the panel stays.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick is a deliberate re-fetch trigger
  useEffect(() => {
    if (!isDesktop() || !selectedId) {
      setData(null);
      setLineage(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLineage(null);
    appApi
      .getInspectorData({ id: selectedId })
      .then((res) => {
        if (!cancelled) {
          setData(res.data);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Request the lineage WITH tombstones (T135 / U2) so a focused element sitting
    // under a soft-deleted ancestor still shows its full chain — the deleted ancestor
    // renders as a muted tombstone with a Restore affordance instead of pruning the
    // focused node from its own lineage.
    appApi
      .getLineage({ id: selectedId, includeTombstones: true })
      .then((res) => {
        if (!cancelled && selectedIdRef.current === selectedId) setLineage(res.lineage);
      })
      .catch(() => {
        if (!cancelled) setLineage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshTick]);

  const onSelect = useCallback((id: string) => select(id), [select]);

  const onOpenLineageItem = useCallback(
    (item: LineageItem) => {
      if (item.type === "card") {
        select(null);
        void navigate({ to: "/card/$id", params: { id: item.id } });
      } else {
        select(item.id);
      }
    },
    [select, navigate],
  );

  // After a concept/tag assign/unassign/add/remove (T041), re-read the inspected
  // element so its concepts + tags reflect the change, and bump the picker/concept
  // list so a freshly-created concept appears in the picker.
  const onOrganizeChanged = useCallback(() => {
    if (!isDesktop() || !selectedId) return;
    appApi
      .getInspectorData({ id: selectedId })
      .then((res) => setData(res.data))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    setRefreshTick((t) => t + 1);
  }, [selectedId]);

  // The universal priority write path (T027): set/raise/lower goes through the
  // typed `elements.setPriority` command (logs `update_element` main-side). On
  // success we re-read the inspected element so the `Prio` badge + Priority row
  // reflect the change without a reload, and ask the picker list to refresh too.
  const onSetPriority = useCallback(
    async (action: ElementsSetPriorityAction) => {
      if (!isDesktop() || !selectedId || priorityBusy) return;
      setPriorityBusy(true);
      try {
        await appApi.setElementPriority({ id: selectedId, action });
        const res = await appApi.getInspectorData({ id: selectedId });
        setData(res.data);
        setError(null);
        requestInspectorRefresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPriorityBusy(false);
      }
    },
    [selectedId, priorityBusy],
  );

  const onScheduleAttention = useCallback(
    async (elementId: string, choice: QueueScheduleChoice) => {
      if (!isDesktop() || scheduleBusy) return;
      setScheduleBusy(true);
      try {
        await appApi.scheduleQueueItem({ id: elementId, choice });
        requestQueueRefresh();
        const res = await appApi.getInspectorData({ id: elementId });
        if (selectedIdRef.current !== elementId) return;
        const refreshed = res.data;
        if (!refreshed) {
          setData(null);
          setError("Element unavailable.");
          return;
        }
        setData(refreshed);
        setElements((items) =>
          items.map((item) => (item.id === elementId ? refreshed.element : item)),
        );
        setError(null);
      } catch (e) {
        if (selectedIdRef.current === elementId) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setScheduleBusy(false);
      }
    },
    [scheduleBusy],
  );

  const onFallowTopic = useCallback(
    async (request: TopicFallowRequest): Promise<TopicFallowResult> => {
      if (!isDesktop() || scheduleBusy) return { applied: 0, skipped: [], batchId: null };
      setScheduleBusy(true);
      try {
        const result = await appApi.fallowTopic(request);
        const res = await appApi.getInspectorData({ id: request.topicId });
        if (selectedIdRef.current === request.topicId) setData(res.data);
        requestQueueRefresh();
        requestInspectorRefresh();
        setError(null);
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        throw e;
      } finally {
        setScheduleBusy(false);
      }
    },
    [scheduleBusy],
  );

  const onUnfallowTopic = useCallback(
    async (request: TopicUnfallowRequest): Promise<TopicFallowResult> => {
      if (!isDesktop() || scheduleBusy) return { applied: 0, skipped: [], batchId: null };
      setScheduleBusy(true);
      try {
        const result = await appApi.unfallowTopic(request);
        const res = await appApi.getInspectorData({ id: request.topicId });
        if (selectedIdRef.current === request.topicId) setData(res.data);
        requestQueueRefresh();
        requestInspectorRefresh();
        setError(null);
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        throw e;
      } finally {
        setScheduleBusy(false);
      }
    },
    [scheduleBusy],
  );

  // Clicking a lineage node navigates BOTH directions (T023): re-select the node
  // (driving the inspector) and open its dedicated page — a source/topic opens its
  // reader at `/source/$id`, an extract opens its review view at `/extract/$id`
  // (T024), and a card opens the stable detail route for that card.
  const onPickLineageNode = useCallback(
    (node: LineageNode) => {
      if (node.type === "source" || node.type === "topic") {
        select(node.id);
        void navigate({ to: "/source/$id", params: { id: node.id } });
      } else if (node.type === "extract") {
        select(node.id);
        void navigate({ to: "/extract/$id", params: { id: node.id } });
      } else if (node.type === "card") {
        select(null);
        void navigate({ to: "/card/$id", params: { id: node.id } });
      }
    },
    [select, navigate],
  );

  // Restore the DELETED-ancestor chain of one node up to the first live ancestor (T135 /
  // U2 — R1/R3/R11). This is the CORRECT primitive: it restores ONLY the chain above (and
  // including, when a tombstone) `id`, never unrelated sibling/cousin tombstones — so a
  // focused live card reconnects to a live root without resurrecting other deletions. The
  // schedule is re-established from each node's preimage main-side; we then refresh.
  const restoreAncestorChainFor = useCallback(
    async (id: string) => {
      if (!isDesktop() || restoringId) return;
      setRestoringId(id);
      try {
        await appApi.restoreAncestorChain({ id });
        setError(null);
        requestInspectorRefresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRestoringId(null);
      }
    },
    [restoringId],
  );

  // Restore one tombstone node (its inline Restore control) — restores that node's
  // ancestor chain so it is never left under a still-tombstoned parent.
  const onRestoreTombstone = useCallback(
    (node: LineageNode) => void restoreAncestorChainFor(node.id),
    [restoreAncestorChainFor],
  );

  // R3 — restore the tombstoned ANCESTOR chain of the FOCUSED element up to a live root,
  // so a live element under a deleted ancestor reconnects in one click (no sibling
  // tombstones resurrected).
  const onRestoreAncestors = useCallback(
    () => void restoreAncestorChainFor(selectedId ?? ""),
    [restoreAncestorChainFor, selectedId],
  );

  const headerTitle = data ? typeLabel(data.element.type) : "Inspector";

  return (
    <aside className="shell-inspector" data-testid="inspector" aria-label="Inspector">
      <div className="shell-inspector__head">
        <span className="shell-inspector__title" data-testid="inspector-header">
          {headerTitle}
        </span>
        {selectedId && (
          <button
            type="button"
            className="shell-cheat__close"
            data-testid="inspector-clear"
            aria-label="Clear selection"
            onClick={() => select(null)}
          >
            <Icon name="x" size={15} />
          </button>
        )}
      </div>
      <div className="shell-inspector__body">
        {!desktop ? (
          <div className="shell-inspector__placeholder" data-testid="inspector-desktop-only">
            <Icon name="info" size={22} />
            <p>
              The inspector reads element data through the desktop bridge — open the Electron app to
              see it.
            </p>
          </div>
        ) : error ? (
          <p className="text-danger text-sm" data-testid="inspector-error">
            {error}
          </p>
        ) : selectedId && loading && !data ? (
          <p className="insp-empty">Loading…</p>
        ) : selectedId && data ? (
          <InspectorBody
            key={data.element.id}
            data={data}
            lineage={lineage}
            allConcepts={allConcepts}
            onSelect={onSelect}
            onOpenLineageItem={onOpenLineageItem}
            onPickLineageNode={onPickLineageNode}
            onRestoreTombstone={onRestoreTombstone}
            onRestoreAncestors={onRestoreAncestors}
            restoringId={restoringId}
            onJumpToLocation={navigateToLocation}
            onSetPriority={onSetPriority}
            onFallowTopic={onFallowTopic}
            onUnfallowTopic={onUnfallowTopic}
            onScheduleAttention={onScheduleAttention}
            onOrganizeChanged={onOrganizeChanged}
            priorityBusy={priorityBusy}
            scheduleBusy={scheduleBusy}
            refreshTick={refreshTick}
          />
        ) : selectedId && !data ? (
          <p className="insp-empty" data-testid="inspector-missing">
            That element is no longer available.
          </p>
        ) : (
          <>
            <div className="shell-inspector__placeholder" style={{ height: "auto" }}>
              <Icon name="info" size={22} />
              <p>Select an element to see its details, lineage, and scheduler signals.</p>
            </div>
            <div className="insp-sec">
              <div className="insp-sec__title">Elements</div>
              <ElementPicker elements={elements} onSelect={onSelect} />
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
