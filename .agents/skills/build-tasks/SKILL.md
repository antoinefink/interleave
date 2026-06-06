---
name: build-tasks
description: >-
  Build the next Interleave roadmap tasks one at a time, each via a dynamic
  Workflow: builder → independent reviewer → fix → review → … (a blocking,
  correct-by-construction gate) → one commit per task. The reviewer is STRICT —
  it fixes small wins and small mistakes too, not just the big issues, unless a
  fix needs a massive refactor (those are deferred and reported). Use when asked
  to "build the next N todos / tasks", "continue the roadmap", "go through the
  to-dos", or implement specific roadmap tasks (T0NN). Generates the milestone's
  detailed spec first if one doesn't exist yet.
---

# Build roadmap tasks (strict builder → reviewer → fix → commit)

This skill encapsulates how Interleave is built: **one task at a time, in
dependency order**, each driven by a fresh dynamic Workflow with a hard quality
gate, committed individually so history stays bisectable and every commit is green.

Always run it with the **Workflow tool** (this is multi-agent orchestration). Confirm
scope first if it's ambiguous (which tasks, how far), then launch.

## The control plane (read first, every time)

- `AGENTS.md` — the engineering charter: architecture invariants, layering, Definition of Done.
- `docs/roadmap.md` — the task queue (`T001`–`T100`, each with deps + *Done when*). Pick the
  lowest-numbered unchecked task whose deps are all `[x]`.
- `docs/tasks/M*.md` — the detailed, buildable spec for a task. **If the next milestone has no
  spec yet, generate it first** (see "Generate the milestone spec" below), review + commit it,
  *then* build — specs written after the prior milestone cite real files/signatures.

## The per-task loop

For each task, strictly in order:

1. **Implement** — a builder agent implements the task against its spec.
2. **Review** — a *fresh, independent* reviewer re-runs the full verification itself
   (`pnpm typecheck` / `lint` / `test`, plus the relevant `pnpm e2e` for UI tasks) and audits
   the diff against the spec, the design kit, and the architecture invariants. It returns a
   structured verdict.
3. **Fix → review → fix → …** — loop until the reviewer signs off, up to **6 rounds**.
4. **Commit** — one commit per task on the default branch.

The gate is **correct-by-construction**: the workflow only commits when
`verdict.passed === true && no fixable findings remain`. A skipped/null reviewer halts the task
cleanly. If a task can't pass in 6 rounds, **commit what's there, flag it, and HALT the run**
(downstream tasks depend on it — don't build on a broken base).

## STRICT review (the important rule)

The reviewer's bar is **not** "only the biggest issues." It must surface — and the fixer must
fix — **every genuine problem, including small wins and small mistakes**: minor bugs, rough
edges, weak/missing tests, dead code, inconsistent naming, small UI/spec mismatches, unhandled
small edge cases. The **only** escape hatch is a fix that requires a **massive refactor** — those
go on a `deferred` list (with a reason) and are reported at the end, not forced in.

So the gate passes only when **all fixable issues (large and small) are resolved**, minus
explicitly-deferred massive-refactor items. Do not wave through minors. (This is stricter than a
pure "critical/major only" gate.)

## Verification

- **Native `pnpm`** (the app is an Electron desktop app on native SQLite — Docker is server-phase
  only): `pnpm typecheck && pnpm lint && pnpm test`, plus targeted `pnpm e2e` (Playwright→Electron)
  for UI tasks. Every feature must **survive an app restart**.
- **Architecture invariants** (enforced by the reviewer; see `AGENTS.md`): the renderer never
  touches SQLite/Node/fs — only `window.appApi`; mutations are transactional and append
  `operation_log`; domain logic stays out of React; source lineage is sacred; FSRS schedules cards
  only, the attention scheduler schedules sources/extracts (never the reverse).

## Commit conventions

One commit per task on the default branch: subject `T0NN: <concise summary>`, a short body, and
the trailer `Co-Authored-By: Codex Opus 4.8 (1M context) <noreply@anthropic.com>`. The committer
also ticks the task's `[x]` in `docs/roadmap.md` and adds a newest-first Progress-log entry.
(Manual commits are SSH-signed via 1Password; if it's locked the user must unlock it. Workflow
subagent commits land unsigned — that's fine.)

## Operational guardrails (hard-won)

- **Bound heavyweight reviewer verifications.** A schema-constrained reviewer that runs a huge
  verification (electron-builder packaging, the *full* e2e) can exhaust its turn and never emit
  its `StructuredOutput`, crashing the workflow. For such tasks, scope the reviewer to inspect +
  confirm the artifact + run the fast checks, and explicitly require it to emit the verdict.
- **Per-task commits + cached resume = cheap recovery.** If the run crashes, edit only the failing
  task's branch in the persisted script (keep earlier agents' prompts byte-identical so they
  cache-hit) and re-invoke `Workflow({scriptPath, resumeFromRunId})`.
- **A whole-suite-green gate is poisoned by any pre-existing/flaky failing test.** Confirm the
  suite is green before starting; an unrelated red test will force every task to the 6-round cap.
- **The committer's tree-integrity check is load-bearing** — it must refuse to commit a broken
  tree (e.g. a deleted root manifest) rather than push red.

## Generate the milestone spec (when missing)

If the next milestone has no `docs/tasks/Mx-*.md`, run a small **docs-only** Workflow first:
parallel agents (one per upcoming milestone) write the spec against the roadmap + reference docs +
the design kit + the *real codebase* (so deliverables cite real files), a coherence reviewer
verifies it's buildable + architecture-consistent, then **review the diff yourself and commit**
the specs (`docs: add Mx task specs`). Then run the build workflow below.

## Workflow template (adapt the task list, then launch)

```js
export const meta = {
  name: 'interleave-build-<range>',
  description: 'Build roadmap tasks <range> sequentially: builder → independent reviewer (strict, blocking gate, ≤6 rounds) → commit per task on the default branch. Halts if a task cannot pass.',
  phases: [ /* one { title } per task */ ],
}

const REPO = '/Users/antoine/Code/interleave'
const MAX_ROUNDS = 6
const BASE = 'pnpm typecheck && pnpm lint && pnpm test'

// passed=true ONLY when every fixable issue is resolved. severity 'deferred-massive-refactor'
// does NOT block; everything else (including 'minor') does.
const VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['passed', 'summary', 'findings'],
  properties: {
    passed: { type: 'boolean', description: 'true ONLY if the task fully meets its spec, the verification you ran is green, and NO fixable issue remains — large OR small (minor bugs, rough edges, weak tests, dead code, naming, small UI/spec mismatches). Only items genuinely needing a massive refactor (severity deferred-massive-refactor) may remain.' },
    summary: { type: 'string', description: 'name the checks you re-ran + their result' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['severity', 'category', 'title', 'detail', 'where'],
      properties: {
        severity: { type: 'string', enum: ['critical', 'major', 'minor', 'deferred-massive-refactor'] },
        category: { type: 'string', enum: ['bug', 'missing-feature', 'tests', 'ui', 'roadmap', 'architecture', 'quality'] },
        title: { type: 'string' }, detail: { type: 'string' }, where: { type: 'string' },
      } } },
  },
}
const COMMIT = { type: 'object', additionalProperties: false,
  required: ['committed', 'commit_hash', 'message'],
  properties: { committed: { type: 'boolean' }, commit_hash: { type: 'string' }, message: { type: 'string' } } }

const ARCH = [
  'ARCHITECTURE INVARIANTS (Electron + native SQLite) — enforce:',
  '- Renderer (apps/web) NEVER touches SQLite/Node/fs; all access via the typed, Zod-validated window.appApi preload bridge. No generic db.query.',
  '- better-sqlite3 + Drizzle; foreign_keys=ON/WAL/busy_timeout; multi-step mutations in ONE transaction that appends an operation_log entry; soft-delete.',
  '- Domain logic in packages/core / local-db / scheduler / editor — never React. Source lineage sacred. FSRS for cards only; attention scheduler for sources/extracts (never crossed).',
  '- Verify with native pnpm (NOT Docker). Every feature must survive APP RESTART.',
].join('\n')

const TASKS = [ /* { id, phase, title, ui, specFile, extraDocs, emphasis, verify, fastVerify, commitMsg } per task */ ]

function builderPrompt(t) { return [
  'You are the BUILDER for Interleave task ' + t.id + ' — ' + t.title + '. cwd: ' + REPO + '. An independent reviewer will re-run your verification and may send fixes.',
  'Read AGENTS.md, ' + REPO + '/' + t.specFile + ' (the ' + t.id + ' section is your AUTHORITATIVE spec), the ' + t.id + ' roadmap line, and: ' + t.extraDocs,
  ARCH,
  'Implement ' + t.id + ' per the spec. Emphasis: ' + t.emphasis,
  'Verify (native pnpm): ' + t.verify + '  Paste the literal output. Do NOT commit; do NOT edit docs/roadmap.md.',
  'Report: files changed, key decisions, verification output, deliverables checklist, downstream notes.',
].join('\n\n') }

function reviewerPrompt(t, report) { return [
  'You are the INDEPENDENT, STRICT REVIEWER for ' + t.id + ' — ' + t.title + '. cwd: ' + REPO + '. Do NOT trust the builder; re-verify yourself.',
  'Read the ' + t.id + ' section of ' + REPO + '/' + t.specFile + ', AGENTS.md, the roadmap line' + (t.ui ? ', and the design kit references in: ' + t.extraDocs : '') + '.',
  ARCH,
  'Builder report:\n<<<\n' + report + '\n>>>',
  '1) Inspect the actual tree (git diff). 2) RE-RUN the verification yourself: ' + t.verify + '. 3) Audit against the spec + Definition of Done + the invariants + ' + (t.ui ? 'design-kit fidelity (tokens, light AND dark, lucide icons).' : 'data/domain correctness.'),
  'STRICT: flag EVERY fixable problem — large AND small (minor bugs, rough edges, weak/missing tests, dead code, naming, small UI/spec mismatches). Only mark severity=deferred-massive-refactor for fixes that genuinely need a massive refactor; those do not block. passed=true ONLY if every other finding is resolved and the checks are green when YOU ran them.',
].join('\n\n') }

function fixerPrompt(t, v) { return [
  'You are the BUILDER (fix round) for ' + t.id + ' — ' + t.title + '. cwd: ' + REPO + '. Fix EVERY finding that is not severity deferred-massive-refactor (small ones included).',
  'Reviewer summary: ' + v.summary,
  'Findings:\n' + JSON.stringify(v.findings, null, 2),
  'Re-run GREEN: ' + t.verify + '. Do NOT commit; do NOT edit docs/roadmap.md. Report changes + fresh output.',
].join('\n\n') }

function committerPrompt(t, clean, rounds) { return [
  'You are the COMMITTER for ' + t.id + ' — ' + t.title + '. cwd: ' + REPO + '. Default branch. Loop ran ' + rounds + ' round(s), ended ' + (clean ? 'CLEAN' : 'at the 6-round cap') + '.',
  '1. Update docs/roadmap.md: tick the ' + t.id + ' checkbox to [x], append " · done", add a newest-first Progress-log entry.',
  '2. Run the fast checks (' + t.fastVerify + '); if red do NOT commit (committed=false, explain).',
  '3. If green: git add -A && ONE commit, subject "' + t.commitMsg + '", body, then trailer EXACTLY: Co-Authored-By: Codex Opus 4.8 (1M context) <noreply@anthropic.com>. Do NOT push.',
  'Return committed, commit_hash (short), message.',
].join('\n') }

const results = []
for (const t of TASKS) {
  phase(t.phase)
  let report = await agent(builderPrompt(t), { phase: t.phase, label: 'build:' + t.id, agentType: 'general-purpose' })
  let round = 0, clean = false, verdict = null
  while (round < MAX_ROUNDS) {
    round++
    verdict = await agent(reviewerPrompt(t, report), { phase: t.phase, label: 'review:' + t.id + '#' + round, agentType: 'general-purpose', schema: VERDICT })
    if (!verdict) break
    const blocking = (verdict.findings || []).filter(f => f.severity !== 'deferred-massive-refactor')
    if (verdict.passed && blocking.length === 0) { clean = true; break }
    if (round >= MAX_ROUNDS) break
    report = await agent(fixerPrompt(t, verdict), { phase: t.phase, label: 'fix:' + t.id + '#' + (round + 1), agentType: 'general-purpose' })
  }
  const commit = await agent(committerPrompt(t, clean, round), { phase: t.phase, label: 'commit:' + t.id, agentType: 'general-purpose', schema: COMMIT })
  if (!commit || !commit.committed) throw new Error(t.id + ' commit failed: ' + (commit ? commit.message : 'no result') + '. Halting.')
  results.push({ id: t.id, rounds: round, clean, commit: commit.commit_hash, deferred: clean ? [] : (verdict?.findings || []).filter(f => f.severity === 'deferred-massive-refactor') })
  if (!clean) throw new Error(t.id + ' did not reach a clean review in ' + MAX_ROUNDS + ' rounds (committed ' + commit.commit_hash + '). Halting — downstream tasks depend on it.')
}
return { completed: results, note: 'Built <range>: strict gate, commit per task. Any deferred massive-refactor items are listed per task.' }
```

After it completes (or halts), **independently verify green at HEAD** (`pnpm typecheck && lint && test`, plus e2e if UI) and report per-task commits + any deferred massive-refactor items.
