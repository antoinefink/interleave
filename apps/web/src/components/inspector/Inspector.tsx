/**
 * Universal element inspector (T010) — the shell's right panel.
 *
 * One consistent view of ANY selected element's metadata, lineage, and scheduler
 * signals, rebuilt from the kit's inspector (design/kit + design-system.md) with
 * the shared primitives. It is read-only for M1 (editing priority/stage lands
 * with T027 and the relevant features).
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

import { useCallback, useEffect, useState } from "react";
import {
  appApi,
  type ElementSummary,
  type InspectorData,
  isDesktop,
  type LineageItem,
} from "../../lib/appApi";
import { useSelection } from "../../shell/selection";
import { Icon } from "../Icon";
import "./inspector.css";
import {
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

/** The full metadata view for one inspected element. */
function InspectorBody({
  data,
  onSelect,
}: {
  data: InspectorData;
  onSelect: (id: string) => void;
}) {
  const { element, scheduler, parent, children, source, provenance, location, tags, review } = data;
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

      {/* Source location — actionable lineage (jump-to-paragraph). */}
      {location && (
        <div className="insp-sec">
          <div className="insp-sec__title">Source location</div>
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

      {/* Tags. */}
      <div className="insp-sec" data-testid="tags-section">
        <div className="insp-sec__title">Tags</div>
        {tags.length > 0 ? (
          <div className="insp-chips">
            {tags.map((tag) => (
              <Tag key={tag} name={tag} />
            ))}
          </div>
        ) : (
          <p className="insp-empty">No tags.</p>
        )}
      </div>
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
  const desktop = isDesktop();
  const [data, setData] = useState<InspectorData | null>(null);
  const [elements, setElements] = useState<readonly ElementSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the picker list once (and whenever desktop availability changes).
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
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the selected element's full payload through the bridge.
  useEffect(() => {
    if (!isDesktop() || !selectedId) {
      setData(null);
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
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const onSelect = useCallback((id: string) => select(id), [select]);

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
          <InspectorBody data={data} onSelect={onSelect} />
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
