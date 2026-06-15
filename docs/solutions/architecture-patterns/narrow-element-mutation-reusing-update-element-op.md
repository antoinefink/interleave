---
title: "Add a narrow renderer mutation by reusing the generic element-update / update_element path — no new op type, no migration"
date: "2026-06-15"
category: "docs/solutions/architecture-patterns/"
module: "apps/desktop IPC + local-db (renameElement / ElementsRename contract over ElementRepository.update + operation_log)"
problem_type: "architecture_pattern"
component: "service_object"
severity: "medium"
applies_when:
  - "The renderer needs a NEW narrow mutation (e.g. rename) and you are tempted to add a new operation_log op type or migration for it"
  - "A new UI entry point needs an EXISTING mutation (e.g. delete from a context menu) and a second soft-delete / undo path would otherwise be introduced"
  - "A title-only or single-field write should ride the proven ElementRepository.update path that appends update_element and records a prev pre-image for undo, all in one transaction"
  - "You want to keep the closed operation_log op set closed and avoid exposing a generic element-update IPC to the renderer"
  - "Routing the new entry point through an existing intent flow (e.g. useLineageDelete via a bumped signal) instead of a parallel command"
related_components:
  - "apps/desktop/src/main/db-service.ts"
  - "apps/desktop/src/shared/contract.ts"
  - "apps/desktop/src/main/ipc.ts"
  - "apps/desktop/src/preload/index.ts"
  - "apps/web/src/lib/appApi.ts"
  - "apps/web/src/components/inspector/LineageContextMenu.tsx"
tags:
  - operation-log
  - ipc-contract
  - element-update
  - soft-delete
  - undo
  - no-migration
  - narrow-command
---

# Add a narrow element mutation by reusing the update_element op

## Context

The context menu needed a **Rename** command, but no rename IPC existed and the renderer
can't touch SQLite. The tempting move — a new `rename_element` op type plus a migration — was
exactly wrong: this repo carries a migration scar (migration 0030's FK cascade nulled lineage
links in the real vault), and `title` is already a universal, NOT-NULL column on `elements`
written by the existing `update_element` op. The right move was to add **zero** new op types
and **zero** migrations, and ride the proven `ElementRepository.update` path that
`setElementPriority` already uses — adding only the thin transport layer.

## Guidance

**Reuse the existing repository update.** `ElementRepository.update(id, { title })` already
does the load-bearing work inside ONE transaction: it captures a `prev.title` pre-image (for
command-level undo) and appends a single `update_element` entry to `operation_log` in the
same transaction as the state change. The narrow command writes nothing else.

```ts
// apps/desktop/src/main/db-service.ts — renameElement()
const element = this.repos.elements.findById(id);
if (!element || element.deletedAt) return { element: null };   // existence/liveness guard
const updated = this.repos.elements.update(id, { title: request.title });
return { element: { id: updated.id, type: updated.type, /* …summary… */ title: updated.title } };
```

**Add only the thin transport chain — nothing touches the schema or the op set:**

1. **Contract schema** (`apps/desktop/src/shared/contract.ts`) — strict, trimmed, bounded:
   ```ts
   export const ELEMENT_TITLE_MAX = 1000;
   export const ElementsRenameRequestSchema = z.object({
     id: ElementIdSchema,
     title: z.string().trim().min(1).max(ELEMENT_TITLE_MAX),
   }).strict();
   ```
   `.strict()` rejects extra keys; `.trim().min(1)` makes it impossible for the renderer to
   blank out the NOT-NULL column or smuggle untrimmed padding. The result type is
   `{ element: ElementSummary | null }`.

2. **Channel constant** (`apps/desktop/src/shared/channels.ts`): `elementsRename: "elements:rename"`.

3. **IPC handler** (`apps/desktop/src/main/ipc.ts`) — **validate before service**, never trust
   the renderer payload:
   ```ts
   ipcMain.handle(IPC_CHANNELS.elementsRename, (_event, rawRequest: unknown) => {
     const request = ElementsRenameRequestSchema.parse(rawRequest);   // parse first
     return dbService.renameElement(request);
   });
   ```

4. **Preload bridge** (`apps/desktop/src/preload/index.ts`):
   `rename: (request) => ipcRenderer.invoke(IPC_CHANNELS.elementsRename, request)` under the
   typed `elements` namespace — passes the payload through unchanged.

5. **appApi wrapper** (`apps/web/src/lib/appApi.ts`):
   ```ts
   renameElement(request: ElementsRenameRequest): Promise<ElementsRenameResult> {
     return requireAppApi().elements.rename(request);
   }
   ```

6. **db-service guard** (shown above): return `{ element: null }` when the id is unknown OR
   `deletedAt` (soft-deleted). Validation already happened at the boundary, so the service
   only guards existence/liveness.

**Caller contract: `{ element: null }` is an ERROR, not a silent success.** A null means the
target was deleted between right-click and commit; treat it as failure rather than reporting a
no-op as success:

```tsx
const res = await appApi.renameElement({ id: node.id, title: next });
if (!res.element) throw new Error("Couldn't rename — the item no longer exists");
```

Returning the updated `ElementSummary` (not just `ok: true`) lets the caller refresh the node
without a re-fetch.

**Same principle for a new entry point on an existing mutation.** When the context menu needed
**Delete**, it did NOT add a second `softDeleteSubtree` call site. It routed through the
existing `useLineageDelete` / `LineageDeleteMenu` intent flow (count-descendants pre-flight ->
fast-path-or-intent-popover + Undo) by bumping a signal that drives a hidden instance of that
component. One delete path, one set of undo/op-log semantics.

## Why This Matters

A new op type is a permanent widening of the closed command set and an irreversible append to
operation-log history; a migration is a one-way schema change that — per this repo's 0030 scar
— can corrupt the real vault. Riding `update_element` means rename inherits undo,
transactionality, and operation-logging for free, and the diff is pure transport (schema +
channel + handler + preload + wrapper + guard) with no migration and no new op. The
`null`-is-error rule prevents the classic race where a mutation on a vanished row looks like
it worked.

## When to Apply

- You need a narrow, single-field mutation (rename, retag, set-flag) on a column an existing
  op already writes. Reuse that op; do **not** add a new op type or migration.
- The renderer needs the capability: always go schema -> channel -> validated IPC handler ->
  preload -> typed appApi wrapper. Validate at the IPC boundary (`Schema.parse(rawRequest)`)
  before the service runs.
- The mutation can target a row that may be gone/soft-deleted: return a nullable result and
  make the caller treat null as an error.
- A new UI surface needs an existing mutation: route it through the existing command/intent
  flow, not a parallel call site.
- Do **not** apply this if the mutation genuinely needs new persisted shape or semantics the
  existing op can't express — then a new op + migration is correct, but weigh it against the
  migration scar.

## Examples

- Contract: `apps/desktop/src/shared/contract.ts` (`ElementsRenameRequestSchema`,
  `ELEMENT_TITLE_MAX`, `ElementsRenameResult`).
- Service: `apps/desktop/src/main/db-service.ts` `renameElement()` (existence/liveness guard,
  reuses `repos.elements.update`).
- Wiring: `apps/desktop/src/shared/channels.ts` (`elementsRename`),
  `apps/desktop/src/main/ipc.ts` (validate-before-service),
  `apps/desktop/src/preload/index.ts`, `apps/web/src/lib/appApi.ts` (`renameElement`).
- Null-is-error caller + single-delete-path reuse:
  `apps/web/src/components/inspector/LineageContextMenu.tsx` (`commitRename`, `deleteState`).
- Implementing commit `d284c06e`; null-handling tightened in review commit `02b3a977`.

## Related

- [bulk-command-heterogeneous-batch-undo-guard](bulk-command-heterogeneous-batch-undo-guard.md)
  — the same "reuse the op, no new op type" principle, batch variant.
- [extract-card-ipc-invariant-test-hardening](extract-card-ipc-invariant-test-hardening.md)
  — how to test a new IPC command's schema validation + operation_log coherence.
- [lineage-aware-deletion-tombstone-purge-guard](lineage-aware-deletion-tombstone-purge-guard.md)
  — the canonical additive-op-payload / no-new-op-type exemplar; the delete this menu reuses.
