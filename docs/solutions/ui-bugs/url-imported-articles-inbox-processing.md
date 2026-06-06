---
title: "URL-imported articles should render as internal readable sources"
date: "2026-06-06"
category: "docs/solutions/ui-bugs/"
module: "import-inbox"
problem_type: "ui_bug"
component: "service_object"
severity: "medium"
symptoms:
  - "URL/blog imports appeared as Manual note in inbox source-type labels."
  - "Inbox selected preview flattened and truncated persisted article content instead of rendering the full formatted body."
  - "The inbox preview rail exposed external links but had no internal Read now action to activate and process the source."
root_cause: "logic_error"
resolution_type: "code_fix"
related_components:
  - "database"
  - "frontend_stimulus"
  - "testing_framework"
tags:
  - "inbox"
  - "url-import"
  - "source-provenance"
  - "prosemirror"
  - "electron-ipc"
  - "read-now"
  - "source-reader"
  - "typed-contract"
---

# URL-imported articles should render as internal readable sources

## Problem

The inbox treated URL-imported articles like manual notes: the type label was misleading, the selected preview used a truncated plain-text slice instead of the persisted formatted document, and the right rail had external provenance links but no internal action that opened the source for processing.

This made a successful URL import look like an inert note instead of a source ready for incremental reading.

## Symptoms

- URL and blog imports appeared as `Manual note` in the inbox source-type label.
- The selected inbox preview flattened formatting and could omit the tail of a long article.
- The user could open the canonical web URL but not the local source reader from the inbox.
- Malformed persisted document JSON could be passed directly to the editor preview.
- Stale inbox triage calls could mutate sources that had already left the inbox.

## What Didn't Work

- Returning only `bodyPreview` from the inbox detail contract was not enough. It was plain text, intentionally truncated, and could not preserve the source reader's ProseMirror structure.
- Keeping `srcType` as an M2 placeholder made all source summaries say `Manual note`, even when provenance contained URL, media, snapshot, or source-type data.
- Handling `Read now` purely in the renderer would not protect against stale IPC calls from another window or a delayed duplicate click.
- Refreshing the full inbox detail after a priority-only change needlessly re-sent full article bodies over IPC.

## Solution

Make the selected inbox detail a full-body payload, but keep full document data out of the list query:

```ts
export interface InboxItemDetail {
  readonly summary: InboxItemSummary;
  readonly provenance: InboxProvenance;
  readonly bodyDoc: unknown | null;
  readonly bodyText: string | null;
  readonly bodyPreview: string | null;
}
```

Return `bodyDoc` from the document row whenever the row exists, and return the full untruncated `plainText` as `bodyText`. Keep `bodyPreview` only as a legacy fallback.

Derive inbox source labels from persisted provenance instead of a hard-coded placeholder:

```ts
export function inboxSourceTypeLabel(source: Source | null): string {
  if (!source) return "Manual note";
  if (source.mediaKind) return mediaSourceLabel(source.mediaKind);
  if (source.sourceType) return SOURCE_TYPE_LABEL[source.sourceType];
  if (source.snapshotKey?.toLowerCase().endsWith(".pdf")) return "PDF";
  if (source.snapshotKey?.toLowerCase().endsWith(".epub")) return "Book";
  if (source.snapshotKey?.toLowerCase().endsWith(".html")) return "Web article";
  if (source.url || source.canonicalUrl || source.originalUrl) return "Web article";
  return "Manual note";
}
```

URL imports should also persist a source type:

```ts
sourceType: "article";
```

In the renderer, prefer a formatted read-only `SourceEditor` only after validating the opaque document JSON against the editor schema. Fall back to full text when the JSON is malformed or missing:

```ts
const inboxPreviewSchema = buildSchema();

function validBodyDoc(value: unknown): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    inboxPreviewSchema.nodeFromJSON(value);
    return value;
  } catch {
    return null;
  }
}
```

Replace the old primary `Activate` action with `Read now`: accept the inbox item, then navigate to `/source/$id`. Keep external URL links visually and semantically separate from the internal processing action.

Finally, make inbox triage conditional in Electron main before mutating:

```ts
const current = tx.select().from(elements).where(eq(elements.id, id)).get();
if (!current || current.deletedAt || current.type !== "source" || current.status !== "inbox") {
  throw new Error("Inbox item is no longer available.");
}
```

Use the returned summary to patch priority-only state locally, avoiding a second `inbox.get` call that would resend the full body.

## Why This Works

The inbox preview now receives the same durable document data that the reader uses: valid ProseMirror JSON for formatted rendering and full plain text as a fallback. Formatting is preserved without making the list endpoint heavy, because only the selected detail endpoint carries the full body.

Source labels now reflect provenance rather than import modality assumptions. A source with URL or HTML snapshot provenance reads as a web article, while true manual text stays a manual note.

The internal processing action is explicit and local: `Read now` changes lifecycle state and opens the local reader, while canonical URL links remain external provenance links.

The stale triage guard belongs in Electron main because it protects all callers, not just the current React window. It prevents a second accept/delete request from reviving or mutating an item that is no longer a live inbox source.

## Prevention

- Keep full article bodies on selected-detail contracts, not list contracts.
- Validate opaque persisted document JSON before handing it to editor components.
- For summary-only mutations, use the mutation response to patch summary state instead of re-fetching full detail.
- Guard command-shaped inbox mutations at the main-process/service boundary with live element preconditions.
- Test both the legacy fallback path and the formatted path:
  - provenance labels for URL imports, manual notes, snapshots, and media
  - full `bodyDoc` and untruncated `bodyText`
  - empty formatted docs with empty plain text
  - malformed formatted JSON falling back to full text
  - `Read now` activation and navigation failure handling
  - stale duplicate accept/delete requests that must not mutate deleted or non-inbox rows

## Related Issues

- [Electron main rolling backups pattern](../architecture-patterns/electron-main-rolling-backups-over-renderer-reminders.md) — low overlap; reinforces keeping trusted state transitions in Electron main.
