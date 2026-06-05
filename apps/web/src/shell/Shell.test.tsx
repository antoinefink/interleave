import { fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("../components/BackupPrompt", () => ({
  BackupPrompt: () => <div data-testid="backup-prompt" />,
  runBackup: vi.fn(),
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
      onMenuCreateBackup: vi.fn(() => vi.fn()),
      updateAppSettings: h.updateAppSettings,
      // The onboarding-flag load: report the welcome as already seen so the
      // first-run modal stays closed in these chrome tests.
      getSettings: vi.fn(() => Promise.resolve({ settings: { "ui.seenOnboarding": true } })),
      updateSetting: vi.fn(() => Promise.resolve({})),
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
    onAction: (id: "cheat-sheet") => void;
  }) => (
    <div
      data-testid="command-palette"
      data-open={String(open)}
      data-has-selection={String(hasSelection)}
    >
      <button type="button" data-testid="command-cheat" onClick={() => onAction("cheat-sheet")}>
        Cheat
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
    fireEvent.click(screen.getByText("System theme"));

    expect(h.applyTheme).toHaveBeenCalledWith("system");
    expect(h.updateAppSettings).toHaveBeenCalledWith({ patch: { theme: "system" } });
  });

  it("renders all sidebar theme choices with the current preference checked", () => {
    render(<Shell />);

    fireEvent.click(screen.getByTestId("user-chip"));

    expect(screen.getByRole("menuitemradio", { name: /System theme/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("menuitemradio", { name: /Light mode/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: /Dark mode/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});
