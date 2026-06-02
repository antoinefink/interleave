/**
 * Application router (T003, shell wired in T004) — code-based, fully typed
 * TanStack Router.
 *
 * Fourteen routes are defined here, each rendered inside the persistent app shell:
 *   /                    home (daily queue / command center landing)
 *   /inbox               import & triage
 *   /queue               due queue
 *   /process             focused one-at-a-time process session (T031)
 *   /source/$id          source reader (typed dynamic param)
 *   /extract/$id         extract review mode (T024 — typed dynamic param)
 *   /review              active-recall review session
 *   /maintenance/leeches leech cleanup (T040)
 *   /search              library / search (keyword FTS5)
 *   /library             browse-everything facet surface
 *   /concepts            concept knowledge-map + member drill-in
 *   /trash               soft-deleted elements (T044)
 *   /analytics           learning-health snapshot (T045)
 *   /analytics/sources   per-source yield analytics (T083)
 *   /settings            local settings
 *
 * Code-based routing (vs the file-based codegen plugin) keeps the route tree
 * explicit and dependency-light. The root route renders the `Shell` (sidebar /
 * command bar / work area / inspector / status bar + ⌘K, ?, g-nav) once; every
 * route's content paints in its <Outlet/>. Every route — including `/` (the Home
 * command center) — mounts its real screen.
 *
 * No domain logic here — each screen reads/writes its own data through the typed
 * `window.appApi` bridge (Electron main + native SQLite); the router only maps
 * paths to components.
 */
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AnalyticsScreen } from "./analytics/AnalyticsScreen";
import { SourceYield } from "./analytics/SourceYield";
import { DesktopStatusPanel } from "./components/DesktopStatusPanel";
import { ConceptsScreen } from "./concepts/ConceptsScreen";
import { BrowseScreen } from "./library/BrowseScreen";
import { LibraryScreen } from "./library/LibraryScreen";
import { LeechCleanup } from "./maintenance/LeechCleanup";
import { RetiredCards } from "./maintenance/RetiredCards";
import { StagnantExtracts } from "./maintenance/StagnantExtracts";
import { HomeScreen } from "./pages/home/HomeScreen";
import { InboxScreen } from "./pages/inbox/InboxScreen";
import { ProcessQueue } from "./pages/queue/ProcessQueue";
import { QueueScreen } from "./pages/queue/QueueScreen";
import { Settings } from "./pages/Settings";
import { SourceReader } from "./pages/source/SourceReader";
import { ExtractView } from "./reader/ExtractView";
import { ReviewScreen } from "./review/ReviewScreen";
import { Shell } from "./shell/Shell";
import { TrashScreen } from "./trash/TrashScreen";

const rootRoute = createRootRoute({ component: Shell });

/**
 * Home command center (T-home) — the real `/` index, replacing the Placeholder. A
 * read-only landing dashboard that orients the user at a glance (greeting + due/est,
 * BudgetMeter + at-risk metrics, streak + retention, a compact top-due preview, the
 * reviews-per-day spark, quick-nav tiles) and routes INTO the interactive surfaces
 * (/process, /queue, /review, /inbox). It composes the existing typed reads
 * `queue.list` + `analytics.get`; no new bridge surface, no domain logic in React.
 */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeScreen,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxScreen,
});

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  component: QueueScreen,
});

/**
 * The "Process queue" learning loop (T031) — a focused, one-element-at-a-time mode
 * the queue's "Start session" button opens. It reuses the same typed `queue.list` /
 * `queue.act` / `elements.setPriority` surface as the list (no new mutation path),
 * advancing the cursor after every action so the user processes ten mixed
 * sources/extracts/cards without returning to a list. Lives on its own `/process`
 * route, kept distinct from `/review` (the FSRS active-recall review session).
 */
const processRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/process",
  component: ProcessQueue,
});

const sourceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/source/$id",
  component: SourceReader,
});

const extractRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/extract/$id",
  component: ExtractView,
});

/**
 * The active-recall review session (T037) — the FSRS review loop. `/review`
 * loads the due-card deck (FSRS `due_at ≤ now`), reveals the answer, grades
 * Again/Hard/Good/Easy with next-interval previews, logs the response time +
 * reschedules through `CardSchedulerService` → `ReviewRepository`, and advances —
 * every grade writing a durable `review_logs` row. All over the typed
 * `window.appApi.review.*` surface; the renderer holds no FSRS math or SQL.
 */
const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/review",
  component: ReviewScreen,
});

/**
 * Leech cleanup view (T040) — the maintenance surface listing every card flagged a
 * leech (auto after ≥4 lapses, or manual) with rewrite / suspend / delete / un-leech.
 * Reads `appApi.reviewLeeches()` (read-only) and drives remediation through the
 * existing `cards.*` surface; the renderer holds no leech threshold logic or SQL.
 */
const leechCleanupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/maintenance/leeches",
  component: LeechCleanup,
});

/**
 * Retired-card inventory (T082) — the maintenance surface listing every card
 * retired (the durable `cards.is_retired` flag) so a low-value mature card leaves
 * active review gracefully, with Un-retire to restore it. Reads
 * `appApi.retiredCards()` (read-only) and drives un-retire through `cards.unretire`;
 * the renderer holds no retirement logic or SQL.
 */
const retiredCardsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/maintenance/retired",
  component: RetiredCards,
});

/**
 * Stagnant-extracts maintenance view (T084) — the attention-side mirror of leech
 * cleanup: every live extract that keeps returning without progressing (stage never
 * advanced, no children, postponed repeatedly), detected by the read-only
 * `ExtractStagnationQuery` (the pure `@interleave/scheduler` `isStagnant` heuristic),
 * with rewrite / convert / postpone / delete remediations that invoke the existing
 * `extracts.*` / extract→card commands. The whole list comes from
 * `appApi.getExtractStagnation()`; the renderer holds no detection logic or SQL.
 */
const stagnantExtractsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/maintenance/stagnant",
  component: StagnantExtracts,
});

/**
 * Library & Search (T042) — local FTS5 full-text search over source title/body +
 * extract body + card prompt/answer + tags, ranked best-first, with the
 * filterbar (type/concept/priority) + grouped/highlighted results + the read-only
 * concept Map tab. All search runs in SQLite FTS5 behind the typed
 * `window.appApi.search.query`; the renderer holds no SQL or ranking logic.
 */
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  component: LibraryScreen,
});

/**
 * Library (Library route) — the facet-driven browse-everything surface. Distinct
 * from `/search` (keyword-driven FTS5 that returns `[]` for an empty query):
 * `/library` DEFAULTS to listing ALL live elements and narrows by FACETS
 * (type/concept/priority/status), covering topic/synthesis_note/task that keyword
 * search can never return. The whole list comes from the typed
 * `window.appApi.library.browse` command (`LibraryQuery` does the SQL/ordering/
 * counts/enrichment); the renderer holds no SQL or scheduling logic.
 */
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  component: BrowseScreen,
});

/**
 * Concepts knowledge-map (`/concepts`) — the dedicated concept-graph browse
 * surface. Renders the shared `ConceptGraph` radial SVG (the kit's `graph`/`gnode`
 * Map view) plus a concept-hierarchy filterbar and a "by volume" rail; selecting a
 * node/pill/row DRILLS INTO that concept's members — the live elements assigned to
 * it — each openable in its reader. Composes the typed reads `concepts.list` +
 * the narrow new `concepts.members` (backed by `ConceptRepository.elementsForConcept`,
 * enriched main-side); the renderer holds no SQL, scheduling, or membership logic.
 */
const conceptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/concepts",
  component: ConceptsScreen,
});

/**
 * Trash view (T044) — soft-deleted elements collect here and can be restored (to
 * their prior lifecycle status, lineage intact) or permanently deleted with
 * confirmation. Reads `appApi.listTrash()` (read-only) and drives Restore / Purge /
 * Empty + the general undo through the typed `window.appApi.trash`/`undo` surface;
 * the renderer holds no soft-delete or restore logic (it lives in `packages/local-db`).
 */
const trashRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trash",
  component: TrashScreen,
});

/**
 * Analytics view (T045) — the read-only system-wide learning-health snapshot:
 * daily reviews, retention, due cards/topics, new cards/extracts, deletions, and
 * leeches. The whole snapshot comes from `appApi.getAnalytics()` (the domain
 * `AnalyticsService` aggregates over `review_logs`/`elements`/`review_states`); the
 * renderer holds no aggregation or SQL. The system-health banners link to the
 * leech cleanup + trash maintenance surfaces.
 */
const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/analytics",
  component: AnalyticsScreen,
});

/**
 * Source-yield view (T083) — the ranked, lowest-yield-first per-source rollup:
 * read %, extracts/cards/mature-cards created, leeches, and review time per source,
 * so low-yield sources are identifiable. The whole payload comes from
 * `appApi.getSourceYield()` (the domain `SourceYieldQuery` aggregates over
 * `elements`/`read_points`/`document_blocks`/`review_states`/`review_logs`/`cards`
 * via the persisted `sourceId` lineage + the pure `scoreSourceYield` rule); the
 * renderer holds no aggregation or SQL. Linked from the Analytics "Low-yield
 * sources" banner.
 */
const sourceYieldRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/analytics/sources",
  component: SourceYield,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsScreen,
});

/**
 * Settings route (T011). Renders the real preferences surface — daily review
 * budget, desired retention, default topic interval, default source priority,
 * keyboard layout, and theme — all read/written through the typed
 * `window.appApi` (`settings.getAll()` / `settings.updateMany()`) and persisted
 * in the SQLite `settings` table. The desktop status panel (T007) stays below as
 * the shell health/DB-status readout and a key/value persistence demonstration.
 */
function SettingsScreen() {
  return (
    <div className="flex h-full min-h-full flex-col overflow-auto">
      <Settings />
      <div className="mx-auto w-full max-w-3xl px-7 pb-10">
        <DesktopStatusPanel />
      </div>
    </div>
  );
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  inboxRoute,
  queueRoute,
  processRoute,
  sourceRoute,
  extractRoute,
  reviewRoute,
  leechCleanupRoute,
  retiredCardsRoute,
  stagnantExtractsRoute,
  searchRoute,
  libraryRoute,
  conceptsRoute,
  trashRoute,
  analyticsRoute,
  sourceYieldRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
