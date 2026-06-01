/**
 * Library & Search screen (T042) — local full-text search + a read-only concept map.
 *
 * Rebuilt from the design kit (`design/kit/app/screen-library.jsx`) for the React
 * 19 renderer: a search input, Results/Map segmented tabs, the left `filterbar`
 * (type / concept / priority + stubbed maintenance rows), grouped + query-
 * highlighted `result` rows, a selection detail panel with the source `refblock`
 * and open-in-context, and the read-only `ConceptGraph` map tab.
 *
 * Architecture (non-negotiable): UI only. All search runs in SQLite FTS5 behind
 * the typed `window.appApi.search.query` command (sanitization, `bm25` ranking,
 * concept/tag filtering all live main-side in `SearchRepository`); the concept
 * list comes from `appApi.listConcepts()`. The renderer holds no SQL, no ranking,
 * and no index logic. Typing debounces the query; an empty query clears results.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConceptGraph } from "../components/ConceptGraph";
import { Icon } from "../components/Icon";
import {
  ConceptTag,
  Prio,
  SchedulerChip,
  TypeIcon,
  typeLabel,
} from "../components/inspector/primitives";
import { RefBlock } from "../components/RefBlock";
import "../components/inspector/inspector.css";
import {
  appApi,
  type ConceptNode,
  isDesktop,
  type SearchableType,
  type SearchResult,
} from "../lib/appApi";
import "./library.css";

type Tab = "results" | "map";

/** The three searchable types, in display order, with their group titles. */
const TYPE_GROUPS: readonly { type: SearchableType; title: string }[] = [
  { type: "source", title: "Sources" },
  { type: "extract", title: "Extracts" },
  { type: "card", title: "Cards" },
];

const PRIORITIES = ["A", "B", "C", "D"] as const;
type PriorityLetter = (typeof PRIORITIES)[number];

/** A due-state badge (overdue / today / soon) — matches the queue's `DueBadge`. */
function DueBadge({ result }: { result: SearchResult }) {
  const cls =
    result.due === "overdue"
      ? "badge--overdue"
      : result.due === "today"
        ? "badge--due"
        : "badge--soft";
  return (
    <span className={`badge ${cls}`} data-testid="library-detail-due">
      {result.dueLabel}
    </span>
  );
}

/** Render `text` with the first case-insensitive occurrence of `q` wrapped in <em>. */
function highlight(text: string, q: string): React.ReactNode {
  const term = q.trim();
  if (term.length === 0) return text;
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <em>{text.slice(i, i + term.length)}</em>
      {text.slice(i + term.length)}
    </>
  );
}

export function LibraryScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>("results");
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<SearchableType | null>(null);
  const [conceptFilter, setConceptFilter] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<PriorityLetter | null>(null);

  const [results, setResults] = useState<readonly SearchResult[]>([]);
  // DRILL-DOWN per-concept counts (keyed by concept id), scoped to the active
  // keyword + type — so the concept chip number matches the narrowed result list,
  // NOT the global ConceptNode.memberCount.
  const [conceptCounts, setConceptCounts] = useState<Readonly<Record<string, number>>>({});
  const [concepts, setConcepts] = useState<readonly ConceptNode[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce the raw input into the query that actually hits the bridge.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(rawQuery), 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [rawQuery]);

  // Load the concept list once (filterbar + map).
  useEffect(() => {
    if (!isDesktop()) return;
    void appApi
      .listConcepts()
      .then((res) => setConcepts(res.concepts))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Run the search whenever the query or the type/concept filters change.
  useEffect(() => {
    if (!isDesktop()) return;
    const q = debouncedQuery.trim();
    if (q.length === 0) {
      // DEFERRED (vs the kit's "show all when no query"): the M8 spec scopes
      // `search.query` to KEYWORD search over the FTS5 index and explicitly
      // returns [] for an empty query — so an empty-query "browse by concept /
      // type / priority facet" is intentionally not wired here. A future
      // browse-by-facet path (so a map-node click populates Results without a
      // keyword) would add a member-listing bridge surface backed by the existing
      // `ConceptRepository.elementsForConcept` / the queue concept filter — out of
      // scope for the keyword-search milestone, tracked as a follow-up.
      setResults([]);
      setConceptCounts({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void appApi
      .searchQuery({
        q,
        ...(typeFilter ? { type: typeFilter } : {}),
        ...(conceptFilter ? { conceptId: conceptFilter } : {}),
        ...(priorityFilter ? { priorityLabel: priorityFilter } : {}),
      })
      .then((res) => {
        if (cancelled) return;
        setResults(res.results);
        // Guarded by the SAME cancelled flag as setResults so an out-of-order
        // response can never leave the chip counts pointing at a different query.
        setConceptCounts(res.counts.byConcept);
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
  }, [debouncedQuery, typeFilter, conceptFilter, priorityFilter]);

  // The result list IS the backend-narrowed set. The Priority facet is now applied
  // MAIN-side (threaded as `priorityLabel` into the FTS query), so the drill-down
  // concept-chip `byConcept` counts respect priority TOO — the chip number always
  // matches the priority-narrowed list (the count-vs-list invariant). No client-side
  // priority filtering: doing it here would re-introduce the chip/list mismatch the
  // reported Library bug was about.
  const visible = results;

  const selected = useMemo(() => visible.find((r) => r.id === selId) ?? null, [visible, selId]);

  // Keep a valid selection as results change.
  useEffect(() => {
    if (selId && !visible.some((r) => r.id === selId)) setSelId(null);
  }, [visible, selId]);

  const open = useCallback(
    (r: SearchResult) => {
      if (r.type === "source") void navigate({ to: "/source/$id", params: { id: r.id } });
      else if (r.type === "extract") void navigate({ to: "/extract/$id", params: { id: r.id } });
      else void navigate({ to: "/review" });
    },
    [navigate],
  );

  // The Map tab's "members" volume — the GLOBAL member count across all element
  // types (NOT filter-scoped). This is intentionally distinct from the filterbar
  // concept chip's drill-down `conceptCounts` (keyword/type-scoped): the Map shows
  // a concept's total reach, while the chip must match the narrowed result list.
  const conceptVolume = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of concepts) m.set(c.id, c.memberCount);
    return m;
  }, [concepts]);

  if (!desktop) {
    return (
      <div className="lib-shell" data-testid="route-search">
        <div className="lib-empty">
          <div className="lib-empty__icon">
            <Icon name="library" size={26} />
          </div>
          <h1 className="lib-empty__title">Library & Search</h1>
          <p className="lib-empty__body">
            Open the Electron app to search across your whole collection.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="lib-shell" data-testid="route-search">
      <div className="lib-topbar">
        <div className="lib-searchbar">
          <Icon name="search" size={15} />
          <input
            type="search"
            data-testid="library-search-input"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Search sources, extracts, cards, concepts…"
            // biome-ignore lint/a11y/noAutofocus: search is the screen's primary action
            autoFocus
          />
        </div>
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
                  {/* DRILL-DOWN count: members of this concept that ALSO match the
                      active keyword + type (NOT the global memberCount) — so the chip
                      number always matches the narrowed result list. Empty until a
                      keyword is entered (search returns [] for an empty query). */}
                  <span className="filter-opt__count">{conceptCounts[c.id] ?? 0}</span>
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
              </button>
            ))}
          </div>

          {/* Maintenance "smart" filters are M9/M17 analytics — shown but disabled. */}
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
          <>
            <div className="lib-results" data-testid="library-results">
              <div className="lib-results__inner">
                {error ? (
                  <p className="lib-error" data-testid="library-error">
                    {error}
                  </p>
                ) : null}
                {debouncedQuery.trim().length === 0 ? (
                  <div className="lib-empty" data-testid="library-prompt">
                    <div className="lib-empty__icon">
                      <Icon name="search" size={26} />
                    </div>
                    <h2 className="lib-empty__title">Search your collection</h2>
                    <p className="lib-empty__body">
                      Find any source, extract, or card by title, body, prompt, answer, or tag.
                    </p>
                  </div>
                ) : loading && visible.length === 0 ? (
                  <p className="lib-loading" data-testid="library-loading">
                    Searching…
                  </p>
                ) : visible.length === 0 ? (
                  <div className="lib-empty" data-testid="library-empty">
                    <div className="lib-empty__icon">
                      <Icon name="search" size={26} />
                    </div>
                    <h2 className="lib-empty__title">No matches for “{debouncedQuery.trim()}”</h2>
                    <p className="lib-empty__body">
                      Try a different term, or clear the type/concept/priority filters.
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
                            onClick={() => setSelId(r.id)}
                            onDoubleClick={() => open(r)}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div className="result__title">
                                {highlight(r.title, debouncedQuery)}
                              </div>
                              <div className="result__meta">
                                {r.concept ? <ConceptTag name={r.concept} /> : null}
                                {r.sourceTitle ? <span>{r.sourceTitle}</span> : null}
                                {r.sourceLocationLabel ? (
                                  <span>{r.sourceLocationLabel}</span>
                                ) : null}
                                {r.snippet ? (
                                  <span className="result__snippet">
                                    {highlight(r.snippet, debouncedQuery)}
                                  </span>
                                ) : null}
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

            {selected ? (
              <div className="lib-detail" data-testid="library-detail">
                <div className="lib-detail__head">
                  <TypeIcon type={selected.type} lg />
                  <div style={{ minWidth: 0 }}>
                    <div className="lib-detail__title">{selected.title}</div>
                    <div className="lib-detail__type">{typeLabel(selected.type)}</div>
                  </div>
                </div>
                <div className="lib-detail__row">
                  <Prio priority={selected.priority} />
                  {selected.concept ? <ConceptTag name={selected.concept} /> : null}
                  {/* The load-bearing scheduler split + due status, matching the
                      kit's detail panel (Prio / ConceptTag / SchedulerChip / Status). */}
                  <SchedulerChip scheduler={selected.scheduler} />
                  {selected.dueAt ? <DueBadge result={selected} /> : null}
                </div>
                {selected.snippet ? (
                  <div className="refblock" data-testid="library-detail-snippet">
                    {selected.snippet}
                  </div>
                ) : null}
                {/* Source reference (T043) — the shared RefBlock so the library
                    reads a source reference the same way the inspector/review do.
                    A `source` hit references itself (just its title); an extract/card
                    shows its originating source title + location. The search payload
                    carries title + location (T042); URL/author/date are resolved in
                    the inspector when the element is opened. */}
                {selected.sourceTitle ? (
                  <RefBlock
                    ref={{
                      sourceElementId: null,
                      sourceTitle: selected.sourceTitle,
                      url: null,
                      author: null,
                      publishedAt: null,
                      locationLabel: selected.sourceLocationLabel,
                      snippet: null,
                    }}
                    showSnippet={false}
                    testId="library-detail-ref"
                  />
                ) : (
                  <div className="lib-detail__type" data-testid="library-detail-nosrc">
                    No source
                  </div>
                )}
                <button
                  type="button"
                  className="lib-btn"
                  data-testid="library-detail-open"
                  onClick={() => open(selected)}
                >
                  <Icon name="external" size={14} />
                  Open {typeLabel(selected.type).toLowerCase()}
                </button>
              </div>
            ) : null}
          </>
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
                      <b>{conceptVolume.get(c.id) ?? 0}</b> members
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
