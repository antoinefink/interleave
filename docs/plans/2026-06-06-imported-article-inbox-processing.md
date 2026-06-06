---
title: Imported Article Inbox Processing
type: fix
status: completed
date: 2026-06-06
---

# Imported Article Inbox Processing

## Summary

Imported URL articles should look and behave like internal sources ready for reading, not like manual notes or external links. The inbox should label URL imports accurately, show the complete formatted article body, and provide a direct internal action to start reading.

---

## Problem Frame

The URL import pipeline already fetches a page, stores `original.html` and `cleaned.html`, converts the cleaned article into ProseMirror JSON, and persists the full document. The inbox read path then flattens that content to a truncated plain-text preview and labels every source as `Manual note`, so a successfully imported blog post appears misclassified and incomplete until the user opens the source elsewhere. The right rail also exposes canonical/external URLs but no internal path to process the article in the source reader.

---

## Requirements

- R1. URL-imported sources must not be labeled `Manual note` in inbox summaries or detail headers.
- R2. Manual text imports without URL/snapshot provenance must continue to read as manual notes.
- R3. The inbox detail preview must render the complete persisted document body without truncating words or reducing the article to plain text.
- R4. The right preview rail must include a clear internal action that opens the selected source in the source reader for processing.
- R5. The internal open action must use the existing typed bridge and router paths; it must not expose raw filesystem, SQLite, or vault paths to the renderer.
- R6. Existing canonical/original external URL links must remain available and visually distinct from the internal read action.

---

## Key Technical Decisions

- **Derive labels from provenance:** `InboxQuery` should derive `srcType` from `sources.source_type`, `media_kind`, `snapshot_key`, and URL provenance rather than hard-coding `Manual note`. This keeps label semantics main-side and testable.
- **Mark URL imports as articles:** `UrlImportService` should persist `sourceType: "article"` for imported web pages. The app cannot reliably distinguish every blog post from every article today, but `Web article` is accurate and avoids the manual-note bug.
- **Return full ProseMirror detail:** `InboxQuery.get` should include the stored `documents.prosemirrorJson` as an opaque JSON payload and keep the plain-text preview only as fallback. The renderer can render the same constrained document shape the source reader uses.
- **Use `Read now` for the action:** Queue copy already uses `Read` for source work, while `Open original` means external URL. A right-rail `Read now` button should activate the inbox item and route to `/source/$id`.

---

## Implementation Units

### U1. Main-side inbox source classification

- **Goal:** Replace hard-coded `Manual note` with a source-label helper and persist URL imports as web articles.
- **Files:** Modify `packages/local-db/src/inbox-query.ts`, `apps/desktop/src/main/url-import-service.ts`, and `apps/desktop/src/main/db-service.ts` if its legacy summary helper remains relevant.
- **Patterns:** Follow `packages/core/src/source-ref.ts` source-type labels and the repository/query layering in `packages/local-db/src/inbox-query.ts`.
- **Test scenarios:** Manual import with no provenance returns `Manual note`; URL import with HTML snapshot/source type returns `Web article`; PDF/media/book paths still produce non-manual labels.
- **Verification:** `packages/local-db/src/inbox-query.test.ts` and `apps/desktop/src/main/url-import-service.test.ts` cover the changed labels/source type.

### U2. Full formatted inbox preview

- **Goal:** Return and render the complete persisted ProseMirror document in the inbox detail pane.
- **Files:** Modify `packages/local-db/src/inbox-query.ts`, `apps/desktop/src/shared/contract.ts`, `apps/desktop/src/main/db-service.ts`, `apps/web/src/lib/appApi.ts`, and `apps/web/src/pages/inbox/InboxScreen.tsx`.
- **Patterns:** Reuse `SourceEditor` with `editable={false}` and reader styles from `apps/web/src/pages/source/SourceReader.tsx`; keep document storage in main/local-db.
- **Test scenarios:** Detail includes the full document JSON; a long article is not truncated; headings, links, lists, and blockquotes render in the inbox preview.
- **Verification:** `packages/local-db/src/inbox-query.test.ts` and `apps/web/src/pages/inbox/InboxScreen.test.tsx` assert full body rendering and no truncation.

### U3. Internal read action in the right rail

- **Goal:** Add a visually consistent `Read now` action in the inbox preview rail that activates and navigates to the source reader.
- **Files:** Modify `apps/web/src/pages/inbox/InboxScreen.tsx` and `apps/web/src/pages/inbox/InboxScreen.test.tsx`.
- **Patterns:** Follow `TriageButton` styling, router usage from `apps/web/src/analytics/SourceYield.tsx`, and queue terminology from `apps/web/src/pages/queue/openQueueItem.ts`.
- **Test scenarios:** Clicking `Read now` calls `triageInboxItem({ kind: "accept" })`, clears shell selection if needed, and navigates to `/source/$id`; external canonical links still render as `ExternalUrlLink`.
- **Verification:** Targeted inbox component tests plus a browser screenshot/manual check of the right rail.

---

## Scope Boundaries

- This does not add new remote fetching or change Readability extraction rules.
- This does not expose vault snapshot paths to the renderer.
- This does not redesign the source reader or source inspector globally.
- This does not try to infer `blog` vs `article` beyond the current source-type model.

---

## Risks & Dependencies

- Rendering full ProseMirror documents in the inbox can be heavier than a text snippet, so the change is limited to the selected detail pane rather than every list row.
- `SourceEditor` is an editor wrapper even when non-editable; tests should catch accidental `onChange` writes or missing reader CSS.
- The `Read now` action changes state before navigation. If activation fails, the app must stay in the inbox and surface the existing error path.

---

## Sources / Research

- `apps/desktop/src/main/url-import-service.ts` already writes original and cleaned HTML snapshots and persists the converted ProseMirror document.
- `packages/local-db/src/inbox-query.ts` hard-codes `srcType: "Manual note"` and truncates `bodyPreview` to 4000 characters.
- `apps/web/src/pages/inbox/InboxScreen.tsx` renders `bodyPreview` as plain-text paragraphs and has no internal source-reader action.
- `apps/web/src/pages/source/SourceReader.tsx` renders full source bodies through `SourceEditor`.
