import type { SourceBlockProcessingState } from "@interleave/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceBlockProcessingSummaryPayload } from "../../lib/appApi";
import { DoneIntentMenu } from "./DoneIntentMenu";

afterEach(cleanup);

type SummaryOverrides = Partial<Omit<SourceBlockProcessingSummaryPayload, "stateCounts">> & {
  stateCounts?: Partial<Record<SourceBlockProcessingState, number>>;
};

function summary(overrides: SummaryOverrides = {}): SourceBlockProcessingSummaryPayload {
  const stateCounts = {
    unread: 0,
    read: 0,
    extracted: 0,
    ignored: 0,
    processed_without_output: 0,
    needs_later: 0,
    stale_after_edit: 0,
  };
  return {
    sourceElementId: "src-1",
    totalBlocks: 0,
    processedBlocks: 0,
    terminalBlocks: 0,
    unresolvedBlocks: 0,
    highPriorityUnresolvedBlocks: 0,
    extractedBlockCount: 0,
    extractedOutputCount: 0,
    ignoredBlocks: 0,
    ignoredRatio: 0,
    terminalRatio: 1,
    staleAfterEditBlocks: 0,
    needsReverifyOutputs: 0,
    legacyProjectedBlocks: 0,
    canMarkDoneWithoutConfirmation: true,
    ...overrides,
    stateCounts: { ...stateCounts, ...(overrides.stateCounts ?? {}) },
  };
}

const UNRESOLVED = summary({
  canMarkDoneWithoutConfirmation: false,
  unresolvedBlocks: 64,
  totalBlocks: 68,
  stateCounts: { unread: 60, needs_later: 3, stale_after_edit: 1 },
});

describe("DoneIntentMenu", () => {
  it("fast path: 0 unresolved marks done immediately with no popover", async () => {
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(summary({ canMarkDoneWithoutConfirmation: true }));
    render(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId("done-intent-trigger"));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith("finished"));
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("done-intent-pop")).toBeNull();
  });

  it("forced open: 0 unresolved opens the popover without resolving", async () => {
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(summary({ canMarkDoneWithoutConfirmation: true }));
    const { rerender } = render(
      <DoneIntentMenu getSummary={getSummary} onResolved={onResolved} forceOpenSignal={0} />,
    );

    rerender(
      <DoneIntentMenu getSummary={getSummary} onResolved={onResolved} forceOpenSignal={1} />,
    );

    expect(await screen.findByTestId("done-intent-pop")).not.toBeNull();
    expect(onResolved).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("done-intent-later")),
    );
  });

  it("labels suggested Abandon without making it the initial focus", async () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    const { rerender } = render(
      <DoneIntentMenu
        getSummary={getSummary}
        onResolved={vi.fn()}
        forceOpenSignal={0}
        suggestedIntent="abandon"
      />,
    );

    rerender(
      <DoneIntentMenu
        getSummary={getSummary}
        onResolved={vi.fn()}
        forceOpenSignal={1}
        suggestedIntent="abandon"
      />,
    );

    await screen.findByTestId("done-intent-pop");
    const abandon = screen.getByRole("button", { name: /Abandon\s+Suggested/i });
    expect(abandon).toBe(screen.getByTestId("done-intent-abandon"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("done-intent-later")),
    );
    expect(document.activeElement).not.toBe(abandon);
  });

  it("opens a non-modal popover with focus on Return later, the breakdown, and the resume line", async () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(
      <DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} resumeLabel="block 12 of 68" />,
    );

    fireEvent.click(screen.getByTestId("done-intent-trigger"));

    const pop = await screen.findByTestId("done-intent-pop");
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.getAttribute("aria-modal")).toBe("false");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("done-intent-later")),
    );
    const breakdown = screen.getByTestId("done-intent-breakdown").textContent ?? "";
    expect(breakdown).toContain("60");
    expect(breakdown).toContain("unread");
    expect(breakdown).toContain("deferred");
    expect(breakdown).toContain("stale after edit");
    expect(screen.getByTestId("done-intent-resume").textContent).toBe("block 12 of 68");
  });

  it("shows the re-verify outputs line (plural) when derived outputs need re-verify", async () => {
    const getSummary = vi.fn().mockResolvedValue(
      summary({
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 4,
        stateCounts: { unread: 4 },
        needsReverifyOutputs: 3,
      }),
    );
    render(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} />);
    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    const reverify = screen.getByTestId("done-intent-reverify").textContent ?? "";
    expect(reverify).toContain("3");
    expect(reverify).toContain("outputs need re-verify");
  });

  it("uses the singular re-verify phrasing for exactly one output", async () => {
    const getSummary = vi.fn().mockResolvedValue(
      summary({
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 1,
        stateCounts: { unread: 1 },
        needsReverifyOutputs: 1,
      }),
    );
    render(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} />);
    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    expect(screen.getByTestId("done-intent-reverify").textContent).toContain(
      "1 output needs re-verify",
    );
  });

  it("omits the re-verify line when no outputs need re-verify", async () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} />);
    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    expect(screen.queryByTestId("done-intent-reverify")).toBeNull();
  });

  it("omits the resume line when none is provided", async () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} />);
    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    expect(screen.queryByTestId("done-intent-resume")).toBeNull();
  });

  it.each([
    ["done-intent-later", "later"],
    ["done-intent-finished", "finished"],
    ["done-intent-abandon", "abandon"],
  ] as const)("routes %s to onResolved(%s) exactly once", async (testId, intent) => {
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    fireEvent.click(screen.getByTestId(testId));

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith(intent);
  });

  it("Escape closes the surface without resolving", async () => {
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("done-intent-pop")).toBeNull());
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("drops a double-submit (resolves once)", async () => {
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    const finished = screen.getByTestId("done-intent-finished");
    fireEvent.click(finished);
    fireEvent.click(finished);

    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("disables the trigger when host is busy and does not fetch", () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} busy />);
    const trigger = screen.getByTestId("done-intent-trigger") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(getSummary).not.toHaveBeenCalled();
  });

  it("runs the trigger logic when triggerSignal changes (keyboard shortcut)", async () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    const { rerender } = render(
      <DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} triggerSignal={0} />,
    );
    expect(getSummary).not.toHaveBeenCalled();
    rerender(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} triggerSignal={1} />);
    await screen.findByTestId("done-intent-pop");
    expect(getSummary).toHaveBeenCalledTimes(1);
  });

  it("guards repeated forced-open activation while the summary read is in flight", async () => {
    let resolveSummary: (value: SourceBlockProcessingSummaryPayload) => void = () => {};
    const getSummary = vi.fn(
      () =>
        new Promise<SourceBlockProcessingSummaryPayload>((resolve) => {
          resolveSummary = resolve;
        }),
    );
    const { rerender } = render(
      <DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} forceOpenSignal={0} />,
    );

    rerender(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} forceOpenSignal={1} />);
    rerender(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} forceOpenSignal={1} />);

    expect(getSummary).toHaveBeenCalledTimes(1);
    resolveSummary(UNRESOLVED);
    await screen.findByTestId("done-intent-pop");
  });

  it("ignores a stale forced-open summary read after the host becomes busy", async () => {
    let resolveSummary: (value: SourceBlockProcessingSummaryPayload) => void = () => {};
    const getSummary = vi.fn(
      () =>
        new Promise<SourceBlockProcessingSummaryPayload>((resolve) => {
          resolveSummary = resolve;
        }),
    );
    const onResolved = vi.fn();
    const { rerender } = render(
      <DoneIntentMenu
        getSummary={getSummary}
        onResolved={onResolved}
        forceOpenSignal={0}
        suggestedIntent="abandon"
      />,
    );

    rerender(
      <DoneIntentMenu
        getSummary={getSummary}
        onResolved={onResolved}
        forceOpenSignal={1}
        suggestedIntent="abandon"
      />,
    );
    await waitFor(() => expect(getSummary).toHaveBeenCalledTimes(1));

    rerender(
      <DoneIntentMenu
        getSummary={getSummary}
        onResolved={onResolved}
        forceOpenSignal={1}
        suggestedIntent="abandon"
        busy
      />,
    );
    await act(async () => resolveSummary(UNRESOLVED));

    expect(screen.queryByTestId("done-intent-pop")).toBeNull();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("releases the in-flight guard after the host settles so a fast-path retry works", async () => {
    // Regression: the fast path never opens the popover, so the guard must clear on
    // `busy` settling (not on an open→close transition) or the Done control deadlocks
    // when the host mutation fails and the component stays mounted on the same item.
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(summary({ canMarkDoneWithoutConfirmation: true }));
    const { rerender } = render(
      <DoneIntentMenu getSummary={getSummary} onResolved={onResolved} busy={false} />,
    );
    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    // Host runs the mutation: busy true, then back to false on a failure (no unmount).
    rerender(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} busy={true} />);
    rerender(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} busy={false} />);
    // The Done control must still respond.
    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(2));
  });

  it("toggles the popover closed on a re-press without re-fetching", async () => {
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} />);
    const trigger = screen.getByTestId("done-intent-trigger");
    fireEvent.click(trigger);
    await screen.findByTestId("done-intent-pop");
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByTestId("done-intent-pop")).toBeNull());
    expect(getSummary).toHaveBeenCalledTimes(1);
  });

  it("closes on an outside click without resolving", async () => {
    const onResolved = vi.fn();
    const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
    render(<DoneIntentMenu getSummary={getSummary} onResolved={onResolved} />);
    fireEvent.click(screen.getByTestId("done-intent-trigger"));
    await screen.findByTestId("done-intent-pop");
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("done-intent-pop")).toBeNull());
    expect(onResolved).not.toHaveBeenCalled();
  });

  // Regression: same `mountedRef` defect as LineageDeleteMenu. Under React StrictMode
  // (active in apps/web/src/main.tsx) a `useRef(true)` cleared only on cleanup stays
  // `false` after the dev mount→unmount→remount cycle, so `handleTrigger` bailed at
  // `if (!mountedRef.current) return` after awaiting `getSummary` and the fast path never
  // resolved. RTL's plain `render` does not apply StrictMode, hence the gap.
  describe("under StrictMode (regression: mountedRef must reset on remount)", () => {
    it("fast path still marks done after the StrictMode remount cycle", async () => {
      const onResolved = vi.fn();
      const getSummary = vi
        .fn()
        .mockResolvedValue(summary({ canMarkDoneWithoutConfirmation: true }));
      render(
        <StrictMode>
          <DoneIntentMenu getSummary={getSummary} onResolved={onResolved} />
        </StrictMode>,
      );

      fireEvent.click(screen.getByTestId("done-intent-trigger"));

      await waitFor(() => expect(onResolved).toHaveBeenCalledWith("finished"));
    });

    it("forceOpenSignal still opens the popover after the StrictMode remount cycle", async () => {
      // handleForceOpen carries its own post-await mountedRef guard (the proactive-review
      // nudge path), equally dead pre-fix. Bumping the signal after mount is stable.
      const getSummary = vi.fn().mockResolvedValue(UNRESOLVED);
      const { rerender } = render(
        <StrictMode>
          <DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} forceOpenSignal={0} />
        </StrictMode>,
      );

      rerender(
        <StrictMode>
          <DoneIntentMenu getSummary={getSummary} onResolved={vi.fn()} forceOpenSignal={1} />
        </StrictMode>,
      );

      expect(await screen.findByTestId("done-intent-pop")).not.toBeNull();
    });
  });
});
