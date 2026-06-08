/**
 * BalanceBanner component tests (T046).
 *
 * The balance math lives MAIN-side (`packages/local-db` `AnalyticsService.computeBalance`
 * + `@interleave/core` `judgeBalance`); this asserts the RENDERER seam only:
 *  - the banner shows ONLY when the mocked `balance.get` payload is `imbalanced`,
 *    and surfaces the four weekly numbers;
 *  - it is HIDDEN when the snapshot is `ok`;
 *  - it respects the `balanceWarnings = false` toggle (hidden even when imbalanced);
 *  - the danger variant carries `data-severity="danger"`.
 *
 * `appApi` + the router's `useNavigate` are mocked so the test exercises only this
 * component's wiring.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, BalanceGetResult } from "../lib/appApi";

const h = vi.hoisted(() => {
  const imbalanced: BalanceGetResult = {
    asOf: "2026-05-30T18:00:00.000Z",
    windowDays: 7,
    sourcesImported: 9,
    extractsCreated: 2,
    cardsCreated: 1,
    reviewsDueThisWeek: 14,
    inboxSources: 3,
    dueQueueItems: 4,
    imbalanced: true,
    severity: "warn",
  };
  const settings = { balanceWarnings: true } as unknown as AppSettings;
  return {
    imbalanced,
    settings,
    getBalance: vi.fn(),
    getAppSettings: vi.fn(),
    getSettings: vi.fn(),
    updateSetting: vi.fn(),
    updateAppSettings: vi.fn(),
    navigateSpy: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      getBalance: h.getBalance,
      getAppSettings: h.getAppSettings,
      getSettings: h.getSettings,
      updateSetting: h.updateSetting,
      updateAppSettings: h.updateAppSettings,
    },
  };
});

import { BalanceBanner } from "./BalanceBanner";

beforeEach(() => {
  vi.clearAllMocks();
  h.getBalance.mockResolvedValue(h.imbalanced);
  h.getAppSettings.mockResolvedValue({ settings: h.settings });
  h.getSettings.mockResolvedValue({ settings: {} });
  h.updateSetting.mockResolvedValue({ key: "ui.noticeDismissals", value: {} });
  h.updateAppSettings.mockResolvedValue({ settings: h.settings });
});

describe("BalanceBanner (T046)", () => {
  it("shows the banner with the four weekly numbers when imbalanced", async () => {
    render(<BalanceBanner />);
    const banner = await screen.findByTestId("balance-banner");
    expect(banner.getAttribute("data-severity")).toBe("warn");
    expect(screen.getByTestId("balance-sources").textContent).toBe("9");
    expect(screen.getByTestId("balance-extracts").textContent).toBe("2");
    expect(screen.getByTestId("balance-cards").textContent).toBe("1");
    expect(screen.getByTestId("balance-reviews").textContent).toBe("14");
  });

  it("renders the danger variant for a severe imbalance", async () => {
    h.getBalance.mockResolvedValue({ ...h.imbalanced, severity: "danger" });
    render(<BalanceBanner />);
    const banner = await screen.findByTestId("balance-banner");
    expect(banner.getAttribute("data-severity")).toBe("danger");
  });

  it("hides the queue action when the due queue is empty", async () => {
    h.getBalance.mockResolvedValue({
      ...h.imbalanced,
      reviewsDueThisWeek: 5,
      inboxSources: 3,
      dueQueueItems: 0,
    });
    render(<BalanceBanner />);
    await screen.findByTestId("balance-banner");
    expect(screen.queryByTestId("balance-open-queue")).toBeNull();
    expect(screen.getByTestId("balance-triage-inbox")).toBeInTheDocument();
  });

  it("shows the queue action without inbox triage when only the due queue has work", async () => {
    h.getBalance.mockResolvedValue({
      ...h.imbalanced,
      inboxSources: 0,
      dueQueueItems: 2,
    });
    render(<BalanceBanner />);
    await screen.findByTestId("balance-banner");
    expect(screen.getByTestId("balance-open-queue")).toBeInTheDocument();
    expect(screen.queryByTestId("balance-triage-inbox")).toBeNull();
  });

  it("is hidden when the snapshot is imbalanced but there is no actionable work", async () => {
    h.getBalance.mockResolvedValue({
      ...h.imbalanced,
      inboxSources: 0,
      dueQueueItems: 0,
    });
    const { container } = render(<BalanceBanner />);
    await waitFor(() => expect(h.getBalance).toHaveBeenCalled());
    expect(screen.queryByTestId("balance-banner")).toBeNull();
    expect(container.querySelector("[data-testid='balance-banner']")).toBeNull();
  });

  it("is hidden when the week is balanced (severity ok)", async () => {
    h.getBalance.mockResolvedValue({ ...h.imbalanced, imbalanced: false, severity: "ok" });
    const { container } = render(<BalanceBanner />);
    // Let the async load settle, then assert nothing rendered.
    await waitFor(() => expect(h.getBalance).toHaveBeenCalled());
    expect(screen.queryByTestId("balance-banner")).toBeNull();
    expect(container.querySelector("[data-testid='balance-banner']")).toBeNull();
  });

  it("respects the balanceWarnings off toggle (hidden even when imbalanced)", async () => {
    h.getAppSettings.mockResolvedValue({
      settings: { balanceWarnings: false } as unknown as AppSettings,
    });
    render(<BalanceBanner />);
    await waitFor(() => expect(h.getAppSettings).toHaveBeenCalled());
    expect(screen.queryByTestId("balance-banner")).toBeNull();
  });

  it("navigates to inbox when no same-route triage callback is supplied", async () => {
    render(<BalanceBanner />);

    fireEvent.click(await screen.findByTestId("balance-triage-inbox"));

    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/inbox" });
  });

  it("uses the same-route triage callback instead of navigating when supplied", async () => {
    const onTriageInbox = vi.fn();
    render(<BalanceBanner onTriageInbox={onTriageInbox} />);

    fireEvent.click(await screen.findByTestId("balance-triage-inbox"));

    expect(onTriageInbox).toHaveBeenCalledTimes(1);
    expect(h.navigateSpy).not.toHaveBeenCalledWith({ to: "/inbox" });
  });

  it("is hidden while the one-week notice dismissal is still active", async () => {
    h.getSettings.mockResolvedValue({
      settings: {
        "ui.noticeDismissals": {
          "balance.importProcess": {
            until: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      },
    });
    const { container } = render(<BalanceBanner />);

    await waitFor(() => expect(h.getSettings).toHaveBeenCalledWith({ key: "ui.noticeDismissals" }));

    expect(screen.queryByTestId("balance-banner")).toBeNull();
    expect(container.querySelector("[data-testid='balance-banner']")).toBeNull();
  });

  it("shows again after a one-week notice dismissal expires", async () => {
    h.getSettings.mockResolvedValue({
      settings: {
        "ui.noticeDismissals": {
          "balance.importProcess": {
            until: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      },
    });
    render(<BalanceBanner />);

    expect(await screen.findByTestId("balance-banner")).toBeVisible();
  });

  it("hides for a week through the generic settings surface", async () => {
    render(<BalanceBanner />);

    fireEvent.click(await screen.findByTestId("balance-dismiss-menu-trigger"));
    fireEvent.click(screen.getByTestId("balance-hide-week"));

    await waitFor(() =>
      expect(h.updateSetting).toHaveBeenCalledWith({
        key: "ui.noticeDismissals",
        value: expect.objectContaining({
          "balance.importProcess": expect.objectContaining({
            until: expect.any(String),
          }),
        }),
      }),
    );
    const call = h.updateSetting.mock.calls.at(-1)?.[0] as {
      value: { "balance.importProcess": { until: string } };
    };
    expect(Date.parse(call.value["balance.importProcess"].until)).toBeGreaterThan(
      Date.now() + 6 * 24 * 60 * 60 * 1000,
    );
    expect(screen.queryByTestId("balance-banner")).toBeNull();
  });

  it("turns the warning off through typed app settings", async () => {
    render(<BalanceBanner />);

    fireEvent.click(await screen.findByTestId("balance-dismiss-menu-trigger"));
    fireEvent.click(screen.getByTestId("balance-turn-off"));

    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({
        patch: { balanceWarnings: false },
      }),
    );
    expect(screen.queryByTestId("balance-banner")).toBeNull();
  });
});
