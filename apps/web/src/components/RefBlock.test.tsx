/**
 * RefBlock (T043) — the shared source-reference component tests.
 *
 * Verifies the block renders the citation/URL/location/snippet for a resolved
 * reference, wires the open-source affordance, and degrades to a calm placeholder
 * (never a broken link) for a source-less element.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SourceRef } from "../lib/appApi";
import { RefBlock } from "./RefBlock";

const FULL: SourceRef = {
  sourceElementId: "src-1",
  sourceTitle: "On the Measure of Intelligence",
  url: "https://arxiv.org/abs/1911.01547",
  author: "François Chollet",
  publishedAt: "2019-11-05T00:00:00.000Z",
  locationLabel: "Definition · ¶1",
  snippet: "Intelligence is skill-acquisition efficiency.",
  sourceType: null,
  reliabilityTier: null,
  confidence: null,
  reliabilityNotes: null,
};

describe("RefBlock", () => {
  it("renders citation + URL + location + snippet for a resolved reference", () => {
    render(<RefBlock ref={FULL} testId="rb" />);
    expect(screen.getByTestId("rb")).toBeInTheDocument();
    expect(screen.getByTestId("rb-quote")).toHaveTextContent(
      "Intelligence is skill-acquisition efficiency.",
    );
    const cite = screen.getByTestId("rb-citation");
    expect(cite).toHaveTextContent("François Chollet");
    expect(cite).toHaveTextContent("On the Measure of Intelligence (2019)");
    expect(cite).toHaveTextContent("Definition · ¶1");
    expect(screen.getByTestId("rb-url")).toHaveAttribute(
      "href",
      "https://arxiv.org/abs/1911.01547",
    );
  });

  it("wires the open-source affordance when onOpenSource is provided", () => {
    const onOpenSource = vi.fn();
    render(<RefBlock ref={FULL} testId="rb" onOpenSource={onOpenSource} />);
    fireEvent.click(screen.getByTestId("rb-open-source"));
    expect(onOpenSource).toHaveBeenCalledTimes(1);
  });

  it("omits the open-source affordance when no handler is given", () => {
    render(<RefBlock ref={FULL} testId="rb" />);
    expect(screen.queryByTestId("rb-open-source")).not.toBeInTheDocument();
  });

  it("renders a calm placeholder (no broken link) for a source-less element", () => {
    render(<RefBlock ref={null} testId="rb" />);
    expect(screen.getByTestId("rb-empty")).toHaveTextContent(/source unavailable/i);
    expect(screen.queryByTestId("rb")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rb-url")).not.toBeInTheDocument();
  });

  it("can suppress the snippet (the library detail row reuses the citation only)", () => {
    render(<RefBlock ref={FULL} testId="rb" showSnippet={false} />);
    expect(screen.queryByTestId("rb-quote")).not.toBeInTheDocument();
    expect(screen.getByTestId("rb-citation")).toBeInTheDocument();
  });

  it("suppresses a duplicate snippet while keeping citation and URL visible", () => {
    render(
      <RefBlock
        ref={FULL}
        testId="rb"
        dedupeSnippetAgainst="Intelligence is skill acquisition efficiency"
      />,
    );

    expect(screen.queryByTestId("rb-quote")).not.toBeInTheDocument();
    expect(screen.getByTestId("rb-citation")).toHaveTextContent("François Chollet");
    expect(screen.getByTestId("rb-url")).toHaveAttribute(
      "href",
      "https://arxiv.org/abs/1911.01547",
    );
  });

  it("keeps the snippet when the nearby answer is materially different", () => {
    render(<RefBlock ref={FULL} testId="rb" dedupeSnippetAgainst="A different answer." />);

    expect(screen.getByTestId("rb-quote")).toHaveTextContent(
      "Intelligence is skill-acquisition efficiency.",
    );
  });

  it("renders the reliability badge + note for a reliable source (T091)", () => {
    render(
      <RefBlock
        ref={{
          ...FULL,
          reliabilityTier: "secondary",
          confidence: "low",
          reliabilityNotes: "Author has a known bias.",
        }}
        testId="rb"
      />,
    );
    const badge = screen.getByTestId("rb-reliability");
    expect(badge).toHaveTextContent("Secondary source · low confidence");
    expect(badge).toHaveAttribute("data-reliability-tier", "secondary");
    // Low confidence + a note → the uncertainty note is shown.
    expect(screen.getByTestId("rb-reliability-note")).toHaveTextContent("Author has a known bias.");
    // The note stays a block BELOW the meta row, not inside it (KTD2 placement).
    const meta = screen.getByTestId("rb-meta");
    expect(within(meta).queryByTestId("rb-reliability-note")).not.toBeInTheDocument();
  });

  it("renders NOTHING extra for a source with no reliability data (T091)", () => {
    render(<RefBlock ref={FULL} testId="rb" />);
    expect(screen.queryByTestId("rb-reliability")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rb-reliability-note")).not.toBeInTheDocument();
  });

  it("groups citation, badge, and URL inside the single wrapping meta row", () => {
    render(
      <RefBlock ref={{ ...FULL, reliabilityTier: "secondary", confidence: "low" }} testId="rb" />,
    );
    const meta = screen.getByTestId("rb-meta");
    // Citation, reliability badge, and URL collapse into the one meta row.
    expect(within(meta).getByTestId("rb-citation")).toBeInTheDocument();
    expect(within(meta).getByTestId("rb-url")).toBeInTheDocument();
    const badge = within(meta).getByTestId("rb-reliability");
    expect(badge).toHaveTextContent("Secondary source · low confidence");
    expect(badge).toHaveAttribute("data-reliability-tier", "secondary");
    // DOM order == visual/reading order (badge -> citation -> URL, no CSS `order`): WCAG 1.3.2.
    expect(Array.from(meta.children).map((c) => c.getAttribute("data-testid"))).toEqual([
      "rb-reliability",
      "rb-citation",
      "rb-url",
    ]);
  });

  it("keeps the snippet quote outside the meta row (block above)", () => {
    render(<RefBlock ref={FULL} testId="rb" />);
    const meta = screen.getByTestId("rb-meta");
    expect(screen.getByTestId("rb-quote")).toBeInTheDocument();
    expect(within(meta).queryByTestId("rb-quote")).not.toBeInTheDocument();
  });

  it("renders a URL-only ref as a lone link inside the meta row", () => {
    render(
      <RefBlock
        ref={{
          sourceElementId: null,
          sourceTitle: null,
          url: "https://example.com/x",
          author: null,
          publishedAt: null,
          locationLabel: null,
          snippet: null,
          sourceType: null,
          reliabilityTier: null,
          confidence: null,
          reliabilityNotes: null,
        }}
        testId="rb"
      />,
    );
    const meta = screen.getByTestId("rb-meta");
    expect(within(meta).getByTestId("rb-url")).toBeInTheDocument();
    expect(screen.queryByTestId("rb-citation")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rb-reliability")).not.toBeInTheDocument();
  });

  it("renders the locator alone in the meta row when only a location label resolves", () => {
    render(
      <RefBlock
        ref={{
          sourceElementId: null,
          sourceTitle: null,
          url: null,
          author: null,
          publishedAt: null,
          locationLabel: "Chapter 3 · ¶4",
          snippet: null,
          sourceType: null,
          reliabilityTier: null,
          confidence: null,
          reliabilityNotes: null,
        }}
        testId="rb"
      />,
    );
    const meta = screen.getByTestId("rb-meta");
    // citation is empty but the locator-only fallback fills the citation slot.
    expect(within(meta).getByTestId("rb-citation")).toHaveTextContent("Chapter 3 · ¶4");
    expect(screen.queryByTestId("rb-url")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rb-reliability")).not.toBeInTheDocument();
  });

  it("omits the meta row entirely when only a snippet resolves (no stray spacing)", () => {
    render(
      <RefBlock
        ref={{
          sourceElementId: null,
          sourceTitle: null,
          url: null,
          author: null,
          publishedAt: null,
          locationLabel: null,
          snippet: "A bare snippet with no citation, badge, or link.",
          sourceType: null,
          reliabilityTier: null,
          confidence: null,
          reliabilityNotes: null,
        }}
        testId="rb"
      />,
    );
    expect(screen.getByTestId("rb-quote")).toBeInTheDocument();
    expect(screen.queryByTestId("rb-meta")).not.toBeInTheDocument();
  });
});
