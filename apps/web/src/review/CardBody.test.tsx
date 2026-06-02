/**
 * CardBody + CardFront review-render tests (T072).
 *
 * The review faces render math + highlighted code from a card prompt/answer STRING
 * via the shared KaTeX/Shiki path — never as a raw LaTeX/source string. Covers:
 *  - a `$$…$$` body renders a KaTeX math node;
 *  - a ```` ```python ```` body renders a code block (highlighted async, plain raw
 *    first) with the code intact;
 *  - a code CLOZE masks `{{cN::…}}` on the front, then reveals the (highlighted) code.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CardBody } from "./CardBody";
import { CardFront } from "./CardFront";

describe("CardBody (T072)", () => {
  it("renders a $$…$$ body as a KaTeX block formula (not raw LaTeX)", () => {
    render(<CardBody body={"$$E=mc^2$$"} />);
    const math = screen.getByTestId("card-body-math");
    expect(math.getAttribute("data-display")).toBe("true");
    // KaTeX wraps its output in `.katex` markup.
    expect(math.querySelector(".katex")).not.toBeNull();
  });

  it("renders inline $…$ math between surrounding text", () => {
    render(<CardBody body={"the relation $a^2+b^2$ holds"} />);
    expect(screen.getByText(/the relation/)).toBeInTheDocument();
    const math = screen.getByTestId("card-body-math");
    expect(math.getAttribute("data-display")).toBe("false");
  });

  it("renders a fenced code body with the code intact (raw first, highlighted when ready)", async () => {
    render(<CardBody body={"```python\nprint('hi')\n```"} />);
    const code = screen.getByTestId("card-body-code");
    expect(code).toHaveTextContent("print('hi')");
    // Shiki resolves asynchronously and swaps in a `.shiki` pre with styled spans.
    await waitFor(() => {
      const el = screen.getByTestId("card-body-code");
      expect(el.querySelector(".shiki") ?? el.querySelector("span")).not.toBeNull();
    });
  });

  it("renders plain prose verbatim (no math/code)", () => {
    render(<CardBody body={"just a plain answer"} />);
    expect(screen.getByText("just a plain answer")).toBeInTheDocument();
    expect(screen.queryByTestId("card-body-math")).toBeNull();
    expect(screen.queryByTestId("card-body-code")).toBeNull();
  });
});

describe("CardFront with code cloze (T072)", () => {
  const codeCloze = "The update is ```python\nw = w - {{c1::lr}} * grad\n```";

  it("masks the cloze deletion on the front", () => {
    render(<CardFront card={{ kind: "cloze", prompt: codeCloze }} revealed={false} />);
    // The masked deletion shows the placeholder, not `lr`.
    expect(screen.getByText("[ … ]")).toBeInTheDocument();
  });

  it("reveals the deletion on reveal (the masked code token is shown)", () => {
    render(<CardFront card={{ kind: "cloze", prompt: codeCloze }} revealed={true} />);
    // The revealed deletion content `lr` appears (no longer masked).
    expect(screen.getByText("lr")).toBeInTheDocument();
    expect(screen.queryByText("[ … ]")).toBeNull();
  });

  it("renders a code cloze whose code body is a SINGLE fenced block (deletion outside the fence)", async () => {
    // When the cloze deletion is OUTSIDE the fence, the literal fenced block renders
    // as one highlighted code block while the deletion masks/reveals around it.
    const cloze = "The function name is {{c1::step}}:\n```python\ndef f(w):\n    return w\n```";
    render(<CardFront card={{ kind: "cloze", prompt: cloze }} revealed={true} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("card-body-code").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("step")).toBeInTheDocument();
  });
});

describe("CardFront Q&A prompt with math (T072)", () => {
  it("renders a math prompt through the body renderer", () => {
    render(
      <CardFront card={{ kind: "qa", prompt: "Compute $$\\int_0^1 x\\,dx$$" }} revealed={false} />,
    );
    const math = screen.getByTestId("card-body-math");
    expect(
      within(math).getByText((_, el) => el?.classList.contains("katex") ?? false),
    ).toBeTruthy();
  });
});
