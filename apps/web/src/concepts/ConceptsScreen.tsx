/**
 * Concepts knowledge-map screen (`/concepts`).
 *
 * A dedicated browse surface rendering the concept knowledge-map (the shared
 * `ConceptGraph` radial `graph`/`gnode` SVG) plus a left concept-hierarchy
 * filterbar and a "Concepts by volume" side rail — and the load-bearing new
 * capability: selecting a node / pill / row DRILLS INTO that concept's members
 * (the real list of elements assigned to it), each openable in its reader.
 *
 * Architecture (non-negotiable): UI only. The concept list comes from the typed
 * `appApi.listConcepts()`; the selected concept's members come from the NEW typed
 * `appApi.conceptMembers({ conceptId })` (backed main-side by
 * `ConceptRepository.elementsForConcept`, enriched like a search/library row). The
 * renderer holds no SQL, no scheduling math, no membership logic — it only awaits
 * the IPC-backed reads and navigates. Outside the desktop shell it degrades to a
 * calm EmptyState.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConceptGraph } from "../components/ConceptGraph";
import { Icon } from "../components/Icon";
import {
  ConceptTag,
  Prio,
  SchedulerChip,
  TypeIcon,
  typeLabel,
} from "../components/inspector/primitives";
import "../components/inspector/inspector.css";
import { appApi, type ConceptMemberSummary, type ConceptNode, isDesktop } from "../lib/appApi";
import "../library/library.css";
import "./concepts.css";

/**
 * The member-row groups, in display order. Sources/Extracts/Cards lead (the
 * pipeline order); every other live type collapses into a trailing "Other" group
 * so a topic/synthesis_note/task member still appears.
 */
const PRIMARY_GROUPS: readonly { type: string; title: string }[] = [
  { type: "source", title: "Sources" },
  { type: "extract", title: "Extracts" },
  { type: "card", title: "Cards" },
];
const PRIMARY_TYPES = new Set(PRIMARY_GROUPS.map((g) => g.type));

/** A due-state badge (overdue / today / soon) — matches the queue/library `DueBadge`. */
function DueBadge({ member }: { member: ConceptMemberSummary }) {
  const cls =
    member.due === "overdue"
      ? "badge--overdue"
      : member.due === "today"
        ? "badge--due"
        : "badge--soft";
  return <span className={`badge ${cls}`}>{member.dueLabel}</span>;
}

/** Indentation depth of a concept from its root, walking `parentConceptId`. */
function depthOf(concept: ConceptNode, byId: Map<string, ConceptNode>): number {
  let depth = 0;
  let cursor: ConceptNode | undefined = concept;
  const seen = new Set<string>();
  while (cursor?.parentConceptId) {
    if (seen.has(cursor.id)) break; // guard against a malformed cycle
    seen.add(cursor.id);
    cursor = byId.get(cursor.parentConceptId);
    if (!cursor) break;
    depth += 1;
  }
  return depth;
}

/** Inclusive UI bounds for desired retention (mirrors `@interleave/core`). */
const DESIRED_RETENTION_MIN = 0.8;
const DESIRED_RETENTION_MAX = 0.97;

/**
 * Per-concept FSRS desired-retention target editor (T079). A concept with no stored
 * target INHERITS the band/global default — the control shows "Inherit" until the user
 * sets one. Cards in this concept then schedule against the target (the strictest among
 * a card's concepts wins). Persists through `retention.setConcept` (which also bumps the
 * per-card scheduler cache); `onChanged` re-reads the concept list so the value sticks.
 */
function ConceptRetentionEditor({
  conceptId,
  target,
  onChanged,
}: {
  conceptId: string;
  target: number | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const set = useCallback(
    async (next: number | null) => {
      setBusy(true);
      try {
        await appApi.setRetentionConcept({ conceptId, target: next });
        onChanged();
      } finally {
        setBusy(false);
      }
    },
    [conceptId, onChanged],
  );
  const pct = target === null ? null : Math.round(target * 100);
  return (
    <div className="cm-retention" data-testid="concept-retention">
      <span className="cm-retention__label">Retention</span>
      <input
        type="range"
        min={Math.round(DESIRED_RETENTION_MIN * 100)}
        max={Math.round(DESIRED_RETENTION_MAX * 100)}
        step={1}
        value={pct ?? Math.round(DESIRED_RETENTION_MAX * 100)}
        disabled={busy}
        data-testid="concept-retention-slider"
        onChange={(e) => void set(Number(e.target.value) / 100)}
        className="cm-retention__range"
      />
      <span className="cm-retention__value" data-testid="concept-retention-value">
        {pct === null ? "Inherit" : `${pct}%`}
      </span>
      <button
        type="button"
        data-testid="concept-retention-reset"
        disabled={busy || target === null}
        onClick={() => void set(null)}
        className="cm-retention__reset"
      >
        Reset
      </button>
    </div>
  );
}

export function ConceptsScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();

  const [concepts, setConcepts] = useState<readonly ConceptNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<readonly ConceptMemberSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [membersLoading, setMembersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the concept list (hierarchy filterbar + graph + by-volume rail). Extracted
  // so the per-concept retention editor (T079) can refresh it after a target write.
  const loadConcepts = useCallback(async () => {
    if (!isDesktop()) return;
    setLoading(true);
    try {
      const res = await appApi.listConcepts();
      setConcepts(res.concepts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConcepts();
  }, [loadConcepts]);

  // Whenever a concept is selected, drill into its members through the bridge.
  useEffect(() => {
    if (!isDesktop() || selectedId === null) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    setMembersLoading(true);
    void appApi
      .conceptMembers({ conceptId: selectedId })
      .then((res) => {
        if (cancelled) return;
        setMembers(res.members);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const byId = useMemo(() => {
    const m = new Map<string, ConceptNode>();
    for (const c of concepts) m.set(c.id, c);
    return m;
  }, [concepts]);

  const selected = useMemo(
    () => (selectedId ? (byId.get(selectedId) ?? null) : null),
    [selectedId, byId],
  );

  /** Open a member element in the right surface for its type. */
  const open = useCallback(
    (m: ConceptMemberSummary) => {
      if (m.type === "source") void navigate({ to: "/source/$id", params: { id: m.id } });
      else if (m.type === "extract") void navigate({ to: "/extract/$id", params: { id: m.id } });
      else if (m.type === "card") void navigate({ to: "/review" });
    },
    [navigate],
  );

  if (!desktop) {
    return (
      <div className="lib-shell" data-testid="route-concepts">
        <div className="lib-empty">
          <div className="lib-empty__icon">
            <Icon name="concepts" size={26} />
          </div>
          <h1 className="lib-empty__title">Concept map</h1>
          <p className="lib-empty__body">Open the Electron app to explore your concept map.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="lib-shell" data-testid="route-concepts">
      <div className="lib-topbar">
        <div>
          <h1 className="cm-title">Concepts</h1>
          <span className="lib-count" data-testid="concepts-count">
            {concepts.length} concept{concepts.length === 1 ? "" : "s"} · click a node to explore
          </span>
        </div>
        <div className="lib-grow" />
      </div>

      <div className="lib-body">
        {/* LEFT — the concept hierarchy filterbar (indented by parent depth). */}
        <div className="filterbar" data-testid="concepts-filterbar">
          <div className="filter-group">
            <div className="filter-group__title">Concepts</div>
            {concepts.length === 0 ? (
              <span className="filter-opt filter-opt--disabled">
                <span>No concepts yet</span>
              </span>
            ) : (
              concepts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`filter-opt${selectedId === c.id ? " filter-opt--on" : ""}`}
                  style={{ paddingLeft: `${8 + depthOf(c, byId) * 14}px` }}
                  data-testid={`concepts-tree-${c.id}`}
                  aria-pressed={selectedId === c.id}
                  onClick={() => setSelectedId(c.id)}
                >
                  <ConceptTag name={c.name} />
                  <span className="filter-opt__count">{c.memberCount}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* CENTER — the read-only concept map canvas + the member drill-in panel. */}
        <div className="cm-main">
          <div className="lib-map__canvas">
            <div className="lib-map__head">
              <h2 className="lib-map__title">Concept map</h2>
              <span className="lib-map__hint">
                {selected ? `Exploring “${selected.name}”` : "Click a node to explore its members"}
              </span>
            </div>
            <div className="lib-map__panel">
              {error ? (
                <p className="lib-error" data-testid="concepts-error">
                  {error}
                </p>
              ) : loading && concepts.length === 0 ? (
                <p className="lib-loading" data-testid="concepts-loading">
                  Loading concepts…
                </p>
              ) : concepts.length > 0 ? (
                <ConceptGraph
                  concepts={concepts}
                  selectedId={selectedId}
                  pickVerb="Explore"
                  onPick={(id) => setSelectedId(id)}
                />
              ) : (
                <div className="lib-empty" data-testid="concepts-empty-map">
                  <div className="lib-empty__icon">
                    <Icon name="concepts" size={26} />
                  </div>
                  <h2 className="lib-empty__title">No concepts yet</h2>
                  <p className="lib-empty__body">
                    Assign concepts to your sources, extracts, and cards to grow the map.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Member drill-in panel — the genuinely-new data. */}
          {selected ? (
            <div className="cm-members" data-testid="concepts-members">
              <div className="cm-members__head">
                <ConceptTag name={selected.name} />
                <span className="cm-members__count">
                  {members.length} member{members.length === 1 ? "" : "s"}
                </span>
              </div>
              <ConceptRetentionEditor
                conceptId={selected.id}
                target={selected.desiredRetention}
                onChanged={() => void loadConcepts()}
              />
              <div className="cm-members__list">
                {membersLoading && members.length === 0 ? (
                  <p className="lib-loading" data-testid="concepts-members-loading">
                    Loading members…
                  </p>
                ) : members.length === 0 ? (
                  <div className="lib-empty" data-testid="concepts-members-empty">
                    <div className="lib-empty__icon">
                      <Icon name="layers" size={22} />
                    </div>
                    <h3 className="lib-empty__title">No live members</h3>
                    <p className="lib-empty__body">Nothing is assigned to “{selected.name}” yet.</p>
                  </div>
                ) : (
                  <MemberGroups members={members} onOpen={open} />
                )}
              </div>
            </div>
          ) : null}
        </div>

        {/* RIGHT — "Concepts by volume" rail. */}
        <div className="lib-map__side" data-testid="concepts-rail">
          <div className="filter-group__title">Concepts by volume</div>
          {[...concepts]
            .sort((a, b) => b.memberCount - a.memberCount)
            .map((c) => (
              <button
                key={c.id}
                type="button"
                className={`lib-map__concept cm-rail__card${
                  selectedId === c.id ? " cm-rail__card--on" : ""
                }`}
                data-testid={`concepts-rail-${c.id}`}
                aria-pressed={selectedId === c.id}
                onClick={() => setSelectedId(c.id)}
              >
                <div className="lib-map__concept-head">
                  <ConceptTag name={c.name} />
                </div>
                <div className="lib-map__concept-counts">
                  <span>
                    <b>{c.memberCount}</b> member{c.memberCount === 1 ? "" : "s"}
                  </span>
                  <span>
                    <b>{c.childCount}</b> child{c.childCount === 1 ? "" : "ren"}
                  </span>
                </div>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

/** The member rows, grouped by type (Sources / Extracts / Cards / Other). */
function MemberGroups({
  members,
  onOpen,
}: {
  members: readonly ConceptMemberSummary[];
  onOpen: (m: ConceptMemberSummary) => void;
}) {
  const otherMembers = members.filter((m) => !PRIMARY_TYPES.has(m.type));
  return (
    <>
      {PRIMARY_GROUPS.map((g) => {
        const rows = members.filter((m) => m.type === g.type);
        if (rows.length === 0) return null;
        return (
          <MemberSection
            key={g.type}
            title={g.title}
            rows={rows}
            onOpen={onOpen}
            testId={`concepts-members-group-${g.type}`}
          />
        );
      })}
      {otherMembers.length > 0 ? (
        <MemberSection
          title="Other"
          rows={otherMembers}
          onOpen={onOpen}
          testId="concepts-members-group-other"
        />
      ) : null}
    </>
  );
}

function MemberSection({
  title,
  rows,
  onOpen,
  testId,
}: {
  title: string;
  rows: readonly ConceptMemberSummary[];
  onOpen: (m: ConceptMemberSummary) => void;
  testId: string;
}) {
  return (
    <div className="lib-sec" data-testid={testId}>
      <div className="lib-sec__head">
        <span className="lib-sec__title">
          {title} · {rows.length}
        </span>
      </div>
      {rows.map((m) => (
        <button
          type="button"
          key={m.id}
          className="result"
          data-testid="concepts-member"
          data-member-id={m.id}
          data-member-type={m.type}
          onDoubleClick={() => onOpen(m)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onOpen(m);
            }
          }}
        >
          <div className="cm-member__main" style={{ minWidth: 0 }}>
            <TypeIcon type={m.type} />
            <div style={{ minWidth: 0 }}>
              <div className="result__title">{m.title}</div>
              <div className="result__meta">
                <span>{typeLabel(m.type)}</span>
                {m.sourceTitle ? <span>{m.sourceTitle}</span> : null}
                <SchedulerChip scheduler={m.scheduler} />
                {m.dueAt ? <DueBadge member={m} /> : null}
              </div>
            </div>
          </div>
          <Prio priority={m.priority} />
        </button>
      ))}
    </div>
  );
}
