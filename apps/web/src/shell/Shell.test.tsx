import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pathname: "/queue",
  navigate: vi.fn(),
  applyTheme: vi.fn(),
  updateAppSettings: vi.fn(),
  useShellShortcuts: vi.fn(),
  globalActions: {
    openSource: vi.fn(),
    openParent: vi.fn(),
    raisePriority: vi.fn(),
    lowerPriority: vi.fn(),
    search: vi.fn(),
  },
  backupResult: {
    path: "/vault/backups/2026-06-06T12-00-00.000Z.zip",
    timestamp: "2026-06-06T12-00-00.000Z",
    sizeBytes: 1024,
    fileCount: 4,
    schemaVersion: "0002_search_fts5",
  },
  createBackup: vi.fn(),
  updateSetting: vi.fn(),
  menu: {
    createBackupCallback: undefined as (() => void) | undefined,
  },
  sourceOpenCallback: undefined as ((sourceId: string) => void) | undefined,
  onMenuCreateBackup: vi.fn((callback: () => void) => {
    h.menu.createBackupCallback = callback;
    return vi.fn();
  }),
  onSourceOpenReader: vi.fn((callback: (sourceId: string) => void) => {
    h.sourceOpenCallback = callback;
    return vi.fn();
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Outlet: () => <div data-testid="route-outlet" />,
  useLinkProps: ({ to }: { to: string }) => ({ href: to }),
  useNavigate: () => h.navigate,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: h.pathname } }),
}));

vi.mock("../components/Icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

vi.mock("../components/Snackbar", () => ({
  Snackbar: ({ message, testId }: { message: string | null; testId: string }) => (
    <div data-testid={testId}>{message}</div>
  ),
}));

vi.mock("../components/inspector/Inspector", () => ({
  Inspector: () => <aside data-testid="mock-inspector" />,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      onMenuShowShortcuts: vi.fn(() => vi.fn()),
      onMenuCreateBackup: h.onMenuCreateBackup,
      onSourceOpenReader: h.onSourceOpenReader,
      updateAppSettings: h.updateAppSettings,
      // The onboarding-flag load: report the welcome as already seen so the
      // first-run modal stays closed in these chrome tests.
      getSettings: vi.fn(() => Promise.resolve({ settings: { "ui.seenOnboarding": true } })),
      updateSetting: h.updateSetting,
      createBackup: h.createBackup,
      undoLast: vi.fn(),
    },
  };
});

vi.mock("../theme", () => ({
  getStoredTheme: () => "light",
  applyTheme: (theme: string) => h.applyTheme(theme),
}));

vi.mock("./CheatSheet", () => ({
  CheatSheet: ({ open }: { open: boolean }) => (
    <div data-testid="cheat-sheet" data-open={String(open)} />
  ),
}));

vi.mock("./CommandPalette", () => ({
  CommandPalette: ({
    open,
    hasSelection,
    onAction,
    onNavigate,
  }: {
    open: boolean;
    hasSelection: boolean;
    onAction: (id: "cheat-sheet" | "create-backup") => void;
    onNavigate: (
      to: string,
      options?: { readonly params?: Readonly<Record<string, string>> },
    ) => void;
  }) => (
    <div
      data-testid="command-palette"
      data-open={String(open)}
      data-has-selection={String(hasSelection)}
    >
      <button type="button" data-testid="command-cheat" onClick={() => onAction("cheat-sheet")}>
        Cheat
      </button>
      <button type="button" data-testid="command-backup" onClick={() => onAction("create-backup")}>
        Backup
      </button>
      <button
        type="button"
        data-testid="command-source"
        onClick={() => onNavigate("/source/$id", { params: { id: "src-alpha" } })}
      >
        Source
      </button>
    </div>
  ),
}));

vi.mock("./useGlobalActions", () => ({
  useGlobalActions: () => h.globalActions,
}));

vi.mock("./useNavBadges", () => ({
  useNavBadges: () => ({ queue: 3, inbox: 2, review: 1 }),
}));

vi.mock("./useShellIdentity", () => ({
  useShellIdentity: () => ({
    identity: { initials: "AV", name: "Antoine Vault", sub: "Local vault" },
    streak: { dayStreak: 5, retentionPct: 91 },
  }),
}));

vi.mock("./useShellShortcuts", () => ({
  useShellShortcuts: (handlers: unknown) => h.useShellShortcuts(handlers),
}));

import { OPEN_HELP_EVENT } from "./nav";
import { Shell } from "./Shell";

beforeEach(() => {
  h.pathname = "/queue";
  h.navigate.mockReset();
  h.applyTheme.mockClear();
  h.updateAppSettings.mockReset();
  h.updateAppSettings.mockResolvedValue({});
  h.createBackup.mockReset();
  h.createBackup.mockResolvedValue(h.backupResult);
  h.updateSetting.mockReset();
  h.updateSetting.mockResolvedValue({});
  h.menu.createBackupCallback = undefined;
  h.sourceOpenCallback = undefined;
  h.onMenuCreateBackup.mockClear();
  h.onSourceOpenReader.mockClear();
  h.useShellShortcuts.mockReset();
  Object.values(h.globalActions).forEach((fn) => {
    fn.mockReset();
  });
});

describe("Shell", () => {
  it("renders the persistent chrome around the active route and inspector", () => {
    render(<Shell />);

    expect(screen.getByTestId("route-outlet")).toBeInTheDocument();
    expect(screen.getByTestId("mock-inspector")).toBeInTheDocument();
    expect(screen.getByTestId("shell-brand-logo")).toHaveAttribute("src", "/logo.png");
    expect(screen.getByTestId("nav-queue")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-queue-badge")).toHaveTextContent("3");
    expect(screen.getByTestId("shell-streak")).toHaveTextContent("5-day streak");
    expect(screen.getByTestId("status-bar").querySelector("[data-vault-root='assets']")).not.toBe(
      null,
    );
    expect(screen.queryByTestId("backup-prompt")).not.toBeInTheDocument();
    expect(screen.queryByTestId("backup-reminder")).not.toBeInTheDocument();
  });

  it("hides the command/search topbar on the Queue route", () => {
    render(<Shell />);

    expect(screen.getByTestId("route-outlet")).toBeInTheDocument();
    expect(screen.queryByTestId("command-bar")).not.toBeInTheDocument();
  });

  it("keeps shell shortcuts live when the Queue topbar is hidden", () => {
    render(<Shell />);

    const handlers = h.useShellShortcuts.mock.calls[0]?.[0] as
      | {
          onSearch: () => void;
          toggleCommandPalette: () => void;
        }
      | undefined;
    expect(handlers).toBeTruthy();

    act(() => {
      handlers?.onSearch();
    });
    expect(h.globalActions.search).toHaveBeenCalledTimes(1);

    expect(screen.getByTestId("command-palette")).toHaveAttribute("data-open", "false");
    act(() => {
      handlers?.toggleCommandPalette();
    });
    expect(screen.getByTestId("command-palette")).toHaveAttribute("data-open", "true");
  });

  it("renders the command/search topbar on non-Queue routes", () => {
    h.pathname = "/inbox";

    render(<Shell />);

    expect(screen.getByTestId("command-bar")).toBeInTheDocument();
  });

  it("opens the command palette and routes palette actions to the cheat sheet", () => {
    h.pathname = "/inbox";

    render(<Shell />);

    expect(screen.getByTestId("command-palette")).toHaveAttribute("data-open", "false");
    fireEvent.click(screen.getByTestId("command-bar"));
    expect(screen.getByTestId("command-palette")).toHaveAttribute("data-open", "true");

    fireEvent.click(screen.getByTestId("command-cheat"));
    expect(screen.getByTestId("cheat-sheet")).toHaveAttribute("data-open", "true");
  });

  it("forwards command-palette source route params into TanStack navigation", () => {
    render(<Shell />);

    fireEvent.click(screen.getByTestId("command-source"));

    expect(h.navigate).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "src-alpha" },
    });
  });

  it("persists theme changes through the desktop settings bridge", () => {
    render(<Shell />);

    fireEvent.click(screen.getByTestId("user-chip"));
    fireEvent.click(screen.getByTestId("shell-theme-option-system"));

    expect(h.applyTheme).toHaveBeenCalledWith("system");
    expect(h.updateAppSettings).toHaveBeenCalledWith({ patch: { theme: "system" } });
    expect(screen.getByTestId("shell-theme-option-system")).toHaveAttribute("aria-checked", "true");
  });

  it("renders the compact sidebar theme switch with the current preference checked", () => {
    render(<Shell />);

    fireEvent.click(screen.getByTestId("user-chip"));

    expect(screen.getByTestId("shell-theme-segmented")).toHaveTextContent("SystemLightDark");
    expect(screen.getByTestId("shell-theme-option-system")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByTestId("shell-theme-option-light")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("shell-theme-option-dark")).toHaveAttribute("aria-checked", "false");
  });

  it("keeps theme actions compact above help actions and vault status in the user menu", () => {
    render(<Shell />);

    fireEvent.click(screen.getByTestId("user-chip"));

    const themeSwitch = screen.getByTestId("shell-theme-segmented");
    expect(themeSwitch.nextElementSibling).toHaveTextContent("Settings");
    expect(screen.queryByTestId("shell-usermenu-theme-sep")).not.toBeInTheDocument();
    const vaultSep = screen.getByTestId("shell-usermenu-vault-sep");
    expect(vaultSep.previousElementSibling).toHaveTextContent("Help & docs");
    expect(vaultSep.nextElementSibling).toHaveTextContent("Local vault · offline-first");
    expect(screen.getByTestId("shell-vault-status").nextElementSibling).toBeNull();
    expect(document.querySelectorAll(".shell-usermenu__sep")).toHaveLength(1);
  });

  it("routes the command palette backup action through the manual backup command", async () => {
    render(<Shell />);

    fireEvent.click(screen.getByTestId("command-backup"));

    expect(screen.getByTestId("shell-backup-snackbar")).toHaveTextContent("Creating backup…");
    await waitFor(() => expect(h.createBackup).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("shell-backup-snackbar")).toHaveTextContent(
        "Backup created · 4 files",
      ),
    );
    expect(h.updateSetting).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "ui.lastBackupAt" }),
    );
  });

  it("routes shortcut and native-menu backup actions through the same manual command", async () => {
    render(<Shell />);

    const handlers = h.useShellShortcuts.mock.calls[0]?.[0] as
      | { onCreateBackup: () => void }
      | undefined;
    expect(handlers).toBeTruthy();

    await act(async () => {
      handlers?.onCreateBackup();
    });

    await waitFor(() => expect(h.createBackup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.onMenuCreateBackup).toHaveBeenCalledTimes(1));

    await act(async () => {
      h.menu.createBackupCallback?.();
    });

    await waitFor(() => expect(h.createBackup).toHaveBeenCalledTimes(2));
  });

  it("opens and closes the in-app help center from shell help events", async () => {
    render(<Shell />);

    expect(screen.queryByTestId("help-center")).not.toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT));
    });
    expect(await screen.findByTestId("help-center")).toBeInTheDocument();
    expect(screen.getByText("How can we help?")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Close help center"));
    await waitFor(() => expect(screen.queryByTestId("help-center")).not.toBeInTheDocument());
  });

  it("opens help from the user menu and navigates from an article action", async () => {
    render(<Shell />);

    fireEvent.click(screen.getByTestId("user-chip"));
    fireEvent.click(screen.getByTestId("usermenu-help"));
    expect(await screen.findByText("How can we help?")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search the help center"), {
      target: { value: "home" },
    });
    fireEvent.click(await screen.findByText(/The Home command center/i));
    fireEvent.click(await screen.findByRole("button", { name: "Open the relevant screen" }));

    expect(h.navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("routes main-process source-open events through in-app navigation", async () => {
    render(<Shell />);

    await waitFor(() => expect(h.onSourceOpenReader).toHaveBeenCalledTimes(1));

    act(() => {
      h.sourceOpenCallback?.("captured-source-1");
    });

    expect(h.navigate).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "captured-source-1" },
    });
  });
});
