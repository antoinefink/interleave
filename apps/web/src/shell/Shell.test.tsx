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
  onMenuCreateBackup: vi.fn((callback: () => void) => {
    h.menu.createBackupCallback = callback;
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
  }: {
    open: boolean;
    hasSelection: boolean;
    onAction: (id: "cheat-sheet" | "create-backup") => void;
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
  h.onMenuCreateBackup.mockClear();
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

  it("opens the command palette and routes palette actions to the cheat sheet", () => {
    render(<Shell />);

    expect(screen.getByTestId("command-palette")).toHaveAttribute("data-open", "false");
    fireEvent.click(screen.getByTestId("command-bar"));
    expect(screen.getByTestId("command-palette")).toHaveAttribute("data-open", "true");

    fireEvent.click(screen.getByTestId("command-cheat"));
    expect(screen.getByTestId("cheat-sheet")).toHaveAttribute("data-open", "true");
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
});
