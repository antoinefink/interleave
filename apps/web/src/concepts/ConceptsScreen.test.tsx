/**
 * ConceptsScreen component tests (`/concepts`).
 *
 * The concept hierarchy + member listing live MAIN-side (`ConceptRepository` +
 * the `concepts.list` / `concepts.members` bridge); this asserts the RENDERER
 * seam of the knowledge-map view:
 *  - the graph renders one `concept-node` per `listConcepts` concept;
 *  - clicking a node calls `conceptMembers(conceptId)` and renders the member rows;
 *  - the by-volume rail shows member/child counts;
 *  - selecting a concept with no members shows the empty-state;
 *  - opening a member row navigates per type (source/extract/card detail);
 *  - the non-desktop path renders the `route-concepts` fallback.
 *
 * `appApi` + the router are mocked so the test exercises ONLY this component's
 * wiring; no SQLite/IPC.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConceptMemberSummary, ConceptNode } from "../lib/appApi";

const h = vi.hoisted(() => {
  const attention: ConceptMemberSummary["scheduler"] = {
    kind: "attention",
    retrievability: null,
    stability: null,
    difficulty: null,
    reps: null,
    lapses: null,
    fsrsState: null,
    stage: "raw_source",
    postponed: 0,
    lastProcessedAt: null,
  };
  const fsrs: ConceptMemberSummary["scheduler"] = {
    kind: "fsrs",
    retrievability: 0.91,
    stability: 12,
    difficulty: 5,
    reps: 3,
    lapses: 0,
    fsrsState: "review",
    stage: "active_card",
    postponed: 0,
    lastProcessedAt: "2026-05-01T00:00:00.000Z",
  };
  const parent: ConceptNode = {
    id: "c-root",
    name: "Cognition",
    parentConceptId: null,
    childCount: 1,
    memberCount: 0,
    desiredRetention: null,
  };
  const child: ConceptNode = {
    id: "c-child",
    name: "Intelligence",
    parentConceptId: "c-root",
    childCount: 0,
    memberCount: 2,
    desiredRetention: null,
  };
  const sourceMember: ConceptMemberSummary = {
    id: "src-1",
    type: "source",
    title: "On the Measure of Intelligence",
    priority: 0.9,
    priorityLabel: "A",
    status: "active",
    stage: "raw_source",
    sourceTitle: "On the Measure of Intelligence",
    dueAt: null,
    scheduler: attention,
    due: "soon",
    dueLabel: "Scheduled",
  };
  const extractMember: ConceptMemberSummary = {
    id: "ext-1",
    type: "extract",
    title: "Intelligence = skill-acquisition efficiency",
    priority: 0.9,
    priorityLabel: "A",
    status: "active",
    stage: "clean_extract",
    sourceTitle: "On the Measure of Intelligence",
    dueAt: "2026-06-01T00:00:00.000Z",
    scheduler: attention,
    due: "today",
    dueLabel: "Due today",
  };
  const cardMember: ConceptMemberSummary = {
    id: "card-1",
    type: "card",
    title: "Chollet's definition of intelligence",
    priority: 0.9,
    priorityLabel: "A",
    status: "active",
    stage: "active_card",
    sourceTitle: "On the Measure of Intelligence",
    dueAt: "2026-06-01T00:00:00.000Z",
    scheduler: fsrs,
    due: "today",
    dueLabel: "Due today",
  };
  return {
    parent,
    child,
    sourceMember,
    extractMember,
    cardMember,
    navigateSpy: vi.fn(),
    listConcepts: vi.fn(),
    conceptMembers: vi.fn(),
    desktop: { value: true },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop.value,
    appApi: {
      listConcepts: h.listConcepts,
      conceptMembers: h.conceptMembers,
    },
  };
});

import { ConceptsScreen } from "./ConceptsScreen";

beforeEach(() => {
  vi.clearAllMocks();
  h.desktop.value = true;
  h.listConcepts.mockResolvedValue({ concepts: [h.parent, h.child] });
  h.conceptMembers.mockResolvedValue({
    members: [h.sourceMember, h.extractMember, h.cardMember],
  });
});

describe("ConceptsScreen", () => {
  it("renders the graph with one node per concept + the count summary", async () => {
    render(<ConceptsScreen />);
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    expect(await screen.findByTestId("concept-graph")).toBeTruthy();
    expect(screen.getAllByTestId("concept-node")).toHaveLength(2);
    expect(screen.getByTestId("concepts-count").textContent).toContain("2 concepts");
    // No member fetch until a concept is selected.
    expect(h.conceptMembers).not.toHaveBeenCalled();
  });

  it("renders the by-volume rail with member + child counts", async () => {
    render(<ConceptsScreen />);
    const rail = await screen.findByTestId("concepts-rail");
    const childCard = within(rail).getByTestId("concepts-rail-c-child");
    expect(childCard.textContent).toContain("2");
    expect(childCard.textContent).toContain("member");
    expect(childCard.textContent).toContain("child");
  });

  it("clicking a node calls conceptMembers and renders grouped member rows", async () => {
    render(<ConceptsScreen />);
    const node = (await screen.findAllByTestId("concept-node")).find(
      (n) => n.getAttribute("data-concept-id") === "c-child",
    ) as Element;
    fireEvent.click(node);

    await waitFor(() => expect(h.conceptMembers).toHaveBeenCalledWith({ conceptId: "c-child" }));
    expect(await screen.findByTestId("concepts-members")).toBeTruthy();
    // One row per member type group.
    expect(screen.getByTestId("concepts-members-group-source")).toBeTruthy();
    expect(screen.getByTestId("concepts-members-group-extract")).toBeTruthy();
    expect(screen.getByTestId("concepts-members-group-card")).toBeTruthy();
    expect(screen.getAllByTestId("concepts-member")).toHaveLength(3);
  });

  it("selecting a concept via the hierarchy filterbar also drills in", async () => {
    render(<ConceptsScreen />);
    fireEvent.click(await screen.findByTestId("concepts-tree-c-child"));
    await waitFor(() => expect(h.conceptMembers).toHaveBeenCalledWith({ conceptId: "c-child" }));
    expect((await screen.findAllByTestId("concepts-member")).length).toBeGreaterThan(0);
  });

  it("shows the empty-state when the selected concept has no live members", async () => {
    h.conceptMembers.mockResolvedValue({ members: [] });
    render(<ConceptsScreen />);
    fireEvent.click(await screen.findByTestId("concepts-rail-c-child"));
    expect(await screen.findByTestId("concepts-members-empty")).toBeTruthy();
  });

  it("opens a member row to the right route per type (source/extract/card)", async () => {
    render(<ConceptsScreen />);
    fireEvent.click(await screen.findByTestId("concepts-rail-c-child"));
    await screen.findByTestId("concepts-members");

    const rowFor = (id: string) =>
      screen
        .getAllByTestId("concepts-member")
        .find((r) => r.getAttribute("data-member-id") === id) as Element;

    fireEvent.doubleClick(rowFor("src-1"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-1" } });

    fireEvent.doubleClick(rowFor("ext-1"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/extract/$id", params: { id: "ext-1" } });

    fireEvent.doubleClick(rowFor("card-1"));
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/card/$id",
      params: { id: "card-1" },
    });
  });

  it("opens a member row on Enter (keyboard)", async () => {
    render(<ConceptsScreen />);
    fireEvent.click(await screen.findByTestId("concepts-rail-c-child"));
    await screen.findByTestId("concepts-members");
    const row = screen
      .getAllByTestId("concepts-member")
      .find((r) => r.getAttribute("data-member-id") === "src-1") as Element;
    fireEvent.keyDown(row, { key: "Enter" });
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-1" } });
  });

  it("renders the non-desktop fallback (route-concepts) outside Electron", () => {
    h.desktop.value = false;
    render(<ConceptsScreen />);
    expect(screen.getByTestId("route-concepts")).toBeTruthy();
    expect(h.listConcepts).not.toHaveBeenCalled();
  });
});
