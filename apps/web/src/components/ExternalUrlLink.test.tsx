import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExternalUrlLink } from "./ExternalUrlLink";

describe("ExternalUrlLink", () => {
  it("renders web URLs as external links", () => {
    render(<ExternalUrlLink testId="url" url="https://example.com/paper.pdf" icon="link" />);

    const link = screen.getByTestId("url");
    expect(link).toHaveAttribute("href", "https://example.com/paper.pdf");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.querySelector("svg")).toBeInTheDocument();
  });

  it("keeps non-web values as plain text instead of clickable URLs", () => {
    render(<ExternalUrlLink testId="url" url="javascript:alert(1)" />);

    const value = screen.getByTestId("url");
    expect(value.tagName).toBe("SPAN");
    expect(value).toHaveTextContent("javascript:alert(1)");
    expect(value).not.toHaveAttribute("href");
  });
});
