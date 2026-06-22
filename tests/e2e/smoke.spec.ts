import { expect, type Page, test } from "@playwright/test";

/**
 * App-shell E2E (T002 smoke, extended in T003/T004).
 *
 * Verifies the real React + TanStack Router app boots, that every main route
 * renders inside the persistent shell (sidebar / work area / inspector /
 * status bar, with route-owned top chrome where applicable), and that the keyboard-first chrome works: every
 * route is reachable by keyboard, ⌘K opens the command palette, ? opens the
 * cheat sheet, and the shell renders in both light and dark (data-theme).
 *
 * This is the gate the Definition of Done refers to: if the app fails to boot,
 * a route fails to load, the shell is missing, or the keyboard workflow breaks,
 * `pnpm e2e` (and CI) fails.
 */

/**
 * Typed routes, their in-page route-content test ids, and whether the route shows
 * the inspector. The third element keeps the inspector expectation next to the
 * route so adding a route can't silently desync the assertion (the prior inline
 * `url !== "/settings"` would have). Covers both selection-driving routes (inspector
 * shown) and several hide routes (inspector unmounted), so the route-conditional
 * mount is exercised in the real shell on more than one hide route.
 */
const ROUTES: ReadonlyArray<[string, string, { inspector: boolean }]> = [
  ["/", "route-home", { inspector: true }],
  ["/inbox", "route-inbox", { inspector: true }],
  ["/queue", "route-queue", { inspector: true }],
  ["/source/demo-1", "route-source", { inspector: true }],
  ["/review", "route-review", { inspector: true }],
  ["/search", "route-search", { inspector: true }],
  ["/settings", "route-settings", { inspector: false }],
  ["/analytics", "route-analytics", { inspector: false }],
  ["/trash", "route-trash", { inspector: false }],
];

/**
 * Asserts the persistent shell chrome is present on the current page. The command
 * bar and the inspector are route-conditional chrome — pass `commandBar: false`
 * for the focused work sessions that hide the topbar (`/queue`, `/process`) and
 * `inspector: false` for routes that hide the inspector (e.g. `/settings`), so the
 * assertion matches what the route actually renders.
 */
async function expectShell(
  page: Page,
  options: { commandBar?: boolean; inspector?: boolean } = {},
) {
  if (options.commandBar !== false) {
    await expect(page.getByTestId("command-bar")).toBeVisible();
  }
  if (options.inspector === false) {
    await expect(page.getByTestId("inspector")).toHaveCount(0);
  } else {
    await expect(page.getByTestId("inspector")).toBeVisible();
  }
  await expect(page.getByTestId("status-bar")).toBeVisible();
  await expect(page.getByTestId("user-chip")).toBeVisible();
}

test("app boots and the home route renders inside the shell", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/Interleave/);
  await expect(page.getByTestId("route-home")).toBeVisible();
  await expectShell(page);
});

test("every main route renders inside the same shell", async ({ page }) => {
  for (const [url, testId, { inspector }] of ROUTES) {
    await page.goto(url);
    await expect(page.getByTestId(testId)).toBeVisible();
    await expectShell(page, { commandBar: url !== "/queue", inspector });
  }
});

test("navigates between routes via the sidebar", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-queue").click();
  await expect(page).toHaveURL(/\/queue$/);
  await expect(page.getByTestId("route-queue")).toBeVisible();

  await page.getByTestId("nav-review").click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByTestId("route-review")).toBeVisible();
});

test("the sidebar highlights at most one nav item — and /search has no sidebar owner", async ({
  page,
}) => {
  // Regression for sidebar active-state bugs: active-state is resolved by item
  // identity (resolveActiveNavId), so sidebar-owned routes highlight one item and
  // route-only screens such as Search highlight none.
  const activeNav = page.locator('.shell-nav [aria-current="page"]');

  await page.goto("/search");
  await expect(page.getByTestId("route-search")).toBeVisible();
  await expect(page.getByTestId("nav-search")).toHaveCount(0);
  await expect(page.getByTestId("nav-library")).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-concepts")).not.toHaveAttribute("aria-current", "page");
  await expect(activeNav).toHaveCount(0);

  // Each uniquely-owned route highlights exactly its own entry — including the new
  // `/` home command center (its canonical owner, nav-home), so the index no longer
  // highlights nothing.
  for (const [route, testId] of [
    ["/", "nav-home"],
    ["/queue", "nav-queue"],
    ["/inbox", "nav-inbox"],
    ["/review", "nav-review"],
  ] as const) {
    await page.goto(route);
    await expect(page.getByTestId(testId)).toHaveAttribute("aria-current", "page");
    await expect(activeNav).toHaveCount(1);
  }
});

test("routes are reachable by keyboard (g + letter navigation)", async ({ page }) => {
  await page.goto("/");

  // g then q → queue
  await page.keyboard.press("g");
  await page.keyboard.press("q");
  await expect(page).toHaveURL(/\/queue$/);
  await expect(page.getByTestId("route-queue")).toBeVisible();

  // g then r → review
  await page.keyboard.press("g");
  await page.keyboard.press("r");
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByTestId("route-review")).toBeVisible();

  // g then i → inbox
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByTestId("route-inbox")).toBeVisible();
});

test("⌘K opens the command palette and can navigate from it", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();

  // Filtering + Enter runs the top match.
  await page.getByLabel("Command palette search").fill("Review session");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-palette")).toBeHidden();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByTestId("route-review")).toBeVisible();

  // Esc closes it again.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toBeHidden();
});

test("? opens the keyboard cheat sheet", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("?");
  await expect(page.getByTestId("cheat-sheet")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cheat-sheet")).toBeHidden();
});

test("the shell renders in both light and dark themes", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");

  const before = await html.getAttribute("data-theme");

  // The theme toggle lives in the user-chip menu.
  await page.getByTestId("user-chip").click();
  await page
    .getByTestId(before === "light" ? "shell-theme-option-dark" : "shell-theme-option-light")
    .click();

  const after = await html.getAttribute("data-theme");
  expect(after).not.toBe(before);
  expect(["light", "dark"]).toContain(after);

  // Shell chrome stays intact after the theme flip.
  await expectShell(page);
});
