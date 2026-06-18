import { BLOCK_ID_DOM_ATTR, type Editor } from "@interleave/editor";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessedSpanButtons } from "./ProcessedSpanButtons";
import type { UseProcessedSpansResult } from "./useProcessedSpans";

function setRect(el: HTMLElement, top: number): void {
  el.getBoundingClientRect = vi.fn(() => ({
    top,
    left: 0,
    right: 100,
    bottom: top + 20,
    width: 100,
    height: 20,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }));
}

function buildEditorDom(): { page: HTMLElement; rail: HTMLElement; editor: Editor } {
  const rail = document.createElement("div");
  rail.className = "reader-rail";
  setRect(rail, 100);

  const editorDom = document.createElement("div");
  const paragraphA = document.createElement("p");
  paragraphA.setAttribute(BLOCK_ID_DOM_ATTR, "blk-a");
  setRect(paragraphA, 140);
  const heading = document.createElement("h2");
  heading.setAttribute(BLOCK_ID_DOM_ATTR, "blk-heading");
  setRect(heading, 160);
  const paragraphB = document.createElement("p");
  paragraphB.setAttribute(BLOCK_ID_DOM_ATTR, "blk-b");
  setRect(paragraphB, 190);

  editorDom.append(paragraphA, heading, paragraphB);
  rail.append(editorDom);
  const page = document.createElement("div");
  page.className = "reader-page";
  page.append(rail);
  document.body.append(page);

  const editor = {
    view: { dom: editorDom },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Editor;
  return { page, rail, editor };
}

function processed(
  processedIds: readonly string[] = [],
  states: Partial<Record<string, ReturnType<UseProcessedSpansResult["stateFor"]>>> = {},
): UseProcessedSpansResult {
  return {
    processed: processedIds.map((blockId) => ({ blockId, markId: `mark-${blockId}` })),
    blocks: [],
    summary: null,
    isProcessed: (blockId: string) => processedIds.includes(blockId),
    markIdFor: (blockId: string) => (processedIds.includes(blockId) ? `mark-${blockId}` : null),
    stateFor: (blockId: string) =>
      states[blockId] ?? (processedIds.includes(blockId) ? "processed_without_output" : "unread"),
    mark: vi.fn(async () => true),
    restore: vi.fn(async () => true),
    toggle: vi.fn(async (blockId: string) =>
      processedIds.includes(blockId) ? "restored" : "marked",
    ),
    markIgnored: vi.fn(async () => true),
    markNeedsLater: vi.fn(async () => true),
    reload: vi.fn(async () => undefined),
    error: null,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ProcessedSpanButtons", () => {
  it("measures paragraph blocks only and renders positioned toggle buttons", async () => {
    const { editor } = buildEditorDom();
    const model = processed(["blk-b"]);
    const { getByTestId, queryByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={model} revision={0} />,
    );

    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());
    expect(queryByTestId("processed-toggle-blk-heading")).not.toBeInTheDocument();
    expect(getByTestId("processed-toggle-blk-a").closest(".readpara__actions")).toHaveStyle({
      top: "40px",
    });
    expect(getByTestId("processed-toggle-blk-a")).toHaveAttribute("aria-pressed", "false");
    expect(getByTestId("processed-toggle-blk-a")).toHaveAccessibleName("Mark paragraph processed");
    expect(getByTestId("processed-toggle-blk-a")).toHaveAttribute(
      "title",
      "Mark processed without output",
    );
    expect(getByTestId("processed-toggle-blk-b").closest(".readpara__actions")).toHaveStyle({
      top: "90px",
    });
    expect(getByTestId("processed-toggle-blk-b")).toHaveAttribute("aria-pressed", "true");
    expect(getByTestId("processed-toggle-blk-b")).toHaveAccessibleName(
      "Restore processed paragraph",
    );
    expect(getByTestId("processed-ignore-blk-a")).toHaveAccessibleName("Ignore paragraph");
    expect(getByTestId("processed-needs-later-blk-a")).toHaveAccessibleName(
      "Mark paragraph needs later",
    );
  });

  it("delegates toggle and reports whether the action marked or restored", async () => {
    const { editor } = buildEditorDom();
    const onToggled = vi.fn();
    const model = processed(["blk-b"]);
    const { getByTestId } = render(
      <ProcessedSpanButtons
        editor={editor}
        editorReady
        processed={model}
        revision={0}
        onToggled={onToggled}
      />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    fireEvent.click(getByTestId("processed-toggle-blk-a"));
    fireEvent.click(getByTestId("processed-toggle-blk-b"));

    await waitFor(() => expect(model.toggle).toHaveBeenCalledTimes(2));
    expect(model.toggle).toHaveBeenNthCalledWith(1, "blk-a");
    expect(model.toggle).toHaveBeenNthCalledWith(2, "blk-b");
    await waitFor(() => expect(onToggled).toHaveBeenCalledWith("marked"));
    expect(onToggled).toHaveBeenCalledWith("restored");
  });

  it("delegates ignore and needs-later actions", async () => {
    const { editor } = buildEditorDom();
    const onToggled = vi.fn();
    const model = processed();
    const { getByTestId } = render(
      <ProcessedSpanButtons
        editor={editor}
        editorReady
        processed={model}
        revision={0}
        onToggled={onToggled}
      />,
    );
    await waitFor(() => expect(getByTestId("processed-ignore-blk-a")).toBeInTheDocument());

    fireEvent.click(getByTestId("processed-ignore-blk-a"));
    fireEvent.click(getByTestId("processed-needs-later-blk-a"));

    await waitFor(() => expect(model.markIgnored).toHaveBeenCalledWith("blk-a"));
    expect(model.markNeedsLater).toHaveBeenCalledWith("blk-a");
    expect(onToggled).toHaveBeenCalledWith("marked");
  });

  it("disables restore and secondary actions for extracted blocks", async () => {
    const { editor } = buildEditorDom();
    const model = processed(["blk-a"], { "blk-a": "extracted" });
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={model} revision={0} />,
    );

    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    expect(getByTestId("processed-toggle-blk-a")).toBeDisabled();
    expect(getByTestId("processed-toggle-blk-a")).toHaveAccessibleName("Extracted paragraph");
    expect(getByTestId("processed-ignore-blk-a")).toBeDisabled();
    expect(getByTestId("processed-needs-later-blk-a")).toBeDisabled();

    fireEvent.click(getByTestId("processed-toggle-blk-a"));
    fireEvent.click(getByTestId("processed-ignore-blk-a"));
    fireEvent.click(getByTestId("processed-needs-later-blk-a"));

    expect(model.toggle).not.toHaveBeenCalled();
    expect(model.markIgnored).not.toHaveBeenCalled();
    expect(model.markNeedsLater).not.toHaveBeenCalled();
  });

  it("does not render controls for blocks hidden by the active reader filter", async () => {
    const { editor } = buildEditorDom();
    const model = processed(["blk-a", "blk-b"], {
      "blk-a": "processed_without_output",
      "blk-b": "needs_later",
    });
    const { getByTestId, queryByTestId } = render(
      <ProcessedSpanButtons
        editor={editor}
        editorReady
        processed={model}
        processingFilter="unresolved"
        revision={0}
      />,
    );

    await waitFor(() => expect(getByTestId("processed-toggle-blk-b")).toBeInTheDocument());
    expect(queryByTestId("processed-toggle-blk-a")).not.toBeInTheDocument();
  });

  it("reports a toggle failure without calling the success handler", async () => {
    const { editor } = buildEditorDom();
    const onToggled = vi.fn();
    const onToggleFailed = vi.fn();
    const model = processed();
    vi.mocked(model.toggle).mockResolvedValue(null);
    const { getByTestId } = render(
      <ProcessedSpanButtons
        editor={editor}
        editorReady
        processed={model}
        revision={0}
        onToggled={onToggled}
        onToggleFailed={onToggleFailed}
      />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    fireEvent.click(getByTestId("processed-toggle-blk-a"));

    await waitFor(() => expect(onToggleFailed).toHaveBeenCalled());
    expect(onToggled).not.toHaveBeenCalled();
  });

  it("clears anchors when the editor is not ready", () => {
    const { editor } = buildEditorDom();
    const { getByTestId, queryByTestId } = render(
      <ProcessedSpanButtons
        editor={editor}
        editorReady={false}
        processed={processed()}
        revision={0}
      />,
    );

    expect(getByTestId("processed-overlay")).toBeInTheDocument();
    expect(queryByTestId("processed-toggle-blk-a")).not.toBeInTheDocument();
  });
});

describe("ProcessedSpanButtons hover scoping", () => {
  function group(getByTestId: (id: string) => HTMLElement, blockId: string): HTMLElement {
    const el = getByTestId(`processed-toggle-${blockId}`).closest(".readpara__actions");
    if (!el) throw new Error(`Missing actions group for ${blockId}`);
    return el as HTMLElement;
  }

  // jsdom has no `PointerEvent`, and `fireEvent.pointerMove` drops `clientY`. The
  // component listens for the bare `"pointermove"`/`"pointerleave"` event types, so a
  // `MouseEvent` of that type (which carries `clientY`) still triggers the handler.
  // The dispatch is wrapped in `act` so the resulting state update flushes before the
  // assertion (the same wrapping `fireEvent` would do for a supported event).
  function pointerMove(rail: HTMLElement, clientY: number, clientX = 0): void {
    act(() => {
      rail.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY, bubbles: true }));
    });
  }
  function pointerLeave(rail: HTMLElement): void {
    act(() => {
      rail.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    });
  }

  // Rail top is 100; paragraph A (blk-a) rect top 140 → rail-relative band [40, 60];
  // paragraph B (blk-b) rect top 190 → rail-relative band [90, 110]. Bands are padded
  // by HOVER_BAND_TOLERANCE_PX (24): A ≈ [16, 84], B ≈ [66, 134].

  it("shows only the hovered paragraph's actions", async () => {
    const { rail, editor } = buildEditorDom();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={processed()} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    // clientY 145 → 145 - 100 = 45, inside A's padded band.
    pointerMove(rail, 145);

    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "true");
    expect(group(getByTestId, "blk-b")).toHaveAttribute("data-hovered", "false");
  });

  it("swaps the active group when moving to another paragraph", async () => {
    const { rail, editor } = buildEditorDom();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={processed()} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    pointerMove(rail, 145);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "true");

    // clientY 200 → 200 - 100 = 100, inside B's padded band [66, 134].
    pointerMove(rail, 200);
    expect(group(getByTestId, "blk-b")).toHaveAttribute("data-hovered", "true");
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "false");
  });

  it("clears actions on pointer leave", async () => {
    const { rail, editor } = buildEditorDom();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={processed()} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    pointerMove(rail, 145);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "true");

    pointerLeave(rail);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "false");
    expect(group(getByTestId, "blk-b")).toHaveAttribute("data-hovered", "false");
  });

  it("keeps the paragraph active for the icon column (Y-only band, R3)", async () => {
    const { rail, editor } = buildEditorDom();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={processed()} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    // The icon column sits ~88px out in the right margin; a far-right X with A's Y
    // still resolves to A because the band ignores X — proving the reach-for-control
    // path does not vanish the icons.
    pointerMove(rail, 145, 800);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "true");
  });

  it("clears the hover when the cursor moves below the last paragraph", async () => {
    const { rail, editor } = buildEditorDom();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={processed()} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    // clientY 145 → rail-relative 45, inside A's padded band.
    pointerMove(rail, 145);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "true");

    // clientY 600 → rail-relative 500, below B's padded bottom (134) → no band.
    pointerMove(rail, 600);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "false");
    expect(group(getByTestId, "blk-b")).toHaveAttribute("data-hovered", "false");
    expect(document.querySelectorAll('.readpara__actions[data-hovered="true"]')).toHaveLength(0);
  });

  it("clears the hover when the cursor moves above the first paragraph", async () => {
    const { rail, editor } = buildEditorDom();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={processed()} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    pointerMove(rail, 145);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "true");

    // clientY 100 → rail-relative 0; A's padded top is 16, so 0 < 16 → above A's band.
    pointerMove(rail, 100);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "false");
    expect(group(getByTestId, "blk-b")).toHaveAttribute("data-hovered", "false");
    expect(document.querySelectorAll('.readpara__actions[data-hovered="true"]')).toHaveLength(0);
  });

  it("resolves to the nearest paragraph in the overlapping band zone", async () => {
    const { rail, editor } = buildEditorDom();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={processed()} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    // clientY 178 → rail-relative 78; inside BOTH A[16,84] and B[66,134].
    // distance to A center (50) = 28, to B center (100) = 22 → B is closer.
    pointerMove(rail, 178);
    expect(group(getByTestId, "blk-b")).toHaveAttribute("data-hovered", "true");
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "false");
  });

  it("keeps the same paragraph active while the cursor moves within its band", async () => {
    const { rail, editor } = buildEditorDom();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={processed()} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    pointerMove(rail, 145);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "true");
    expect(group(getByTestId, "blk-b")).toHaveAttribute("data-hovered", "false");

    // clientY 150 → rail-relative 50, still inside A's band → no swap.
    pointerMove(rail, 150);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "true");
    expect(group(getByTestId, "blk-b")).toHaveAttribute("data-hovered", "false");
  });

  it("clears the hover when the active paragraph is filtered out", async () => {
    const { rail, editor } = buildEditorDom();
    const model = processed(["blk-a"], {
      "blk-a": "processed_without_output",
      "blk-b": "needs_later",
    });
    const { getByTestId, queryByTestId, rerender } = render(
      <ProcessedSpanButtons
        editor={editor}
        editorReady
        processed={model}
        processingFilter="all"
        revision={0}
      />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    pointerMove(rail, 145);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "true");

    // Switching to "unresolved" hides the terminal blk-a (processed_without_output) but
    // keeps non-terminal blk-b. Bumping `revision` forces the re-measure that drops the
    // dangling hover via fix #1.
    rerender(
      <ProcessedSpanButtons
        editor={editor}
        editorReady
        processed={model}
        processingFilter="unresolved"
        revision={1}
      />,
    );

    await waitFor(() => expect(queryByTestId("processed-toggle-blk-a")).not.toBeInTheDocument());
    expect(document.querySelectorAll('.readpara__actions[data-hovered="true"]')).toHaveLength(0);
  });

  it("re-resolves the hovered paragraph when the reader body scrolls", async () => {
    const { page, rail, editor } = buildEditorDom();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={processed()} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    // clientY 145 → rail-relative 45 (railTop 100), inside A's band.
    pointerMove(rail, 145);
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "true");

    // Simulate a scroll-up: the rail's top moves from 100 to 50. With lastPointerY=145
    // still held, rail-relative becomes 95 → inside B's band [66,134].
    setRect(rail, 50);
    act(() => {
      page.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    expect(group(getByTestId, "blk-b")).toHaveAttribute("data-hovered", "true");
    expect(group(getByTestId, "blk-a")).toHaveAttribute("data-hovered", "false");
  });
});

describe("U14: docChanged remeasure guard", () => {
  /**
   * Helpers to extract the `onTx` callback registered via `editor.on("transaction", cb)`.
   */
  function getTxCallback(editor: Editor): (args: { transaction: { docChanged: boolean } }) => void {
    const onMock = vi.mocked(editor.on);
    for (const call of onMock.mock.calls) {
      if (call[0] === "transaction")
        return call[1] as (args: { transaction: { docChanged: boolean } }) => void;
    }
    throw new Error("transaction callback not registered");
  }

  it("does not remeasure on a decoration-only transaction (docChanged===false)", async () => {
    const { editor } = buildEditorDom();
    const model = processed();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={model} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    // Capture the initial anchor count (anchors are set after mount).
    const initialCount = document.querySelectorAll(".readpara__actions").length;
    expect(initialCount).toBeGreaterThan(0);

    // Simulate a decoration-only transaction (cursor move, read-point push, etc.).
    const onTx = getTxCallback(editor);
    act(() => {
      onTx({ transaction: { docChanged: false } });
    });

    // rAF should not have been scheduled, so the anchor count must not change.
    // (In jsdom requestAnimationFrame is synchronous enough that if it ran, it would
    // have fired already — but nothing should change because docChanged===false bails early.)
    expect(document.querySelectorAll(".readpara__actions")).toHaveLength(initialCount);
  });

  it("remeasures after a doc-changing transaction (docChanged===true)", async () => {
    const { editor, rail } = buildEditorDom();
    const model = processed();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={model} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    // Move the rail top so a new remeasure would produce different positions.
    setRect(rail, 50);

    const onTx = getTxCallback(editor);
    await act(async () => {
      onTx({ transaction: { docChanged: true } });
      // Flush the rAF.
      await new Promise((r) => setTimeout(r, 0));
    });

    // After remeasure with rail top 50, blk-a's rail-relative top is 140-50=90.
    await waitFor(() => {
      const actions = getByTestId("processed-toggle-blk-a").closest(
        ".readpara__actions",
      ) as HTMLElement | null;
      expect(actions).toHaveStyle({ top: "90px" });
    });
  });

  it("resize trigger still fires remeasure regardless of docChanged guard", async () => {
    const { editor, rail } = buildEditorDom();
    const model = processed();
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={model} revision={0} />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    setRect(rail, 50);

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      const actions = getByTestId("processed-toggle-blk-a").closest(
        ".readpara__actions",
      ) as HTMLElement | null;
      expect(actions).toHaveStyle({ top: "90px" });
    });
  });
});
