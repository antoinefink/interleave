---
title: "Relocating screen-specific UI into the shared shell inspector via a UI-only context bridge"
date: "2026-06-18"
category: "docs/solutions/architecture-patterns/"
module: "apps/web shell Inspector + Import & Inbox triage"
problem_type: "architecture_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "Moving a screen-local control cluster into the shared shell Inspector (or any always-mounted shell slot)"
  - "A page needs to drive behavior in a shell component it cannot reach through the router tree"
  - "Two components must share UI state + DOM-focus coordination without a parent in common"
  - "Deleting a redundant rail/column and reflowing the freed width into a reader"
related_components:
  - "apps/web/src/shell/inboxTriagePanel.tsx"
  - "apps/web/src/shell/selection.tsx"
  - "apps/web/src/components/inspector/Inspector.tsx"
  - "apps/web/src/pages/inbox/InboxScreen.tsx"
  - "apps/web/src/pages/inbox/InboxTriageSection.tsx"
tags:
  - inspector
  - shell-context
  - ui-bridge
  - inbox-triage
  - gating
  - cross-tree-focus
---

# Relocating screen-specific UI into the shared shell inspector via a UI-only context bridge

## Context

The Import & Inbox screen kept its triage cluster (Read now / Queue soon / Save for later / Delete, the provenance-aware A/B/C/D priority picker, and the T127 suggestion affordances) in a 288px metadata rail wedged between the article preview and the shared shell `Inspector`. That rail's metadata duplicated the Inspector's own `SOURCE`/`PROPERTIES` sections, and the rail itself ate the width that should belong to the article. The goal was to move the unique controls into the Inspector (above `PROPERTIES`) and delete the rail.

The structural obstacle: the `Inspector` is mounted **once** in `Shell.tsx`, a sibling of the route `<Outlet/>`, and is shared by every route (queue, reader, review, card, …). It fetches its own element payload from `useSelection().selectedId` and has **no access** to the inbox screen's handlers or state. So this is not "move some JSX" — it is "establish a one-way state channel from a route into a shared shell component, render the relocated UI only when it belongs, and not regress provenance, keyboard shortcuts, the reveal/focus affordance, or leak the UI onto other routes."

This is the second instance of the same shape (see `shell-status-hint-page-publishes-chrome-context.md`), so it is a pattern worth naming.

## Guidance

Bridge the state with a tiny **UI-only React context** modeled on `apps/web/src/shell/selection.tsx`, and respect five rules that the first naïve version gets wrong.

**1. The bridge is a context, not props.** The publishing screen (`InboxScreen`) calls `setPanel({...})` to publish a payload (target id + handlers + display state); the shell component consumes it via a `useInboxTriagePanel()` hook. No domain logic, no data fetching — references only. Wrap the subtree in `Shell.tsx` alongside `SelectionProvider`.

**2. Gate strictly, and clear aggressively, or the UI leaks onto other routes.** The shared component renders the relocated section only when `panel !== null && panel.targetId === element.id && element.type === <expected>`. Clear the payload in the publishing screen's unmount cleanup (`useEffect(() => () => setPanel(null), [setPanel])`) **and** before any navigation that unmounts the screen (e.g. Read now → `/source/$id`): the destination may select the same element, the type gate still matches, and the section flashes on the wrong route during the navigate→unmount frame. Belt (unmount cleanup) and suspenders (clear-before-navigate).

**3. Keep the volatile payload separate from the stable ref machinery.** The payload is re-published on every busy/highlight/suggestion change. If the DOM-node registration callbacks (used so the screen can scroll/focus the relocated controls) live *inside* that payload object, the shell component's `ref={register}` callback detaches and reattaches on every re-publish — focus loss / churn. Put the register setters and their `useRef` slots on the **context value itself** (created once, `useCallback([], [])`), never on the rebuilt payload.

**4. Re-key cross-tree reveal on registration, not on the publisher's own data.** When the screen wants to scroll/focus the relocated controls, the target DOM node is registered by the shell component *after the component's own independent fetch lands* — which can be later than the publisher's data. A reveal keyed only on the publisher's `detail` fires before the node exists and silently no-ops. Add a registration tick the screen also watches, so a pending reveal retries once the node registers.

**5. Suppress the duplicate when the relocated control overlaps a generic shell control.** The Inspector already has a generic "Set priority" editor. Showing it *and* the relocated provenance-aware picker for the same element violates the single-owner rule (`extract-inspector-single-responsibility-lineage-scheduler.md`). Suppress the generic one while the relocated section is active; keep it for every other element. Note: the *value* row stays; only the editing affordance is suppressed — and because the shell fetches its element independently, fire its refresh signal after the relocated control mutates so its value row re-syncs.

When the relocation deletes a rail/column, reflow the freed width per `process-source-reader-scroll-owner-full-width-measure-on-content.md`: the scroll owner stays full-width; the reading measure (`--reader-text-measure`) caps and centers the **content** node, not an ancestor of the scroll owner.

## Why This Matters

The shell component is shared by every route. The naïve relocation (publish a fat payload, render whenever it exists, rely on unmount timing) produces three field-visible defects that pass unit tests and surface only in the running app:

- **Cross-route leak** — the section paints on the reader/queue route for a frame because the type gate matches and the unmount cleanup hasn't flushed.
- **Focus churn / lost reveal** — the reveal affordance focuses nothing (node not registered yet) or the shell's `ref` callback thrashes because the register fn rides the rebuilt payload.
- **Silent provenance regression** — routing the relocated control through the shell's *generic* mutation path (here `setElementPriority`) drops the screen-specific provenance the original control recorded (T127 accepted/overridden). The two controls *look* equivalent but write through different commands.

These are layering and transient-frame bugs, not output-value bugs — which is exactly why a code-review pass (and these rules) catch them and assertions don't.

## When to Apply

- Relocating screen-owned controls into the shared shell Inspector or any always-mounted shell slot.
- Any time a route must drive UI/behavior in a shell component that is not its descendant.
- When the relocated control has a screen-specific command path (provenance, navigation, optimistic list mutation) that a generic shell control does not replicate.

## Examples

**The context value — stable machinery separate from the volatile payload:**

```ts
interface InboxTriagePanel {            // volatile: re-published on every busy/suggestion/highlight tick
  targetId: string; priority: number; busy: boolean; suggestion: InboxRowSuggestion;
  triageHighlighted: boolean; onReadNow(): void; onPickPriority(b): void; /* … */
}
interface InboxTriagePanelContextValue {
  panel: InboxTriagePanel | null;
  setPanel(p: InboxTriagePanel | null): void;
  registerSection(n: HTMLElement | null): void;       // stable: useCallback([], []) in the provider
  registerReadNowButton(n: HTMLButtonElement | null): void;
  sectionRef: MutableRefObject<HTMLElement | null>;   // read by the publisher's reveal
  readNowRef: MutableRefObject<HTMLButtonElement | null>;
  registrationTick: number;                            // bumps on read-now registration -> reveal retry
}
```

**The gate + single-owner suppression in the shell component:**

```tsx
const { panel, registerSection, registerReadNowButton } = useInboxTriagePanel();
const showInboxTriage = panel !== null && panel.targetId === element.id && element.type === "source";
// …above Properties:
{showInboxTriage && panel ? <InboxTriageSection panel={panel} registerSection={…} registerReadNowButton={…} /> : null}
// …in Properties: suppress the generic editor when the relocated one is active
{showInboxTriage ? null : <SetPriorityRow … />}
```

**Clear before navigate (leak guard) + on unmount:**

```ts
// onReadNow, after the accept succeeds, BEFORE navigate:
setTriagePanel(null);
void navigate({ to: "/source/$id", params: { id } });
// and the unmount cleanup:
useEffect(() => () => setTriagePanel(null), [setTriagePanel]);
```

**Testing the cross-tree behavior without mounting the whole shell:** render the real relocated section from the published payload via a small probe (`useInboxTriagePanel()` → render the section), so reveal/focus and handler wiring exercise live code; unit-test the gate (type/target mismatch → no section) on the shell component directly; prove the real end-to-end (publish → shell gates → renders) with an Electron E2E that clicks the relocated controls. Add a no-flicker test: re-publish with only `busy` changed and assert the section DOM node identity is preserved (not remounted).

## Related

- `docs/solutions/design-patterns/shell-status-hint-page-publishes-chrome-context.md` — the sibling pattern (page publishes chrome into the shell status bar via a `selection.tsx`-modeled context); this doc is the Inspector-targeted, bidirectional (reveal-ref) variant with gating + single-owner suppression.
- `docs/solutions/ui-bugs/extract-inspector-single-responsibility-lineage-scheduler.md` — the Inspector single-owner rule and "test presence and absence" of suppressed controls.
- `docs/solutions/ui-bugs/process-source-reader-scroll-owner-full-width-measure-on-content.md` — full-width scroll owner + centered `--reader-text-measure` on the content node (the rail-removal reflow).
- `docs/solutions/ui-bugs/source-reader-taller-middle-area.md` — reclaim reading space by removing structural chrome, not by collapsing it with CSS.
- `docs/solutions/logic-errors/extraction-is-engagement-not-triage-preserve-inbox-status.md` — triage status is user-owned; the relocated triage controls remain the only sanctioned authors, and gating must respect inbox status.
- `docs/solutions/workflow-issues/inbox-triage-queue-soon-attention-scheduling.md` — the triage verb semantics the relocated cluster exposes; click + keyboard share the same typed verb.
- `docs/solutions/ui-bugs/inbox-row-cursor-selection-single-border.md` — same Import & Inbox surface; `InboxGroupedList.tsx` carries an intentional `\x00other` NUL sentinel (git treats it binary — use `grep -a`, never "fix" it).
