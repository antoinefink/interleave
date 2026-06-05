import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, getStoredTheme, toggleTheme } from "./theme";

function stubSystemTheme(initialDark: boolean) {
  let listener: ((event: MediaQueryListEvent) => void) | null = null;
  const query = {
    matches: initialDark,
    addEventListener: vi.fn(
      (_event: "change", nextListener: (event: MediaQueryListEvent) => void) => {
        listener = nextListener;
      },
    ),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query),
  );

  return {
    query,
    setDark(next: boolean) {
      query.matches = next;
      listener?.({ matches: next } as MediaQueryListEvent);
    },
  };
}

afterEach(() => {
  applyTheme("dark");
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme controller", () => {
  it("prefers a persisted theme preference over the html attribute", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem("interleave.theme", "system");

    expect(getStoredTheme()).toBe("system");
  });

  it("falls back to the html attribute, defaulting to dark", () => {
    document.documentElement.setAttribute("data-theme", "light");
    expect(getStoredTheme()).toBe("light");

    document.documentElement.removeAttribute("data-theme");
    expect(getStoredTheme()).toBe("dark");
  });

  it("applies and persists a theme", () => {
    applyTheme("dark");

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("interleave.theme")).toBe("dark");
  });

  it("resolves system mode from prefers-color-scheme and follows OS changes", () => {
    const system = stubSystemTheme(true);

    applyTheme("system");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("interleave.theme")).toBe("system");
    expect(system.query.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));

    system.setDark(false);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("keeps the current resolved theme when system mode is unavailable", () => {
    document.documentElement.setAttribute("data-theme", "dark");

    applyTheme("system");

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("interleave.theme")).toBe("system");
  });

  it("stops following system mode when an explicit theme is applied", () => {
    const system = stubSystemTheme(false);

    applyTheme("system");
    applyTheme("dark");

    expect(system.query.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("interleave.theme")).toBe("dark");
  });

  it("toggles the current theme and returns the new value", () => {
    applyTheme("dark");

    expect(toggleTheme()).toBe("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("toggles from the currently resolved system theme into an explicit theme", () => {
    stubSystemTheme(true);
    applyTheme("system");

    expect(toggleTheme()).toBe("light");
    expect(localStorage.getItem("interleave.theme")).toBe("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});
