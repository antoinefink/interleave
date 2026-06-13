/**
 * Collection Explorer Search mode (T042) — local full-text search + a read-only
 * concept map.
 *
 * Rebuilt from the design kit (`design/kit/app/screen-library.jsx`) for the React
 * 19 renderer: a search input, Results/Map segmented tabs, the left `filterbar`
 * (type / concept / priority + stubbed maintenance rows), grouped + query-
 * highlighted `result` rows, a selection detail panel with the source `refblock`
 * and open-in-context, and the read-only `ConceptGraph` map tab.
 *
 * Architecture (non-negotiable): UI only. Keyword search runs in SQLite FTS5
 * behind the typed `window.appApi.search.query` command; empty-query facet counters
 * use the typed `window.appApi.library.browse` command without rendering browse
 * rows. The renderer holds no SQL, no ranking, and no index logic.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
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
import { AutoVirtualList } from "../components/VirtualList";
import { CollectionExplorerModeSwitch } from "./CollectionExplorerModeSwitch";
import "../components/inspector/inspector.css";
import {
  appApi,
  type ConceptNode,
  isDesktop,
  type LibraryBrowseRequest,
  type LibraryBrowseResult,
  SEMANTIC_COVERAGE_THRESHOLD,
  type SearchableType,
  type SearchCounts,
  type SearchResult,
  type SemanticIndexHealth,
  type SemanticSearchMode,
} from "../lib/appApi";
import { ReviewModeButton } from "../review/ReviewModeButton";
import "../review/review.css";
import { useSelection } from "../shell/selection";
import {
  explorerSearchParams,
  PRIORITIES,
  type PriorityLetter,
  parsePriority,
  parseSearchableType,
  parseStringParam,
  SEARCHABLE_TYPES,
} from "./collectionExplorerState";
import "./library.css";

type Tab = "results" | "map";

/**
 * A library row: the FTS {@link SearchResult} OR a fused semantic row (the same
 * shape + a `semantic` flag for the "related" label). Modeled as `SearchResult`
 * with an optional `semantic` so the existing row/detail rendering is unchanged.
 */
type LibraryRow = SearchResult & { readonly semantic?: boolean };

/** The three searchable types, in display order, with their group titles. */
const TYPE_GROUPS: readonly { type: SearchableType; title: string }[] = [
  { type: "source", title: "Sources" },
  { type: "extract", title: "Extracts" },
  { type: "card", title: "Cards" },
];

const EMPTY_SEARCH_COUNTS: SearchCounts = {
  byType: { source: 0, extract: 0, card: 0 },
  byConcept: {},
  byPriority: { A: 0, B: 0, C: 0, D: 0 },
};

function searchCountsFromBrowse(counts: LibraryBrowseResult["counts"]): SearchCounts {
  return {
    byType: {
      source: counts.byType.source ?? 0,
      extract: counts.byType.extract ?? 0,
      card: counts.byType.card ?? 0,
    },
    byConcept: counts.byConcept,
    byPriority: {
      A: counts.byPriority.A ?? 0,
      B: counts.byPriority.B ?? 0,
      C: counts.byPriority.C ?? 0,
      D: counts.byPriority.D ?? 0,
    },
  };
}

function emptyQueryBrowseRequest(filters: {
  readonly typeFilter: SearchableType | null;
  readonly conceptFilter: string | null;
  readonly priorityFilter: PriorityLetter | null;
}): LibraryBrowseRequest {
  return {
    types: filters.typeFilter ? [filters.typeFilter] : SEARCHABLE_TYPES,
    ...(filters.conceptFilter ? { conceptId: filters.conceptFilter } : {}),
    ...(filters.priorityFilter ? { priorityLabel: filters.priorityFilter } : {}),
  };
}

/** A due-state badge (overdue / today / soon) — matches the queue's `DueBadge`. */
function DueBadge({ result }: { result: SearchResult }) {
  const cls = !result.queueEligible
    ? "badge--soft"
    : result.due === "overdue"
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
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const { select } = useSelection();
  const routeQuery = parseStringParam(routeSearch.q) ?? "";
  const routeType = parseSearchableType(routeSearch.type);
  const routeConceptId = parseStringParam(routeSearch.conceptId);
  const routePriority = parsePriority(routeSearch.priority);

  const [tab, setTab] = useState<Tab>("results");
  const [rawQuery, setRawQuery] = useState(() => routeQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(() => routeQuery);
  const [typeFilter, setTypeFilter] = useState<SearchableType | null>(() => routeType);
  const [conceptFilter, setConceptFilter] = useState<string | null>(() => routeConceptId);
  const [priorityFilter, setPriorityFilter] = useState<PriorityLetter | null>(() => routePriority);

  const [results, setResults] = useState<readonly LibraryRow[]>([]);
  // DRILL-DOWN filterbar counts scoped to the active retrieval mode. Keyword and
  // semantic paths use search/semantic counts; empty-query paths use library browse
  // counts bounded to source/extract/card. ConceptNode.memberCount is Map volume.
  const [searchCounts, setSearchCounts] = useState<SearchCounts>(EMPTY_SEARCH_COUNTS);
  const [concepts, setConcepts] = useState<readonly ConceptNode[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Semantic search (T087): whether on-device vector search is available, and
  // which retrieval the last query actually ran (so the UI labels keyword fallback honestly).
  const [semanticAvailable, setSemanticAvailable] = useState(false);
  const [searchMode, setSearchMode] = useState<SemanticSearchMode>("fts");
  // The live "N of M embedded" index progress (drives the available-but-incomplete
  // "Build index" affordance, per the T087 spec) + an in-flight reindex guard.
  const [semanticIndex, setSemanticIndex] = useState({ embedded: 0, total: 0 });
  // Index-health rollup (U6) — distinguishes actively-building from stale-and-idle so
  // a user watching the index self-heal isn't told search is broken.
  const [indexHealth, setIndexHealth] = useState<SemanticIndexHealth>("healthy");
  const [reindexing, setReindexing] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const debouncedTerm = debouncedQuery.trim();
  const hasQuery = debouncedTerm.length > 0;
  const hasActiveFacet = typeFilter !== null || conceptFilter !== null || priorityFilter !== null;
  const showSemanticBuildIndex =
    !hasQuery && semanticAvailable && semanticIndex.embedded < semanticIndex.total;
  // U6 — honest coverage states. `coverageRatio` is 1 on an empty corpus so an empty
  // vault never reads as "partial". `building` is a reassuring "Indexing…" signal;
  // `partial` (stale + idle, below threshold) is the honest keyword-weighted warning.
  const coverageRatio = semanticIndex.total > 0 ? semanticIndex.embedded / semanticIndex.total : 1;
  const indexBuilding = semanticAvailable && indexHealth === "building";
  const partialCoverage =
    semanticAvailable &&
    !indexBuilding &&
    semanticIndex.total > 0 &&
    coverageRatio < SEMANTIC_COVERAGE_THRESHOLD;
  const pendingFilterLabels = useMemo(() => {
    const labels: string[] = [];
    if (typeFilter) {
      labels.push(
        TYPE_GROUPS.find((group) => group.type === typeFilter)?.title ?? typeLabel(typeFilter),
      );
    }
    if (conceptFilter) {
      labels.push(
        concepts.find((concept) => concept.id === conceptFilter)?.name ?? "Selected concept",
      );
    }
    if (priorityFilter) labels.push(`Priority ${priorityFilter}`);
    return labels;
  }, [typeFilter, conceptFilter, priorityFilter, concepts]);
  const pendingFilterSummary = pendingFilterLabels.join(", ");
  const filterOptionClass = useCallback(
    (active: boolean) =>
      `filter-opt${active ? ` filter-opt--on${!hasQuery ? " filter-opt--pending" : ""}` : ""}`,
    [hasQuery],
  );

  const openBrowseMode = useCallback(() => {
    void navigate({
      to: "/library",
      search: explorerSearchParams("browse", {
        type: typeFilter,
        conceptId: conceptFilter,
        priority: priorityFilter,
      }),
    });
  }, [navigate, typeFilter, conceptFilter, priorityFilter]);

  useEffect(() => {
    setRawQuery(routeQuery);
    setDebouncedQuery(routeQuery);
    setTypeFilter(routeType);
    setConceptFilter(routeConceptId);
    setPriorityFilter(routePriority);
    setSelId(null);
    searchInputRef.current?.focus();
  }, [routeQuery, routeType, routeConceptId, routePriority]);

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

  // Read whether on-device semantic indexing is available (T087) so the query
  // effect picks the fused `semantic.search` path when sqlite-vec is functional.
  // Re-checked when embed jobs run and when the window regains focus.
  const refreshSemantic = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const status = await appApi.semanticStatus();
      setSemanticAvailable(status.vecAvailable);
      setSemanticIndex({ embedded: status.embedded, total: status.total });
      setIndexHealth(status.indexHealth);
    } catch {
      setSemanticAvailable(false);
    }
  }, []);

  // Build the on-device index (T087): enqueue `embed` jobs for everything that
  // needs (re-)embedding; progress is observed via the existing `jobs.subscribe`
  // (which calls `refreshSemantic` per `embed` job), so the readout updates live.
  // Pure UI — one command + the shared subscription; no model/SQL in React.
  const onReindex = useCallback(async () => {
    if (!isDesktop() || reindexing) return;
    setReindexing(true);
    try {
      await appApi.semanticReindex({ onlyMissing: false });
      await refreshSemantic();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReindexing(false);
    }
  }, [reindexing, refreshSemantic]);
  useEffect(() => {
    void refreshSemantic();
    const onFocus = () => void refreshSemantic();
    window.addEventListener("focus", onFocus);
    const unsubscribe = isDesktop()
      ? appApi.subscribeJobs((job) => {
          if (job.type === "embed") void refreshSemantic();
        })
      : undefined;
    return () => {
      window.removeEventListener("focus", onFocus);
      unsubscribe?.();
    };
  }, [refreshSemantic]);

  // Run the search whenever the query or the type/concept filters change.
  useEffect(() => {
    if (!isDesktop()) return;
    const q = debouncedTerm;
    if (q.length === 0) {
      let cancelled = false;
      setLoading(true);
      setError(null);
      setResults([]);
      setSelId(null);
      void appApi
        .libraryBrowse(
          emptyQueryBrowseRequest({
            typeFilter,
            conceptFilter,
            priorityFilter,
          }),
        )
        .then((res) => {
          if (cancelled) return;
          setSearchCounts(searchCountsFromBrowse(res.counts));
          setResults([]);
          setSearchMode(semanticAvailable ? "fts" : "disabled");
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
    }
    let cancelled = false;
    setLoading(true);

    // Semantic path (T087): when on-device vector search is available AND no
    // concept/priority facet is active (the fused KNN path doesn't take those
    // facets), use `semantic.search` so conceptually-related material surfaces
    // without a keyword match. It returns counts over the fused result universe so
    // the filterbar never shows zeroed chips while semantic rows are visible.
    // Otherwise — or when a facet is active — use the FTS keyword search unchanged.
    const useSemantic = semanticAvailable && !conceptFilter && !priorityFilter;
    if (useSemantic) {
      void appApi
        .semanticSearch({ q, ...(typeFilter ? { type: typeFilter } : {}) })
        .then((res) => {
          if (cancelled) return;
          setResults(res.results);
          setSearchCounts(res.counts);
          setSearchMode(res.mode);
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
    }

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
        setSearchCounts(res.counts);
        setSearchMode(semanticAvailable ? "fts" : "disabled");
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
  }, [debouncedTerm, typeFilter, conceptFilter, priorityFilter, semanticAvailable]);

  const keywordFallbackHint = useMemo(() => {
    if (!semanticAvailable) {
      return "Keyword search · semantic indexing is unavailable on this build.";
    }
    if (conceptFilter || priorityFilter) {
      return "Keyword search · semantic results are not used with concept or priority filters.";
    }
    if (semanticIndex.total > 0 && semanticIndex.embedded === 0) {
      return "Keyword search · semantic index has not been built yet.";
    }
    if (semanticIndex.embedded < semanticIndex.total) {
      return "Keyword search · semantic index is still building.";
    }
    return "Keyword search · semantic results are unavailable for this query.";
  }, [semanticAvailable, semanticIndex, conceptFilter, priorityFilter]);

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
      else if (r.type === "card") void navigate({ to: "/card/$id", params: { id: r.id } });
    },
    [navigate],
  );

  /** One result row — shared by the inline (small) + virtualized (large) group paths. */
  const renderResult = useCallback(
    (r: LibraryRow) => (
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
          <div className="result__title">
            {highlight(r.title, debouncedQuery)}
            {r.semantic ? (
              <span
                className="badge badge--soft"
                data-testid="library-related-badge"
                title="Surfaced by meaning, not just keywords"
                style={{ marginLeft: 8 }}
              >
                related
              </span>
            ) : null}
          </div>
          <div className="result__meta">
            {r.concept ? <ConceptTag name={r.concept} /> : null}
            {r.sourceTitle ? <span>{r.sourceTitle}</span> : null}
            {r.sourceLocationLabel ? <span>{r.sourceLocationLabel}</span> : null}
            {r.snippet ? (
              <span className="result__snippet">{highlight(r.snippet, debouncedQuery)}</span>
            ) : null}
          </div>
        </div>
        <Prio priority={r.priority} />
      </button>
    ),
    [selId, select, open, debouncedQuery],
  );

  // The Map tab's "members" volume — the GLOBAL member count across all element
  // types (NOT filter-scoped). This is intentionally distinct from the filterbar
  // concept chip's drill-down `searchCounts.byConcept` (keyword/type/priority
  // scoped): the Map shows a concept's total reach, while the chip must match the
  // narrowed result list.
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
          <h1 className="lib-empty__title">Collection Explorer Search</h1>
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
        <CollectionExplorerModeSwitch
          mode="search"
          onBrowse={openBrowseMode}
          onSearch={() => undefined}
        />
        <div className="lib-searchbar">
          <Icon name="search" size={15} />
          <input
            ref={searchInputRef}
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
                className={filterOptionClass(typeFilter === g.type)}
                data-testid={`library-filter-type-${g.type}`}
                onClick={() => setTypeFilter((cur) => (cur === g.type ? null : g.type))}
              >
                <TypeIcon type={g.type} />
                <span>{g.title}</span>
                <span className="filter-opt__count">{searchCounts.byType[g.type] ?? 0}</span>
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
                  className={filterOptionClass(conceptFilter === c.id)}
                  data-testid={`library-filter-concept-${c.id}`}
                  onClick={() => setConceptFilter((cur) => (cur === c.id ? null : c.id))}
                >
                  <ConceptTag name={c.name} />
                  {/* Keyword counts come from `search.query`; empty-query counts come
                      from `library.browse`, bounded to source/extract/card for this
                      screen. The Map tab still uses the global concept volume. */}
                  <span className="filter-opt__count">{searchCounts.byConcept[c.id] ?? 0}</span>
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
                className={filterOptionClass(priorityFilter === p)}
                data-testid={`library-filter-prio-${p}`}
                onClick={() => setPriorityFilter((cur) => (cur === p ? null : p))}
              >
                <span className={`prio-dot prio-dot--${p.toLowerCase()}`} />
                <span>Priority {p}</span>
                <span className="filter-opt__count">{searchCounts.byPriority[p] ?? 0}</span>
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
                {/* Semantic-search affordance (T087): a calm one-liner telling the
                    user which retrieval ran. Only shown once there is a query. */}
                {hasQuery ? (
                  indexBuilding ? (
                    <div className="lib-hint" data-testid="library-semantic-building">
                      Indexing… {semanticIndex.embedded} of {semanticIndex.total}. Semantic results
                      improve as it finishes.
                    </div>
                  ) : searchMode === "semantic" ? (
                    partialCoverage ? (
                      <div className="lib-hint" data-testid="library-semantic-partial">
                        Partial coverage — newer items may only match by keyword until indexing
                        finishes.
                      </div>
                    ) : (
                      <div className="lib-hint" data-testid="library-semantic-on">
                        Semantic search on — results include conceptually related items.
                      </div>
                    )
                  ) : searchMode === "fts" || searchMode === "disabled" ? (
                    <div className="lib-hint" data-testid="library-semantic-off">
                      {keywordFallbackHint}
                    </div>
                  ) : null
                ) : null}
                {/* T096 — launch a TARGETED review over the CARDS matching this query
                    (keyword always; semantic when available). Each button resolves its own
                    subset count and is omitted when no cards match. */}
                {hasQuery ? (
                  <div className="lib-review-modes" data-testid="library-review-modes">
                    <ReviewModeButton
                      selector={{ kind: "search", query: debouncedQuery.trim() }}
                      hideWhileLoading
                      label={(n) => `Review ${n} matching card${n === 1 ? "" : "s"}`}
                      testId="library-review-search"
                    />
                    {semanticAvailable ? (
                      <ReviewModeButton
                        selector={{ kind: "semantic", query: debouncedQuery.trim() }}
                        hideWhileLoading
                        icon="sparkle"
                        label={(n) => `Review ${n} related card${n === 1 ? "" : "s"}`}
                        testId="library-review-semantic"
                      />
                    ) : null}
                  </div>
                ) : null}
                {showSemanticBuildIndex ? (
                  <button
                    type="button"
                    className="lib-build-index"
                    data-testid="library-build-index"
                    disabled={reindexing}
                    onClick={() => void onReindex()}
                  >
                    {reindexing
                      ? "Building index…"
                      : `Build index (${semanticIndex.embedded} of ${semanticIndex.total} embedded)`}
                  </button>
                ) : null}
                {!hasQuery ? (
                  <div className="lib-empty" data-testid="library-prompt">
                    <div className="lib-empty__icon">
                      <Icon name="search" size={26} />
                    </div>
                    <h2 className="lib-empty__title">Search your collection</h2>
                    <p className="lib-empty__body">
                      {hasActiveFacet
                        ? `Type to search within ${pendingFilterSummary}.`
                        : "Find any source, extract, or card by title, body, prompt, answer, or tag."}
                    </p>
                    {hasActiveFacet ? (
                      <div className="lib-pending" data-testid="library-pending-filters">
                        <Icon name="filter" size={14} />
                        <span>
                          Pending constraints: {pendingFilterSummary}. They apply when you type.
                        </span>
                      </div>
                    ) : null}
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
                    <h2 className="lib-empty__title">
                      {hasQuery
                        ? `No matches for “${debouncedTerm}”`
                        : "No matches for selected filters"}
                    </h2>
                    <p className="lib-empty__body">
                      {hasQuery
                        ? "Try a different term, or clear the type/concept/priority filters."
                        : "Clear the type/concept/priority filters to return to the search prompt."}
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
                        {/* Virtualized once a single type-group crosses the threshold
                            (years-of-use scale, T100); inline below it so the everyday
                            result list keeps its exact kit layout. */}
                        <AutoVirtualList
                          items={rows}
                          itemKey={(r) => r.id}
                          estimateSize={64}
                          height={520}
                          className="lib-sec__vlist"
                          testId={`library-group-${g.type}-list`}
                          renderInline={() => <>{rows.map((r) => renderResult(r))}</>}
                          renderItem={(r) => renderResult(r)}
                        />
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
                {selected.notInQueueReason ? (
                  <div className="lib-detail__reason" data-testid="library-detail-queue-reason">
                    {selected.notInQueueReason}
                  </div>
                ) : null}
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
                      // The library mini-ref does not carry reliability metadata (T091);
                      // the badge surfaces in the inspector/review refblock instead.
                      sourceType: null,
                      reliabilityTier: null,
                      confidence: null,
                      reliabilityNotes: null,
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
