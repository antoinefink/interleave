/**
 * Library screen (`/library`) — the browse-everything surface.
 *
 * DISTINCT from `/search` (LibraryScreen, keyword-driven FTS5 that returns `[]`
 * for an empty query): Library DEFAULTS to listing ALL live elements and narrows
 * by FACETS — type / concept / priority / status — with no keyword required. It
 * covers `topic`/`synthesis_note`/`task` too, which keyword search can never
 * return. Rebuilt from the design kit (`design/kit/app/screen-library.jsx`) for
 * the React 19 renderer, reusing the SAME `library.css` markup (filterbar /
 * result rows / lib-map) and the inspector primitives.
 *
 * Architecture (non-negotiable): UI only. The browse read runs MAIN-side in
 * `LibraryQuery` behind the typed `window.appApi.library.browse` command (the
 * SQL, ordering, per-facet counts, and scheduler/due/concept/refblock enrichment
 * all live there). The concept list comes from `appApi.listConcepts()`. The
 * renderer holds no SQL, no ranking, no scheduling math — it toggles facet state
 * and re-runs the bridge read; an optional inline title filter narrows the
 * already-fetched payload client-side (never a second FTS call).
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConceptGraph } from "../components/ConceptGraph";
import { Icon } from "../components/Icon";
import { ConceptTag, Prio, TypeIcon, typeLabel } from "../components/inspector/primitives";
import { CollectionExplorerModeSwitch } from "./CollectionExplorerModeSwitch";
import "../components/inspector/inspector.css";
import {
  appApi,
  type ConceptNode,
  isDesktop,
  type LibraryBrowseRequest,
  type LibraryBrowseType,
  type LibraryItem,
} from "../lib/appApi";
import { formatShortDate } from "../lib/formatDate";
import { openQueueItem } from "../pages/queue/openQueueItem";
import { useLibraryInspectorPanel } from "../shell/libraryInspectorPanel";
import { useSelection } from "../shell/selection";
import {
  explorerSearchParams,
  PRIORITIES,
  type PriorityLetter,
  parseBrowseType,
  parsePriority,
  parseStringParam,
} from "./collectionExplorerState";
import "./library.css";

type Tab = "results" | "map";

/** The six browsable types, in display order, with their group/section titles. */
const TYPE_GROUPS: readonly { type: LibraryBrowseType; title: string }[] = [
  { type: "source", title: "Sources" },
  { type: "extract", title: "Extracts" },
  { type: "card", title: "Cards" },
  { type: "topic", title: "Topics" },
  { type: "synthesis_note", title: "Synthesis notes" },
  { type: "task", title: "Tasks" },
];

/** The status facets, in display order (matching the kit's lifecycle order). */
const STATUSES: readonly { value: string; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "scheduled", label: "Scheduled" },
  { value: "inbox", label: "Inbox" },
  { value: "pending", label: "Pending" },
  { value: "done", label: "Done" },
  { value: "parked", label: "Parked" },
  { value: "suspended", label: "Suspended" },
];

function parseStatus(value: unknown): string | null {
  const parsed = parseStringParam(value);
  return parsed && STATUSES.some((status) => status.value === parsed) ? parsed : null;
}

export function BrowseScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const { select } = useSelection();
  const { setPanel: setLibraryPanel } = useLibraryInspectorPanel();
  const routeType = parseBrowseType(routeSearch.type);
  const routeConceptId = parseStringParam(routeSearch.conceptId);
  const routePriority = parsePriority(routeSearch.priority);
  const routeStatus = parseStatus(routeSearch.status);
  const routeTitleFilter = parseStringParam(routeSearch.q) ?? "";

  const [tab, setTab] = useState<Tab>("results");
  // Facet state — each drives a query param and re-runs the browse read.
  const [typeFilter, setTypeFilter] = useState<LibraryBrowseType | null>(() => routeType);
  const [conceptFilter, setConceptFilter] = useState<string | null>(() => routeConceptId);
  const [priorityFilter, setPriorityFilter] = useState<PriorityLetter | null>(() => routePriority);
  const [statusFilter, setStatusFilter] = useState<string | null>(() => routeStatus);
  // An OPTIONAL inline "filter by title" box — narrows the already-fetched payload
  // client-side (never an FTS call; Library browses, it does not keyword-search).
  const [titleFilter, setTitleFilter] = useState(() => routeTitleFilter);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchComposing, setSearchComposing] = useState(false);

  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [counts, setCounts] = useState<{
    all: number;
    byType: Readonly<Record<string, number>>;
    byConcept: Readonly<Record<string, number>>;
    byPriority: Readonly<Record<string, number>>;
    byStatus: Readonly<Record<string, number>>;
  }>({ all: 0, byType: {}, byConcept: {}, byPriority: {}, byStatus: {} });
  const [concepts, setConcepts] = useState<readonly ConceptNode[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parkedActionId, setParkedActionId] = useState<string | null>(null);

  const browseRequest = useMemo<LibraryBrowseRequest>(
    () => ({
      ...(typeFilter ? { types: [typeFilter] } : {}),
      ...(conceptFilter ? { conceptId: conceptFilter } : {}),
      ...(priorityFilter ? { priorityLabel: priorityFilter } : {}),
      ...(statusFilter ? { statuses: [statusFilter] } : {}),
    }),
    [typeFilter, conceptFilter, priorityFilter, statusFilter],
  );

  // Load the concept list once (filterbar + map).
  useEffect(() => {
    if (!isDesktop()) return;
    void appApi
      .listConcepts()
      .then((res) => setConcepts(res.concepts))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Run the facet-driven browse whenever a facet changes. With no facets set this
  // lists EVERYTHING (the browse-first default) — no keyword required.
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    setLoading(true);
    void appApi
      .libraryBrowse(browseRequest)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setCounts(res.counts);
        setError(null);
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
  }, [browseRequest]);

  // The optional inline title narrowing happens entirely client-side over the
  // already-fetched browse payload (case-insensitive substring on the title).
  const visible = useMemo(() => {
    const t = titleFilter.trim().toLowerCase();
    if (t.length === 0) return items;
    return items.filter((r) => r.title.toLowerCase().includes(t));
  }, [items, titleFilter]);

  const selected = useMemo(() => visible.find((r) => r.id === selId) ?? null, [visible, selId]);

  // Whether an inline title filter is actively narrowing the fetched payload. Both
  // the top count summary and the empty-state copy switch to a title-aware mode
  // when this is true, so the header, the sections, the list, and the empty
  // remediation copy all agree about WHY the visible set is what it is.
  const titleActive = titleFilter.trim().length > 0;

  const openSearchMode = useCallback(
    (query?: string) => {
      void navigate({
        to: "/search",
        search: explorerSearchParams("search", {
          query,
          type: typeFilter,
          conceptId: conceptFilter,
          priority: priorityFilter,
        }),
      });
    },
    [navigate, typeFilter, conceptFilter, priorityFilter],
  );

  useEffect(() => {
    setTypeFilter(routeType);
    setConceptFilter(routeConceptId);
    setPriorityFilter(routePriority);
    setStatusFilter(routeStatus);
    setTitleFilter(routeTitleFilter);
    setSearchDraft("");
    setSelId(null);
  }, [routeType, routeConceptId, routePriority, routeStatus, routeTitleFilter]);

  useEffect(() => {
    const query = searchDraft.trim();
    if (query.length === 0 || searchComposing) return;
    const timeout = window.setTimeout(() => openSearchMode(searchDraft), 150);
    return () => window.clearTimeout(timeout);
  }, [searchDraft, searchComposing, openSearchMode]);

  // Keep a valid selection as the list changes.
  useEffect(() => {
    if (selId && !visible.some((r) => r.id === selId)) setSelId(null);
  }, [visible, selId]);

  const open = useCallback(
    (r: LibraryItem) => {
      // Clear the relocated inspector controls BEFORE navigating away: the
      // destination may select the same element and the gate would still match,
      // flashing the controls on the wrong route during the navigate→unmount
      // frame (the leak guard from the relocation playbook). The unmount cleanup
      // below is the belt; this is the suspenders.
      setLibraryPanel(null);
      if (r.type === "synthesis_note") {
        select(r.id);
        void navigate({ to: "/synthesis/$id", params: { id: r.id } });
      } else {
        openQueueItem({ item: r, navigate, select });
      }
    },
    [navigate, select, setLibraryPanel],
  );

  const runParkedAction = useCallback(
    async (item: LibraryItem, action: "moveToInbox" | "queueSoon" | "dismiss") => {
      setParkedActionId(`${item.id}:${action}`);
      setError(null);
      try {
        const result = await appApi.libraryParkedAction({ id: item.id, action: { kind: action } });
        const updatedItem = result.item;
        const res = await appApi.libraryBrowse(browseRequest);
        setItems(res.items);
        setCounts(res.counts);
        if (!updatedItem || (statusFilter && updatedItem.status !== statusFilter)) {
          setSelId(null);
          select(null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setParkedActionId(null);
      }
    },
    [browseRequest, statusFilter, select],
  );

  // Publish the selected element's relocated controls (Open + parked actions +
  // context lines) to the shared shell inspector. Gated to the matching element
  // there; cleared here when nothing is selected. The button paints once the
  // inspector's own async element fetch resolves to the same id.
  useEffect(() => {
    if (!selected) {
      setLibraryPanel(null);
      return;
    }
    const isParkedSource = selected.status === "parked" && selected.type === "source";
    setLibraryPanel({
      targetId: selected.id,
      openLabel: `Open ${typeLabel(selected.type).toLowerCase()}`,
      onOpen: () => open(selected),
      parkedAt: selected.parkedAt,
      notInQueueReason: selected.notInQueueReason,
      parked: isParkedSource
        ? {
            busy: parkedActionId !== null,
            onMoveToInbox: () => void runParkedAction(selected, "moveToInbox"),
            onQueueSoon: () => void runParkedAction(selected, "queueSoon"),
            onDismiss: () => void runParkedAction(selected, "dismiss"),
          }
        : null,
    });
  }, [selected, parkedActionId, open, runParkedAction, setLibraryPanel]);

  // Clear the published payload on unmount so the controls never show on other routes.
  useEffect(() => () => setLibraryPanel(null), [setLibraryPanel]);

  if (!desktop) {
    return (
      <div className="lib-shell" data-testid="route-library">
        <div className="lib-empty">
          <div className="lib-empty__icon">
            <Icon name="library" size={26} />
          </div>
          <h1 className="lib-empty__title">Library</h1>
          <p className="lib-empty__body">Open the Electron app to browse your whole collection.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="lib-shell" data-testid="route-library">
      <div className="lib-topbar">
        <CollectionExplorerModeSwitch
          mode="browse"
          onBrowse={() => undefined}
          onSearch={() => openSearchMode()}
        />
        {/* Browse-first: a calm count summary + a restrained Search handoff.
            The deeper title-only narrowing lives in the filter rail below. */}
        <div className="lib-searchbar">
          <Icon name="search" size={15} />
          <input
            type="search"
            data-testid="collection-query-input"
            value={searchDraft}
            onChange={(e) => {
              const next = e.target.value;
              setSearchDraft(next);
            }}
            onCompositionStart={() => setSearchComposing(true)}
            onCompositionEnd={(e) => {
              setSearchComposing(false);
              setSearchDraft(e.currentTarget.value);
            }}
            placeholder="Search sources, extracts, cards…"
          />
        </div>
        <span className="lib-count" data-testid="library-count">
          {titleActive ? (
            // While a title filter is active the rendered sections are narrowed
            // client-side to `visible`; show "{visible} of {all}" so the header
            // agrees with the section counts and the list (counts.all stays the
            // pre-title-narrow facet total, per the backend SPEC).
            <>
              {visible.length} of {counts.all} element{counts.all === 1 ? "" : "s"}
            </>
          ) : (
            <>
              {counts.all} element{counts.all === 1 ? "" : "s"}
            </>
          )}
        </span>
        <div className="lib-grow" />
        <div className="lib-seg" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "results"}
            className={`lib-seg__btn${tab === "results" ? " lib-seg__btn--on" : ""}`}
            data-testid="library-tab-results"
            onClick={() => setTab("results")}
          >
            <Icon name="layers" size={14} />
            Results
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "map"}
            className={`lib-seg__btn${tab === "map" ? " lib-seg__btn--on" : ""}`}
            data-testid="library-tab-map"
            onClick={() => setTab("map")}
          >
            <Icon name="concepts" size={14} />
            Map
          </button>
        </div>
      </div>

      <div className="lib-body">
        <div className="filterbar" data-testid="library-filterbar">
          <div className="filter-group">
            <div className="filter-group__title">Visible titles</div>
            <label className="lib-mini-input">
              <Icon name="filter" size={14} />
              <input
                type="search"
                data-testid="library-title-filter"
                value={titleFilter}
                onChange={(e) => setTitleFilter(e.target.value)}
                placeholder="Filter visible titles"
              />
            </label>
          </div>

          <div className="filter-group">
            <div className="filter-group__title">Type</div>
            {TYPE_GROUPS.map((g) => (
              <button
                key={g.type}
                type="button"
                className={`filter-opt${typeFilter === g.type ? " filter-opt--on" : ""}`}
                data-testid={`library-filter-type-${g.type}`}
                onClick={() => setTypeFilter((cur) => (cur === g.type ? null : g.type))}
              >
                <TypeIcon type={g.type} />
                <span>{g.title}</span>
                <span className="filter-opt__count">{counts.byType[g.type] ?? 0}</span>
              </button>
            ))}
          </div>

          {concepts.length > 0 ? (
            <div className="filter-group">
              <div className="filter-group__title">Concept</div>
              {concepts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`filter-opt${conceptFilter === c.id ? " filter-opt--on" : ""}`}
                  data-testid={`library-filter-concept-${c.id}`}
                  onClick={() => setConceptFilter((cur) => (cur === c.id ? null : c.id))}
                >
                  <ConceptTag name={c.name} />
                  {/* DRILL-DOWN count: members of this concept that also match the
                      OTHER active facets (NOT the global memberCount) — so the chip
                      number always matches the filtered result list. */}
                  <span className="filter-opt__count">{counts.byConcept?.[c.id] ?? 0}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="filter-group">
            <div className="filter-group__title">Priority</div>
            {PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                className={`filter-opt${priorityFilter === p ? " filter-opt--on" : ""}`}
                data-testid={`library-filter-prio-${p}`}
                onClick={() => setPriorityFilter((cur) => (cur === p ? null : p))}
              >
                <span className={`prio-dot prio-dot--${p.toLowerCase()}`} />
                <span>Priority {p}</span>
                <span className="filter-opt__count">{counts.byPriority[p] ?? 0}</span>
              </button>
            ))}
          </div>

          <div className="filter-group">
            <div className="filter-group__title">Status</div>
            {STATUSES.map((s) => (
              <button
                key={s.value}
                type="button"
                className={`filter-opt${statusFilter === s.value ? " filter-opt--on" : ""}`}
                data-testid={`library-filter-status-${s.value}`}
                onClick={() => setStatusFilter((cur) => (cur === s.value ? null : s.value))}
              >
                <span className="prio-dot" style={{ background: "var(--text-3)" }} />
                <span>{s.label}</span>
                <span className="filter-opt__count">{counts.byStatus[s.value] ?? 0}</span>
              </button>
            ))}
          </div>

          {/* Maintenance "smart" filters are M9/M17 analytics — shown but disabled,
              exactly as the search screen does. */}
          <div className="filter-group">
            <div className="filter-group__title">Maintenance</div>
            {[
              ["hourglass", "Stale facts"],
              ["leech", "Leeches"],
              ["pause", "Stagnant extracts"],
            ].map(([ic, label]) => (
              <span
                key={label}
                className="filter-opt filter-opt--disabled"
                title="Coming with analytics"
              >
                <Icon name={ic as never} size={14} />
                <span>{label}</span>
                <span className="filter-opt__count">—</span>
              </span>
            ))}
          </div>
        </div>

        {tab === "results" ? (
          <div className="lib-results" data-testid="library-results">
            <div className="lib-results__inner">
              {error ? (
                <p className="lib-error" data-testid="library-error">
                  {error}
                </p>
              ) : null}
              {loading && visible.length === 0 ? (
                <p className="lib-loading" data-testid="library-loading">
                  Loading…
                </p>
              ) : visible.length === 0 && titleActive && items.length > 0 ? (
                // The facets matched rows but the inline title filter excluded them
                // all — blame the title (mirroring /search's "No matches for …"),
                // NOT the facets the user may not even have set.
                <div className="lib-empty" data-testid="library-empty-title">
                  <div className="lib-empty__icon">
                    <Icon name="filter" size={26} />
                  </div>
                  <h2 className="lib-empty__title">No matches for “{titleFilter.trim()}”</h2>
                  <p className="lib-empty__body">
                    No titles match your filter. Clear the title filter to see all {counts.all}{" "}
                    matching element{counts.all === 1 ? "" : "s"}.
                  </p>
                </div>
              ) : visible.length === 0 ? (
                <div className="lib-empty" data-testid="library-empty">
                  <div className="lib-empty__icon">
                    <Icon name="library" size={26} />
                  </div>
                  <h2 className="lib-empty__title">Nothing here yet</h2>
                  <p className="lib-empty__body">
                    No elements match these facets. Clear the type/concept/priority/status filters
                    to see your whole collection.
                  </p>
                </div>
              ) : (
                TYPE_GROUPS.map((g) => {
                  const rows = visible.filter((r) => r.type === g.type);
                  if (rows.length === 0) return null;
                  return (
                    <div className="lib-sec" key={g.type} data-testid={`library-group-${g.type}`}>
                      <div className="lib-sec__head">
                        <span className="lib-sec__title">
                          {g.title} · {rows.length}
                        </span>
                      </div>
                      {rows.map((r) => (
                        <button
                          type="button"
                          key={r.id}
                          className={`result${selId === r.id ? " result--on" : ""}`}
                          data-testid="library-result"
                          data-result-id={r.id}
                          data-result-type={r.type}
                          onClick={() => {
                            setSelId(r.id);
                            select(r.id);
                          }}
                          onDoubleClick={() => open(r)}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div className="result__title">{r.title}</div>
                            <div className="result__meta">
                              {r.concept ? <ConceptTag name={r.concept} /> : null}
                              {r.sourceTitle ? <span>{r.sourceTitle}</span> : null}
                              {r.sourceLocationLabel ? <span>{r.sourceLocationLabel}</span> : null}
                              <span>
                                {r.status === "parked" && r.parkedAt
                                  ? `Parked ${formatShortDate(r.parkedAt)}`
                                  : r.dueLabel}
                              </span>
                            </div>
                          </div>
                          <Prio priority={r.priority} />
                        </button>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div className="lib-map" data-testid="library-map">
            <div className="lib-map__canvas">
              <div className="lib-map__head">
                <h2 className="lib-map__title">Concept map</h2>
                <span className="lib-map__hint">
                  {concepts.length} concept{concepts.length === 1 ? "" : "s"} · click a node to
                  filter
                </span>
              </div>
              <div className="lib-map__panel">
                {concepts.length > 0 ? (
                  <ConceptGraph
                    concepts={concepts}
                    onPick={(id) => {
                      setConceptFilter(id);
                      setTab("results");
                    }}
                  />
                ) : (
                  <div className="lib-empty">
                    <p className="lib-empty__body">No concepts yet.</p>
                  </div>
                )}
              </div>
            </div>
            <div className="lib-map__side">
              <div className="filter-group__title">Concepts by volume</div>
              {concepts.map((c) => (
                <div key={c.id} className="lib-map__concept">
                  <div className="lib-map__concept-head">
                    <ConceptTag
                      name={c.name}
                      onClick={() => {
                        setConceptFilter(c.id);
                        setTab("results");
                      }}
                    />
                  </div>
                  <div className="lib-map__concept-counts">
                    <span>
                      <b>{c.memberCount}</b> members
                    </span>
                    <span>
                      <b>{c.childCount}</b> children
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
