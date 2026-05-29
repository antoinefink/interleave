# Scheduling & priority

Two schedulers, two different questions. **Never collapse them into one model.**

| Scheduler | Applies to | Question it answers | Engine |
|-----------|-----------|---------------------|--------|
| **Card scheduler** | `card` elements | *Can the user recall this?* | FSRS (`ts-fsrs`) |
| **Topic/extract scheduler** | `source`, `topic`, `extract` | *Should the user process this again, and when?* | Custom priority-based |

## Card scheduler (FSRS)

Use FSRS for active-recall cards only. Wrap `ts-fsrs` behind our own `SchedulerService`
interface so the engine is swappable and testable. Persist FSRS state on `review_states`:
`due_at`, `stability`, `difficulty`, `elapsed_days`, `scheduled_days`, `reps`, `lapses`,
`fsrs_state`. Every grade (`Again` / `Hard` / `Good` / `Easy`) writes a durable
`review_logs` row and updates `review_states`.

FSRS treats **desired retention** as a first-class input. The MVP uses one global desired
retention from settings; the gold-standard phase allows per-priority/per-concept retention
and parameter optimization from accumulated review history.

## Topic/extract scheduler (custom)

Sources and extracts are not memory items — they are **attention items**. Their scheduler
considers:

- priority
- distillation stage
- last processed date
- the user's last action (extract / rewrite / postpone / done / delete)
- whether the element produced useful children (extracts/cards)
- whether it is **stagnant** (keeps returning without progressing)
- whether it has been **postponed repeatedly**

### Starter interval heuristic (MVP)

Practical, not "scientific" — a starting point that the queue refines over time:

```txt
By priority (sources):
  A items     return in 1–7 days
  B items     return in 7–30 days
  C items     return in 30–60 days
  D items     return in 90+ days, or are deleted

By stage (extracts):
  raw_extract                    +1 to +7 days
  clean_extract                  +3 to +14 days
  atomic_statement (card-ready)  convert now, or +1 day
  flashcard                      → hand off to FSRS
```

### Rescheduling by action

```txt
deleted            never
low-value source   +30 to +180 days
medium source      +7 to +30 days
high-value source  +1 to +7 days
```

## The daily queue

The queue is the user-facing product of both schedulers combined.

```txt
Every day:
  1. Select due cards + due sources/extracts.
  2. Sort by priority first, then due date.
  3. Add 10–20% randomness so the user isn't trapped in one topic.
  4. Process within a fixed timebox / daily budget.
  5. Reschedule each item based on the action taken.
```

In review specifically: **due flashcards first**, then reading/extract items. **Sibling
cards** (same extract or cloze group) must not appear back-to-back in a session unless the
user explicitly asks.

## Priority model

Numeric internally, A/B/C/D in the MVP UI (see [`domain-model.md`](./domain-model.md)).
Core rules:

- High-priority fragile memory is **protected**.
- Low-priority material is **sacrificed first** during overload.
- Newly imported material must **not** automatically dominate older high-value material.

## Overload handling (gold-standard, but design for it now)

Overload is expected. The system must support:

- **Auto-sort** — a scoring function over priority, due date, retrievability, type, sibling
  spacing, concept diversity, and session mode.
- **Auto-postpone** — when due load exceeds the daily budget, postpone lower-priority topics
  first, then low-priority *mature* cards, while protecting high-priority *fragile* cards.
- **Catch-up / vacation modes** — recover from backlog / pre-adjust future load, always
  showing the cost of postponement.
- **Workload simulation** — preview how load changes before changing retention/imports.

Even in the MVP, schedule data so these are addable without a migration rewrite (store
`reps`, `lapses`, last-processed timestamps, postpone counts).
</content>
