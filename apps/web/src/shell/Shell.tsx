/**
 * Persistent app shell (T004).
 *
 * The workspace chrome every screen shares, rebuilt from the kit's shell.jsx for
 * React 19 + Tailwind v4 + TanStack Router:
 *
 *   ┌────────────┬───────────────────────────────┬──────────────┐
 *   │  Sidebar   │  Topbar (command bar · ⌘K)    │  Inspector   │
 *   │  brand     ├───────────────────────────────┤  (selected   │
 *   │  nav       │  Work area (route <Outlet/>)   │   element ·  │
 *   │  Organize  │                               │   lineage)   │
 *   │  streak    ├───────────────────────────────┤              │
 *   │  user chip │  Status bar (shortcut hints)  │              │
 *   └────────────┴───────────────────────────────┴──────────────┘
 *
 * Layout dims come exclusively from the design tokens (--sidebar-w /
 * --inspector-w / --topbar-h) via shell.css; no hard-coded px. The shell hosts
 * the ⌘K command palette, the ? cheat sheet, and g+letter navigation. The
 * right inspector (T010) renders the selected element's metadata + actionable
 * lineage, driven by the shared selection context.
 *
 * No domain logic lives here: navigation goes through TanStack Router and the
 * nav/command catalogues are static config.
 */
import type { LocalVaultPath, VaultRoot } from "@interleave/core";
import {
  Link,
  Outlet,
  useLinkProps,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Inspector } from "../components/inspector/Inspector";
import { Snackbar } from "../components/Snackbar";
import { HelpCenter } from "../help/HelpCenter";
import { type HelpContextValue, HelpProvider } from "../help/HelpContext";
import { appApi, isDesktop } from "../lib/appApi";
import { getTourSteps, TourLayer } from "../onboarding/Tour";
import { WelcomeModal } from "../onboarding/WelcomeModal";
import { applyTheme, getStoredTheme, type Theme } from "../theme";
import { CheatSheet } from "./CheatSheet";
import { CommandPalette } from "./CommandPalette";
import { Kbd } from "./Kbd";
import {
  type NavItem,
  NEW_SOURCE_EVENT,
  OPEN_HELP_EVENT,
  PRIMARY_NAV,
  resolveActiveNavId,
  SECONDARY_NAV,
  START_TOUR_EVENT,
  UNDO_EVENT,
} from "./nav";
import { SelectionProvider, useSelection } from "./selection";
import "./shell.css";
import type { PaletteActionId } from "./shortcuts";
import { useGlobalActions } from "./useGlobalActions";
import { type NavBadgeCounts, useNavBadges } from "./useNavBadges";
import { useShellIdentity } from "./useShellIdentity";
import { useShellShortcuts } from "./useShellShortcuts";

/** Generic settings keys for the onboarding + contextual-help flags (persisted in
 *  the SQLite `settings` table via the bridge, like the original `ui.seenOnboarding`). */
const SEEN_ONBOARDING_KEY = "ui.seenOnboarding";
const TIPS_ENABLED_KEY = "ui.tipsEnabled";
const COACH_SEEN_KEY = "ui.coachSeen";

function runBackup() {
  return appApi.createBackup();
}

const THEME_MENU_ITEMS = [
  { theme: "system", label: "System" },
  { theme: "light", label: "Light" },
  { theme: "dark", label: "Dark" },
] as const satisfies ReadonlyArray<{ theme: Theme; label: string }>;

function NavButton({
  item,
  active,
  badges,
}: {
  item: NavItem;
  /**
   * Whether THIS entry is the single active one — resolved once per render by
   * `resolveActiveNavId` (by item identity), so exactly one entry highlights even
   * when several routes or route-only screens exist.
   */
  active: boolean;
  badges: NavBadgeCounts;
}) {
  // Live count for this entry (Queue / Inbox / Review), read from window.appApi
  // via useNavBadges — not a hardcoded placeholder. Hidden until loaded and when
  // the count is 0 (a calm sidebar shows no empty "0" pills).
  const count = item.liveBadge ? badges[item.id as keyof NavBadgeCounts] : undefined;
  // We render the full TanStack Link behaviour (navigation, preload, accessible
  // anchor) via useLinkProps, but OVERRIDE its built-in active markers. The Link
  // auto-stamps `aria-current="page"` + `data-status="active"` + an `active` class
  // on EVERY anchor whose `to` matches the URL — and those win over our own props
  // because the library spreads them last.
  // Instead we strip the auto markers and drive them from the single resolved
  // `active` flag (resolveActiveNavId), so exactly one entry is active in the DOM.
  const {
    className: _c,
    "aria-current": _a,
    "data-status": _d,
    // `type`/`disabled` are not valid anchor attributes — the real <Link> strips
    // them before rendering its <a>; mirror that so we emit a clean anchor.
    type: _t,
    disabled: _disabled,
    ...linkProps
  } = useLinkProps({ to: item.to }) as Record<string, unknown>;
  return (
    <a
      {...linkProps}
      data-testid={`nav-${item.id}`}
      className={active ? "shell-nav__item shell-nav__item--on" : "shell-nav__item"}
      aria-current={active ? "page" : undefined}
      data-status={active ? "active" : undefined}
    >
      <Icon name={item.icon} size={17} />
      {item.label}
      {typeof count === "number" && count > 0 && (
        <span className="shell-nav__badge" data-testid={`nav-${item.id}-badge`}>
          {count}
        </span>
      )}
    </a>
  );
}

function Sidebar({
  pathname,
  theme,
  onPickTheme,
  onOpenCheat,
  onOpenHelp,
}: {
  pathname: string;
  theme: Theme;
  onPickTheme: (theme: Theme) => void;
  onOpenCheat: () => void;
  onOpenHelp: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  // Real local-vault identity + streak (settings.displayName + analytics), not a
  // hardcoded persona/streak. Degrades to the neutral identity / hidden streak
  // outside the desktop shell.
  const { identity, streak } = useShellIdentity();
  // Live Queue / Inbox / Review count badges from window.appApi (queue.list /
  // inbox.list), not hardcoded numbers. Empty (every badge hidden) outside desktop.
  const badges = useNavBadges();
  // The SINGLE active nav entry for this route, resolved by item identity. Some
  // routes, including `/search`, intentionally have no sidebar owner.
  const activeId = resolveActiveNavId(pathname);

  // Close the user menu on a click outside the chip/menu, or on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (!menuWrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <aside className="shell-sidebar">
      <div className="shell-brand">
        <span className="shell-brand__logo" aria-hidden="true">
          <img
            className="shell-brand__logo-img"
            src="/logo.png"
            alt=""
            data-testid="shell-brand-logo"
          />
        </span>
        <div className="flex flex-col">
          <span className="shell-brand__name">Interleave</span>
        </div>
      </div>

      <nav className="shell-nav" aria-label="Primary">
        {PRIMARY_NAV.map((item) => (
          <NavButton key={item.id} item={item} active={item.id === activeId} badges={badges} />
        ))}
        <div className="shell-nav__label">Organize</div>
        {SECONDARY_NAV.map((item) => (
          <NavButton key={item.id} item={item} active={item.id === activeId} badges={badges} />
        ))}
      </nav>

      <div className="shell-sidebar__foot">
        {streak && streak.dayStreak > 0 ? (
          <div className="shell-streak" data-testid="shell-streak">
            <Icon name="flame" size={13} />
            <span className="shell-streak__n">{streak.dayStreak}-day streak</span>
            {streak.retentionPct !== null ? (
              <span className="shell-streak__l" data-testid="shell-streak-retention">
                {streak.retentionPct}%
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="shell-userchip-wrap" ref={menuWrapRef}>
          <button
            type="button"
            className="shell-userchip"
            data-testid="user-chip"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span className="shell-avatar" aria-hidden="true">
              {identity.initials}
            </span>
            <div className="flex flex-col">
              <span className="shell-userchip__name" data-testid="user-chip-name">
                {identity.name}
              </span>
              <span className="shell-userchip__sub">{identity.sub}</span>
            </div>
            <Icon name="chevronDown" size={14} className="ml-auto text-text-3" />
          </button>
          {menuOpen && (
            <div className="shell-usermenu" role="menu">
              <fieldset
                className="shell-usermenu__theme"
                aria-label="Theme"
                data-testid="shell-theme-segmented"
              >
                {THEME_MENU_ITEMS.map((item) => {
                  const active = theme === item.theme;
                  return (
                    <button
                      type="button"
                      className={
                        active
                          ? "shell-usermenu__theme-option shell-usermenu__theme-option--on"
                          : "shell-usermenu__theme-option"
                      }
                      role="menuitemradio"
                      aria-checked={active}
                      data-testid={`shell-theme-option-${item.theme}`}
                      key={item.theme}
                      onClick={() => onPickTheme(item.theme)}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </fieldset>
              <Link
                to="/settings"
                className="shell-usermenu__item"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                <Icon name="settings" size={14} />
                <span className="shell-grow">Settings</span>
              </Link>
              <button
                type="button"
                className="shell-usermenu__item"
                role="menuitem"
                onClick={() => {
                  onOpenCheat();
                  setMenuOpen(false);
                }}
              >
                <Icon name="keyboard" size={14} />
                <span className="shell-grow">Keyboard shortcuts</span>
                <Kbd keys="?" />
              </button>
              <button
                type="button"
                className="shell-usermenu__item"
                role="menuitem"
                data-testid="usermenu-help"
                onClick={() => {
                  onOpenHelp();
                  setMenuOpen(false);
                }}
              >
                <Icon name="info" size={14} />
                <span className="shell-grow">Help &amp; docs</span>
              </button>
              <hr className="shell-usermenu__sep" data-testid="shell-usermenu-vault-sep" />
              {/* Non-interactive status (not a menu action): the MVP is local-only,
                  so this is honest "offline-first" copy, not a misleading "synced"
                  button. Cloud sync is a later server-phase feature. */}
              <div className="shell-usermenu__status" data-testid="shell-vault-status">
                <Icon name="shield" size={14} />
                <span className="shell-grow">Local vault · offline-first</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function Topbar({ onOpenCommand }: { onOpenCommand: () => void }) {
  return (
    <header className="shell-topbar">
      <button
        type="button"
        className="shell-cmdbar"
        data-testid="command-bar"
        onClick={onOpenCommand}
        aria-label="Open command palette"
      >
        <Icon name="search" size={15} />
        <span className="shell-cmdbar__ph">Search, import, or run command…</span>
        <Kbd keys={["⌘", "K"]} />
      </button>
    </header>
  );
}

/**
 * The local asset vault the desktop app persists into. Typed with the real
 * `@interleave/core` vocabulary so the renderer references the vault root by its
 * canonical name — and demonstrably never resolves a raw filesystem path itself
 * (path resolution belongs to the Electron main process; T007). Live DB/vault
 * status (open/migrated) is read through `appApi.db.getStatus()` in the
 * Settings System section on /settings; this constant only labels the status bar.
 */
const VAULT_ROOT: VaultRoot = "assets";
const VAULT_DB_PATH: LocalVaultPath = { root: VAULT_ROOT, relativePath: "app.sqlite" };

function StatusBar() {
  return (
    <footer className="shell-statusbar" data-testid="status-bar">
      <span className="shell-statusbar__hint">
        <Kbd keys={["⌘", "K"]} />
        Command
      </span>
      <span className="shell-statusbar__hint">
        <Kbd keys={["G"]} />
        then a key to navigate
      </span>
      <span className="shell-statusbar__hint">
        <Kbd keys={["?"]} />
        Shortcuts
      </span>
      <span className="shell-statusbar__spacer" />
      <span className="shell-statusbar__hint" data-vault-root={VAULT_DB_PATH.root}>
        Local vault · offline-first
      </span>
    </footer>
  );
}

/**
 * The shell's interactive body. Lives INSIDE `SelectionProvider` so the global
 * shortcuts + the `⌘K` palette can act on the current selection (T048 — open
 * source / open parent / raise·lower priority operate on the selected element via
 * `useGlobalActions`, calling the SAME typed commands as the inspector buttons).
 */
function ShellInner() {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { selectedId } = useSelection();
  const globalActions = useGlobalActions();
  const hideTopbar = pathname === "/queue";

  const [commandOpen, setCommandOpen] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());
  const [undoToast, setUndoToast] = useState<string | null>(null);
  const [backupToast, setBackupToast] = useState<string | null>(null);

  // ---- Onboarding + contextual-help state (design handoff) ----
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpSlug, setHelpSlug] = useState<string | null>(null);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const [tipsEnabled, setTipsState] = useState(true);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const tourSteps = useMemo(() => getTourSteps(), []);

  const onNavigate = (
    to: string,
    options?: { readonly params?: Readonly<Record<string, string>> },
  ) => {
    void navigate({ to, ...(options?.params ? { params: options.params } : {}) });
  };

  // ⌘← / ⌘→ walk the renderer's page-history stack via TanStack Router's history
  // (the SAME history every in-app navigation uses). back()/forward() are safe
  // no-ops at the ends of the stack, so no canGoBack()/canGoForward() guard needed.
  // History nav is universal: it fires ABOVE the per-screen scope gate in
  // useShellShortcuts (like ⌘Z/⌘B), so it works mid-reader/review/queue just as
  // clicking a nav link would. It must NOT, however, walk the route out from under
  // an open modal/overlay (cheat sheet, palette with focus off its input, help,
  // welcome) — those keep focus on non-input elements, so the hook's `typing` guard
  // wouldn't stop it. Gate on the overlay state here, where it lives.
  const overlayOpen = commandOpen || cheatOpen || helpOpen || welcomeOpen;
  const onNavigateBack = () => {
    if (overlayOpen) return;
    router.history.back();
  };
  const onNavigateForward = () => {
    if (overlayOpen) return;
    router.history.forward();
  };

  /**
   * Create a backup now (T050) — the single handler the ⌘B shortcut, the ⌘K
   * "Create a backup" command, and the native File → "Back up…" menu all route
   * through. It calls `appApi.createBackup()` directly — no second path, no
   * renderer-side reminder freshness state. The backup bundle is produced entirely
   * in the main process.
   */
  const onCreateBackup = () => {
    if (!isDesktop()) return;
    setBackupToast("Creating backup…");
    void runBackup()
      .then((res) => setBackupToast(`Backup created · ${res.fileCount} files`))
      .catch((e: unknown) =>
        setBackupToast(e instanceof Error ? `Backup failed: ${e.message}` : "Backup failed"),
      );
  };
  // Latest backup handler, so the native-menu subscription can mount once and still
  // call the current closure (matches the `handlers` ref pattern in useShellShortcuts).
  const createBackupRef = useRef(onCreateBackup);
  createBackupRef.current = onCreateBackup;

  /**
   * Run a registry-backed palette/shortcut ACTION (T048). This is the single map
   * from the closed `PaletteActionId` set to the shared handlers — both the `⌘K`
   * palette and (for `cheat-sheet`) the menus route through here, and the element
   * actions delegate to `useGlobalActions` (same `window.appApi` commands as the
   * inspector buttons). No domain logic here — pure dispatch.
   */
  const runAction = (actionId: PaletteActionId) => {
    switch (actionId) {
      case "open-source":
        globalActions.openSource();
        break;
      case "open-parent":
        globalActions.openParent();
        break;
      case "raise-priority":
        globalActions.raisePriority();
        break;
      case "lower-priority":
        globalActions.lowerPriority();
        break;
      case "search":
        globalActions.search();
        break;
      case "start-review":
        // The palette item already navigated to /review via its `to`; nothing more.
        break;
      case "create-backup":
        onCreateBackup();
        break;
      case "cheat-sheet":
        setCheatOpen(true);
        break;
    }
  };

  /**
   * General command-level undo (T044) — ⌘Z reverses the LAST `operation_log` op from
   * anywhere (delete / mark-done / suspend / bulk-postpone) through
   * `appApi.undo.last()`. The main process applies the inverse (itself logged); we
   * toast the result label and dispatch `UNDO_EVENT` so the active screen re-reads
   * its data. No domain logic lives here — the inverse is computed main-side.
   */
  const onUndo = () => {
    if (!isDesktop()) return;
    void appApi
      .undoLast()
      .then((res) => {
        if (res.undone) {
          setUndoToast(res.label || "Undid last change");
          window.dispatchEvent(new CustomEvent(UNDO_EVENT));
        } else {
          setUndoToast(res.reason ?? "Nothing to undo");
        }
      })
      .catch((e: unknown) => {
        setUndoToast(e instanceof Error ? e.message : "Undo failed");
      });
  };

  // The native Help → "Keyboard shortcuts" (⌘/) menu item opens the in-app cheat
  // sheet via the narrow `menu.onShowShortcuts` bridge event (T048). No-op outside
  // the desktop shell.
  useEffect(() => {
    if (!isDesktop()) return;
    return appApi.onMenuShowShortcuts(() => setCheatOpen(true));
  }, []);

  // The native File → "Back up…" (⌘B) menu item runs the SAME backup command as the
  // ⌘B shortcut and the ⌘K palette, via the narrow `menu.onCreateBackup` bridge.
  // The handler is re-read through a ref so the subscription mounts once.
  useEffect(() => {
    if (!isDesktop()) return;
    return appApi.onMenuCreateBackup(() => createBackupRef.current());
  }, []);

  // Browser capture can ask an already-open desktop window to show a captured
  // source. Navigate in-app so pending editor state is not lost to a hard reload.
  useEffect(() => {
    if (!isDesktop()) return;
    return appApi.onSourceOpenReader((sourceId) => {
      void navigate({ to: "/source/$id", params: { id: sourceId } });
    });
  }, [navigate]);

  // ---- Onboarding + contextual-help wiring (design handoff) ----

  // Load the persisted flags once: tips toggle, the once-only "seen" coachmark set,
  // and whether the first-run welcome still needs to show. All via the generic
  // key/value settings surface (SQLite-backed) — never localStorage.
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    void appApi
      .getSettings()
      .then(({ settings }) => {
        if (cancelled) return;
        if (settings[TIPS_ENABLED_KEY] === false) setTipsState(false);
        const arr = settings[COACH_SEEN_KEY];
        if (Array.isArray(arr)) setSeen(new Set(arr as string[]));
        if (settings[SEEN_ONBOARDING_KEY] !== true) setWelcomeOpen(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const persistOnboardingSeen = useCallback(() => {
    if (isDesktop())
      void appApi.updateSetting({ key: SEEN_ONBOARDING_KEY, value: true }).catch(() => {});
  }, []);

  const setTipsEnabled = useCallback((value: boolean) => {
    setTipsState(value);
    if (isDesktop()) void appApi.updateSetting({ key: TIPS_ENABLED_KEY, value }).catch(() => {});
  }, []);

  const markSeen = useCallback((id: string) => {
    setSeen((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      if (isDesktop())
        void appApi.updateSetting({ key: COACH_SEEN_KEY, value: [...next] }).catch(() => {});
      return next;
    });
  }, []);

  const resetTips = useCallback(() => {
    setSeen(new Set());
    if (isDesktop()) void appApi.updateSetting({ key: COACH_SEEN_KEY, value: [] }).catch(() => {});
  }, []);

  const openHelp = useCallback((slug?: string) => {
    setHelpSlug(slug ?? null);
    setHelpOpen(true);
  }, []);

  const finishTour = useCallback(() => {
    setTourIndex(null);
    persistOnboardingSeen();
    void navigate({ to: "/queue" });
  }, [navigate, persistOnboardingSeen]);

  const startTour = useCallback(() => {
    setWelcomeOpen(false);
    setHelpOpen(false);
    persistOnboardingSeen();
    setTourIndex(0);
  }, [persistOnboardingSeen]);

  const tourNext = useCallback(() => {
    const next = (tourIndex ?? 0) + 1;
    if (next >= tourSteps.length) finishTour();
    else setTourIndex(next);
  }, [tourIndex, tourSteps.length, finishTour]);

  const tourPrev = useCallback(() => setTourIndex((i) => Math.max(0, (i ?? 0) - 1)), []);

  // Drive the route as the tour advances so each coachmark anchors on its screen.
  useEffect(() => {
    if (tourIndex != null && tourSteps[tourIndex]) {
      void navigate({ to: tourSteps[tourIndex].route });
    }
  }, [tourIndex, tourSteps, navigate]);

  // Welcome-modal exits.
  const onWelcomeImport = useCallback(() => {
    setWelcomeOpen(false);
    persistOnboardingSeen();
    void navigate({ to: "/inbox" }).then(() =>
      window.dispatchEvent(new CustomEvent(NEW_SOURCE_EVENT)),
    );
  }, [navigate, persistOnboardingSeen]);

  const onWelcomeExplore = useCallback(() => {
    setWelcomeOpen(false);
    persistOnboardingSeen();
  }, [persistOnboardingSeen]);

  const onWelcomeDisableTips = useCallback(() => {
    setWelcomeOpen(false);
    persistOnboardingSeen();
    setTipsEnabled(false);
  }, [persistOnboardingSeen, setTipsEnabled]);

  // Set a specific theme (welcome picker) — applies + persists like onToggleTheme.
  const onPickTheme = useCallback((next: Theme) => {
    applyTheme(next);
    setTheme(next);
    if (isDesktop()) void appApi.updateAppSettings({ patch: { theme: next } }).catch(() => {});
  }, []);

  // ⌘K "Help" commands dispatch window events the palette can't handle itself.
  useEffect(() => {
    const onOpen = () => openHelp();
    const onTour = () => startTour();
    window.addEventListener(OPEN_HELP_EVENT, onOpen);
    window.addEventListener(START_TOUR_EVENT, onTour);
    return () => {
      window.removeEventListener(OPEN_HELP_EVENT, onOpen);
      window.removeEventListener(START_TOUR_EVENT, onTour);
    };
  }, [openHelp, startTour]);

  const helpValue = useMemo<HelpContextValue>(
    () => ({
      tipsEnabled,
      setTipsEnabled,
      isSeen: (id: string) => seen.has(id),
      markSeen,
      resetTips,
      openHelp,
      startTour,
    }),
    [tipsEnabled, setTipsEnabled, seen, markSeen, resetTips, openHelp, startTour],
  );

  useShellShortcuts({
    toggleCommandPalette: () => setCommandOpen((o) => !o),
    toggleCheatSheet: () => setCheatOpen((o) => !o),
    onNavigate,
    onUndo,
    onCreateBackup,
    onSearch: globalActions.search,
    onOpenSource: globalActions.openSource,
    onOpenParent: globalActions.openParent,
    onRaisePriority: globalActions.raisePriority,
    onLowerPriority: globalActions.lowerPriority,
    onNavigateBack,
    onNavigateForward,
  });

  return (
    <HelpProvider value={helpValue}>
      <div className="app-shell">
        <Sidebar
          pathname={pathname}
          theme={theme}
          onPickTheme={onPickTheme}
          onOpenCheat={() => setCheatOpen(true)}
          onOpenHelp={() => openHelp()}
        />

        <div className="shell-main">
          {hideTopbar ? null : <Topbar onOpenCommand={() => setCommandOpen(true)} />}
          <main className="shell-page">
            <Outlet />
          </main>
          <StatusBar />
        </div>

        <Inspector />

        {/* First-run welcome (design handoff) — shown once, then a `ui.seenOnboarding`
          flag persists in settings (survives restart). Replaces the minimal T050
          welcome with the method primer + myth-busters + theme + the guided tour. */}
        <WelcomeModal
          open={welcomeOpen}
          theme={theme}
          onPickTheme={onPickTheme}
          onStartTour={startTour}
          onImport={onWelcomeImport}
          onExplore={onWelcomeExplore}
          onDisableTips={onWelcomeDisableTips}
        />
        {/* The scripted guided tour: rail + anchored coachmarks over the real screens. */}
        <TourLayer index={tourIndex} onNext={tourNext} onPrev={tourPrev} onSkip={finishTour} />

        <CommandPalette
          open={commandOpen}
          onClose={() => setCommandOpen(false)}
          onNavigate={onNavigate}
          onAction={runAction}
          hasSelection={selectedId !== null}
        />
        <CheatSheet open={cheatOpen} onClose={() => setCheatOpen(false)} />
        {/* The in-app help center (deep-linked from every contextual hook + ⌘K). */}
        <HelpCenter
          open={helpOpen}
          openSlug={helpSlug}
          onClose={() => setHelpOpen(false)}
          onNavScreen={onNavigate}
        />
        {/* Global undo toast (T044) — confirms the ⌘Z command-level undo. */}
        <Snackbar
          message={undoToast}
          onClose={() => setUndoToast(null)}
          testId="shell-undo-snackbar"
        />
        {/* Backup toast (T050) — confirms the ⌘B / palette / menu backup command. */}
        <Snackbar
          message={backupToast}
          onClose={() => setBackupToast(null)}
          testId="shell-backup-snackbar"
        />
      </div>
    </HelpProvider>
  );
}

/**
 * Persistent app shell — provides the selection context, then renders the
 * interactive body (`ShellInner`) inside it so the global shortcuts + palette can
 * act on the selected element (T048).
 */
export function Shell() {
  return (
    <SelectionProvider>
      <ShellInner />
    </SelectionProvider>
  );
}
