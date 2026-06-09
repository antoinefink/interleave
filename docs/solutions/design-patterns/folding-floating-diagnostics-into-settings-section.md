---
title: Fold a floating diagnostics surface into the native Settings vocabulary
date: 2026-06-09
category: docs/solutions/design-patterns
module: apps/web Settings page
problem_type: design_pattern
component: frontend_stimulus
severity: medium
related_components:
  - testing_framework
  - database
applies_when:
  - Re-skinning or relocating a UI surface that existing unit/E2E tests assert against
  - Moving a self-fetching panel (its own useEffect bridge reads) into a parent component
  - Porting a design-kit mockup into the real React + token-only-CSS stack
  - Rendering health/status diagnostics through the typed window.appApi bridge
tags:
  - design-kit-port
  - settings
  - test-contract
  - data-testid
  - window-appapi
  - status-chip
  - component-reuse
---

# Fold a floating diagnostics surface into the native Settings vocabulary

## Context

The web Settings page (`apps/web/src/pages/Settings.tsx`) carried a desktop-diagnostics
readout (`DesktopStatusPanel`) that was rendered **outside** `<Settings/>` by the router
(`router.tsx` `SettingsScreen()`) as a narrow, centered `max-w-md` floating card showing a raw
7-row `<dl>` key/value dump. It read "strange / detached" because it invented its own layout
instead of speaking the page's section vocabulary.

The fix relocated and re-skinned it into a native, full-width **"System"** section at the bottom
of the Settings column — same `SettingRow` rows, the same `bg-ok-soft`/`text-ok` OK chip and a
neutral mono token pill used elsewhere — regrouping the 7 raw values into 4 readable rows (Local
database → Healthy chip; Schema → "{n} migrations" + Up to date; Connection → `wal`/`FK on`/`{ms}
ms` tokens; Persistence check → value + Write check button). No feature changed: the same typed
`window.appApi` calls (`health`/`dbStatus`/`getSettings`/`updateSetting`) and the T007
restart-survival/persistence proof were preserved.

The non-obvious part wasn't the markup — it was doing this **without breaking the test contract**
that proves the renderer reaches SQLite only through the typed bridge and that writes survive a
restart. This doc captures the four learnings that the test contract forced.

## Guidance

### 1. Re-skinning a tested surface is a refactor-under-test-contract: preserve the load-bearing `data-testid` hooks

A diagnostics/status surface usually exists *because of a test*. Here, an Electron E2E
(`tests/electron/desktop.spec.ts`) and a unit suite asserted on specific hooks. Before changing
any markup, enumerate which hooks are load-bearing and keep them on the new nodes — change only
the **assertions whose visible text the redesign actually changes**.

```
desktop-status (+ data-desktop="true")  -> kept on the new <section>
health-status                           -> kept on the chip; E2E text "ok" -> "Healthy" (updated)
db-journal-mode                         -> kept on the "wal" token (text unchanged -> assertion unchanged)
persist-button / persisted-value        -> kept; round-trip assertions unchanged
```

The exact-match `toHaveText("ok")` was the trap: a re-skin that changes a chip's label from `ok`
to `Healthy` silently breaks an exact assertion. Grep every testid the redesign touches and
update assertions deliberately, in the same commit.

### 2. Moving a self-fetching panel *into* a parent means the parent's test mock must gain the panel's bridge methods

The deleted `DesktopStatusPanel` rendered outside `<Settings/>`, so `Settings.test.tsx`'s
`appApi` mock never needed `health`/`dbStatus`/`getSettings`/`updateSetting`. The moment the panel
moved **inside** `<Settings/>`, those methods are called on mount — and an `appApi` mock that
omits them makes every call `undefined()`, throwing during render and breaking **all** of the
parent's existing tests, not just the new ones.

```ts
// Settings.test.tsx — extend the hoisted mock BEFORE the panel mounts inside <Settings/>
const h = vi.hoisted(() => ({ /* …existing… */, health: vi.fn(), dbStatus: vi.fn(),
  getSettings: vi.fn(), updateSetting: vi.fn() }));
// …and give them beforeEach defaults so the 24 pre-existing tests stay green.
```

### 3. Gate a status chip's loading/healthy state on the error flag so a failed load is *coherent*

A naive `loading = a === null || b === null` leaves the chip on "Checking…" **forever** when the
first bridge read rejects (the values never arrive), while an error row renders below it — an
incoherent "Checking… + error" pair, and the explicit "Unavailable" branch becomes unreachable. A
later transient refresh failure can likewise leave a stale "Healthy" chip beside the error.

```tsx
// Gate both derived states on the absence of an error.
const loading = !error && (health === null || status === null);
const healthy = error === null && health?.status === "ok" && status?.open === true;
// first-load failure  -> loading=false, healthy=false -> "Unavailable" + error row (coherent)
// transient refresh failure -> "Unavailable" + error (no stale "Healthy")
```

### 4. Reuse the existing chip/token vocabulary instead of inventing

The "Healthy"/"Up to date" chips are the same class string already used by the backup-result and
capture-status chips (`inline-flex items-center gap-1.5 rounded-md bg-ok-soft px-2.5 py-1 text-ok
text-xs`); the neutral mono token pill (`border border-border bg-surface font-mono text-text-2
text-xs`) needs no new CSS variables. Fidelity to the design system beats fidelity to a mockup's
approximation.

A small adjacent gotcha: a hand-rolled `<section>` was used (not the shared `SectionPanel`)
specifically because the section needed `data-testid="desktop-status"` + `data-desktop` and
`SectionPanel` takes no testid prop — mirroring how the "Browser capture" section already
hand-rolls the identical chrome. Branch to a hand-rolled variant when a shared component can't
carry a required attribute, rather than widening the shared component for one caller.

## Why This Matters

A "design task" on a diagnostics surface is rarely just markup — the surface is wired to a proof
(here: the renderer reaches SQLite only via the typed bridge, and writes survive restart). Treat
it as a refactor under a test contract: the redesign is only correct if the proof still passes.
Missing learning #2 breaks the *entire* parent test file (not an obvious failure mode from the
diff alone); missing #1 breaks an exact-text E2E assertion; missing #3 ships an incoherent UI
state that no happy-path test catches.

## When to Apply

- Relocating/re-skinning any UI surface that unit or E2E tests assert against.
- Moving a component that does its own `window.appApi` (or other bridge) reads into a parent.
- Rendering health/status as chips with loading + error states.
- Porting a Claude Design handoff mockup into the real renderer.

## Examples

Before — floating, detached, rendered outside `<Settings/>`:

```tsx
// router.tsx
function SettingsScreen() {
  return (
    <div className="flex h-full min-h-full flex-col overflow-auto">
      <Settings />
      <div className="mx-auto w-full max-w-3xl px-7 pb-10">
        <DesktopStatusPanel />   {/* 7-row <dl> dump in a max-w-md card */}
      </div>
    </div>
  );
}
```

After — integrated `SystemPanel` inside the Settings column, same bridge calls, same testids,
coherent states:

```tsx
// Settings.tsx (rendered after the Browser-capture section)
<section className="mb-6" data-testid="desktop-status" data-desktop="true">
  <div className="…uppercase tracking-wide">System</div>
  <div className="rounded-lg border border-border bg-surface-2 px-4">
    <SettingRow label="Local database" hint="On-device SQLite store…">
      {loading ? <Token testid="health-status">Checking…</Token>
        : healthy ? <OkChip testid="health-status" icon="checkCircle">Healthy</OkChip>
        : <span data-testid="health-status" className="…text-danger…">Unavailable</span>}
    </SettingRow>
    {/* Schema / Connection token rows, Persistence-check write button … */}
  </div>
</section>
```

Verification that the contract held: `pnpm test` (full suite green, incl. the migrated System
coverage) and `pnpm build && pnpm e2e --project=electron tests/electron/desktop.spec.ts` (8/8,
including the restart-survival relaunch). Rebuild before the Electron E2E — Playwright loads the
built `dist`, not live source.

## Related

- [Three-zone scroll-owned review card surface](three-zone-scroll-owned-review-card-surface.md) — the same `design-kit-port` meta-pattern (reuse canonical components, preserve testids) applied to the in-session review card. Different surface, different files.
- [Compact card quality-check disclosure](compact-card-quality-check-disclosure.md) — the direct precedent for "preserve `data-testid` row contracts during a reskin; only update assertions whose visible text changed," and for regrouping raw items into a readable summary.
- [Process Queue inline session controls](../ui-bugs/process-queue-inline-session-controls.md) — first doc to name `data-testid` stability as load-bearing when controls are relocated into a parent.
- [Restore a backup from an untrusted file on disk](../architecture-patterns/restore-backup-from-untrusted-file.md) — the most recent prior addition to the Settings page's `window.appApi` mock surface; the canonical record of what bridge methods a `Settings.tsx` test mock must include.
- [Electron SQLite backup restore/reset coordination](../architecture-patterns/electron-sqlite-backup-restore-reset-coordination.md) — establishes the T007 restart-survival proof this refactor preserved.
