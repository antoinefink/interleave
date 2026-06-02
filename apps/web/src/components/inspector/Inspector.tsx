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
  type SemanticRelatedItem,
  type SemanticRelatedResult,
} from "../../lib/appApi";
import { useNavigateToLocation } from "../../reader/navigateToLocation";
import { useSelection } from "../../shell/selection";
import { ConflictSection } from "../ConflictSection";
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
 * "Export to Markdown" action (T068) — serializes the element's stored document
 * body to a `.md` in the managed `exports/` vault (MAIN owns the path) and surfaces
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
      setDone(result.relativePath);
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
          Exported to exports/{done}
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
 * in the managed `exports/` vault, carrying the source reference OUT to Anki. The scope
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
        `${result.relativePath} · ${result.cardCount} card${result.cardCount === 1 ? "" : "s"}`,
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
      <div style={{ display: "flex", gap: 6 }}>
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
          Exported to exports/{done}
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
      <span data-testid="inspector-retired-state">
        {isRetired ? "Retired (kept for reference)" : "Active"}
      </span>{" "}
      <button
        type="button"
        className="insp-add__btn"
        data-testid="inspector-retire-toggle"
        disabled={busy}
        onClick={() => void toggle()}
      >
        <Icon name="archive" size={13} />
        {isRetired ? "Un-retire" : "Retire"}
      </button>
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
 * Graceful degrade: when `semanticAvailable` is false (semantics off / not embedded)
 * the vector buckets (similar/duplicates) hide and a calm "enable semantic search"
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

  // Nothing to show AND semantics are on with nothing nearby → skip the section
  // entirely (keep the inspector calm). When semantics are OFF we still show the
  // hint so the user knows similarity suggestions exist behind the setting.
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
          <div className="tag-list">
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
          Enable semantic search in Settings for similarity suggestions.
        </p>
      ) : null}
    </div>
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
            {review?.isRetired ? (
              <span className="badge badge--retired" data-testid="inspector-retired-badge">
                <Icon name="archive" size={11} />
                Retired
              </span>
            ) : null}
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
          {/* Full-width row: the A/B/C/D editor needs the whole body width to lay
              out ↑ A B C D ↓ on one calm line. In the 2-column MetaRow the ~147px
              value cell is too narrow and the last band ("D") clips at the fixed
              296px inspector edge — so the label sits on its own line and the
              control spans below it. The control's own flex-wrap is the safety net. */}
          <div className="meta-row meta-row--stack">
            <span className="meta-key">Set priority</span>
            <PriorityControl
              priority={element.priority}
              busy={priorityBusy}
              onSetPriority={onSetPriority}
            />
          </div>
          <MetaRow k="Due">
            <span data-testid="meta-due">{fmtDate(element.dueAt)}</span>
          </MetaRow>
        </div>
      </div>

      {/* Export to Markdown (T068) — document-bearing elements only. */}
      {EXPORTABLE_TYPES.has(element.type) && <ExportMarkdownSection elementId={element.id} />}

      {/* Export to Anki (T070) — cards only; scope = this card / a concept / all. */}
      {element.type === "card" && <ExportAnkiSection cardId={element.id} concepts={concepts} />}

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
            {/* Source-yield chip (T083): read % + extracts/cards produced. */}
            {scheduler.yield ? (
              <>
                <MetaRow k="Read">
                  <span data-testid="inspector-yield-read">
                    {Math.round(scheduler.yield.readPct * 100)}%
                  </span>
                </MetaRow>
                <MetaRow k="Yield">
                  <span data-testid="inspector-yield">
                    {scheduler.yield.extractsCreated} extract
                    {scheduler.yield.extractsCreated === 1 ? "" : "s"} ·{" "}
                    {scheduler.yield.cardsCreated} card
                    {scheduler.yield.cardsCreated === 1 ? "" : "s"}
                  </span>
                </MetaRow>
              </>
            ) : null}
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
