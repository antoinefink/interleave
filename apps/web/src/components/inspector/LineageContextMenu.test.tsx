/**
 * LineageContextMenu container test (lineage-tree context menu, U5).
 *
 * Drives the renderer seam where a right-clicked node becomes the in-app ContextMenu and
 * each chosen action dispatches through the right channel. Mocks `appApi` with the repo's
 * `vi.hoisted` + partial `vi.mock` pattern (mirroring LineageDeleteMenu.test.tsx): every
 * command the container OR the driven LineageDeleteMenu calls is stubbed, `isDesktop` is
 * forced true, and `navigator.clipboard.writeText` is stubbed.
 *
 * Crucially it asserts the SINGLE delete path (R4): Delete engages the shared
 * LineageDeleteMenu flow (its `countDescendants` pre-flight runs) and the container never
 * calls `softDeleteSubtree` directly.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  countDescendants: vi.fn(),
  softDeleteSubtree: vi.fn(),
  setElementPriority: vi.fn(),
  renameElement: vi.fn(),
  updateExtractStage: vi.fn(),
  postponeExtract: vi.fn(),
  markExtractDone: vi.fn(),
  suspendCard: vi.fn(),
  markLeechCard: vi.fn(),
  retireCard: vi.fn(),
  restoreFromTrash: vi.fn(),
  restoreAncestorChain: vi.fn(),
  purgeFromTrash: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      countDescendants: h.countDescendants,
      softDeleteSubtree: h.softDeleteSubtree,
      setElementPriority: h.setElementPriority,
      renameElement: h.renameElement,
      updateExtractStage: h.updateExtractStage,
      postponeExtract: h.postponeExtract,
      markExtractDone: h.markExtractDone,
      suspendCard: h.suspendCard,
      markLeechCard: h.markLeechCard,
      retireCard: h.retireCard,
      restoreFromTrash: h.restoreFromTrash,
      restoreAncestorChain: h.restoreAncestorChain,
      purgeFromTrash: h.purgeFromTrash,
    },
  };
});

import type { LineageNode } from "../../lib/appApi";
import { LineageContextMenu } from "./LineageContextMenu";

afterEach(cleanup);

function node(overrides: Partial<LineageNode> = {}): LineageNode {
  return {
    id: "el-1",
    type: "extract",
    title: "An extract",
    stage: "raw_extract",
    depth: 1,
    meta: "raw_extract",
    active: false,
    deleted: false,
    ...overrides,
  };
}

interface HostProps {
  readonly onOpen?: (n: LineageNode) => void;
  readonly onAfterMutation?: () => void;
  /** Wrap the host in <StrictMode> to exercise the dev mount→unmount→remount cycle. */
  readonly strict?: boolean;
}

/**
 * Render the container the way the Inspector (U6) will: the HOST owns the target state
 * and `onClose` clears it. Modelling that faithfully matters — when `onClose` clears the
 * target the menu unmounts, which is exactly what lets the inline rename input take focus.
 */
function renderMenu(n: LineageNode, props: HostProps = {}) {
  const onOpen = props.onOpen ?? vi.fn();
  const onAfterMutation = props.onAfterMutation ?? vi.fn();
  function Host() {
    const [target, setTarget] = useState<{
      node: LineageNode;
      position: { x: number; y: number };
    } | null>({ node: n, position: { x: 120, y: 80 } });
    return (
      <LineageContextMenu
        target={target}
        onClose={() => setTarget(null)}
        onOpen={onOpen}
        onAfterMutation={onAfterMutation}
      />
    );
  }
  const utils = render(
    props.strict ? (
      <StrictMode>
        <Host />
      </StrictMode>
    ) : (
      <Host />
    ),
  );
  return { ...utils, onOpen, onAfterMutation };
}

beforeEach(() => {
  h.desktop = true;
  for (const fn of [
    h.countDescendants,
    h.softDeleteSubtree,
    h.setElementPriority,
    h.renameElement,
    h.updateExtractStage,
    h.postponeExtract,
    h.markExtractDone,
    h.suspendCard,
    h.markLeechCard,
    h.retireCard,
    h.restoreFromTrash,
    h.restoreAncestorChain,
    h.purgeFromTrash,
    h.writeText,
  ]) {
    fn.mockReset();
  }
  // Default resolved values so the awaited mutations settle.
  h.setElementPriority.mockResolvedValue({ element: null });
  h.renameElement.mockResolvedValue({ element: null });
  h.updateExtractStage.mockResolvedValue({ extract: {} });
  h.postponeExtract.mockResolvedValue({ extract: {}, postponeCount: 1 });
  h.markExtractDone.mockResolvedValue({ extract: {} });
  h.suspendCard.mockResolvedValue({ card: {} });
  h.markLeechCard.mockResolvedValue({ card: {} });
  h.retireCard.mockResolvedValue({ card: {} });
  h.restoreFromTrash.mockResolvedValue({ item: null });
  h.restoreAncestorChain.mockResolvedValue({ restored: [], batchId: null });
  h.purgeFromTrash.mockResolvedValue({ purged: 1, blocked: false, liveDependents: 0 });
  h.writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: h.writeText },
  });
});

describe("LineageContextMenu", () => {
  it("opens the menu with the expected items for a live extract", () => {
    renderMenu(node());
    expect(screen.getByTestId("lineage-context-menu")).toBeInTheDocument();
    // Universal + extract extras (see lineageNodeActions).
    expect(screen.getByTestId("context-menu-item-open")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-copy-ref")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-copy-text")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-advance-stage")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-create-card")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-postpone")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-mark-done")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-priority")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-rename")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-delete")).toBeInTheDocument();
  });

  it("renders nothing in the menu when target is null", () => {
    render(
      <LineageContextMenu
        target={null}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onAfterMutation={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("lineage-context-menu")).toBeNull();
  });

  it("Set priority → B dispatches setElementPriority with a set action", async () => {
    const { onAfterMutation } = renderMenu(node());
    // Open the priority submenu, then pick B.
    fireEvent.click(screen.getByTestId("context-menu-item-priority"));
    fireEvent.click(await screen.findByTestId("context-menu-item-priority-B"));

    await waitFor(() =>
      expect(h.setElementPriority).toHaveBeenCalledWith({
        id: "el-1",
        action: { kind: "set", priority: "B" },
      }),
    );
    await waitFor(() => expect(onAfterMutation).toHaveBeenCalled());
  });

  it("Advance stage on an extract dispatches updateExtractStage with no stage", async () => {
    renderMenu(node());
    fireEvent.click(screen.getByTestId("context-menu-item-advance-stage"));
    await waitFor(() => expect(h.updateExtractStage).toHaveBeenCalledWith({ id: "el-1" }));
  });

  it("Suspend on a card dispatches suspendCard({ cardId })", async () => {
    renderMenu(node({ type: "card", id: "card-9" }));
    fireEvent.click(screen.getByTestId("context-menu-item-suspend"));
    await waitFor(() => expect(h.suspendCard).toHaveBeenCalledWith({ cardId: "card-9" }));
  });

  it("Flag leech on a card dispatches markLeechCard({ cardId, leech: true })", async () => {
    renderMenu(node({ type: "card", id: "card-9" }));
    fireEvent.click(screen.getByTestId("context-menu-item-flag-leech"));
    await waitFor(() =>
      expect(h.markLeechCard).toHaveBeenCalledWith({ cardId: "card-9", leech: true }),
    );
  });

  it("Retire on a card dispatches retireCard({ cardId })", async () => {
    renderMenu(node({ type: "card", id: "card-9" }));
    fireEvent.click(screen.getByTestId("context-menu-item-retire"));
    await waitFor(() => expect(h.retireCard).toHaveBeenCalledWith({ cardId: "card-9" }));
  });

  it("Delete engages the shared LineageDeleteMenu flow (countDescendants runs) and never calls softDeleteSubtree directly (Covers R4)", async () => {
    h.countDescendants.mockResolvedValue({
      extracts: 0,
      cards: 0,
      cardsWithHistory: 0,
      total: 1,
    });
    renderMenu(node());
    fireEvent.click(screen.getByTestId("context-menu-item-delete"));

    // The driven LineageDeleteMenu runs its pre-flight via the bumped signal.
    await waitFor(() => expect(h.countDescendants).toHaveBeenCalledWith({ id: "el-1" }));
    // The container itself NEVER calls softDeleteSubtree (single delete path).
    expect(h.softDeleteSubtree).not.toHaveBeenCalled();
  });

  it("Copy reference writes interleave://element/<id> to the clipboard", async () => {
    renderMenu(node({ id: "abc" }));
    fireEvent.click(screen.getByTestId("context-menu-item-copy-ref"));
    await waitFor(() => expect(h.writeText).toHaveBeenCalledWith("interleave://element/abc"));
  });

  it("Copy text writes the node title to the clipboard", async () => {
    renderMenu(node({ title: "Hello world" }));
    fireEvent.click(screen.getByTestId("context-menu-item-copy-text"));
    await waitFor(() => expect(h.writeText).toHaveBeenCalledWith("Hello world"));
  });

  it("Open routes through onOpen", () => {
    const onOpen = vi.fn();
    const n = node();
    renderMenu(n, { onOpen });
    fireEvent.click(screen.getByTestId("context-menu-item-open"));
    expect(onOpen).toHaveBeenCalledWith(n);
  });

  it("Tombstone → Restore ancestor chain dispatches restoreAncestorChain({ id })", async () => {
    renderMenu(node({ deleted: true, id: "dead-1" }));
    fireEvent.click(screen.getByTestId("context-menu-item-restore-chain"));
    await waitFor(() => expect(h.restoreAncestorChain).toHaveBeenCalledWith({ id: "dead-1" }));
  });

  it("Tombstone → plain Restore dispatches restoreFromTrash({ id })", async () => {
    renderMenu(node({ deleted: true, id: "dead-1" }));
    fireEvent.click(screen.getByTestId("context-menu-item-restore"));
    await waitFor(() => expect(h.restoreFromTrash).toHaveBeenCalledWith({ id: "dead-1" }));
  });

  it("Tombstone → Delete permanently confirm child dispatches purgeFromTrash", async () => {
    renderMenu(node({ deleted: true, id: "dead-1" }));
    // The destructive confirm is a one-child submenu — open it, then pick the child.
    fireEvent.click(screen.getByTestId("context-menu-item-purge"));
    fireEvent.click(await screen.findByTestId("context-menu-item-purge-confirm"));
    await waitFor(() => expect(h.purgeFromTrash).toHaveBeenCalledWith({ id: "dead-1" }));
  });

  it("a blocked purge surfaces an error toast and never refreshes", async () => {
    h.purgeFromTrash.mockResolvedValue({ purged: 0, blocked: true, liveDependents: 3 });
    const { onAfterMutation } = renderMenu(node({ deleted: true, id: "dead-1" }));
    fireEvent.click(screen.getByTestId("context-menu-item-purge"));
    fireEvent.click(await screen.findByTestId("context-menu-item-purge-confirm"));
    const toast = await screen.findByTestId("lineage-context-toast");
    expect(toast.textContent).toContain("3 live items");
    expect(onAfterMutation).not.toHaveBeenCalled();
  });

  it("Rename shows the inline input and committing dispatches renameElement", async () => {
    renderMenu(node({ id: "el-1", title: "Old title" }));
    fireEvent.click(screen.getByTestId("context-menu-item-rename"));

    const input = (await screen.findByTestId("lineage-rename-input")) as HTMLInputElement;
    expect(input.value).toBe("Old title");
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(h.renameElement).toHaveBeenCalledWith({ id: "el-1", title: "New title" }),
    );
  });

  it("Rename to the same/empty value does not dispatch renameElement", async () => {
    renderMenu(node({ id: "el-1", title: "Same" }));
    fireEvent.click(screen.getByTestId("context-menu-item-rename"));
    const input = (await screen.findByTestId("lineage-rename-input")) as HTMLInputElement;
    // Commit unchanged.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.renameElement).not.toHaveBeenCalled();
  });

  it("a successful rename ({ element: {...} }) refreshes via onAfterMutation", async () => {
    h.renameElement.mockResolvedValue({ element: { id: "el-1", title: "New title" } });
    const { onAfterMutation } = renderMenu(node({ id: "el-1", title: "Old title" }));
    fireEvent.click(screen.getByTestId("context-menu-item-rename"));
    const input = (await screen.findByTestId("lineage-rename-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(h.renameElement).toHaveBeenCalledWith({ id: "el-1", title: "New title" }),
    );
    await waitFor(() => expect(onAfterMutation).toHaveBeenCalled());
  });

  it("a rename returning { element: null } surfaces an error toast and never refreshes (Theme E)", async () => {
    // The default mock already resolves to { element: null } (deleted between right-click
    // and commit) — commitRename throws → error toast, no onAfterMutation.
    h.renameElement.mockResolvedValue({ element: null });
    const { onAfterMutation } = renderMenu(node({ id: "el-1", title: "Old title" }));
    fireEvent.click(screen.getByTestId("context-menu-item-rename"));
    const input = (await screen.findByTestId("lineage-rename-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(h.renameElement).toHaveBeenCalledWith({ id: "el-1", title: "New title" }),
    );
    const toast = await screen.findByTestId("lineage-context-toast");
    expect(toast.textContent).toContain("no longer exists");
    expect(onAfterMutation).not.toHaveBeenCalled();
  });

  it("Rename commits on blur (clicking away SAVES, not discards) with the trimmed title (Theme A)", async () => {
    h.renameElement.mockResolvedValue({ element: { id: "el-1", title: "Renamed" } });
    renderMenu(node({ id: "el-1", title: "Old title" }));
    fireEvent.click(screen.getByTestId("context-menu-item-rename"));
    const input = (await screen.findByTestId("lineage-rename-input")) as HTMLInputElement;
    // Whitespace around the value proves the commit trims before dispatching.
    fireEvent.change(input, { target: { value: "  Renamed  " } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(h.renameElement).toHaveBeenCalledWith({ id: "el-1", title: "Renamed" }),
    );
  });

  it("Enter commits exactly once even though unmounting fires a blur (no double-commit, Theme A)", async () => {
    h.renameElement.mockResolvedValue({ element: { id: "el-1", title: "New title" } });
    renderMenu(node({ id: "el-1", title: "Old title" }));
    fireEvent.click(screen.getByTestId("context-menu-item-rename"));
    const input = (await screen.findByTestId("lineage-rename-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New title" } });
    // Enter commits and clears rename → the input unmounts (which fires a blur). The
    // doneRef latch must keep that unmount-blur from committing a second time.
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    await waitFor(() => expect(h.renameElement).toHaveBeenCalledTimes(1));
    expect(h.renameElement).toHaveBeenCalledWith({ id: "el-1", title: "New title" });
    // The input is gone after the commit.
    await waitFor(() => expect(screen.queryByTestId("lineage-rename-input")).toBeNull());
  });

  it("Escape cancels the rename — no renameElement, input unmounts (Theme A)", async () => {
    renderMenu(node({ id: "el-1", title: "Old title" }));
    fireEvent.click(screen.getByTestId("context-menu-item-rename"));
    const input = (await screen.findByTestId("lineage-rename-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("lineage-rename-input")).toBeNull());
    expect(h.renameElement).not.toHaveBeenCalled();
  });

  it("a runMutation failure surfaces an error toast, closes the menu, and never refreshes", async () => {
    h.updateExtractStage.mockRejectedValue(new Error("stage advance blew up"));
    const { onAfterMutation } = renderMenu(node({ type: "extract", id: "el-1" }));
    fireEvent.click(screen.getByTestId("context-menu-item-advance-stage"));

    const toast = await screen.findByTestId("lineage-context-toast");
    expect(toast.textContent).toContain("stage advance blew up");
    // The menu closes on the error path (target cleared by onClose) and no refresh fires.
    await waitFor(() => expect(screen.queryByTestId("lineage-context-menu")).toBeNull());
    expect(onAfterMutation).not.toHaveBeenCalled();
  });

  it("a non-desktop environment does not dispatch a mutation", async () => {
    h.desktop = false;
    renderMenu(node());
    fireEvent.click(screen.getByTestId("context-menu-item-advance-stage"));
    await Promise.resolve();
    expect(h.updateExtractStage).not.toHaveBeenCalled();
  });
});

// Regression (real-app bug): the right-click → Delete item in the inspector lineage menu
// did nothing in the running app. Delete is the ONE menu action that does not dispatch
// from its own onSelect — it bumps a `triggerSignal` that drives the (hidden-trigger)
// LineageDeleteMenu, whose `handleTrigger` bails at `if (!mountedRef.current) return`
// after awaiting `countDescendants`. `mountedRef` was initialised `true` and cleared only
// on cleanup, so under React StrictMode (active in apps/web/src/main.tsx) the dev-only
// mount→unmount→remount cycle left it permanently `false` and the delete never fired.
//
// LineageDeleteMenu.test.tsx covers the fix via its VISIBLE trigger; this exercises the
// DISTINCT inspector entry point — the hidden trigger bumped by the context-menu Delete
// item — which had no StrictMode coverage. RTL's plain `render` does not apply StrictMode,
// which is exactly why the suite stayed green while the real menu was dead.
describe("LineageContextMenu under StrictMode (regression: context-menu Delete must fire)", () => {
  it("leaf Delete soft-deletes through the shared flow after the StrictMode remount cycle (Covers R4)", async () => {
    h.countDescendants.mockResolvedValue({ extracts: 0, cards: 0, cardsWithHistory: 0, total: 0 });
    h.softDeleteSubtree.mockResolvedValue({ affected: ["card-9"], batchId: null });
    const { onAfterMutation } = renderMenu(node({ type: "card", id: "card-9" }), { strict: true });

    fireEvent.click(screen.getByTestId("context-menu-item-delete"));

    // The signal-driven pre-flight runs (would NOT, pre-fix: mountedRef stuck false)…
    await waitFor(() => expect(h.countDescendants).toHaveBeenCalledWith({ id: "card-9" }));
    // …and the leaf quietly soft-deletes via the shared controller (the fast path).
    await waitFor(() =>
      expect(h.softDeleteSubtree).toHaveBeenCalledWith({ id: "card-9", includeSubtree: false }),
    );
    // …and the surface refreshes after the mutation settles (the full controller chain ran,
    // not just the IPC call) — a delete that fired but never refreshed would look just as
    // broken to the user.
    await waitFor(() => expect(onAfterMutation).toHaveBeenCalled());
  });

  it("descendant Delete opens the intent popover after the StrictMode remount cycle", async () => {
    h.countDescendants.mockResolvedValue({ extracts: 1, cards: 0, cardsWithHistory: 0, total: 1 });
    renderMenu(node({ type: "extract", id: "ext-1" }), { strict: true });

    fireEvent.click(screen.getByTestId("context-menu-item-delete"));

    // The descendant-aware popover appears (the signal reached LineageDeleteMenu's effect).
    expect(await screen.findByTestId("lineage-delete-pop")).toBeInTheDocument();
    // A leaf-only fast path must NOT have fired for a node with descendants.
    expect(h.softDeleteSubtree).not.toHaveBeenCalled();
  });

  it("count-error fall-through still soft-deletes after the StrictMode remount cycle", async () => {
    // The catch block in handleTrigger has the SAME post-await `if (!mountedRef.current)
    // return` guard as the leaf path. Cover it through the inspector entry point too: when
    // countDescendants fails we can't quantify the blast radius, so the controller falls
    // through to a safe single soft-delete (with a no-undo error toast).
    h.countDescendants.mockRejectedValue(new Error("count blew up"));
    h.softDeleteSubtree.mockResolvedValue({ affected: ["card-9"], batchId: null });
    renderMenu(node({ type: "card", id: "card-9" }), { strict: true });

    fireEvent.click(screen.getByTestId("context-menu-item-delete"));

    await waitFor(() => expect(h.countDescendants).toHaveBeenCalledWith({ id: "card-9" }));
    await waitFor(() =>
      expect(h.softDeleteSubtree).toHaveBeenCalledWith({ id: "card-9", includeSubtree: false }),
    );
  });
});
