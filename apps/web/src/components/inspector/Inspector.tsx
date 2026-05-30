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

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  appApi,
  type ConceptNode,
  type ElementSummary,
  type ElementsSetPriorityAction,
  type InspectorData,
  isDesktop,
  type LineageData,
  type LineageItem,
  type LineageNode,
  type PriorityLabel as PriorityLabelType,
} from "../../lib/appApi";
import { useNavigateToLocation } from "../../reader/navigateToLocation";
import { useSelection } from "../../shell/selection";
import { Icon } from "../Icon";
import { RefBlock } from "../RefBlock";
import "./inspector.css";
import { LineageTree } from "./LineageTree";
import {
  ConceptTag,
  FsrsStats,
  MetaRow,
  Prio,
  priorityLabel,
  SchedulerChip,
  Stage,
  Status,
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

/** A clickable lineage row that re-selects the target element. */
function LineageRow({ item, onSelect }: { item: LineageItem; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      className="tree-node"
      data-testid="lineage-row"
      data-element-id={item.id}
      onClick={() => onSelect(item.id)}
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

/** The full metadata view for one inspected element. */
function InspectorBody({
  data,
  lineage,
  allConcepts,
  onSelect,
  onPickLineageNode,
  onJumpToLocation,
  onSetPriority,
  onOrganizeChanged,
  priorityBusy,
}: {
  data: InspectorData;
  lineage: LineageData | null;
  allConcepts: readonly ConceptNode[];
  onSelect: (id: string) => void;
  onPickLineageNode: (node: LineageNode) => void;
  onJumpToLocation: (location: NonNullable<InspectorData["location"]>) => void;
  onSetPriority: (action: ElementsSetPriorityAction) => void;
  onOrganizeChanged: () => void;
  priorityBusy: boolean;
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
  } = data;
  return (
    <div className="insp" data-testid="inspector-content" data-element-type={element.type}>
      {/* Header: type icon + title + the at-a-glance chips. */}
      <div className="insp-head">
        <TypeIcon type={element.type} lg />
        <div style={{ minWidth: 0 }}>
          <h2 className="insp-head__title" data-testid="inspector-title">
            {element.title}
          </h2>
          <div className="insp-head__row">
            <Prio priority={element.priority} />
            <Status status={element.status} />
            <SchedulerChip scheduler={scheduler} />
          </div>
        </div>
      </div>

      {/* Metadata */}
      <div className="insp-sec">
        <div className="insp-sec__title">Metadata</div>
        <div className="meta-list">
          <MetaRow k="Type">
            <span data-testid="meta-type">{typeLabel(element.type)}</span>
          </MetaRow>
          <MetaRow k="Status">
            <span data-testid="meta-status">{element.status}</span>
          </MetaRow>
          <MetaRow k="Stage">
            <Stage stage={element.stage} />
          </MetaRow>
          <MetaRow k="Priority">
            <span data-testid="meta-priority">
              {priorityLabel(element.priority)} · {element.priority.toFixed(3)}
            </span>
          </MetaRow>
          <MetaRow k="Set priority">
            <PriorityControl
              priority={element.priority}
              busy={priorityBusy}
              onSetPriority={onSetPriority}
            />
          </MetaRow>
          <MetaRow k="Due">
            <span data-testid="meta-due">{fmtDate(element.dueAt)}</span>
          </MetaRow>
        </div>
      </div>

      {/* Scheduler — the FSRS vs attention split, surfaced explicitly. */}
      <div className="insp-sec" data-testid="scheduler-section">
        <div className="insp-sec__title">
          <span>{scheduler.kind === "fsrs" ? "Recall (FSRS)" : "Attention"}</span>
          <SchedulerChip scheduler={scheduler} />
        </div>
        {scheduler.kind === "fsrs" && review ? (
          <FsrsStats scheduler={scheduler} />
        ) : (
          <div className="meta-list">
            <MetaRow k="Stage">
              <Stage stage={scheduler.stage} />
            </MetaRow>
            <MetaRow k="Postponed">{scheduler.postponed}×</MetaRow>
            <MetaRow k="Last seen">{fmtDate(scheduler.lastProcessedAt)}</MetaRow>
          </div>
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
                <span style={{ overflowWrap: "anywhere" }}>{provenance.url}</span>
              ) : (
                "—"
              )}
            </MetaRow>
            {provenance.canonicalUrl && (
              <MetaRow k="Canonical URL">
                <span data-testid="provenance-canonical-url" style={{ overflowWrap: "anywhere" }}>
                  {provenance.canonicalUrl}
                </span>
              </MetaRow>
            )}
            {provenance.originalUrl && provenance.originalUrl !== provenance.url && (
              <MetaRow k="Original URL">
                <span data-testid="provenance-original-url" style={{ overflowWrap: "anywhere" }}>
                  {provenance.originalUrl}
                </span>
              </MetaRow>
            )}
            <MetaRow k="Published">{fmtDate(provenance.publishedAt)}</MetaRow>
            <MetaRow k="Accessed">
              <span data-testid="provenance-accessed-at">{fmtDate(provenance.accessedAt)}</span>
            </MetaRow>
            {provenance.reasonAdded && <MetaRow k="Reason">{provenance.reasonAdded}</MetaRow>}
          </div>
        </div>
      )}

      {/* Owning source (lineage root) for non-source elements. */}
      {source && (
        <div className="insp-sec" data-testid="source-section">
          <div className="insp-sec__title">From source</div>
          <div className="tree">
            <LineageRow item={source} onSelect={onSelect} />
          </div>
        </div>
      )}

      {/* Source reference (T043) — the originating refblock for an extract/card, so
          opening the inspector on a card never feels orphaned. Sources show their
          provenance above; extracts/cards show the shared RefBlock resolved from
          lineage (title/URL/author/date/location + snippet), with the jump-to-source
          affordance. A missing/soft-deleted source degrades to a calm placeholder. */}
      {element.type !== "source" && sourceRef && (
        <div className="insp-sec" data-testid="source-ref-section">
          <div className="insp-sec__title">Source reference</div>
          <RefBlock
            ref={sourceRef}
            testId="inspector-refblock"
            {...(location && location.blockIds.length > 0
              ? { onOpenSource: () => onJumpToLocation(location) }
              : {})}
          />
        </div>
      )}

      {/* Source location — actionable lineage (jump-to-paragraph, T022). */}
      {location && (
        <div className="insp-sec" data-testid="location-section">
          <div className="insp-sec__title">
            <span>Source location</span>
            {location.blockIds.length > 0 && (
              <button
                type="button"
                className="insp-jump"
                data-testid="location-jump"
                title="Open the source and scroll to this paragraph"
                onClick={() => onJumpToLocation(location)}
              >
                <Icon name="external" size={13} /> Jump to source
              </button>
            )}
          </div>
          {location.label && <MetaRow k="Label">{location.label}</MetaRow>}
          <blockquote className="insp-quote" data-testid="location-quote">
            {location.selectedText}
          </blockquote>
        </div>
      )}

      {/* Parent (lineage up). */}
      {parent && (
        <div className="insp-sec" data-testid="parent-section">
          <div className="insp-sec__title">Parent</div>
          <div className="tree">
            <LineageRow item={parent} onSelect={onSelect} />
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
              <LineageRow key={child.id} item={child} onSelect={onSelect} />
            ))}
          </div>
        ) : (
          <p className="insp-empty">No children yet.</p>
        )}
      </div>

      {/* Lineage (T023): the full navigable tree — source → extract → sub-extract
          → card — rooted at the lineage root, with the active element highlighted.
          Clicking any node navigates there (up OR down the chain). */}
      {lineage && lineage.nodes.length > 0 && (
        <div className="insp-sec" data-testid="lineage-section">
          <div className="insp-sec__title">
            <span>Lineage</span>
            <span className="insp-sec__count">{lineage.nodes.length}</span>
          </div>
          <LineageTree nodes={lineage.nodes} onPick={onPickLineageNode} />
        </div>
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
          </div>
        </div>
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
    appApi
      .getLineage({ id: selectedId })
      .then((res) => {
        if (!cancelled) setLineage(res.lineage);
      })
      .catch(() => {
        if (!cancelled) setLineage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshTick]);

  const onSelect = useCallback((id: string) => select(id), [select]);

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

  // Clicking a lineage node navigates BOTH directions (T023): re-select the node
  // (driving the inspector) and open its dedicated page — a source/topic opens its
  // reader at `/source/$id`, an extract opens its review view at `/extract/$id`
  // (T024). Cards select in the inspector (their dedicated view lands in M6).
  const onPickLineageNode = useCallback(
    (node: LineageNode) => {
      select(node.id);
      if (node.type === "source" || node.type === "topic") {
        void navigate({ to: "/source/$id", params: { id: node.id } });
      } else if (node.type === "extract") {
        void navigate({ to: "/extract/$id", params: { id: node.id } });
      }
    },
    [select, navigate],
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
            data={data}
            lineage={lineage}
            allConcepts={allConcepts}
            onSelect={onSelect}
            onPickLineageNode={onPickLineageNode}
            onJumpToLocation={navigateToLocation}
            onSetPriority={onSetPriority}
            onOrganizeChanged={onOrganizeChanged}
            priorityBusy={priorityBusy}
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
