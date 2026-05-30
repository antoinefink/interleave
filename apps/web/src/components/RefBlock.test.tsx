/**
 * RefBlock (T043) — the shared source-reference component tests.
 *
 * Verifies the block renders the citation/URL/location/snippet for a resolved
 * reference, wires the open-source affordance, and degrades to a calm placeholder
 * (never a broken link) for a source-less element.
 */

import { fireEvent, render, screen } from "@testing-library/react";
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
});
