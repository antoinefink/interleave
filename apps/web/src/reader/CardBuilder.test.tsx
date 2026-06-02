/**
 * CardBuilder component tests (T033 — Q&A card creation).
 *
 * Covers the renderer seam the spec calls out for the Q&A tab:
 *  - the Q&A tab shows Front + Back fields and a live preview;
 *  - editing the front updates the preview (the prompt face);
 *  - reveal toggles the preview to the back (the answer face);
 *  - pressing Create calls the typed `cards.create` client with
 *    `{ kind: "qa", prompt, answer }` + the chosen priority, and the returned
 *    `siblingGroupId` is threaded into the NEXT create (the Q&A + cloze pair are
 *    recorded as siblings);
 *  - the Create button is disabled while a required field is empty (the coarse
 *    boundary check — the rich quality gate is T035).
 *
 * The component is presentational: it ships only the authored strings + the
 * `extractId` + the priority label over the mocked `cards.create`. No SQLite/IPC —
 * the renderer is a pure UI consumer here, exactly as the layering rules require.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createCard: vi.fn(),
  getRegionImage: vi.fn(),
  generateOcclusionCards: vi.fn(),
  onToast: vi.fn(),
  onCardCreated: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock("../lib/appApi", () => ({
  isDesktop: () => true,
  appApi: {
    createCard: h.createCard,
    getRegionImage: h.getRegionImage,
    generateOcclusionCards: h.generateOcclusionCards,
  },
}));

import { CardBuilder } from "./CardBuilder";

function renderBuilder(props?: Partial<React.ComponentProps<typeof CardBuilder>>) {
  return render(
    <CardBuilder
      extractId="ex_1"
      extractPriority={0.625} // → "B"
      seedBody="As skill-acquisition efficiency over a scope of tasks."
      initialTab="qa"
      onToast={h.onToast}
      onCardCreated={h.onCardCreated}
      onClose={h.onClose}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.createCard.mockResolvedValue({
    card: {
      id: "card_1",
      type: "card",
      status: "pending",
      stage: "card_draft",
      priority: 0.625,
      title: "Q?",
      kind: "qa",
      parentId: "ex_1",
      sourceId: "src_1",
      siblingGroupId: "sg_1",
    },
    sourceLocationId: "loc_1",
  });
  h.getRegionImage.mockResolvedValue({ bytes: new ArrayBuffer(8), mime: "image/png" });
  h.generateOcclusionCards.mockResolvedValue({ siblingGroupId: "sg_1", cards: [] });
  if (!("createObjectURL" in URL)) {
    // biome-ignore lint/suspicious/noExplicitAny: jsdom shim
    (URL as any).createObjectURL = () => "blob:mock";
    // biome-ignore lint/suspicious/noExplicitAny: jsdom shim
    (URL as any).revokeObjectURL = () => {};
  }
});

describe("CardBuilder — Q&A tab", () => {
  it("shows the Front + Back fields and a preview, defaulting to the extract's priority band", () => {
    renderBuilder();
    expect(screen.getByTestId("cb-qa-front")).toBeInTheDocument();
    expect(screen.getByTestId("cb-qa-back")).toBeInTheDocument();
    expect(screen.getByTestId("cb-preview")).toBeInTheDocument();
    // The default priority chip is the extract's band (0.625 → "B").
    expect(screen.getByTestId("cb-priority-B")).toHaveAttribute("data-active", "true");
    // The back field is seeded from the extract body.
    expect((screen.getByTestId("cb-qa-back") as HTMLTextAreaElement).value).toContain(
      "skill-acquisition efficiency",
    );
  });

  it("updates the preview as the front is edited and reveal toggles to the back", () => {
    renderBuilder();
    const front = screen.getByTestId("cb-qa-front");
    fireEvent.change(front, { target: { value: "How does Chollet define intelligence?" } });
    // The preview shows the front (prompt face) by default.
    expect(screen.getByTestId("cb-preview").textContent).toContain(
      "How does Chollet define intelligence?",
    );
    // Reveal flips to the back (answer face).
    fireEvent.click(screen.getByTestId("cb-reveal"));
    expect(screen.getByTestId("cb-preview").textContent).toContain("skill-acquisition efficiency");
  });

  it("disables Create until both Front and Back are non-empty", () => {
    renderBuilder({ seedBody: "" });
    const create = screen.getByTestId("cb-create");
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByTestId("cb-qa-front"), { target: { value: "Q?" } });
    expect(create).toBeDisabled(); // back still empty
    fireEvent.change(screen.getByTestId("cb-qa-back"), { target: { value: "A." } });
    expect(create).not.toBeDisabled();
  });

  it("pressing Create calls cards.create with { kind: 'qa', prompt, answer } + the priority", async () => {
    renderBuilder();
    fireEvent.change(screen.getByTestId("cb-qa-front"), {
      target: { value: "How does Chollet define intelligence?" },
    });
    fireEvent.change(screen.getByTestId("cb-qa-back"), {
      target: { value: "As skill-acquisition efficiency." },
    });
    // Choose an A-priority override.
    fireEvent.click(screen.getByTestId("cb-priority-A"));
    fireEvent.click(screen.getByTestId("cb-create"));

    await waitFor(() => expect(h.createCard).toHaveBeenCalledTimes(1));
    expect(h.createCard).toHaveBeenCalledWith(
      expect.objectContaining({
        extractId: "ex_1",
        kind: "qa",
        prompt: "How does Chollet define intelligence?",
        answer: "As skill-acquisition efficiency.",
        priority: "A",
      }),
    );
    // The very first create from this extract has NO sibling group yet.
    expect(h.createCard.mock.calls[0]?.[0]).not.toHaveProperty("siblingGroupId");
    await waitFor(() => expect(h.onCardCreated).toHaveBeenCalled());
    expect(h.onToast).toHaveBeenCalledWith("Q&A card created");
  });

  it("threads the returned siblingGroupId into the next create (sibling pair)", async () => {
    renderBuilder();
    fireEvent.change(screen.getByTestId("cb-qa-front"), { target: { value: "Q1?" } });
    fireEvent.change(screen.getByTestId("cb-qa-back"), { target: { value: "A1." } });
    fireEvent.click(screen.getByTestId("cb-create"));
    await waitFor(() => expect(h.createCard).toHaveBeenCalledTimes(1));

    // Author a SECOND card — it must carry the first card's sibling group id.
    fireEvent.change(screen.getByTestId("cb-qa-front"), { target: { value: "Q2?" } });
    // (back persists across creates by design — re-type it to be explicit)
    fireEvent.change(screen.getByTestId("cb-qa-back"), { target: { value: "A2." } });
    fireEvent.click(screen.getByTestId("cb-create"));
    await waitFor(() => expect(h.createCard).toHaveBeenCalledTimes(2));
    expect(h.createCard.mock.calls[1]?.[0]).toMatchObject({ siblingGroupId: "sg_1" });
  });

  it("renders the Cloze tab and the FSRS scheduler chip; close calls onClose", () => {
    renderBuilder();
    expect(screen.getByTestId("cb-scheduler-fsrs")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("cb-tab-cloze"));
    expect(screen.getByTestId("cb-cloze-text")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("cb-close"));
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("the 'Predict output' template (T072) seeds the prompt with a fenced code block", async () => {
    renderBuilder({ seedBody: "def step(w, grad, lr):\n    return w - lr * grad" });
    fireEvent.click(screen.getByTestId("cb-predict-output"));
    const front = screen.getByTestId("cb-qa-front") as HTMLTextAreaElement;
    // The prompt now wraps the extract code in a fence (renders highlighted in review).
    expect(front.value).toContain("```");
    expect(front.value).toContain("def step(w, grad, lr):");
    // The answer is cleared (the user fills in the expected output).
    expect((screen.getByTestId("cb-qa-back") as HTMLTextAreaElement).value).toBe("");
  });
});

describe("CardBuilder — Cloze tab (T034)", () => {
  it("renders each deletion as the placeholder and reveals answers on toggle", () => {
    renderBuilder({
      initialTab: "cloze",
      initialClozeText: "Memory moves from the {{c1::hippocampus}} to the {{c2::neocortex}}.",
    });
    // Two deletions, both hidden as the `[ … ]` placeholder.
    const deletions = screen.getAllByTestId("cb-cloze-deletion");
    expect(deletions).toHaveLength(2);
    expect(deletions.every((d) => d.textContent === "[ … ]")).toBe(true);
    expect(screen.getByTestId("cb-cloze-count").textContent).toContain("2 cloze deletions");
    // Reveal flips every deletion to its answer.
    fireEvent.click(screen.getByTestId("cb-reveal"));
    const revealed = screen.getAllByTestId("cb-cloze-deletion");
    expect(revealed.map((d) => d.textContent)).toEqual(["hippocampus", "neocortex"]);
  });

  it("disables Create until the cloze text has a deletion, then sends canonical text", async () => {
    renderBuilder({ initialTab: "cloze", initialClozeText: "" });
    const create = screen.getByTestId("cb-create");
    expect(create).toBeDisabled();
    // A bare `{{answer}}` is auto-numbered to `{{c1::…}}` before sending.
    fireEvent.change(screen.getByTestId("cb-cloze-text"), {
      target: { value: "Intelligence is {{skill-acquisition efficiency}}." },
    });
    expect(create).not.toBeDisabled();
    fireEvent.click(create);
    await waitFor(() => expect(h.createCard).toHaveBeenCalledTimes(1));
    expect(h.createCard).toHaveBeenCalledWith(
      expect.objectContaining({
        extractId: "ex_1",
        kind: "cloze",
        cloze: "Intelligence is {{c1::skill-acquisition efficiency}}.",
      }),
    );
    expect(h.onToast).toHaveBeenCalledWith("Cloze card created");
  });
});

describe("CardBuilder — quality checks (T035)", () => {
  it("renders the qc rows and updates them as fields change", () => {
    renderBuilder({ hasSource: true, seedBody: "" });
    // Empty Q&A → a `block` "empty" row; source attached → an `ok` source row.
    expect(screen.getByTestId("cb-qc-empty")).toHaveAttribute("data-severity", "block");
    expect(screen.getByTestId("cb-qc-missing-source")).toHaveAttribute("data-severity", "ok");

    // Fill both fields → the empty blocker clears to ok.
    fireEvent.change(screen.getByTestId("cb-qa-front"), { target: { value: "What is X?" } });
    fireEvent.change(screen.getByTestId("cb-qa-back"), { target: { value: "A short answer." } });
    expect(screen.getByTestId("cb-qc-empty")).toHaveAttribute("data-severity", "ok");
  });

  it("warns 'missing source' when the extract has no source location", () => {
    renderBuilder({ hasSource: false });
    expect(screen.getByTestId("cb-qc-missing-source")).toHaveAttribute("data-severity", "warn");
  });

  it("warns on an over-long prompt without blocking Create", () => {
    renderBuilder({ hasSource: true });
    fireEvent.change(screen.getByTestId("cb-qa-front"), {
      target: { value: "Q?".padEnd(200, "x") },
    });
    fireEvent.change(screen.getByTestId("cb-qa-back"), { target: { value: "A." } });
    expect(screen.getByTestId("cb-qc-prompt-too-long")).toHaveAttribute("data-severity", "warn");
    // A warning is advisory — Create stays enabled.
    expect(screen.getByTestId("cb-create")).not.toBeDisabled();
  });

  it("disables Create while a block-severity check is present and re-enables when fixed", () => {
    renderBuilder({ hasSource: true, seedBody: "" });
    const create = screen.getByTestId("cb-create");
    expect(create).toBeDisabled(); // empty Q&A → block
    fireEvent.change(screen.getByTestId("cb-qa-front"), { target: { value: "What is X?" } });
    fireEvent.change(screen.getByTestId("cb-qa-back"), { target: { value: "A short answer." } });
    expect(create).not.toBeDisabled();
  });

  it("flags 'multiple clozes' as a warning on the Cloze tab", () => {
    renderBuilder({
      initialTab: "cloze",
      hasSource: true,
      initialClozeText: "Memory moves from the {{c1::hippocampus}} to the {{c2::neocortex}}.",
    });
    expect(screen.getByTestId("cb-qc-multiple-clozes")).toHaveAttribute("data-severity", "warn");
    // Two deletions is still authorable (warnings never block).
    expect(screen.getByTestId("cb-create")).not.toBeDisabled();
  });
});

describe("CardBuilder — image extract (T071)", () => {
  it("mounts the OcclusionEditor (not the text tabs) for an image extract", async () => {
    renderBuilder({ isImageExtract: true });
    // The dedicated occlusion editor replaces the Q&A/Cloze surface.
    expect(await screen.findByTestId("occlusion-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("card-builder")).toBeNull();
    expect(screen.queryByTestId("cb-tab-qa")).toBeNull();
  });

  it("keeps the text-card tabs for a non-image extract (occlusion tab disabled)", () => {
    renderBuilder({ isImageExtract: false });
    expect(screen.getByTestId("card-builder")).toBeInTheDocument();
    expect(screen.getByTestId("cb-tab-qa")).toBeInTheDocument();
    expect(screen.getByTestId("cb-tab-occlusion-disabled")).toBeDisabled();
  });
});
