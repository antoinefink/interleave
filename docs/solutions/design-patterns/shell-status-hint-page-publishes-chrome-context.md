---
title: "Shell StatusHint Context — Pages Publish Chrome Into the Status Bar"
date: "2026-06-17"
category: "docs/solutions/design-patterns/"
module: "apps/web shell"
problem_type: "design_pattern"
component: "frontend_stimulus"
severity: "low"
applies_when:
  - "A focused work screen (process session, review) has per-item or per-session action-key hints that belong in the shell chrome, not inside the scrolling content."
  - "A second persistent footer row would otherwise be added to a screen just to show contextual hints."
  - "A page needs to contribute dynamic content into a reserved shell slot without coupling the page to the shell layout."
related_components:
  - "apps/web/src/shell/statusHint.tsx"
  - "apps/web/src/shell/selection.tsx"
  - "apps/web/src/shell/Shell.tsx"
  - "apps/web/src/pages/queue/ProcessQueue.tsx"
tags:
  - "shell"
  - "status-bar"
  - "context-slot"
  - "status-hint"
  - "page-chrome"
  - "design-pattern"
---

# Shell StatusHint Context — Pages Publish Chrome Into the Status Bar

## Context

The Process session's `ProcessCard` showed its per-item action keys (`d done · p postpone · …`) in a `<p class="pq-keys">` row rendered *inside* the scrolling card — a second footer row stacked above the shell's own bottom status bar, costing a full line of reading space on the one screen where reading area matters most. The shell `StatusBar` had a reserved right-side slot, but no mechanism for a screen to put dynamic content there.

## Guidance

Add a tiny provider/hook pair — modeled exactly on `apps/web/src/shell/selection.tsx` — that lets the active screen publish a `ReactNode` into the status bar and clears it on unmount. UI-orchestration state only; no domain logic.

```tsx
// apps/web/src/shell/statusHint.tsx
export interface StatusHintContextValue {
  readonly hint: ReactNode | null;
  setHint(hint: ReactNode | null): void;
}
const StatusHintContext = createContext<StatusHintContextValue | null>(null);

export function StatusHintProvider({ children }: { children: ReactNode }) {
  const [hint, setHint] = useState<ReactNode | null>(null);
  const value = useMemo(() => ({ hint, setHint }), [hint]); // setHint is the stable useState setter
  return <StatusHintContext.Provider value={value}>{children}</StatusHintContext.Provider>;
}

export function useStatusHint(): StatusHintContextValue {
  const ctx = useContext(StatusHintContext);
  if (!ctx) throw new Error("useStatusHint must be used within a <StatusHintProvider>");
  return ctx;
}
```

The shell wraps `ShellInner` with the provider and the `StatusBar` renders whatever it receives:

```tsx
// Shell.tsx
<SelectionProvider><StatusHintProvider><ShellInner /></StatusHintProvider></SelectionProvider>

function StatusBar() {
  const { hint } = useStatusHint();
  return (
    <footer className="shell-statusbar">
      {/* …persistent global hints (⌘K / G / ?)… */}
      {hint ? <span className="shell-statusbar__keys" data-testid="status-session-hint">{hint}</span> : null}
    </footer>
  );
}
```

The screen publishes in an effect and clears on unmount:

```tsx
// ProcessCard in ProcessQueue.tsx
const { setHint } = useStatusHint();
const sessionHint = useMemo<ReactNode>(() => (isCard ? <>…reveal · grade…</> : <>…done · postpone…</>), [isCard, canUndo]);
useEffect(() => {
  setHint(sessionHint);
  return () => setHint(null); // the hint never outlives the screen that set it
}, [sessionHint, setHint]);
```

## Why This Matters

- **Reclaims vertical space**: removing the in-card footer row gives the article a full line back; the keys live in the always-present status bar instead.
- **Single source of truth**: the keys are defined once in the publishing screen, not duplicated per card render; the shell renders them opaquely.
- **Zero coupling**: the shell knows nothing about the hint's content or origin; the screen knows nothing about where/how it renders.
- **Automatic cleanup**: the effect's `return () => setHint(null)` guarantees the slot is empty once the screen unmounts, so navigating away never leaves a stale hint.

## When to Apply

Use it when a focused screen has dynamic, per-item/per-session hints that belong in existing shell chrome (a reserved status-bar/footer slot) and must clear when the screen unmounts. Mirror `selection.tsx`: small context, UI state only, throw-if-no-provider hook.

Do **not** use it for persistent global hints (hard-code those in the status bar), or for transient toast/notification content (that has its own `Snackbar` channel). With a single consumer the provider's value-object identity change re-renders consumers harmlessly; if many screens start *reading* the hint, split into separate value/setter contexts so publishers don't re-render on hint changes.

## Examples

- `ProcessCard` publishes card-mode (`␣ reveal · 1–4 grade · …`) vs. attention-item (`d done · p postpone · …`) keys based on `isCard`, plus `⌘Z undo` when an undo is pending.
- A future review session could publish its grade-key hints with the same three-line `useMemo` + `useEffect` block. The hint is any `ReactNode`, so styling stays in the shell (`.shell-statusbar__keys`).

## Related Issues

- [Queue Route Hides Shell Topbar Without Breaking Global Shortcuts](../ui-bugs/hide-queue-route-shell-topbar.md) is the complementary direction — the shell conditionally hides chrome by route; this pattern lets a page push chrome *up* into the shell.
- [Process Queue Source Reader Metadata Row Chrome](../ui-bugs/process-queue-source-reader-metadata-row-chrome.md) covers where session/identity chrome belongs vs. the constrained rail footer.
