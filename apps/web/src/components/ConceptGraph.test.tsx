/**
 * ConceptGraph component tests.
 *
 * The shared read-only concept Map (kit `graph`/`gnode`) is rendered by `/search`
 * (LibraryScreen), `/library` (BrowseScreen), and `/concepts` (ConceptsScreen), so
 * this pin-tests its pure rendering + interaction contract once:
 *  - one `concept-node` per concept, edges drawn from `parentConceptId`;
 *  - `onPick(id)` fires on click AND on Enter/Space (keyboard accessibility);
 *  - the node radius scales with `memberCount`;
 *  - an optional `selectedId` marks exactly that node selected.
 *
 * Pure render — no router, no appApi.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConceptNode } from "../lib/appApi";
import { ConceptGraph } from "./ConceptGraph";

const ROOT: ConceptNode = {
  id: "c-root",
  name: "Cognition",
  parentConceptId: null,
  childCount: 1,
  memberCount: 1,
};
const CHILD: ConceptNode = {
  id: "c-child",
  name: "Intelligence",
  parentConceptId: "c-root",
  childCount: 0,
  memberCount: 5,
};
const CONCEPTS = [ROOT, CHILD] as const;

describe("ConceptGraph", () => {
  it("renders one node per concept", () => {
    render(<ConceptGraph concepts={CONCEPTS} onPick={vi.fn()} />);
    expect(screen.getAllByTestId("concept-node")).toHaveLength(2);
    expect(screen.getByText("Cognition")).toBeTruthy();
    expect(screen.getByText("Intelligence")).toBeTruthy();
  });

  it("draws an edge from each child to its parent (one edge for one parent link)", () => {
    const { container } = render(<ConceptGraph concepts={CONCEPTS} onPick={vi.fn()} />);
    // The single parent→child link yields exactly one <line>.
    expect(container.querySelectorAll("line")).toHaveLength(1);
  });

  it("fires onPick with the concept id on click", () => {
    const onPick = vi.fn();
    render(<ConceptGraph concepts={CONCEPTS} onPick={onPick} />);
    const childNode = screen
      .getAllByTestId("concept-node")
      .find((n) => n.getAttribute("data-concept-id") === "c-child");
    expect(childNode).toBeTruthy();
    fireEvent.click(childNode as Element);
    expect(onPick).toHaveBeenCalledWith("c-child");
  });

  it("fires onPick on Enter and on Space (keyboard accessibility)", () => {
    const onPick = vi.fn();
    render(<ConceptGraph concepts={CONCEPTS} onPick={onPick} />);
    const rootNode = screen
      .getAllByTestId("concept-node")
      .find((n) => n.getAttribute("data-concept-id") === "c-root") as Element;

    fireEvent.keyDown(rootNode, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("c-root");

    onPick.mockClear();
    fireEvent.keyDown(rootNode, { key: " " });
    expect(onPick).toHaveBeenCalledWith("c-root");
  });

  it("scales the node radius with memberCount (more members → larger circle)", () => {
    const { container } = render(<ConceptGraph concepts={CONCEPTS} onPick={vi.fn()} />);
    const circleFor = (id: string) =>
      container.querySelector(`[data-concept-id="${id}"] circle`) as SVGCircleElement;
    const rootR = Number(circleFor("c-root").getAttribute("r"));
    const childR = Number(circleFor("c-child").getAttribute("r"));
    // The child has more members (5 vs 1), so despite being a child ring node its
    // radius grows with memberCount above the base.
    expect(childR).toBeGreaterThan(24);
    expect(rootR).toBeGreaterThan(0);
  });

  it("marks exactly the selected node when selectedId is set", () => {
    render(<ConceptGraph concepts={CONCEPTS} onPick={vi.fn()} selectedId="c-child" />);
    const selected = screen
      .getAllByTestId("concept-node")
      .filter((n) => n.getAttribute("data-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-concept-id")).toBe("c-child");
  });

  it("labels nodes with the pickVerb (defaults to 'Filter by', '/concepts' uses 'Explore')", () => {
    const { rerender } = render(<ConceptGraph concepts={CONCEPTS} onPick={vi.fn()} />);
    expect(screen.getByLabelText("Filter by Intelligence")).toBeTruthy();
    rerender(<ConceptGraph concepts={CONCEPTS} onPick={vi.fn()} pickVerb="Explore" />);
    expect(screen.getByLabelText("Explore Intelligence")).toBeTruthy();
  });
});
