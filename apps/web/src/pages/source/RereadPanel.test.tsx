import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RereadItemDetailDto } from "../../lib/appApi";
import { RereadPanel } from "./RereadPanel";

const h = vi.hoisted(() => ({
  completeTask: vi.fn(),
}));

// The card-detail click-through renders a TanStack `<Link>`; mock it to a plain anchor.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: { id: string };
    children: ReactNode;
  }) => (
    <a href={`${to}:${params?.id ?? ""}`} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return { ...actual, appApi: { completeTask: h.completeTask } };
});

const REGION: RereadItemDetailDto["region"] = {
  sourceElementId: "src-1",
  blockIds: ["block-a", "block-b"],
  label: "Section 3 · Scaling laws",
  page: null,
};

const MEMBERS: RereadItemDetailDto["members"] = [
  { cardId: "card-1", prompt: "What is the chinchilla-optimal ratio?", windowLapseCount: 3 },
  { cardId: "card-2", prompt: "Define compute-optimal training.", windowLapseCount: 1 },
];

function renderPanel(overrides: Partial<Parameters<typeof RereadPanel>[0]> = {}) {
  const onClose = vi.fn();
  const onCompleted = vi.fn();
  render(
    <RereadPanel
      taskElementId="task-1"
      region={REGION}
      members={MEMBERS}
      windowDays={30}
      onClose={onClose}
      onCompleted={onCompleted}
      {...overrides}
    />,
  );
  return { onClose, onCompleted };
}

describe("RereadPanel", () => {
  it("lists the failing cards with live lapse counts + card-detail links", () => {
    renderPanel();
    expect(screen.getByText("What is the chinchilla-optimal ratio?")).toBeInTheDocument();
    expect(screen.getByText("3 lapses in 30d")).toBeInTheDocument();
    // Singular grammar for a single lapse.
    expect(screen.getByText("1 lapse in 30d")).toBeInTheDocument();
    const links = screen.getAllByTestId("reread-panel-card-link");
    expect(links[0]).toHaveAttribute("href", "/card/$id:card-1");
  });

  it("is a complementary landmark and moves focus to its heading on first render", () => {
    renderPanel();
    // The `<aside>` is implicitly a `complementary` landmark (no redundant role attr).
    expect(screen.getByRole("complementary", { name: "Failing cards for this re-read" })).toBe(
      screen.getByTestId("reread-panel"),
    );
    expect(screen.getByRole("heading", { name: /Re-reading this section/ })).toHaveFocus();
  });

  it("close hides the panel WITHOUT completing the task", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByTestId("reread-panel-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.completeTask).not.toHaveBeenCalled();
  });

  it("Mark re-read done completes the task with NO FSRS bump, then calls onCompleted", async () => {
    h.completeTask.mockResolvedValueOnce({ task: {} });
    const { onCompleted } = renderPanel();
    fireEvent.click(screen.getByTestId("reread-panel-done"));
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    // The exact request: only `id`, never a `bumpReviewByDays` (R7).
    expect(h.completeTask).toHaveBeenCalledWith({ id: "task-1" });
    expect(h.completeTask.mock.calls[0]?.[0]).not.toHaveProperty("bumpReviewByDays");
  });

  it("still fires the done action after the StrictMode remount cycle", async () => {
    h.completeTask.mockReset();
    h.completeTask.mockResolvedValueOnce({ task: {} });
    const onCompleted = vi.fn();
    render(
      <StrictMode>
        <RereadPanel
          taskElementId="task-2"
          region={REGION}
          members={MEMBERS}
          windowDays={30}
          onClose={vi.fn()}
          onCompleted={onCompleted}
        />
      </StrictMode>,
    );
    fireEvent.click(screen.getByTestId("reread-panel-done"));
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
  });
});
