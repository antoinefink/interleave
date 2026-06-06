---
name: deep-review
description: >-
  Deeply review and harden the whole Interleave app, component by component, via a
  dynamic Workflow with one phase per part of the application (many parts — take
  your time). For each component an independent auditor verifies it is implemented
  as expected, the design works (light + dark, matches the kit), nothing is broken
  / weird / nonsensical, and there are enough tests — then a fixer loop (≤6 rounds)
  fixes EVERYTHING it finds (small wins and small mistakes included) unless a fix
  needs a massive refactor, and commits per component. Use when asked to "review
  the app in depth", "harden / audit everything", "do a full quality pass", or
  check the whole application is solid.
---

# Deep review / harden the whole app (per-component audit → fix → commit)

This skill encapsulates the cross-cutting quality pass: decompose the app into **many
components**, and for each run an adversarial **audit → fix → re-audit** loop, fixing
everything fixable and committing per component. It catches *emergent* defects a per-task
build gate can't see (cross-component state bleed, design inconsistency across screens,
data-integrity gaps, missing tests) because it audits each part **in situ, in the whole system**.

Run it with the **Workflow tool**. It is **long and thorough by design** — that's the point.

## What "good" means for each component

The auditor verifies, and the fixer ensures:
- **Implemented as expected** — every feature matches its roadmap line + `docs/tasks/` spec; nothing
  is stubbed, faked, or half-wired (real data flows through `window.appApi`).
- **Design works** — UI matches the design kit (`design/`, `design/kit/`): tokens (no hard-coded
  hex/px), correct in **light AND dark**, lucide icons, dense-but-calm, the load-bearing patterns
  (FSRS-vs-attention `SchedulerChip`, actionable lineage).
- **Nothing broken, weird, or nonsensical** — no bugs, dead buttons, empty/incoherent states, race
  conditions, mislabeled data, or behavior that contradicts the product intent.
- **Enough tests** — the component's behaviors *and* edge cases are actually covered; weak/missing
  tests are a finding, and the fixer adds them.
- **Architecture invariants hold** (see `AGENTS.md`): renderer never touches SQLite/Node/fs (only
  `window.appApi`); mutations transactional + `operation_log`; domain logic out of React; source
  lineage sacred; FSRS for cards only vs the attention scheduler for sources/extracts.

## The per-component loop (NEVER halts)

For each component: **audit → (if findings) fix → re-audit → …**, up to **6 rounds**, then **commit
any changes** and move on. Unlike the build skill, this pass **does not halt** — a stubborn
component is committed + flagged, and the run continues to the rest. At the end, report **every
component that used all 6 rounds** (with its residual findings) and **all deferred massive-refactor
items**.

**The bar (same strict rule as the build skill):** fix EVERYTHING the auditor finds — large and
**small** (small wins, small mistakes, polish, weak tests) — and **only** defer a fix that genuinely
requires a **massive refactor** (flag it; don't force it). `passed=true` only when no fixable issue
remains for that component.

## Decompose into many components (adapt to the current app)

Use ~15–20 phases — the backend layers as units, then each feature surface end to end, then
cross-cutting passes. A proven decomposition (adapt to what exists now):

1. Domain core (`packages/core`) · 2. DB schema + migrations (`packages/db`) · 3. Repositories &
services (`packages/local-db`) · 4. Schedulers (`packages/scheduler`) · 5. Editor (`packages/editor`)
· 6. Electron main + security + the typed IPC/`appApi` boundary (`apps/desktop`) · 7. App shell,
navigation, keyboard & command palette · 8. Capture & inbox · 9. Reader & document editing · 10.
Extraction, lineage & hierarchy · 11. Priority, scheduling & queue · 12. Cards & card-quality · 13.
FSRS review · 14. Concepts, tags, search & references · 15. Trash/undo, analytics & backup · 16.
Design-system fidelity (cross-cutting UI/UX) · 17. End-to-end integration, data integrity & packaging.

## Verification & guardrails

- **Native `pnpm`**: each audit re-runs `pnpm typecheck && pnpm lint && pnpm test` (fast — seconds),
  plus targeted `pnpm e2e` (Playwright→Electron) for UI components; the integration phase runs the
  full e2e + the packaging build.
- **Stabilize the suite first.** A pre-existing/flaky red test poisons the "checks green" gate and
  forces *every* component to the 6-round cap. Confirm green before starting (or fix the flake in an
  early phase).
- **Bound heavyweight verifications** so schema-constrained auditors don't exhaust their turn and
  fail to emit `StructuredOutput` (scope packaging/full-e2e to inspect-and-fast-checks where needed).
- **Per-component commits** make the long run **resumable** on a crash (`Workflow({scriptPath,
  resumeFromRunId})`; unchanged earlier agents cache-hit).
- Commit per component: subject `harden(<area>): <summary>`, body, trailer `Co-Authored-By: Codex
  Opus 4.8 (1M context) <noreply@anthropic.com>`. A component that audits clean makes no commit.

## Workflow template (adapt the component list, then launch)

```js
export const meta = {
  name: 'interleave-deep-review',
  description: 'Per-component deep review/harden: independent auditor (implemented-as-expected, design, no breakage, enough tests, invariants) → fixer loop ≤6 rounds → commit per component. Never halts; flags any component that uses all 6 rounds + deferred massive-refactor items.',
  phases: [ /* one { title } per component */ ],
}

const REPO = '/Users/antoine/Code/interleave'
const MAX_ROUNDS = 6
const BASE = 'pnpm typecheck && pnpm lint && pnpm test'

const AUDIT = {
  type: 'object', additionalProperties: false,
  required: ['passed', 'summary', 'findings'],
  properties: {
    passed: { type: 'boolean', description: 'true ONLY if this component is implemented as expected, the design works (light+dark, matches the kit), nothing is broken/weird/nonsensical, tests are sufficient, the invariants hold, the verification you ran is green, and NO fixable finding remains — large OR small. Only severity deferred-massive-refactor may remain.' },
    summary: { type: 'string', description: 'what you audited + which checks you re-ran + their result' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['severity', 'category', 'title', 'detail', 'where'],
      properties: {
        severity: { type: 'string', enum: ['critical', 'major', 'minor', 'deferred-massive-refactor'] },
        category: { type: 'string', enum: ['bug', 'missing-feature', 'tests', 'ui', 'design', 'roadmap', 'architecture', 'quality'] },
        title: { type: 'string' }, detail: { type: 'string' }, where: { type: 'string' },
      } } },
  },
}
const COMMIT = { type: 'object', additionalProperties: false,
  required: ['committed', 'changed', 'commit_hash', 'message'],
  properties: { committed: { type: 'boolean' }, changed: { type: 'boolean' }, commit_hash: { type: 'string' }, message: { type: 'string' } } }

const ARCH = [
  'ARCHITECTURE INVARIANTS (Electron + native SQLite): renderer never touches SQLite/Node/fs (only the typed, Zod-validated window.appApi); mutations transactional + operation_log; domain logic in packages/*, not React; source lineage sacred; FSRS for cards only vs the attention scheduler for sources/extracts; verify with native pnpm; every feature survives an app restart.',
].join('\n')

// COMPONENTS: { key, title, ui, paths, refs, scope, verify }  — `refs` = roadmap milestone(s) +
// docs/tasks spec + (ui) the design-kit screens. `verify` = BASE (+ targeted e2e for ui; full e2e
// + packaging for the integration phase).
const COMPONENTS = [ /* ~15–20 entries; see the decomposition above */ ]

function auditPrompt(c, round, fixReport) { return [
  'You are an INDEPENDENT, STRICT QUALITY AUDITOR for the Interleave component: ' + c.title + '. cwd: ' + REPO + '. This is a hardening pass on already-built code — find REAL defects + gaps, not speculative rewrites.',
  'Scope: ' + c.scope + '\nCode: ' + c.paths + '\nRequirements (source of truth for "expected"): ' + c.refs + '. Also read AGENTS.md.',
  ARCH,
  (round > 1 ? 'A fixer just addressed the prior round (report below). Re-audit from scratch.\n<<<\n' + (fixReport || '') + '\n>>>' : ''),
  '1) Read the code + its requirements. 2) RE-RUN: ' + c.verify + ' (a red check is critical). 3) Audit: implemented-as-expected vs spec/roadmap; ' + (c.ui ? 'design works (matches the kit, light AND dark, lucide, the SchedulerChip + lineage patterns); ' : '') + 'nothing broken/weird/nonsensical; tests sufficient (cover behaviors + edge cases — gaps are findings); the invariants hold.',
  'STRICT: flag EVERY fixable issue — large AND small. Only severity=deferred-massive-refactor for fixes needing a massive refactor (does not block). Do NOT manufacture findings for taste; clean code passes round 1. passed=true ONLY if no fixable finding remains and the checks are green.',
].join('\n\n') }

function fixerPrompt(c, v) { return [
  'You are the FIXER for the Interleave component: ' + c.title + '. cwd: ' + REPO + '. ' + ARCH,
  'Auditor summary: ' + v.summary,
  'Fix EVERY finding that is not deferred-massive-refactor (small ones included; ADD missing tests; match the design kit for UI). Do NOT regress other parts — the fast suite must stay green.',
  'Findings:\n' + JSON.stringify(v.findings, null, 2),
  'Re-run GREEN: ' + c.verify + '. Do NOT commit. Report changes per finding + fresh output.',
].join('\n\n') }

function commitPrompt(c, clean, rounds) { return [
  'You are the COMMITTER for the hardening component: ' + c.title + ' (' + c.key + '). cwd: ' + REPO + '. Default branch. Loop ran ' + rounds + ' round(s), ended ' + (clean ? 'CLEAN' : 'at the 6-round cap') + '.',
  '1. git status. If clean (no changes) → committed=false, changed=false, message="no changes — audited clean".',
  '2. If changed: run ' + BASE + '. If red, do NOT commit (committed=false, changed=true, explain). If green: git add -A && ONE commit, subject "harden(' + c.key + '): <summary>", body, trailer EXACTLY: Co-Authored-By: Codex Opus 4.8 (1M context) <noreply@anthropic.com>. Do NOT push.',
  'Return committed, changed, commit_hash (short/empty), message.',
].join('\n') }

const results = []
for (const c of COMPONENTS) {
  phase(c.title)
  let round = 0, clean = false, verdict = null, fixReport = ''
  while (round < MAX_ROUNDS) {
    round++
    verdict = await agent(auditPrompt(c, round, fixReport), { phase: c.title, label: 'audit:' + c.key + '#' + round, agentType: 'general-purpose', schema: AUDIT })
    if (!verdict) break
    const blocking = (verdict.findings || []).filter(f => f.severity !== 'deferred-massive-refactor')
    if (verdict.passed && blocking.length === 0) { clean = true; break }
    fixReport = await agent(fixerPrompt(c, verdict), { phase: c.title, label: 'fix:' + c.key + '#' + round, agentType: 'general-purpose' })
  }
  const commit = await agent(commitPrompt(c, clean, round), { phase: c.title, label: 'commit:' + c.key, agentType: 'general-purpose', schema: COMMIT })
  results.push({ component: c.key, rounds: round, clean, capped: !clean,
    committed: commit ? !!commit.committed : false, commit_hash: commit ? commit.commit_hash : '',
    residual: clean ? [] : (verdict?.findings || []).filter(f => f.severity !== 'deferred-massive-refactor'),
    deferred: (verdict?.findings || []).filter(f => f.severity === 'deferred-massive-refactor') })
  // NEVER halt — continue to the next component regardless.
}
const capped = results.filter(r => r.capped)
return { components: results, cappedComponents: capped, note: capped.length ? (capped.length + ' component(s) hit the 6-round cap — see cappedComponents.') : 'All components reached a clean audit within 6 rounds.' }
```

After it completes, **independently verify green at HEAD** (`pnpm typecheck && lint && test`, plus a
full `pnpm e2e`), and report: per-component rounds + commit, the **capped** components with residual
findings, and all **deferred massive-refactor** items. (Re-run a flaky full e2e fresh before treating
a CI/e2e failure as real — one worker launches Electron per test, so it can flake under load.)
