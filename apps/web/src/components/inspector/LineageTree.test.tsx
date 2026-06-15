/**
 * LineageTree component test (T023).
 *
 * The tree itself is presentational — the flattened, depth-tagged nodes are
 * computed in `packages/local-db` and cross IPC (covered by the LineageQuery
 * Vitest there). Here we assert the renderer seam:
 *  - it renders one row per node, depth-indented, with the active node marked;
 *  - clicking a node fires `onPick` with that node (the bidirectional-navigation
 *    hinge the inspector wires to selection + `/source/$id`).
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LineageNode } from "../../lib/appApi";
import { LineageTree } from "./LineageTree";

/** A source → extract → sub-extract chain as the main process would flatten it. */
const NODES: readonly LineageNode[] = [
  {
    id: "src-1",
    type: "source",
    title: "On the Measure of Intelligence",
    stage: "raw_source",
    depth: 0,
    meta: "source",
    active: false,
    deleted: false,
  },
  {
    id: "ext-1",
    type: "extract",
    title: "Intelligence = skill-acquisition efficiency",
    stage: "atomic_statement",
    depth: 1,
    meta: "atomic_statement",
    active: true,
    deleted: false,
  },
  {
    id: "sub-1",
    type: "extract",
    title: "Must control for priors and experience",
    stage: "raw_extract",
    depth: 2,
    meta: "sub-extract",
    active: false,
    deleted: false,
  },
];

describe("LineageTree", () => {
  it("renders one node per row with the active node highlighted", () => {
    render(<LineageTree nodes={NODES} onPick={() => {}} />);
    const rows = screen.getAllByTestId("lineage-tree-node");
    expect(rows).toHaveLength(3);

    // The active extract carries the `--on` highlight + aria-current.
    const active = rows.find((r) => r.getAttribute("data-element-id") === "ext-1");
    expect(active?.getAttribute("data-active")).toBe("true");
    expect(active?.className).toContain("tree-node--on");

    // A non-active node is not highlighted.
    const source = rows.find((r) => r.getAttribute("data-element-id") === "src-1");
    expect(source?.getAttribute("data-active")).toBe("false");
    expect(source?.className).not.toContain("tree-node--on");
  });

  it("indents each node by its depth (the kit's vertical guide spacers)", () => {
    const { container } = render(<LineageTree nodes={NODES} onPick={() => {}} />);
    const rows = container.querySelectorAll(".tree-row");
    // depth 0 → 0 indents, depth 1 → 1 indent, depth 2 → 2 indents.
    expect(rows[0]?.querySelectorAll(".tree-indent")).toHaveLength(0);
    expect(rows[1]?.querySelectorAll(".tree-indent")).toHaveLength(1);
    expect(rows[2]?.querySelectorAll(".tree-indent")).toHaveLength(2);
  });

  it("renders the faint meta suffix for each node", () => {
    render(<LineageTree nodes={NODES} onPick={() => {}} />);
    expect(screen.getByText("sub-extract")).toBeInTheDocument();
    expect(screen.getByText("source")).toBeInTheDocument();
  });

  it("fires onPick with the clicked node (bidirectional navigation)", () => {
    const onPick = vi.fn();
    render(<LineageTree nodes={NODES} onPick={onPick} />);

    // Click the source node (navigating UP the chain from the active extract).
    const source = screen
      .getAllByTestId("lineage-tree-node")
      .find((r) => r.getAttribute("data-element-id") === "src-1");
    expect(source).toBeDefined();
    if (source) fireEvent.click(source);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "src-1", type: "source" }));

    // Click the sub-extract node (navigating DOWN the chain).
    const sub = screen
      .getAllByTestId("lineage-tree-node")
      .find((r) => r.getAttribute("data-element-id") === "sub-1");
    if (sub) fireEvent.click(sub);
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ id: "sub-1" }));
  });

  // T135 / U2 — tombstone rendering: a soft-deleted ancestor stays visible (muted +
  // struck) so a focused live node never disappears from its own lineage.
  describe("tombstones (T135)", () => {
    /** source → (deleted) extract → live card focused — the user's real case. */
    const TOMBSTONE_NODES: readonly LineageNode[] = [
      {
        id: "src-1",
        type: "source",
        title: "The Toxoplasma Of Rage",
        stage: "raw_source",
        depth: 0,
        meta: "source",
        active: false,
        deleted: false,
      },
      {
        id: "ext-dead",
        type: "extract",
        title: "The University of Virginia rape case…",
        stage: "raw_extract",
        depth: 1,
        meta: "raw_extract",
        active: false,
        deleted: true,
      },
      {
        id: "card-1",
        type: "card",
        title: "{{c1::…to discredit}}",
        stage: "card",
        depth: 2,
        meta: "cloze",
        active: true,
        deleted: false,
      },
    ];

    it("renders a tombstone node muted + struck with a distinguishing test-id (Covers R1)", () => {
      render(<LineageTree nodes={TOMBSTONE_NODES} onPick={() => {}} onRestore={() => {}} />);
      const rows = screen.getAllByTestId("lineage-tree-node");
      const dead = rows.find((r) => r.getAttribute("data-element-id") === "ext-dead");
      // The tombstone is flagged distinctly from live nodes (data-deleted + class).
      expect(dead?.getAttribute("data-deleted")).toBe("true");
      expect(dead?.className).toContain("tree-node--deleted");
      // The struck "deleted" tag replaces the live mono meta on the tombstone row.
      expect(within(dead as HTMLElement).getByTestId("lineage-tombstone-tag")).toBeInTheDocument();

      // The focused live card is still present and marked active (never pruned).
      const card = rows.find((r) => r.getAttribute("data-element-id") === "card-1");
      expect(card?.getAttribute("data-active")).toBe("true");
      expect(card?.getAttribute("data-deleted")).toBe("false");

      // A live node is NOT muted/struck and shows no tombstone tag.
      const src = rows.find((r) => r.getAttribute("data-element-id") === "src-1");
      expect(src?.className).not.toContain("tree-node--deleted");
      expect(screen.getAllByTestId("lineage-tombstone-tag")).toHaveLength(1);
    });

    it("renders an ALWAYS-VISIBLE inline Restore only on tombstone rows and fires onRestore (Covers R11)", () => {
      const onRestore = vi.fn();
      render(<LineageTree nodes={TOMBSTONE_NODES} onPick={() => {}} onRestore={onRestore} />);
      const restores = screen.getAllByTestId("lineage-tombstone-restore");
      // Exactly one tombstone → exactly one Restore control (not hover-gated; rendered).
      expect(restores).toHaveLength(1);
      expect(restores[0]?.getAttribute("data-element-id")).toBe("ext-dead");
      fireEvent.click(restores[0] as HTMLElement);
      expect(onRestore).toHaveBeenCalledTimes(1);
      expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: "ext-dead" }));
    });

    it("disables the Restore control while that node's restore is in flight", () => {
      render(
        <LineageTree
          nodes={TOMBSTONE_NODES}
          onPick={() => {}}
          onRestore={() => {}}
          restoringId="ext-dead"
        />,
      );
      const restore = screen.getByTestId("lineage-tombstone-restore") as HTMLButtonElement;
      expect(restore.disabled).toBe(true);
      expect(restore.textContent).toContain("Restoring");
    });

    it("omits the Restore control entirely when no onRestore is provided", () => {
      render(<LineageTree nodes={TOMBSTONE_NODES} onPick={() => {}} />);
      expect(screen.queryByTestId("lineage-tombstone-restore")).toBeNull();
      // The tombstone is still rendered (muted) — only the affordance is gone.
      expect(screen.getByTestId("lineage-tombstone-tag")).toBeInTheDocument();
    });
  });

  // U5 — right-click seam: when the host passes `onNodeContextMenu`, a contextmenu on a
  // node suppresses the native browser menu and reports the node + cursor position so the
  // host can open the in-app LineageContextMenu. Omitting the prop keeps native behavior.
  describe("right-click (onNodeContextMenu)", () => {
    it("suppresses the native menu and reports the node + cursor position", () => {
      const onNodeContextMenu = vi.fn();
      render(<LineageTree nodes={NODES} onPick={() => {}} onNodeContextMenu={onNodeContextMenu} />);
      const source = screen
        .getAllByTestId("lineage-tree-node")
        .find((r) => r.getAttribute("data-element-id") === "src-1");
      expect(source).toBeDefined();

      // fireEvent.contextMenu returns false when the handler called preventDefault().
      const notPrevented = fireEvent.contextMenu(source as HTMLElement, {
        clientX: 321,
        clientY: 654,
      });
      expect(notPrevented).toBe(false);

      // The callback fires once with (node, { x, y }) where x/y mirror clientX/clientY.
      expect(onNodeContextMenu).toHaveBeenCalledTimes(1);
      expect(onNodeContextMenu).toHaveBeenCalledWith(
        expect.objectContaining({ id: "src-1", type: "source" }),
        { x: 321, y: 654 },
      );
    });

    it("forwards the right-clicked node (not a sibling) for each row", () => {
      const onNodeContextMenu = vi.fn();
      render(<LineageTree nodes={NODES} onPick={() => {}} onNodeContextMenu={onNodeContextMenu} />);
      const sub = screen
        .getAllByTestId("lineage-tree-node")
        .find((r) => r.getAttribute("data-element-id") === "sub-1");
      fireEvent.contextMenu(sub as HTMLElement, { clientX: 5, clientY: 7 });
      expect(onNodeContextMenu).toHaveBeenCalledTimes(1);
      expect(onNodeContextMenu).toHaveBeenLastCalledWith(expect.objectContaining({ id: "sub-1" }), {
        x: 5,
        y: 7,
      });
    });

    it("does nothing (native default) and never throws when onNodeContextMenu is omitted", () => {
      render(<LineageTree nodes={NODES} onPick={() => {}} />);
      const source = screen
        .getAllByTestId("lineage-tree-node")
        .find((r) => r.getAttribute("data-element-id") === "src-1");
      // No handler is wired, so preventDefault is never called — the event is NOT consumed.
      const notPrevented = fireEvent.contextMenu(source as HTMLElement, {
        clientX: 10,
        clientY: 20,
      });
      expect(notPrevented).toBe(true);
    });
  });
});
