/**
 * Application router (T003, shell wired in T004) — code-based, fully typed
 * TanStack Router.
 *
 * Eight routes are defined here, each rendered inside the persistent app shell:
 *   /            home (daily queue / command center landing)
 *   /inbox       import & triage
 *   /queue       due queue
 *   /source/$id  source reader (typed dynamic param)
 *   /extract/$id extract review mode (T024 — typed dynamic param)
 *   /review      active-recall review session
 *   /search      library / search
 *   /settings    local settings
 *
 * Code-based routing (vs the file-based codegen plugin) keeps the scaffold
 * explicit and dependency-light while the screens are still placeholders. The
 * root route renders the `Shell` (sidebar / command bar / work area / inspector
 * / status bar + ⌘K, ?, g-nav) once; every route's content paints in its
 * <Outlet/>.
 *
 * No domain logic here — routes render placeholders; data wiring lands after
 * the Electron shell + native SQLite (T007) and the repositories (T008), reached
 * through the typed `window.appApi` bridge.
 */
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { DesktopStatusPanel } from "./components/DesktopStatusPanel";
import { LeechCleanup } from "./maintenance/LeechCleanup";
import { InboxScreen } from "./pages/inbox/InboxScreen";
import { Placeholder } from "./pages/Placeholder";
import { ProcessQueue } from "./pages/queue/ProcessQueue";
import { QueueScreen } from "./pages/queue/QueueScreen";
import { Settings } from "./pages/Settings";
import { SourceReader } from "./pages/source/SourceReader";
import { ExtractView } from "./reader/ExtractView";
import { ReviewScreen } from "./review/ReviewScreen";
import { Shell } from "./shell/Shell";

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <Placeholder
      routeId="home"
      icon="layers"
      title="Home"
      body="Your daily command center. The queue, streak, and next actions land here."
    />
  ),
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
 * route so the `/review` placeholder stays reserved for the M7 review session.
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
 * reschedules through `SchedulerService` → `ReviewRepository`, and advances —
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

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  component: () => (
    <Placeholder
      routeId="search"
      icon="library"
      title="Library & Search"
      body="Find any source, extract, or card across your whole collection."
    />
  ),
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
  searchRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
