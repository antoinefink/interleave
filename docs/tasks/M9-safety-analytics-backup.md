# M9 — Safety, analytics & backup (T044–T047)

Detailed, buildable specs for the ninth milestone. M9 is the **durability + self-awareness**
milestone: it makes the app safe to throw too much material at and honest about whether the
user is keeping up. Four tasks: a **Trash + command-level undo** so no action is irreversible
(T044), a **basic analytics** view that summarizes the learning system from `review_logs` +
`elements` (T045), an **import/process balance warning** that catches the "I imported more than
I can process" failure mode (T046), and a **backup/export** that bundles the canonical local
store — `app.sqlite` + the filesystem asset vault + a restore-ready `manifest.json` — into a
ZIP (T047).

After M9 the local-first promise is real and provable: every destructive action is recoverable
(trash + undo), the user can see their throughput and retention at a glance, the app warns
before the inbox silently outpaces processing, and the whole knowledge base can be backed up to
a single portable archive whose format is designed for restore from day one.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and
the roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node, or the
filesystem. Every capability flows React UI → typed client wrapper (`apps/web/src/lib/appApi.ts`)
→ preload bridge (`apps/desktop/src/preload/index.ts`) → validated IPC (Zod) on the main side
(`apps/desktop/src/main/ipc.ts`) → the `DbService` (`apps/desktop/src/main/db-service.ts`) →
`packages/local-db` repositories + `packages/scheduler` services → SQLite + the filesystem asset
vault. **Undo, analytics aggregation, balance math, and backup/zip logic are domain / main-process
functions — never React component code.** Every meaningful mutation runs in **one transaction** and
appends an **`operation_log`** row; deletes are **soft** (`deleted_at`); `foreign_keys = ON`. A
feature is not done until it survives an **app restart**.

> **The operation log is the basis for undo (load-bearing — read before touching T044).**
> `OPERATION_TYPES` (`packages/core/src/operation-log.ts`) is a **closed, fixed set of 15** — "a
> rename is a migration." Undo does **not** add op types: it reads the **last** `operation_log`
> entry and applies its **inverse** using the existing repository write paths, which themselves
> append the inverting op (e.g. undoing `soft_delete_element` calls
> `ElementRepository.restore` → appends `restore_element`; undoing `update_element` re-applies the
> captured previous field values → appends another `update_element`). Undo is therefore *itself*
> logged — the log stays append-only and the history is auditable. **The op payloads already
> carry what undo needs:** `soft_delete_element` stores `{ id, deletedAt }`; `update_element`
> stores `{ id, patch }` (the queue/status/leech changes); `reschedule_element` stores
> `{ id, dueAt, status?, postpone?, ... }`. T044 must confirm each undoable op's payload captures
> the **prior** value (or read the prior value at undo time) so the inverse is exact.

> **Two existing undo mechanisms — do not confuse them.** There is already a **recipe-based,
> removing-only** undo scoped to the daily queue (T030): `QueueActionService.act` returns a
> `QueueActionUndo` recipe (`{ kind: "restore" | "status", previousStatus }`) the renderer hands
> back to `queue.undo` (`packages/local-db/src/queue-action-service.ts`,
> `apps/web/src/pages/queue/QueueScreen.tsx` + `QueueSnackbar.tsx`). That covers only
> done/dismiss/delete *initiated from the queue list*. T044 adds the **general, command-level**
> undo: a single "undo the last operation" path that works **anywhere** (reader, review,
> inspector, trash, bulk actions) by inverting the last `operation_log` op. Reuse `QueueSnackbar`
> as the toast and reuse `ElementRepository.restore`/`update`; **do not** widen the queue recipe
> into a second ad-hoc system.

> **Backup bundles the canonical local store, not a JSON dump (load-bearing for T047).** The
> canonical local database is the native SQLite file (`app.sqlite` + `-wal`/`-shm`); the
> canonical asset store is the filesystem **vault** (`assets/`). A backup is therefore a copy of
> **both** plus a `manifest.json` describing them — never a hand-rolled JSON serialization of the
> domain. The "schema version" in the manifest is the **latest applied Drizzle migration tag**
> (today `0001_clever_rictor`, read from the `__drizzle_migrations` journal / the
> `packages/db/drizzle/meta/_journal.json` entries), so restore can reject a backup newer than the
> installed schema. Restore itself is **deferred** (M11/T055 one-way restore-onto-fresh-install) —
> but T047 must **design the format so restore is mechanical**.

Read first:
- [`../../CLAUDE.md`](../../CLAUDE.md) — **"Data rules"** (soft delete / trash / undoable actions;
  `operation_log` from day one; no silent data destruction; backup = SQLite file + vault, not a
  JSON dump), **"Asset vault"** (layout under the app data dir; renderer never touches files),
  **"SQLite rules"** (WAL, `foreign_keys`, the DB + `assets/` + `backups/` siblings).
- [`../domain-model.md`](../domain-model.md) — soft-delete (`deleted_at`), lifecycle statuses
  (`deleted`/`dismissed`/`suspended`), the closed op set, lineage (a restored card must still
  point at its extract → source location → source).
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the **import/process balance**
  idea (don't let new material dominate; overload protection) behind T046; "due reviews this week"
  for the balance numbers.
- [`../design-system.md`](../design-system.md) — `Status` (`trashed`/`suspended`/`dismissed`),
  `Metric`, `Spark`, `Banner` (balance + system-health notices), `BudgetMeter`, `Snackbar` (undo
  toast), `EmptyState`; the screen→milestone map (`screen-extra` → Trash = T044; `screen-analytics`
  = T045/T046; `screen-settings` backup = T047).
- Design kit (immutable reference):
  - `design/kit/app/screen-extra.jsx` — the `TrashScreen` (the `result` rows with `TypeIcon`,
    "from {source}", "deleted {when}", Restore + permanent-delete buttons, "Empty trash",
    `EmptyState` "Trash is empty", the "deleted items are recoverable for 30 days" sub) +
    `design/kit/screenshots/01-v2-trash.png` / `02-v2-trash.png`.
  - `design/kit/app/screen-analytics.jsx` — the `AnalyticsScreen` (four top `Metric`s, the
    "Reviews per day" + "7-day forecast" `spark` panels, "Retention by concept" bars, the "System
    health" `Banner`s, "Open maintenance").
  - `design/kit/app/components.jsx` — `Metric`, `Spark`, `Banner`, `BudgetMeter`, `Snackbar`,
    `EmptyState`, `TypeIcon`, `Dot`, `Status`.

### What already exists (inspect before building — do not duplicate)

The M1 substrate built most of M9's persistence + safety seam already:

- **Soft-delete + restore (T008) — already built, the basis for the trash + undo:**
  - `ElementRepository.softDelete(id)` (`packages/local-db/src/element-repository.ts`): sets
    `deletedAt` + status `deleted`, **never** hard-DELETEs, logs `soft_delete_element` in one
    transaction. `restore(id, status = "active")`: clears `deletedAt`, sets status, logs
    `restore_element`. `update(id, patch)` logs `update_element`; `reschedule` logs
    `reschedule_element`. **T044 wires a Trash UI + the general undo onto these — no new write
    primitives are needed.**
  - `findById` returns soft-deleted rows (so the trash can read them); the `listBy*` queries
    already filter `isNull(deletedAt)` (so the rest of the app hides trashed items).
- **The operation log (T005/T008) — the undo source of truth:**
  - `OperationLogRepository` (`packages/local-db/src/operation-log-repository.ts`):
    `listAll(limit?)` (whole log, newest first, **with deterministic `rowid` tie-break** — exactly
    what "the last op" needs), `listForElement(elementId)`, `append(tx, …)`, `count()`.
  - `OPERATION_TYPES` + `OperationLogEntry` (`packages/core/src/operation-log.ts`): the closed
    15-op union and the `{ id, opType, payload, elementId, createdAt }` shape. The payloads above
    are already populated by the existing write paths.
- **Review history (T036/T037) — the analytics source of truth:**
  - `review_logs` (`packages/db/src/schema/cards.ts`): append-only, one immutable row per grade,
    with `rating` (`again`/`hard`/`good`/`easy`), `reviewedAt`, `responseMs`, `prevState`/
    `nextState`, `nextDueAt`. **This is the table T045's "daily reviews" + "30-day retention"
    aggregate.** Indexed on `reviewedAt`.
  - `review_states` (`packages/db/src/schema/cards.ts`): `dueAt`, `lapses`, `reps`, `fsrsState` —
    the source for "due cards" + "leeches".
  - `ReviewRepository` (`packages/local-db/src/review-repository.ts`): `listLeechCards()` already
    returns leech cards (`cards.is_leech = 1`); `listReviewLogs(elementId)`.
- **The queue / due reads (T029) — reused for "due this week":**
  - `QueueRepository` (`packages/local-db/src/queue-repository.ts`): `dueCards(asOf, limit)`,
    `dueCardCount`, `dueAttentionItems` — the basis for "reviews due this week" (T046) and "due
    cards/topics" (T045).
- **The asset vault + paths (T007) — what backup copies:**
  - `paths.ts` (`apps/desktop/src/main/paths.ts`): `AppPaths` = `{ dataDir, dbPath, assetsDir,
    exportsDir, backupsDir }`; `INTERLEAVE_DATA_DIR` override (used by tests + the Playwright
    restart spec); `ensureVaultSkeleton`. **The `backupsDir` (`backups/`) already exists** — T047
    writes into it.
  - `AssetRepository` (`packages/local-db/src/asset-repository.ts`): `findById`,
    `listForElement`, `findByContentHash`, `create` — the metadata side (stable id, `vaultRoot`,
    `relativePath`, `contentHash`, `mime`, `size`). T047 reads asset metadata for the manifest;
    the **bytes** are copied from the vault on disk.
- **The `window.appApi` seam (every prior task) — the pattern to follow exactly:** channels
  (`apps/desktop/src/shared/channels.ts`), Zod request schemas + result types
  (`apps/desktop/src/shared/contract.ts` + `contract.test.ts`), preload group
  (`apps/desktop/src/preload/index.ts`), validated IPC handlers (`apps/desktop/src/main/ipc.ts`),
  `DbService` methods (`apps/desktop/src/main/db-service.ts` + `db-service.test.ts`), renderer
  client (`apps/web/src/lib/appApi.ts`). Existing groups: `app`/`db`/`settings`/`inspector`/
  `elements`/`queue`/`lineage`/`sources`/`inbox`/`documents`/`extractions`/`cards`/`extracts`/
  `review`/`readPoint`. M9 adds **`trash.*`** (T044), **`undo.*`** (T044), **`analytics.*`**
  (T045), **`balance.*`** (T046), and **`backups.*`** (T047).
- **The renderer shell + nav (T004):** `apps/web/src/router.tsx` (typed routes: `/`, `/inbox`,
  `/queue`, `/process`, `/source/$id`, `/extract/$id`, `/review`, `/maintenance/leeches`,
  `/search`, `/settings`); `apps/web/src/shell/nav.ts` (`SECONDARY_NAV` already lists "Analytics"
  + "Leeches" pointing at placeholder routes); `QueueSnackbar` (`apps/web/src/components/queue/`)
  — the undo toast to reuse; the `/maintenance/leeches` `LeechCleanup` view (T040) — the
  maintenance-screen sibling Trash + Analytics join.
- **`@interleave/core` settings (T011):** `AppSettings` + `SETTINGS_KEYS` + `coerceSettingValue`
  (`packages/core/src/settings.ts`) — the place to add the T044 trash-retention + T046
  balance-threshold settings (keys are stable; they're part of backup, T047).

### What M9 must add (the gaps)

- **No Trash view, no general undo path.** Soft-delete + `restore` + `listAll` all exist, but
  there is **no** `trash.list`/`trash.restore`/`trash.purge` surface and **no** `undo.last` path.
  The only undo today is the queue's removing-only recipe (T030). T044 adds both.
- **No analytics aggregation + no `analytics.*` surface + `/analytics` is not a route.** Nothing
  aggregates `review_logs`/`elements` into daily counts or 30-day retention; `screen-analytics`
  has no React counterpart; `SECONDARY_NAV`'s "Analytics" points at `/search`. T045 adds the
  aggregation service, the IPC surface, the route, and the screen.
- **No balance computation + no `balance.*` surface + no balance Banner.** T046 adds the
  import-vs-process math + the inbox/analytics banner.
- **No backup packager, no zip dependency, no `backups.*` surface.** Confirmed: there is **no**
  `archiver`/`yazl`/`jszip`/`adm-zip` (and no `electron-builder`/`electron-forge`) in any
  `package.json` (`apps/desktop/package.json` has only `@electron/rebuild`/`electron`/`esbuild`).
  T047 adds a zip dependency on the **main** side and the `backups.create` command.
  - **No `schema_version` table.** The manifest's schema version is the latest **Drizzle
    migration tag** from the `__drizzle_migrations` journal (`packages/db/drizzle/meta/_journal.json`
    last entry), **not** a column. `documents.schemaVersion` is an unrelated ProseMirror-doc field —
    do not reuse it. The app version is `app.getVersion()` / the desktop `package.json` version.

Build order is the task order. T044 and T047 depend only on T008 and may be built in parallel;
T045 depends on T037 (`review_logs`) + T028 (attention `due_at`); T046 depends on T045. This M9
file is generated ahead per the orchestration loop. **Generate `tasks/M8-organize-search.md`
(T041–T043) before its tasks** — that spec file does not exist yet.

---

## T044 — Deletion, trash & undo

- **Status:** `[ ]`  · **Depends on:** T008
- **Roadmap line:** Done when: soft delete + trash view + restore exist; command-level undo
  covers delete/mark-done/suspend/bulk-postpone; accidental deletion is recoverable.

### Goal

Nothing the user does is irreversible. Soft-deleted elements (already produced everywhere via
`ElementRepository.softDelete`) collect in a **Trash** view (`design/kit/app/screen-extra.jsx`
`TrashScreen`) where each item shows its type, source, and deletion time and can be **restored**
(to its prior lifecycle status, lineage intact) or **permanently deleted** with confirmation.
Separately, a **general command-level undo** — a `Snackbar` "Undo" plus a global shortcut —
reverses the **last `operation_log` operation** from anywhere in the app, covering
**delete / mark-done / suspend / bulk-postpone** (and any other inverse-able op) by applying the
inverse through the existing repository write paths. Accidental deletion (or a fat-fingered
suspend/postpone) is one keystroke from recovery.

### Context to load first

- Reference: `CLAUDE.md` "Data rules" (soft delete / trash / undoable actions; the op log is the
  undo basis); `domain-model.md` (soft-delete + lifecycle statuses + lineage survives delete).
- Existing code to inspect: `packages/local-db/src/element-repository.ts` (`softDelete`,
  `restore`, `update`, `reschedule`, `findById` returns deleted rows); `operation-log-repository.ts`
  (`listAll` newest-first w/ `rowid` tie-break, `listForElement`); `packages/core/src/operation-log.ts`
  (the closed op set + payload shapes); `packages/local-db/src/queue-action-service.ts` +
  `apps/web/src/pages/queue/{QueueScreen,QueueSnackbar}.tsx` + `apps/web/src/components/queue/QueueSnackbar.tsx`
  (the existing removing-only recipe undo — reuse the `QueueSnackbar`, generalize the path);
  `design/kit/app/screen-extra.jsx` (`TrashScreen`) + `design/kit/app/components.jsx` (`Snackbar`,
  `EmptyState`, `TypeIcon`, `Status`); `apps/web/src/router.tsx` + `apps/web/src/shell/nav.ts`
  (add the `/trash` route + nav entry); `apps/web/src/maintenance/LeechCleanup.tsx` (the
  maintenance-screen pattern to mirror for the Trash screen).
- Invariants in play: undo never adds an op type — the inverse is one of the existing 15 and is
  itself logged; soft-delete never destroys (permanent delete is the **only** hard-DELETE, gated
  by explicit confirmation); restore preserves `card → source location → source` lineage; bulk
  actions are still individually undoable / re-doable.

### Deliverables

- [ ] **A `TrashRepository` (or `trash-query.ts`) read + permanent-delete in `packages/local-db`**
      (`packages/local-db/src/trash-query.ts`, exported from `packages/local-db/src/index.ts` +
      added to `Repositories`/`createRepositories`):
      - `listTrash(): TrashItem[]` — all elements with `deletedAt != null`, newest-deleted first,
        each carrying `{ element, sourceTitle, deletedAt, originStatus }` where `originStatus` is
        the status the element had **before** delete (read from the latest `soft_delete_element`
        op payload, or default `active` if absent). Joins the owning `sources` row for the "from
        {source}" line.
      - `purge(id): void` — the **only** hard delete in the app: a real `DELETE` of the element
        row inside a transaction (FK `onDelete: cascade`/`set null` already cleans up
        `cards`/`review_states`/`review_logs`/`source_locations`/`assets`/relations). Logs… see
        note: **a hard delete cannot be `restore`d, so it is recorded with `soft_delete_element`'s
        absence** — instead append no domain op but DO record an audit row; the simplest
        compliant choice is to leave the prior `soft_delete_element` op in the log and NOT add a
        new op (purge is irreversible by design and is the trash's terminal state). Document this
        decision in the file header.
      - `emptyTrash(): { purged: number }` — purge every trashed element (one transaction),
        returning the count. Gated behind explicit confirmation in the UI.
- [ ] **An `UndoService` in `packages/local-db`** (`packages/local-db/src/undo-service.ts`,
      exported + wired into `createRepositories`/the `DbService`): the single, general command-level
      undo.
      - `undoLast(): UndoResult` — read `OperationLogRepository.listAll(1)` (the most recent op);
        compute and apply its **inverse** via the existing repositories, in one transaction:
        - `soft_delete_element` → `ElementRepository.restore(id, originStatus)` (origin status from
          the op payload / prior state) → appends `restore_element`.
        - `restore_element` → `ElementRepository.softDelete(id)` → appends `soft_delete_element`
          (so undo is itself undoable / redo-able).
        - `update_element` (covers **mark-done**, **dismiss**, **suspend**, priority raise/lower,
          leech flag) → re-apply the **previous** field values. The current `update_element`
          payload stores `{ id, patch }` (the *new* values) — **T044 must also capture the prior
          values** so the inverse is exact: either (a) extend the `update_element` payload at
          write time to `{ id, patch, prev }` (a payload enrichment, **not** a new op type or a
          migration), or (b) reconstruct the prior value by replaying the element's op history.
          **Prefer (a)** — enrich `ElementRepository.updateWithin` to record the pre-image of each
          patched field. Re-applying logs another `update_element`.
        - `reschedule_element` (covers **postpone**, incl. **bulk-postpone**) → restore the prior
          `dueAt`/`status`. Same pre-image rule: enrich `rescheduleWithin` to record `prevDueAt`/
          `prevStatus` in the payload so undo is exact. Re-applying logs `reschedule_element`.
        - non-invertible ops (`create_element`/`create_source`/`create_extract`/`create_card`/
          `add_review_log`/`update_document`/`set_read_point`/`add_relation`/`remove_relation`/
          `add_tag`/`remove_tag`): for the MVP, `undoLast` returns `{ undone: false, reason }` for
          ops it does not invert (creates are undone by deleting — out of MVP scope for the global
          undo; tag/relation changes have their own affordances). **MVP undo scope = the four the
          roadmap names: delete / mark-done / suspend / bulk-postpone**, i.e.
          `soft_delete_element` + `update_element`(status) + `reschedule_element`. Document the
          covered set explicitly.
      - `UndoResult = { undone: boolean; opType: OperationType; elementId: string | null; label: string; reason?: string }`
        — `label` is the human string for the snackbar ("Restored 'Spaced repetition'").
      - **Bulk actions** (the roadmap's "bulk-postpone"): a bulk op is N individual
        `reschedule_element`/`update_element` rows. Add `undoLastBatch(n)` **or** group bulk
        mutations under a shared `batchId` in the op payload so `undoLast` reverses the whole batch
        — **choose the batch-id approach** (enrich the payload with an optional `batchId`; `undoLast`
        reverses every op sharing the most-recent op's `batchId`, else just the single last op).
- [ ] **`trash.*` + `undo.*` `window.appApi` surface** across the established seam, Zod-validated:
      - channels (`channels.ts`): `trashList` (`trash:list`), `trashRestore` (`trash:restore`),
        `trashPurge` (`trash:purge`), `trashEmpty` (`trash:empty`), `undoLast` (`undo:last`).
      - contract (`contract.ts` + `contract.test.ts`): `trash.list() → { items: TrashItemSummary[] }`;
        `trash.restore({ id }) → { item: ElementSummary }`; `trash.purge({ id }) → { purged: 1 }`;
        `trash.empty() → { purged: number }`; `undo.last() → UndoResult`. Reuse `ElementIdSchema`.
      - preload (`preload/index.ts`): `trash` + `undo` groups.
      - IPC router (`ipc.ts`): validated handlers.
      - `DbService` (`db-service.ts` + `db-service.test.ts`): `listTrash`, `restoreFromTrash`,
        `purgeFromTrash`, `emptyTrash`, `undoLastOperation` composing the new repos/services.
      - renderer client (`apps/web/src/lib/appApi.ts`): `trash` + `undo` groups + types.
- [ ] **A `/trash` route + `TrashScreen`** (`apps/web/src/router.tsx` + e.g.
      `apps/web/src/trash/TrashScreen.tsx` + a css module), rebuilt from
      `design/kit/app/screen-extra.jsx` `TrashScreen` pixel-for-pixel: the `result` rows
      (`TypeIcon`, dimmed title, "{type} · from {source} · deleted {when}"), Restore +
      permanent-delete (trash-icon) per row, "Empty trash" in the topbar (with a confirm), the
      `EmptyState` "Trash is empty", the "deleted items are recoverable" sub. Add a "Trash" entry
      to `SECONDARY_NAV` (`apps/web/src/shell/nav.ts`) pointing at `/trash`. Wire the existing
      reader/inspector "trash + undo land in M9 (T044)" placeholder (`apps/web/src/pages/source/SourceReader.tsx`)
      to the real delete + undo.
- [ ] **A global undo affordance:** reuse `QueueSnackbar` (rename/generalize to a shared
      `Snackbar` in `apps/web/src/components/` if it is queue-coupled) shown after any undoable
      mutation, with an "Undo" button calling `appApi.undo.last()`; plus a global `⌘Z` shortcut in
      the shell that calls `undo.last()` and toasts the `label`. Keep the queue's existing recipe
      undo working (or migrate it to call `undo.last()` — preferred, to retire the second system).
- [ ] **A trash-retention setting (optional, design-aligned):** the kit says "recoverable for 30
      days". Add `SETTINGS_KEYS.trashRetentionDays` (default 30) to `packages/core/src/settings.ts`
      (`AppSettings` + `coerceSettingValue`). **Auto-purge on expiry is DEFERRED** (a maintenance
      job is M20/T099) — for M9 the number is informational copy + a manual "Empty trash". Note the
      deferral.
- [ ] **Tests (Vitest, `packages/local-db`):**
      - `undo.last` reverses each covered op against an in-memory DB
        (`packages/local-db/src/test-db.ts`): soft-delete then `undoLast` → element live again
        with its **prior** status + lineage intact + a `restore_element` op appended; mark-done
        then `undoLast` → status back to the prior value (`update_element` appended); suspend then
        `undoLast` → un-suspended; postpone (`reschedule_element`) then `undoLast` → prior `dueAt`
        restored; a bulk-postpone batch then `undoLast` → all items in the batch reverted.
      - `undoLast` on a non-invertible last op returns `{ undone: false }` and mutates nothing.
      - `listTrash` returns only `deletedAt != null` rows with the correct `originStatus` + source
        title; `restore` removes the item from the trash; `purge`/`emptyTrash` hard-delete and
        cascade (no orphan `cards`/`review_states` rows).
- [ ] **Tests (Vitest, `DbService` + renderer component):** the `trash.*`/`undo.*` handlers
      round-trip; `TrashScreen` lists items, Restore/Purge call the right commands, "Empty trash"
      confirms first (mock `window.appApi.trash`/`undo`).
- [ ] **Playwright E2E** (`tests/electron/trash-undo.spec.ts`): delete a seeded extract → it
      appears in `/trash` and disappears from its source's children → Restore → it returns to the
      hierarchy with its prior status; separately, delete an element then press `⌘Z` (or the
      Snackbar "Undo") → it is restored; **restart the Electron app** → the trash list + the
      restored element persist correctly.

### Done when

- Soft delete (already produced everywhere), a **Trash** view, and **restore** exist; a **general
  command-level undo** reverses the last operation from anywhere and covers
  **delete / mark-done / suspend / bulk-postpone**; accidental deletion is recoverable; permanent
  delete is the only hard delete and is confirmation-gated; restored elements keep their lineage;
  everything survives **app restart**.
- Undo + trash logic live in `packages/local-db` (`UndoService`/`TrashRepository`), **never** in
  React; undo adds no new op type (the inverse is one of the existing 15 and is itself logged).
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the trash/undo Playwright spec pass.

### Notes / risks

- **The payload pre-image is the one real risk.** Exact undo of `update_element`/`reschedule_element`
  needs the *previous* values. Enrich those op payloads at **write time** (`updateWithin` /
  `rescheduleWithin`) to record the pre-image — this is a payload enrichment within the closed op
  set, **not** a schema migration and **not** a new op type. Backfill is unnecessary (undo only
  ever targets ops written after this change; an old op without a pre-image returns
  `{ undone: false }` gracefully).
- **Retire, don't duplicate, the queue's recipe undo.** Prefer migrating `QueueScreen`'s
  `queue.undo` callers onto the general `undo.last()`; if that is too large for this task, leave
  the recipe undo in place and ensure the two never fight (the general undo always targets the
  *global* last op).
- Purge is irreversible by design — that is the whole point of a two-stage delete. Gate
  `purge`/`emptyTrash` behind explicit confirmation; never auto-purge in M9.
- Undo is a stack of one for the MVP (the *last* op). A multi-step undo/redo stack is a later
  refinement; keep `undoLast` shaped so a redo (re-applying the inverse's inverse) is natural.

---

## T045 — Basic analytics

- **Status:** `[ ]`  · **Depends on:** T037, T028
- **Roadmap line:** Done when: a view shows daily reviews, due cards/topics, new cards/extracts,
  deletions, leeches, and 30-day retention.

### Goal

A read-only **Analytics** view (matching `design/kit/app/screen-analytics.jsx`) gives the user a
30-day snapshot of their learning system: **daily reviews** (a `Spark` over the last N days),
**due cards / due topics** right now, **new cards / new extracts** created in the window,
**deletions**, **leeches**, and **30-day retention** (% of reviews graded ≥ Hard, i.e. not
`again`). Every number is computed by a domain aggregation over `review_logs` + `elements` +
`review_states` — **never** in React — and surfaced as `Metric`s + `Spark`s.

### Context to load first

- Reference: `CLAUDE.md` "Testing expectations" (analytics has unit tests); `design-system.md`
  `screen-analytics` row, `Metric`/`Spark`/`Banner`.
- Existing code to inspect: `packages/db/src/schema/cards.ts` (`review_logs.reviewedAt`/`rating`
  indexed; `review_states.dueAt`/`lapses`; `cards.is_leech`); `packages/db/src/schema/elements.ts`
  (`elements.type`/`status`/`createdAt`/`deletedAt`/`dueAt`); `packages/local-db/src/review-repository.ts`
  (`listLeechCards`, `listReviewLogs`); `packages/local-db/src/queue-repository.ts` (`dueCardCount`,
  `dueCards`, `dueAttentionItems`); `packages/scheduler/src/date-util.ts` (day-bucketing helpers,
  if present — reuse, don't reinvent date math); `design/kit/app/screen-analytics.jsx` +
  `design/kit/app/data.js` (`reviewHistory`, `forecast`); `apps/web/src/shell/nav.ts` ("Analytics"
  entry to re-point); `apps/web/src/router.tsx` (add `/analytics`).
- Invariants in play: analytics is **read-only** (no mutation, no `operation_log`); aggregation
  runs in the main/domain layer; retention is defined precisely (see below) and computed from the
  durable `review_logs`, so it survives restart and matches what the user actually graded.

### Deliverables

- [ ] **An `AnalyticsService` (or `analytics-query.ts`) in `packages/local-db`**
      (`packages/local-db/src/analytics-query.ts`, exported from the index + `Repositories`):
      `computeAnalytics(asOf, { windowDays = 30 }): AnalyticsSummary`, a single read that returns:
      - `reviewsByDay: { date: string; count: number }[]` — `review_logs` grouped by calendar day
        over the window (the `Spark`). Day bucketing uses the local day (document the timezone
        choice — local day, derived from `reviewedAt`).
      - `reviewsTotal`, `reviewsPerDayAvg`.
      - `retention30d: number` — **% of reviews in the window graded `hard`/`good`/`easy` (i.e.
        not `again`)**, the simple recall-success proxy (document this definition in the file; true
        FSRS retrievability is a later refinement, M17). `null` when there are no reviews.
      - `dueCards: number`, `dueTopics: number` — from `QueueRepository.dueCardCount` +
        `dueAttentionItems` (the two-scheduler split shows up here: cards vs topics/extracts are
        counted separately).
      - `newCards: number`, `newExtracts: number` — `elements` of type `card`/`extract` with
        `createdAt` in the window.
      - `deletions: number` — `elements` with `deletedAt` in the window (or
        `soft_delete_element` ops in the window — prefer `deletedAt` for the live count).
      - `leeches: number` — `ReviewRepository.listLeechCards().length` (or a `count`).
      - All counts respect soft-delete where it matters (e.g. `newCards` counts created cards even
        if later trashed? — **document**: count by `createdAt` regardless of deletion, since it
        measures throughput; `dueCards` excludes deleted/suspended).
- [ ] **An `analytics.*` `window.appApi` surface**: channel `analyticsGet` (`analytics:get`);
      contract `analytics.get({ asOf?, windowDays? }) → AnalyticsSummary` (Zod request schema +
      result type in `contract.ts` + `contract.test.ts`); preload `analytics` group; IPC handler;
      `DbService.getAnalytics` (+ `db-service.test.ts`); renderer client
      (`apps/web/src/lib/appApi.ts`).
- [ ] **An `/analytics` route + `AnalyticsScreen`** (`apps/web/src/router.tsx` + e.g.
      `apps/web/src/analytics/AnalyticsScreen.tsx` + css module), rebuilt from
      `design/kit/app/screen-analytics.jsx`: the top `Metric` row (Retention %, Reviews, due,
      leeches/deletions), the "Reviews per day" `Spark` panel, and the "System health" `Banner`s
      (leeches → link to `/maintenance/leeches`; deletions → link to `/trash`). Re-point the
      `SECONDARY_NAV` "Analytics" entry + the `GOTO_MAP` `a` key (`apps/web/src/shell/nav.ts`) to
      `/analytics`. (The kit's "Retention by concept" + "7-day forecast" panels depend on concepts
      (M8) + a forecast model — **render only the data we have in M9** and note concept-level
      retention + forecast as M17 deferrals.)
- [ ] **Tests (Vitest, `packages/local-db`):** seed a deterministic fixture (via
      `packages/testing` factories + `test-db.ts`) of `review_logs` across several days + some
      `again` grades + N new cards/extracts + a soft-deleted element + a leech card, then assert
      `computeAnalytics` returns the exact `reviewsByDay`, `reviewsPerDayAvg`, `retention30d`
      (e.g. 8/10 non-again = 80%), `dueCards`/`dueTopics`, `newCards`/`newExtracts`, `deletions`,
      and `leeches`. Test the window boundary (a review just outside `windowDays` is excluded) and
      the empty case (`retention30d = null`).
- [ ] **Tests (Vitest, renderer component):** `AnalyticsScreen` renders the metrics + spark from a
      mocked `analytics.get` payload; the leech/deletion banners link to the right routes.
- [ ] **Playwright E2E** (`tests/electron/analytics.spec.ts`): on the seeded DB, open `/analytics`
      → the metrics + the reviews-per-day spark render with non-placeholder numbers → grade a card
      `Again` in `/review`, return to `/analytics` → "Reviews" increments and retention reflects
      the failed grade → **restart the app** → the numbers persist (they are computed from durable
      `review_logs`).

### Done when

- A view shows **daily reviews, due cards/topics, new cards/extracts, deletions, leeches, and
  30-day retention**, all computed by a domain aggregation over `review_logs`/`elements`/
  `review_states` and rendered as `Metric`s/`Spark`s; the numbers are correct (unit-tested) and
  survive **app restart**.
- The aggregation lives in `packages/local-db` (`AnalyticsService`), **not** React; analytics is
  read-only (no `operation_log` writes).
- `pnpm typecheck`, `pnpm test`, and the analytics Playwright spec pass.

### Notes / risks

- **Pin the retention definition** ("not `again`" over the window) and document it — it is the
  contract T046's banner and the screen both depend on, and it must match what a user expects
  from their grades. FSRS-true retrievability + retention-by-concept are **M17/T083** — note the
  deferral; do not build them here.
- Compute one `AnalyticsSummary` in a single pass where practical (the screen reads one payload);
  index support already exists (`review_logs_reviewed_idx`, `elements` type/status).
- The kit's "forecast" panel needs a due-date forecast model — **defer** (render only
  `reviewsByDay` in M9). The "Day streak" metric needs a streak calc — include it only if cheap
  from `reviewsByDay` (consecutive days with ≥1 review); otherwise defer and omit the tile.
- Source-yield analytics (read %, extracts/cards per source) is **M17/T083** — T045 is the
  *system-wide* snapshot only.

---

## T046 — Import/process balance warnings

- **Status:** `[ ]`  · **Depends on:** T045
- **Roadmap line:** Done when: the app warns when imports outpace processing, showing sources
  imported / extracts created / cards created / reviews due this week.

### Goal

Catch the core failure mode of an incremental-reading system — **importing faster than you
process** — before the inbox silently buries old high-value material. A `Banner`
(`design/kit/app/components.jsx`) appears on the **inbox** (and the analytics view) when the
week's **imports outpace processing**, showing the four weekly numbers: **sources imported /
extracts created / cards created / reviews due this week**. The imbalance judgment + the numbers
are computed in the domain layer (an extension of the T045 aggregation), never in React.

### Context to load first

- Reference: `scheduling-and-priority.md` (overload protection; "don't let newly imported
  material dominate older high-value material"); `CLAUDE.md` "MVP boundaries" (inbox triage; due
  queue); `design-system.md` `Banner`, the `screen-inbox` + `screen-analytics` rows.
- Existing code to inspect: `packages/local-db/src/analytics-query.ts` (T045 — extend it);
  `packages/local-db/src/queue-repository.ts` (`dueCardCount` / `dueCards` / `dueAttentionItems`
  for "reviews due this week"); `elements` (`type`/`createdAt` for sources/extracts/cards
  imported/created this week); `design/kit/app/screen-inbox.jsx` (where the banner sits) +
  `apps/web/src/pages/inbox/` (the inbox screen to host the banner); `apps/web/src/analytics/AnalyticsScreen.tsx`
  (T045 — host the banner there too); `packages/core/src/settings.ts` (add the threshold setting).
- Invariants in play: balance is **read-only / advisory** (it never auto-postpones or deletes —
  that's M16/T077); the math lives in the domain layer; the threshold is a stable setting.

### Deliverables

- [ ] **A balance computation in `packages/local-db`** — extend the T045 `AnalyticsService` (or a
      sibling `computeBalance(asOf, { windowDays = 7 }): BalanceSummary`):
      - `sourcesImported: number` — `elements` of type `source` with `createdAt` in the last 7 days.
      - `extractsCreated: number` — type `extract`, `createdAt` in the window.
      - `cardsCreated: number` — type `card`, `createdAt` in the window.
      - `reviewsDueThisWeek: number` — due cards (+ optionally due attention items) with `dueAt`
        within the next 7 days (`QueueRepository`).
      - `imbalanced: boolean` + `severity: "ok" | "warn" | "danger"` — the judgment. **Define the
        rule explicitly and keep it a pure function** (e.g. `imbalanced` when
        `sourcesImported > (extractsCreated + cardsCreated) * factor` AND `sourcesImported` exceeds
        a floor, so a quiet week doesn't false-alarm). Put the rule + the factor/floor constants in
        one place (`packages/local-db/src/balance.ts` or `@interleave/core`) so it is unit-testable
        and tunable. Default factor/floor documented; overridable via the setting below.
- [ ] **A balance-threshold setting:** add `SETTINGS_KEYS.importBalanceFactor` (and/or a simple
      on/off `SETTINGS_KEYS.balanceWarnings`) to `packages/core/src/settings.ts` (`AppSettings` +
      `coerceSettingValue` + the renderer `AppSettings` mirror + the `/settings` toggle). Keys are
      stable (part of backup, T047).
- [ ] **A `balance.*` `window.appApi` surface** (or fold into `analytics.*`): channel
      `balanceGet` (`balance:get`); contract `balance.get({ asOf?, windowDays? }) → BalanceSummary`
      (Zod + result type + `contract.test.ts`); preload group; IPC handler;
      `DbService.getBalance` (+ test); renderer client.
- [ ] **A balance `Banner` in the renderer**, rendered on the **inbox** (`apps/web/src/pages/inbox/…`)
      and the **analytics** screen (T045) when `imbalanced`: e.g. "You're importing faster than you
      process — N sources in, only M extracts/cards out this week; K reviews due." with the four
      numbers and a soft action ("Open queue" / "Triage inbox"). Use the `Banner` variant matching
      `severity` (warn/danger). Hidden when `severity === "ok"`.
- [ ] **Tests (Vitest, `packages/local-db`):** the pure balance rule — `imbalanced`/`severity`
      true when imports exceed the processed output by the factor above the floor, false on a
      balanced or quiet week (boundary cases either side of the factor + the floor);
      `computeBalance` returns the correct four counts for a seeded week (sources/extracts/cards by
      `createdAt`, due-this-week from `dueAt`), and excludes items outside the 7-day window.
- [ ] **Tests (Vitest, renderer component):** the inbox/analytics screen shows the `Banner` only
      when the mocked `balance.get` payload is `imbalanced`, with the four numbers; respects the
      `balanceWarnings` off toggle.
- [ ] **Playwright E2E** (extend `tests/electron/analytics.spec.ts` or
      `tests/electron/balance.spec.ts`): seed a week with many imported sources but few
      extracts/cards → the balance `Banner` shows on the inbox with the four numbers → process /
      create enough extracts to rebalance (or toggle the warning off) → the banner disappears →
      **survives app restart**.

### Done when

- The app **warns when imports outpace processing**, showing **sources imported / extracts created
  / cards created / reviews due this week**; the imbalance rule + numbers are computed in the
  domain layer (pure, unit-tested) and rendered as an advisory `Banner` on the inbox + analytics;
  the warning respects its setting and survives **app restart**.
- The balance math lives in `packages/local-db`/`@interleave/core`, **not** React; balance is
  advisory only (no auto-postpone/delete).
- `pnpm typecheck`, `pnpm test`, and the balance Playwright spec pass.

### Notes / risks

- **Keep the rule a pure, tunable function** with a documented default and a floor so a quiet week
  (few imports) never false-alarms. The threshold is a setting, not a magic constant scattered in
  the code.
- This is **advisory** only. **Auto-postpone / overload management** (sacrificing low-priority
  material when due load exceeds the budget) is **M16/T077** — note the deferral; do not mutate
  schedules from the balance check.
- Reuse the T045 windowed aggregation rather than re-querying from scratch — the only differences
  are the 7-day window and the import-vs-output framing.

---

## T047 — Backup / export

- **Status:** `[ ]`  · **Depends on:** T008
- **Roadmap line:** Done when: an Electron-managed backup exports a ZIP of `app.sqlite` + the
  `assets/` vault + a `manifest.json` (schema version, app version, timestamp, integrity hashes)
  into `backups/<timestamp>/`; the format is designed for restore from the start so a backup
  re-imports into a fresh install.

### Goal

The user can capture their entire local knowledge base in one portable archive. An
**Electron-main-managed** backup copies the **canonical local store** — the native SQLite database
(`app.sqlite`, checkpointed so WAL contents are included) + the filesystem **asset vault**
(`assets/`) — and writes a `manifest.json` (schema version = latest Drizzle migration tag, app
version, ISO timestamp, per-file integrity hashes) into `backups/<timestamp>/`, then zips it. The
**format is designed for restore from day one** (deterministic layout, version + hashes so a
restore can verify and reject a too-new or corrupt backup), even though **restore itself is
deferred** to the server/sync phase (M11/T055). The renderer triggers it through a typed
`backups.create` command and never touches the filesystem.

### Context to load first

- Reference: `CLAUDE.md` "Asset vault" (the `assets/` + `backups/<timestamp>/` layout: `app.sqlite`
  + `assets-manifest.json`), "SQLite rules" (WAL — must checkpoint before copying), "Data rules"
  (backup = SQLite file + vault, **not** a JSON dump).
- Existing code to inspect: `apps/desktop/src/main/paths.ts` (`AppPaths` — `dbPath`, `assetsDir`,
  `backupsDir`; `INTERLEAVE_DATA_DIR` override for tests); `apps/desktop/src/main/db-service.ts`
  (owns the open `better-sqlite3` handle — needed to `PRAGMA wal_checkpoint` / use
  `Database.backup()`); `apps/desktop/src/main/migrations.ts` + `packages/db/src/migrator.ts` +
  `packages/db/drizzle/meta/_journal.json` (the latest migration tag = the manifest schema
  version; the `__drizzle_migrations` table is the runtime source); `packages/local-db/src/asset-repository.ts`
  (asset metadata — id/`vaultRoot`/`relativePath`/`contentHash`/`size`/`mime` for the
  asset-manifest); `design/kit/app/screen-settings.jsx` (the Settings "backup" affordance — where
  the button lives); `apps/web/src/pages/Settings.tsx`.
- Invariants in play: backup is a **copy of the canonical store** (SQLite file + vault), not a
  re-serialization; the DB must be checkpointed/consistent before copying (WAL); the manifest is
  the restore contract (version + hashes); the renderer never sees absolute paths or touches files.

### Deliverables

- [ ] **A zip dependency on the MAIN side.** Add a zip library to `apps/desktop/package.json`
      (e.g. `archiver` or `yazl` — pure-JS, no native build; pin a known-good version; install
      updates `pnpm-lock.yaml`). **Confirmed not present today** — no archiver/yazl/jszip/adm-zip
      anywhere. It runs only in the Electron main process; the renderer never imports it. (A
      desktop **packager** — electron-builder/forge — is a **separate** concern, **T050**, and is
      out of scope here; T047 only zips a backup.)
- [ ] **A `BackupService` in `apps/desktop/src/main/`** (e.g. `apps/desktop/src/main/backup-service.ts`,
      main-process only — it needs absolute paths + the live DB handle), `createBackup(): BackupResult`:
      1. **Checkpoint the DB** so the backup is consistent: run `PRAGMA wal_checkpoint(TRUNCATE)`
         (or use better-sqlite3's `db.backup(destPath)` online-backup API, which is the safest —
         **prefer `db.backup()`** to snapshot a consistent `app.sqlite` without disturbing the live
         WAL).
      2. **Create `backups/<timestamp>/`** (ISO-ish, filesystem-safe timestamp) under `paths.backupsDir`.
      3. **Copy `app.sqlite`** into it (from the consistent snapshot in step 1).
      4. **Copy the `assets/` vault** recursively into `<timestamp>/assets/` (the bytes; the
         renderer never does this).
      5. **Write `manifest.json`** with the restore contract:
         - `formatVersion` (the backup-format version, start at `1`),
         - `schemaVersion` — the **latest applied Drizzle migration tag** (read from
           `__drizzle_migrations` / `_journal.json` last entry, e.g. `"0001_clever_rictor"`),
         - `appVersion` — `app.getVersion()` (or the desktop `package.json` version),
         - `createdAt` — ISO timestamp,
         - `files` — `[{ path, sha256, size }]` for `app.sqlite` and **every** asset file
           (integrity hashes; reuse `AssetRepository.contentHash` where it matches the on-disk
           hash, recompute otherwise — document the choice),
         - `counts` — element/source/extract/card/asset counts (a quick human sanity check),
         - `assetVaultRoot: "assets"`.
      6. **Zip** `<timestamp>/` into `backups/<timestamp>.zip` (or write the dir then zip — choose
         and document; the kit/charter shows the unzipped `backups/<timestamp>/` layout, so keep
         the **unzipped directory** as the canonical structure and the `.zip` as the portable
         artifact).
      7. Return `BackupResult = { path: string; timestamp: string; sizeBytes: number; fileCount: number; schemaVersion: string }`
         (the `path` is the `.zip`).
- [ ] **A `backups.*` `window.appApi` surface**: channel `backupsCreate` (`backups:create`);
      contract `backups.create() → BackupResult` (Zod `z.void()` request + result type in
      `contract.ts` + `contract.test.ts`); preload `backups` group; IPC handler in `ipc.ts`;
      `DbService` (or the main process directly) wiring `BackupService.createBackup`; renderer
      client (`apps/web/src/lib/appApi.ts`). **No raw filesystem/path is ever exposed to the
      renderer** — the result carries only the final path string for display ("Backed up to …").
      (A "reveal in Finder" affordance, if wanted, is a separate `shell.openPath` main-side
      command — optional, note it.)
- [ ] **A backup button in `/settings`** (`apps/web/src/pages/Settings.tsx`, matching
      `design/kit/app/screen-settings.jsx`'s backup affordance): "Back up now" → `appApi.backups.create()`
      → toast the result path + timestamp + size. Disabled-with-spinner while running.
- [ ] **A documented restore contract (design, not implementation).** Add a short
      `## Restore (deferred to T055)` note to this spec **and** a comment block at the top of
      `BackupService` describing exactly how a future restore consumes the archive: verify
      `formatVersion`/`schemaVersion` (reject if `schemaVersion` is newer than the installed
      migration tag), verify every file's `sha256`, copy `app.sqlite` into a fresh app data dir,
      copy `assets/` into the vault, run migrations forward if older. Restore is **NOT** built in
      T047 — but the format guarantees it is mechanical.
- [ ] **Tests (Vitest, `apps/desktop` main):** `createBackup` against a temp `INTERLEAVE_DATA_DIR`
      (a seeded in-memory-then-flushed or on-disk test DB + a couple of vault files): the
      `backups/<timestamp>/` dir + `.zip` are created; the zip unzips to `app.sqlite` + `assets/…`
      + `manifest.json`; the opened-from-backup `app.sqlite` has the same row counts as the source
      (a consistency check the WAL-checkpoint guarantees); `manifest.json` has the right
      `schemaVersion` (the latest migration tag), `appVersion`, `createdAt`, and a `sha256` per
      file that matches a recomputed hash; tampering with a copied file makes its hash mismatch
      (integrity check works).
- [ ] **Tests (Vitest, `DbService`/contract):** the `backups.create` handler validates + returns
      the `BackupResult` shape.
- [ ] **Playwright E2E** (`tests/electron/backup.spec.ts`): on the seeded app, open `/settings` →
      "Back up now" → a `BackupResult` path is returned and the `.zip` exists on disk under the
      test `backups/` dir → unzip + assert `manifest.json` + `app.sqlite` + the seeded asset files
      are present and the manifest hashes verify → **restart the app** → the backup file still
      exists (it lives in the vault, outside the DB) and a second backup produces a distinct
      timestamped archive.

### Done when

- An Electron-managed backup exports a **ZIP** of `app.sqlite` (consistently checkpointed) + the
  `assets/` vault + a `manifest.json` (schema version = latest migration tag, app version, ISO
  timestamp, per-file integrity hashes) into `backups/<timestamp>/`; the **format is designed for
  restore from the start** (versioned + hashed + deterministic layout) so a backup can re-import
  into a fresh install; the backup is reachable from `/settings` and produced entirely in the
  Electron main process.
- The renderer triggers backup only through `backups.create` over typed `window.appApi`; **no raw
  filesystem/SQLite access is exposed to the renderer**, and the backup is a copy of the canonical
  store, not a JSON dump.
- `pnpm typecheck`, `pnpm test`, and the backup Playwright spec pass.

### Notes / risks

- **WAL consistency is the key correctness risk.** A naive file copy of `app.sqlite` while WAL is
  active misses un-checkpointed pages. Use better-sqlite3's online `db.backup(dest)` (preferred)
  or `PRAGMA wal_checkpoint(TRUNCATE)` immediately before copying. The Vitest row-count check
  guards this.
- **Restore is deferred (M11/T055)** — but T047 *must* make it mechanical by versioning + hashing
  the manifest. Do not build restore now; do design the format so a future restore can verify and
  reject a too-new/corrupt backup.
- The manifest's `schemaVersion` is the **migration tag**, not a `schema_version` column (there is
  none) and not `documents.schemaVersion` (an unrelated ProseMirror field). Read it from the
  `__drizzle_migrations` journal at backup time.
- The desktop **installer/packager** (electron-builder/forge) is **T050**, not this task. T047
  only needs a pure-JS zip library on the main side.
- Encrypted backups are **M19/T098** — leave a seam (the manifest could later note `encrypted:
  true`) but ship plaintext archives in M9. Scheduled/automatic backups are a later polish (T050
  "backup prompts"); M9 ships the manual "Back up now".
- A backup of a 100k-element collection with large assets is sized for **M20/T100** — for M9 a
  straightforward recursive copy + zip is fine; note that incremental/dedup backup is a later
  scale concern.

### Restore (deferred to T055)

Restore is **NOT** built in T047 — but the format produced here guarantees it is mechanical. A
future one-way restore-onto-a-fresh-install (M11/T055) consumes a T047 archive as follows (the
contract is also documented in the header comment of
`apps/desktop/src/main/backup-service.ts`):

1. **Unzip** the `.zip` and read `manifest.json`.
2. **Verify `formatVersion`** is understood — reject an unknown/newer format (today: `1`).
3. **Verify `schemaVersion`** is **not newer** than the installed Drizzle migration tag — reject a
   backup from a newer app (the installed schema cannot represent it). A backup **older** than the
   installed schema is fine: migrations run forward after the copy.
4. **Verify integrity** — every entry in `files[]` exists and its on-disk SHA-256 matches the
   recorded `sha256` (reject a corrupt/tampered archive **before** touching any data).
5. **Copy `app.sqlite`** into a fresh app data directory's `dbPath` (the snapshot is a clean,
   WAL-free `VACUUM INTO` file — no `-wal`/`-shm` siblings to carry).
6. **Copy `assets/`** (rooted at `assetVaultRoot`, i.e. `"assets"`) into the vault.
7. **Open the DB and run migrations forward** if the backup's schema is older than the installed one.

The manifest's `counts` (element/source/extract/card/asset) give a quick human sanity check before
and after a restore. Encrypted archives (M19/T098) would add an `encrypted: true` manifest flag at
that time; T047 ships plaintext.

---

## Exit criteria for M9

- All of T044–T047 are `[x]` in [`../roadmap.md`](../roadmap.md).
- **Safety:** soft delete (everywhere), a **Trash** view, **restore**, and a **general
  command-level undo** all work; undo reverses the last `operation_log` op and covers
  **delete / mark-done / suspend / bulk-postpone**; permanent delete is the only hard delete and
  is confirmation-gated; restored elements keep `card → extract → source location → source`
  lineage. Undo adds **no new op type** (the inverse is one of the closed 15 and is itself logged).
- **Self-awareness:** an **Analytics** view shows daily reviews, due cards/topics, new
  cards/extracts, deletions, leeches, and 30-day retention — all computed by a domain aggregation
  over `review_logs`/`elements`/`review_states` (correct + unit-tested) — and an **import/process
  balance** `Banner` warns when imports outpace processing, showing sources imported / extracts
  created / cards created / reviews due this week (advisory only; no auto-postpone).
- **Durability:** an Electron-managed **backup** exports a versioned, hashed **ZIP** of
  `app.sqlite` (consistently checkpointed) + the `assets/` vault + `manifest.json` into
  `backups/<timestamp>/`, with a format **designed for restore** (restore itself is deferred to
  M11/T055).
- All new capabilities reach the renderer **only** through new typed `window.appApi` commands
  (`trash.*`, `undo.*`, `analytics.*`, `balance.*`, `backups.*`) with Zod-validated IPC; **no raw
  DB/filesystem access is exposed to the renderer**, and no generic `db.query`. Undo / analytics /
  balance / backup logic lives in `packages/local-db` / `packages/scheduler` / the Electron main
  process — **never** in React.
- Every feature **survives an app restart**: the trash list + restored elements persist, the
  analytics/balance numbers are recomputed from durable tables, and backups persist on disk.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M9 Playwright specs (trash + undo;
  analytics; balance; backup → valid zip → restart) are green.

When M9 is complete, generate `tasks/M10-keyboard-e2e-ship.md` (T048–T050) from the roadmap before
starting T048. (Note: `tasks/M8-organize-search.md` for T041–T043 must also be generated before
its tasks — M8 precedes M9 in the roadmap and its spec file does not yet exist.)
