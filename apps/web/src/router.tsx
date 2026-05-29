/**
 * Application router (T003, shell wired in T004) — code-based, fully typed
 * TanStack Router.
 *
 * Seven routes are defined here, each rendered inside the persistent app shell:
 *   /            home (daily queue / command center landing)
 *   /inbox       import & triage
 *   /queue       due queue
 *   /source/$id  source reader (typed dynamic param)
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
import { InboxScreen } from "./pages/inbox/InboxScreen";
import { Placeholder } from "./pages/Placeholder";
import { Settings } from "./pages/Settings";
import { SourceReader } from "./pages/source/SourceReader";
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
  component: () => (
    <Placeholder
      routeId="queue"
      icon="queue"
      title="Daily Queue"
      body="Due sources, extracts, and cards, sorted by priority then due date."
    />
  ),
});

const sourceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/source/$id",
  component: SourceReader,
});

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/review",
  component: () => (
    <Placeholder
      routeId="review"
      icon="review"
      title="Review"
      body="Active-recall review: reveal, grade Again / Hard / Good / Easy, advance."
    />
  ),
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
  sourceRoute,
  reviewRoute,
  searchRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
