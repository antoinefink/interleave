/**
 * Pure deep-link + in-app route helpers for the lineage-tree context menu's
 * "Copy reference" action (plan KTD4).
 *
 * `interleave://element/<id>` is the canonical, stable reference-string
 * convention for an element. Keeping it in one pure, unit-tested place means a
 * future OS protocol handler can reuse the exact same string — registering that
 * `interleave://` handler is desktop-main work and is **deferred** (out of scope
 * for a renderer context menu, per KTD4). For now "Copy reference" just writes
 * this string to the clipboard.
 *
 * No imports from `appApi`, IPC, Node, or Electron — these are pure string
 * helpers safe to use anywhere in the renderer.
 */

/**
 * The canonical, stable reference string for an element:
 * `interleave://element/<id>`.
 *
 * The `id` is trimmed before use. An empty / whitespace-only id has no valid
 * reference, so this **throws** rather than emitting a malformed
 * `interleave://element/` link.
 *
 * @throws {Error} `"elementDeepLink: empty element id"` when `id` is empty or
 *   only whitespace.
 */
export function elementDeepLink(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") {
    throw new Error("elementDeepLink: empty element id");
  }
  return `interleave://element/${trimmed}`;
}

/**
 * Map a lineage-node `type` to the in-app TanStack route path the Inspector
 * navigates to (see `apps/web/src/router.tsx`). The real routes are
 * `/source/$id`, `/extract/$id`, and `/card/$id`; topics share the source
 * reader surface, so `"topic"` also maps to `/source/<id>`.
 *
 *   - `"source"` | `"topic"` → `/source/<id>`
 *   - `"extract"`            → `/extract/<id>`
 *   - `"card"`               → `/card/<id>`
 *
 * There is **no** `/element/$id` route. For any unknown / unexpected type we
 * therefore must NOT fabricate a route (which would mis-navigate to a 404 or,
 * worse, the wrong surface). Instead we return the non-navigating
 * {@link elementDeepLink} string as a safe fallback — a caller that blindly
 * passes it to the router will simply not match a route rather than land
 * somewhere wrong, and a caller can detect the `interleave://` prefix to skip
 * navigation entirely.
 *
 * The `id` is trimmed; an empty id throws via {@link elementDeepLink}.
 */
export function elementRoutePath(type: string, id: string): string {
  const trimmed = id.trim();
  switch (type) {
    case "source":
    case "topic":
      return `/source/${trimmed}`;
    case "extract":
      return `/extract/${trimmed}`;
    case "card":
      return `/card/${trimmed}`;
    default:
      // No `/element/$id` route exists — fall back to the non-navigating
      // canonical reference string rather than mis-navigating.
      return elementDeepLink(id);
  }
}
