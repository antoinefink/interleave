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
import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { LibrarySearchField } from "./LibrarySearchField";
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

/**
 * Index of the first case-insensitive occurrence of `term` in `text`, or `-1`
 * (empty/whitespace term → `-1`). The match unit for query highlighting.
 *
 * Highlighting used to wrap this match in an `<em>` inside every row's React tree.
 * That was the long-standing `/search` typing stutter: because the query was a prop
 * on every `ResultRow`, each keystroke re-rendered all rows AND mutated each row's DOM
 * (splitting the text around a moving `<em>`), forcing a synchronous style/layout/paint
 * pass whose cost scaled with the visible row count and landed between keystrokes. The
 * highlight is now applied via the CSS Custom Highlight API ({@link useSearchHighlight}):
 * rows render plain text once, and a query change becomes a paint-only highlight update
 * with no React re-render and no DOM mutation. This helper stays the shared, pure match
 * rule so the live-DOM ranges line up with what a row would consider "the hit".
 */
export function firstMatchIndex(text: string, term: string): number {
  const t = term.trim();
  if (t.length === 0) return -1;
  return text.toLowerCase().indexOf(t.toLowerCase());
}

/** The document-wide CSS highlight registry name (paired with `::highlight()` in library.css). */
const SEARCH_HIGHLIGHT_NAME = "library-search-hit";

/**
 * Min interval between `embed`-job-driven `refreshSemantic()` calls. The job runner emits
 * hundreds of embed-progress events/sec while a large add indexes; refreshing per event
 * floods the renderer with an IPC round-trip + re-render each time, pinning the main thread
 * so typing stutters DURING indexing. Throttling to this cadence keeps the "N of M embedded"
 * readout advancing smoothly while bounding the work to a few refreshes/sec.
 */
const EMBED_REFRESH_THROTTLE_MS = 400;

/**
 * Paint-only query highlighting via the CSS Custom Highlight API. After each results/
 * query change, walk the rendered `.result__title` / `.result__snippet` text and register
 * a {@link Range} over the first match in each (mirroring the former `highlight()`'s
 * first-occurrence behavior), then hand them to `CSS.highlights` so the browser paints the
 * highlight WITHOUT a React re-render or DOM mutation. No-ops where the API is unavailable
 * (jsdom in unit tests), so the rows simply render unhighlighted there.
 */
function useSearchHighlight(
  rootRef: React.RefObject<HTMLElement | null>,
  term: string,
  // Re-run when the rendered rows change, not just the query (new/removed/reordered rows
  // invalidate the previously-registered ranges). The caller passes the visible rows.
  rows: readonly unknown[],
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rows` identity is the row-set signal.
  useEffect(() => {
    // Access the CSS Custom Highlight API via globalThis with our OWN minimal shapes (cast
    // through `unknown` so we neither depend on nor collide with lib.dom's Map-based
    // declaration). Absent in jsdom → rows just render plain.
    const g = globalThis as unknown as {
      Highlight?: new (...ranges: Range[]) => object;
      CSS?: { highlights?: { set(name: string, h: object): void; delete(name: string): void } };
    };
    const HighlightCtor = g.Highlight;
    const highlights = g.CSS?.highlights;
    if (!HighlightCtor || !highlights) return; // unsupported (jsdom)
    const root = rootRef.current;
    const needle = term.trim().toLowerCase();
    if (!root || needle.length === 0) {
      highlights.delete(SEARCH_HIGHLIGHT_NAME);
      return;
    }
    const ranges: Range[] = [];
    for (const el of root.querySelectorAll(".result__title, .result__snippet")) {
      // First text node carrying the match (mirrors the former first-occurrence highlight;
      // skips nested chrome like the "related" badge span, which is a sibling node).
      for (let node = el.firstChild; node; node = node.nextSibling) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const text = node.textContent ?? "";
        const i = text.toLowerCase().indexOf(needle);
        if (i < 0) continue;
        const range = new Range();
        range.setStart(node, i);
        range.setEnd(node, i + needle.length);
        ranges.push(range);
        break;
      }
    }
    if (ranges.length === 0) highlights.delete(SEARCH_HIGHLIGHT_NAME);
    else highlights.set(SEARCH_HIGHLIGHT_NAME, new HighlightCtor(...ranges));
    return () => {
      highlights.delete(SEARCH_HIGHLIGHT_NAME);
    };
  }, [rootRef, term, rows]);
}

/**
 * One result row, memoized so it re-renders only when its own data or selection state
 * changes — NOT when an unrelated `LibraryScreen` render fires (loading flip, another
 * row's selection, a sibling state change) and crucially NOT on a query keystroke. The
 * row carries NO query prop: highlighting is applied out-of-band via the CSS Custom
 * Highlight API ({@link useSearchHighlight}), so typing leaves every persisting row's
 * props identical and the whole list skips re-render + repaint on the hot path.
 */
const ResultRow = memo(function ResultRowImpl({
  result,
  selected,
  onSelect,
  onOpen,
}: {
  readonly result: LibraryRow;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
  readonly onOpen: (result: SearchResult) => void;
}) {
  return (
    <button
      type="button"
      className={`result${selected ? " result--on" : ""}`}
      data-testid="library-result"
      data-result-id={result.id}
      data-result-type={result.type}
      onClick={() => onSelect(result.id)}
      onDoubleClick={() => onOpen(result)}
    >
      <div style={{ minWidth: 0 }}>
        <div className="result__title">
          {result.title}
          {result.semantic ? (
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
          {result.concept ? <ConceptTag name={result.concept} /> : null}
          {result.sourceTitle ? <span>{result.sourceTitle}</span> : null}
          {result.sourceLocationLabel ? <span>{result.sourceLocationLabel}</span> : null}
          {result.snippet ? <span className="result__snippet">{result.snippet}</span> : null}
        </div>
      </div>
      <Prio priority={result.priority} />
    </button>
  );
});

/**
 * The left filterbar (type / concept / priority + disabled maintenance rows), memoized so
 * it does NOT reconcile on a query-only `LibraryScreen` render — its inputs (concepts,
 * active filters, backend counts) change far less often than the debounced query. This
 * keeps the concept list (potentially hundreds of `ConceptTag` buttons) off the
 * keystroke-adjacent render path; it re-renders only when counts arrive or a filter toggles.
 */
const FilterBar = memo(function FilterBarImpl({
  concepts,
  typeFilter,
  conceptFilter,
  priorityFilter,
  searchCounts,
  hasQuery,
  onToggleType,
  onToggleConcept,
  onTogglePriority,
}: {
  readonly concepts: readonly ConceptNode[];
  readonly typeFilter: SearchableType | null;
  readonly conceptFilter: string | null;
  readonly priorityFilter: PriorityLetter | null;
  readonly searchCounts: SearchCounts;
  readonly hasQuery: boolean;
  readonly onToggleType: (type: SearchableType) => void;
  readonly onToggleConcept: (id: string) => void;
  readonly onTogglePriority: (priority: PriorityLetter) => void;
}) {
  // A pending (query-less) active facet styles differently — it applies once you type.
  const optClass = (active: boolean) =>
    `filter-opt${active ? ` filter-opt--on${!hasQuery ? " filter-opt--pending" : ""}` : ""}`;
  return (
    <div className="filterbar" data-testid="library-filterbar">
      <div className="filter-group">
        <div className="filter-group__title">Type</div>
        {TYPE_GROUPS.map((g) => (
          <button
            key={g.type}
            type="button"
            className={optClass(typeFilter === g.type)}
            data-testid={`library-filter-type-${g.type}`}
            onClick={() => onToggleType(g.type)}
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
              className={optClass(conceptFilter === c.id)}
              data-testid={`library-filter-concept-${c.id}`}
              onClick={() => onToggleConcept(c.id)}
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
            className={optClass(priorityFilter === p)}
            data-testid={`library-filter-prio-${p}`}
            onClick={() => onTogglePriority(p)}
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
  );
});

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
  // The raw input text + its 150 ms debounce now live inside `LibrarySearchField`
  // (U1) so a keystroke no longer re-renders this screen's heavy results/filterbar
  // subtree. This component holds only the DEBOUNCED query, which drives the search
  // effect + `highlight()` and changes at most every 150 ms.
  const [debouncedQuery, setDebouncedQuery] = useState(() => routeQuery);
  // Bumped on every external route-sync so the field re-syncs its text + refocuses
  // even when the route resets to the same `q` value.
  const [searchSyncToken, setSearchSyncToken] = useState(0);
  const [typeFilter, setTypeFilter] = useState<SearchableType | null>(() => routeType);
  const [conceptFilter, setConceptFilter] = useState<string | null>(() => routeConceptId);
  const [priorityFilter, setPriorityFilter] = useState<PriorityLetter | null>(() => routePriority);

  const [results, setResults] = useState<readonly LibraryRow[]>([]);
  // Mirror whether results are currently on screen so the search effect can SKIP the
  // `setLoading(true)` flip on a WARM search-as-you-type (Fix 3) — keeping the existing
  // rows visible instead of flashing "Searching…" and committing an extra render on
  // every debounce-settle. Read via a ref so the effect need not depend on `results`
  // (which would re-run the search on every result change).
  const hasResultsRef = useRef(false);
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

  // The search EFFECT + its UI gating key on the IMMEDIATE query so navigation fires a
  // search right away (no debounce wait) and route resets behave deterministically.
  const debouncedTerm = debouncedQuery.trim();
  const hasQuery = debouncedTerm.length > 0;
  // Query highlighting reads the DEFERRED query and is applied OUT OF BAND via the CSS
  // Custom Highlight API ({@link useSearchHighlight}), NOT as a per-row React prop. This
  // is the fix for the long-standing typing stutter: highlighting used to be an `<em>`
  // inside every row, so a keystroke re-rendered all rows AND mutated each row's DOM,
  // forcing a synchronous style/layout/paint pass whose cost scaled with the visible row
  // count and landed between characters (measured: ~25–35% of keystrokes dropped frames at
  // 34–50 rows, Paint/Composite-bound — which is why earlier render-level fixes via memo +
  // `useDeferredValue` + `startTransition` could not help). With the highlight off the row
  // render path, a persisting row's props are identical across keystrokes so the row memo
  // skips entirely; the query change becomes a paint-only highlight update. The deferral
  // keeps even that highlight repaint off the keystroke's critical frame.
  const deferredQuery = useDeferredValue(debouncedQuery);
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

  // Stable facet toggles so the memoized `FilterBar` isn't invalidated each render.
  const onToggleType = useCallback(
    (type: SearchableType) => setTypeFilter((cur) => (cur === type ? null : type)),
    [],
  );
  const onToggleConcept = useCallback(
    (id: string) => setConceptFilter((cur) => (cur === id ? null : id)),
    [],
  );
  const onTogglePriority = useCallback(
    (priority: PriorityLetter) => setPriorityFilter((cur) => (cur === priority ? null : priority)),
    [],
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
    // Drive the debounced query directly from the route so the search effect runs
    // immediately on navigation (no 150 ms wait for a keystroke). The field syncs
    // its own visible text + refocuses off `searchSyncToken` (bumped here).
    setDebouncedQuery(routeQuery);
    setTypeFilter(routeType);
    setConceptFilter(routeConceptId);
    setPriorityFilter(routePriority);
    setSelId(null);
    setSearchSyncToken((t) => t + 1);
  }, [routeQuery, routeType, routeConceptId, routePriority]);

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
    // THROTTLE the embed-progress refresh (see EMBED_REFRESH_THROTTLE_MS): fire the first
    // event immediately (responsive), then coalesce a burst into at most one trailing
    // refresh per window — so a flood of embed events can't pin the renderer mid-typing.
    let lastRefresh = 0;
    let trailing: number | null = null;
    const refreshThrottled = () => {
      const elapsed = Date.now() - lastRefresh;
      if (elapsed >= EMBED_REFRESH_THROTTLE_MS) {
        if (trailing !== null) {
          window.clearTimeout(trailing);
          trailing = null;
        }
        lastRefresh = Date.now();
        void refreshSemantic();
      } else if (trailing === null) {
        trailing = window.setTimeout(() => {
          trailing = null;
          lastRefresh = Date.now();
          void refreshSemantic();
        }, EMBED_REFRESH_THROTTLE_MS - elapsed);
      }
    };
    const unsubscribe = isDesktop()
      ? appApi.subscribeJobs((job) => {
          if (job.type === "embed") refreshThrottled();
        })
      : undefined;
    return () => {
      window.removeEventListener("focus", onFocus);
      if (trailing !== null) window.clearTimeout(trailing);
      unsubscribe?.();
    };
  }, [refreshSemantic]);

  // Run the search whenever the query or the type/concept filters change.
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    const q = debouncedTerm;

    // Apply a settled response's result state at LOW priority via startTransition, so the
    // heavy grouped-list reconcile (highlight() per row) is interruptible and yields to
    // keystrokes. setLoading(false) co-commits with the rows so a cold search never flashes
    // an empty state between "loading off" and the deferred results. setError(null) stays
    // URGENT (clearing an error is instant). Callers check `cancelled` before calling.
    const applyResults = (apply: () => void) => {
      setError(null);
      startTransition(() => {
        apply();
        setLoading(false);
      });
    };
    // Failure is URGENT so the error message + cleared spinner appear instantly. This
    // (plus the success setLoading inside applyResults) replaces the old `.finally`, so
    // loading is cleared on exactly one of the two outcomes — never both, never neither.
    const handleError = (e: unknown) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    };

    if (q.length === 0) {
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
          // Rows were already cleared synchronously above; only counts/mode apply here.
          applyResults(() => {
            setSearchCounts(searchCountsFromBrowse(res.counts));
            setSearchMode(semanticAvailable ? "fts" : "disabled");
          });
        })
        .catch(handleError);
      return () => {
        cancelled = true;
      };
    }

    // Only flash the "Searching…" placeholder on a COLD search (nothing on screen yet).
    // A warm search-as-you-type keeps its existing rows visible — no loading churn (Fix 3).
    if (!hasResultsRef.current) setLoading(true);

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
          // Reflect "results are about to land" SYNCHRONOUSLY: the `[results]` effect that
          // maintains hasResultsRef only runs after the low-priority transition commits, so
          // a rapid follow-up query's (urgent) effect would otherwise read a stale ref and
          // re-flash the spinner the warm-search guard above is meant to suppress.
          hasResultsRef.current = res.results.length > 0;
          applyResults(() => {
            setResults(res.results);
            setSearchCounts(res.counts);
            setSearchMode(res.mode);
          });
        })
        .catch(handleError);
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
        // Keep hasResultsRef in sync eagerly (see the semantic path) — the `[results]`
        // effect trails the low-priority transition commit. Guarded by the SAME cancelled
        // flag as the result setters so an out-of-order response can never leave the
        // rows/chip counts pointing at a different query.
        hasResultsRef.current = res.results.length > 0;
        applyResults(() => {
          setResults(res.results);
          setSearchCounts(res.counts);
          setSearchMode(semanticAvailable ? "fts" : "disabled");
        });
      })
      .catch(handleError);
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
  // Out-of-band, paint-only query highlighting (see `useSearchHighlight` / the deferredQuery
  // comment): keeps the moving highlight off every row's React render so typing doesn't
  // re-render + repaint the whole result list each keystroke.
  const resultsRef = useRef<HTMLDivElement | null>(null);
  useSearchHighlight(resultsRef, deferredQuery, visible);
  useEffect(() => {
    hasResultsRef.current = results.length > 0;
  }, [results]);

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

  // Stable row-select handler so the memoized `ResultRow` isn't invalidated by a new
  // closure identity on every render.
  const onSelectRow = useCallback(
    (id: string) => {
      setSelId(id);
      select(id);
    },
    [select],
  );

  /** One result row — shared by the inline (small) + virtualized (large) group paths. */
  const renderResult = useCallback(
    (r: LibraryRow) => (
      <ResultRow
        key={r.id}
        result={r}
        selected={selId === r.id}
        onSelect={onSelectRow}
        onOpen={open}
      />
    ),
    // NB: intentionally NOT keyed on the query — the row carries no highlight prop, so a
    // keystroke leaves a persisting row's element identical and its memo skips. Highlight
    // is applied via `useSearchHighlight` below.
    [selId, onSelectRow, open],
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
        <LibrarySearchField
          syncQuery={routeQuery}
          syncToken={searchSyncToken}
          onDebouncedChange={setDebouncedQuery}
        />
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
        <FilterBar
          concepts={concepts}
          typeFilter={typeFilter}
          conceptFilter={conceptFilter}
          priorityFilter={priorityFilter}
          searchCounts={searchCounts}
          hasQuery={hasQuery}
          onToggleType={onToggleType}
          onToggleConcept={onToggleConcept}
          onTogglePriority={onTogglePriority}
        />

        {tab === "results" ? (
          <>
            <div className="lib-results" data-testid="library-results">
              <div className="lib-results__inner" ref={resultsRef}>
                {error ? (
                  <p className="lib-error" data-testid="library-error">
                    {error}
                  </p>
                ) : null}
                {/* Semantic-search affordance (T087): an HONEST hint, shown only when
                    it tells the user something they can't already see. The happy path
                    (semantic ran, index healthy) shows NOTHING — the per-row `related`
                    badge already marks meaning-only hits, so a standing "semantic on"
                    banner is pure chrome. We surface a line only for the exceptions:
                    a genuine in-flight index build, honestly-degraded partial coverage,
                    or a keyword-only fallback (and why). Only shown once there is a query. */}
                {hasQuery ? (
                  indexBuilding ? (
                    <div className="lib-hint" data-testid="library-semantic-building">
                      {semanticIndex.embedded < semanticIndex.total
                        ? `Indexing… ${semanticIndex.embedded} of ${semanticIndex.total}.`
                        : "Indexing…"}
                    </div>
                  ) : searchMode === "semantic" ? (
                    partialCoverage ? (
                      <div className="lib-hint" data-testid="library-semantic-partial">
                        Partial coverage — newer items may only match by keyword until indexing
                        finishes.
                      </div>
                    ) : null
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
                      selector={{ kind: "search", query: debouncedTerm }}
                      hideWhileLoading
                      label={(n) => `Review ${n} matching card${n === 1 ? "" : "s"}`}
                      testId="library-review-search"
                    />
                    {semanticAvailable ? (
                      <ReviewModeButton
                        selector={{ kind: "semantic", query: debouncedTerm }}
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
