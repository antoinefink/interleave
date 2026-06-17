---
title: "Pre-save lookups must reuse the exact save-time query for correct-by-construction agreement"
date: 2026-06-17
category: architecture-patterns
module: capture
problem_type: architecture_pattern
component: service_object
severity: medium
related_components:
  - "apps/extension"
  - "apps/desktop/src/main"
  - "packages/capture-contract"
  - "packages/local-db"
  - "packages/core"
tags:
  - loopback-capture
  - pre-save-lookup
  - correct-by-construction
  - url-canonicalization
  - dedup-query
  - discriminated-union
applies_when:
  - "Adding an extension-to-desktop capability that must agree with an existing save-time behavior"
  - "A read-only answer shown before an action must match what the action would later compute"
  - "Exposing a new loopback/IPC route alongside existing authenticated routes"
  - "Modeling a present-or-absent wire response that must reject malformed bodies"
---

# Pre-save lookups must reuse the exact save-time query for correct-by-construction agreement

## Context

The Chrome capture extension popup only learned a page was *already saved* **after** the user
clicked Save — the loopback `POST /capture` route returned `deduped: true` (the T061 page-dedup) and
the popup then rendered an "Already saved" confirmation. The goal was to surface that fact **up
front**, when the popup opens, so the user can see it (and open the existing source) before acting.

The hard part is not the UI — it is the guarantee. A pre-save "already saved" hint that disagrees
with what Save actually does is worse than no hint: it tells the user the wrong thing. The durable
lesson is how to make the up-front answer **agree by construction** with the existing behavior,
across the MV3-extension ↔ Electron-main ↔ local-db boundary, without weakening the loopback
threat model.

## Guidance

When you add a read-only capability whose answer must agree with an existing write/save path:

1. **Reuse the EXACT query the write path uses — do not re-derive the match.** The desktop
   `lookupSourceByUrl` canonicalizes the URL with the same `canonicalizeUrl` and calls the same
   `SourceDedupQuery.findSourcesByCanonicalUrl` that T061 save-time dedup calls, and echoes
   `matches[0]` exactly like the save-time `mapResult`. Agreement is then structural, not a second
   implementation that must be kept in sync. A parity test asserts the pre-save lookup resolves the
   same source id a subsequent `/capture` reports as `deduped`.

2. **Frame it as a positive-only hint and document what it cannot reproduce.** The lookup keys on
   the canonical URL only. The two other save-time dedup signals — the cleaned-HTML content-hash
   backstop and post-redirect canonical drift — are unavailable at popup-open time (no fetched HTML,
   no redirect yet). So a `found: false` answer is **never** a guarantee that Save won't dedup. State
   this explicitly in the wire contract's doc comment so the gap is a documented design choice, not a
   future bug report. Save-time stays authoritative; the post-save screen overrides the banner.

3. **Add a NEW narrow loopback route; clone the existing threat model — never widen it.** Following
   the precedent in
   [url-imported-articles-inbox-processing.md](../ui-bugs/url-imported-articles-inbox-processing.md),
   `POST /lookup-source` is a dedicated route, not an overload of `/capture` or a generic query
   channel. It reuses the same loopback-only socket guard, paired-origin CORS, constant-time bearer
   token, body cap, and zod validation as `/open-source`.

4. **Keep the answer correct under reality changes.** The query already filters
   `deleted_at IS NULL`, so a soft-deleted source correctly reports "not saved" (matching re-import
   behavior). A read-only capability must mutate nothing — no vault write, no DB row, no
   `operation_log` entry — and a test asserts that.

5. **A pre-action "Open" must not mutate state.** The pre-save "Open in Interleave" passes
   `activate: false` so it never silently triages-accepts an inbox source; the post-save screen keeps
   `activate: true` because capture intent is explicit there.

### Secondary lessons that emerged in review

- **Model present-or-absent responses as a zod discriminated union, not an optional field.**
  `LookupSourceResponseSchema` is `z.discriminatedUnion("found", [...])` so `found: true` *requires*
  `source` and `found: false` *forbids* it. With an optional `source`, a malformed `{ found: true }`
  body parses and the client silently reads it as "not found"; the union makes that body fail to
  parse → the client maps it to `errored` instead.
- **Parameterize a shared auth guard with a per-route typed error sender.** `authorizeRequest` is
  shared by `/open-source` and `/lookup-source`, but each route has its own error-code contract.
  Inject the route's own `sendError` callback (typed to the codes both contracts share) so the type
  boundary stays correct even though the wire bytes are identical today.
- **Resolve `link[rel="canonical"]` to absolute via `HTMLLinkElement.href`, not
  `getAttribute("href")`.** A relative `href="/x"` read raw both corrupts the displayed URL and fails
  the `^https?://` lookup guard (silently skipping the lookup), and at save time the strict URL
  schema rejects it outright. Reading the element's `.href` property returns the DOM-resolved
  absolute URL, keeping lookup and save keyed off the same value.
- **Centralize the async trigger so recovery paths fire it too.** Driving the lookup from the end of
  `refreshConnection()` (not just initial open) means it also fires after an offline → "Retry
  connection" recovery. Reset transient UI state (the cached "already saved" hint) on "Save another"
  so a returned idle view is re-derived honestly.
- **Guard the async completion against stale renders** (per
  [chrome-extension-popup-options-design-boundary.md](chrome-extension-popup-options-design-boundary.md)):
  bail if the popup moved off the idle phase or its body disconnected before the lookup resolved, and
  bound the whole round-trip (including the body read) with an `AbortController` timer cleared in a
  `finally`.

## Why This Matters

A second implementation of "is this the same thing?" inevitably drifts from the first, and the
drift surfaces as a UI that contradicts itself. Routing the read path through the *same* query the
write path uses removes the drift at the source — there is nothing to keep in sync. Pairing that
with an explicit positive-only contract means the one place the answers *can* differ (content-hash /
redirect signals) is documented and expected, not a latent defect. And cloning the existing loopback
threat model (rather than widening it) means a new capability adds zero new attack surface.

## When to Apply

- Any new extension/IPC/loopback capability whose answer the user will compare against a later action
  (pre-flight checks, "already exists?" indicators, dry-run previews).
- Whenever a read path and a write path must agree on a match/identity decision — reuse the query,
  don't fork it.
- Modeling any wire response where a field is present iff a boolean is set — reach for a discriminated
  union.

## Examples

**Correct-by-construction agreement** — the read path reuses the write path's query:

```ts
// desktop: lookupSourceByUrl (read) reuses the SAME query T061 save-time dedup uses
const canonical = canonicalizeUrl(url);
if (canonical == null) return { ok: true, found: false };
const matches = findSourcesByCanonicalUrl(canonical); // same query as /capture dedup
const first = matches[0];                              // same matches[0] as save-time mapResult
return first
  ? { ok: true, found: true, source: { id: first.elementId, title: first.title, status: first.status } }
  : { ok: true, found: false };
```

**Present-or-absent as a discriminated union** (rejects `{ found: true }` with no source):

```ts
export const LookupSourceResponseSchema = z.discriminatedUnion("found", [
  z.object({ ok: z.literal(true), found: z.literal(true),
             source: z.object({ id: z.string(), title: z.string(), status: z.string() }) }),
  z.object({ ok: z.literal(true), found: z.literal(false) }),
]);
```

**Positive-only contract, documented at the seam** (excerpt of the schema doc comment):

> A `found: false` answer is NOT a guarantee a subsequent save will not dedup. The content-hash
> backstop and post-redirect canonical drift cannot be resolved at popup-open time; those are
> intentional save-time-only false-negatives. This route reproduces the canonical-URL match and
> nothing else.

## Related

- [url-imported-articles-inbox-processing.md](../ui-bugs/url-imported-articles-inbox-processing.md)
  — the parent pattern: each extension→desktop action gets its own narrow capture contract +
  loopback route (the `/open-source` precedent `/lookup-source` is cloned from).
- [chrome-extension-popup-options-design-boundary.md](chrome-extension-popup-options-design-boundary.md)
  — the popup boundary contract: untrusted extension, desktop owns state, `isConnected` stale-render
  guard for async completions.
- [command-palette-source-lookup-search-query.md](../ui-bugs/command-palette-source-lookup-search-query.md)
  — adjacent: reuse the existing typed query path for a read-only lookup rather than forking a new one
  (there over FTS/semantic search; here over the canonical-URL dedup query).
- Plan: `docs/plans/2026-06-17-001-feat-extension-capture-already-saved-plan.md`.
- T061 page-dedup (`docs/roadmap.md`): the canonical-URL dedup query reused here.
