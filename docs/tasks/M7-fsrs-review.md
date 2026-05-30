# M7 — FSRS review (T036–T040)

Detailed, buildable specs for the seventh milestone. M7 turns the cards built in M6 into a
real **active-recall review loop**. The keystone is **FSRS** (T036): a `SchedulerService` in
`packages/scheduler` that wraps `ts-fsrs` behind our own interface and persists FSRS memory
state on `review_states`. Around it sit the surfaces that make review fast, repairable, and
source-grounded: the `/review` session UI with reveal → grade Again/Hard/Good/Easy and
next-interval previews (T037), in-review repair actions — edit prompt/answer, open source,
suspend, delete, flag-as-bad (T038), sibling burying so cards from one extract/cloze group
don't appear back-to-back (T039), and basic leech detection that warns after repeated
failures and offers a cleanup view (T040).

After M7 the core knowledge loop is closed end to end: **read → extract → distill → card →
review → reschedule**, with the **two-scheduler split** intact — cards are scheduled by FSRS
(*"can the user recall this?"*) while sources/extracts stay on the attention scheduler
(*"should the user process this again, and when?"*). Every review writes a durable
`review_logs` row and survives an app restart.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and
the roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node, or the
filesystem. Every mutation flows React UI → typed client wrapper (`apps/web/src/lib/appApi.ts`)
→ preload bridge (`apps/desktop/src/preload/index.ts`) → validated IPC (Zod) on the main side
(`apps/desktop/src/main/ipc.ts`) → the `DbService` (`apps/desktop/src/main/db-service.ts`) →
`packages/local-db` repositories + `packages/scheduler` services → SQLite. Every meaningful
mutation runs in **one transaction** and appends an **`operation_log`** row; deletes are soft
(`deleted_at`). **FSRS scheduling applies to cards only** — an `extract`/`source`/`topic` must
never get a `review_states`/FSRS row.

> **The two-scheduler split (load-bearing — read before touching the scheduler).**
> `packages/scheduler` already documents both mental models in its index doc comment. M5
> (T028) fills the **attention** scheduler (priority + stage + last-seen + action +
> postpone-count) for `source`/`topic`/`extract`. M7 fills the **FSRS** scheduler for
> `card` only. Do **not** collapse them. The FSRS math + review-state transitions live in
> `packages/scheduler` (and the `ReviewRepository` persistence seam), **never** in React
> components. `SchedulerChip` renders whichever applies (`schedulerKindForType` in
> `packages/local-db/src/inspector-query.ts` is the existing classifier: `card → 'fsrs'`,
> everything else → `'attention'`).

> **Operation-log discipline.** `OPERATION_TYPES`
> (`packages/core/src/operation-log.ts`) is a **closed, fixed set of 15** — "a rename is a
> migration." M7 mutations map onto the existing ops, **no new op types**: a graded review →
> `add_review_log` (the `ReviewRepository.recordReview` path already logs this and advances
> `review_states` + `elements.due_at` in one transaction); edit prompt/answer → `update_element`
> (card body fields); suspend / flag-as-bad / mark-leech (status or attribute change) →
> `update_element`; delete → `soft_delete_element`. Do **not** invent `grade`/`suspend`/`leech`
> op types.

Read first:
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the **Card scheduler
  (FSRS)** section (wrap `ts-fsrs` behind `SchedulerService`; persist `due_at`/`stability`/
  `difficulty`/`elapsed_days`/`scheduled_days`/`reps`/`lapses`/`fsrs_state`; desired retention
  is a first-class input; **due flashcards first**, then reading/extract items; **sibling
  cards must not appear back-to-back**).
- [`../../CLAUDE.md`](../../CLAUDE.md) — **"Review rules"** (reveal / grade / next-interval
  previews / edit / open source / suspend / delete / mark leech / add context; every review
  creates a durable review log; siblings not back-to-back) and **"Card-quality rules"**.
- [`../design-system.md`](../design-system.md) — `screen-review` row (`rcard`, `FsrsStats`,
  `grades` with interval previews, jump-to-source); `SchedulerChip` (the FSRS vs attention
  split); `Retr`/`FsrsStats`; `Banner` (leech); `Status` (`leech`/`suspended`).
- [`../domain-model.md`](../domain-model.md) — card lineage `card → source location → source`;
  stage vs status; soft-delete.
- Design kit (immutable reference): `design/kit/app/screen-review.jsx` (the `ReviewScreen`:
  `rcard`/`rcard__prompt`/`rcard__answer`, reveal on `Space`, `grades` with `card.intervals[g]`
  previews + `1`/`2`/`3`/`4` keys, `FsrsStats`, the leech `Banner`, the `refblock` +
  `jumpToSource`, the repair-action row, the context drawer, `SessionClock`/`pbar`), plus
  `design/kit/screenshots/review2.png` and `review3.png`. `design/kit/app/components.jsx`
  (`SchedulerChip`, `FsrsStats`, `Retr`, `Status`, `Banner`, `Metric`, `EmptyState`).

### What already exists (inspect before building — do not duplicate)

The M1 substrate built far more of M7's persistence seam than the roadmap implies:

- **Schema (T006) — already present, no new tables needed for T036–T039:**
  - `review_states` (`packages/db/src/schema/cards.ts`): `elementId` (PK, 1:1 with the card
    element), `dueAt`, `stability`, `difficulty`, `elapsedDays`, `scheduledDays`, `reps`,
    `lapses`, `fsrsState` (CHECKed against `FSRS_STATES`), `lastReviewedAt`. **This is an exact
    field-for-field match for the `ts-fsrs` `Card` shape** — T036 maps `Card.due/stability/
    difficulty/elapsed_days/scheduled_days/reps/lapses/state/last_review` straight onto it.
  - `review_logs` (`packages/db/src/schema/cards.ts`): `id`, `elementId`, `rating` (CHECK
    `REVIEW_RATINGS`), `reviewedAt`, `responseMs`, `prevState`/`nextState` (CHECK `FSRS_STATES`),
    `nextStability`, `nextDifficulty`, `nextDueAt`. Append-only; one immutable row per grade.
  - `cards` (`packages/db/src/schema/cards.ts`): `elementId` (PK), `kind` (`qa`/`cloze`),
    `prompt`, `answer`, `cloze`, `sourceLocationId` (the lineage anchor for jump-to-source).
  - `element_relations` (`packages/db/src/schema/relations.ts`): the `sibling_group` relation
    type + a `siblingGroupId` column already exist — the basis for T039 sibling burying.
- **`@interleave/core` (T005) — already present:** `ReviewState` + `ReviewLog`
  (`packages/core/src/review.ts`); `REVIEW_RATINGS` = `["again","hard","good","easy"]`,
  `REVIEW_RATING_VALUE` (`again:1 … easy:4`), `FSRS_STATES` =
  `["new","learning","review","relearning"]`, `CARD_KINDS`, `ELEMENT_STATUSES` (incl.
  `suspended`, `deleted`) (`packages/core/src/enums.ts`); `SiblingGroupId` branded id
  (`packages/core/src/ids.ts`); `AppSettings` with `dailyReviewBudget` +
  `defaultDesiredRetention` (`packages/core/src/settings.ts`).
- **`packages/local-db` (T008/T009) — already present:**
  - `ReviewRepository` (`packages/local-db/src/review-repository.ts`) is **already built and
    is the persistence seam M7 plugs into**: `createCard` (element + `cards` row + fresh
    `review_states` row, logs `create_card`), `findCardById`, `findReviewState`,
    `listReviewLogs`, and **`recordReview(cardElementId, outcome: ReviewOutcome)`** — which
    appends an immutable `review_logs` row, updates `review_states` (all FSRS fields), advances
    `elements.due_at`, and logs `add_review_log`, **all in one transaction**. `ReviewOutcome`
    is the typed hand-off: `{ rating, reviewedAt, responseMs, prevState, nextState,
    nextStability, nextDifficulty, nextDueAt, elapsedDays, scheduledDays, reps, lapses }`.
    **T036's `SchedulerService` computes the `ReviewOutcome`; `ReviewRepository` persists it —
    do not move FSRS math into the repository, and do not write `review_states` from anywhere
    else.**
  - `QueueRepository` (`packages/local-db/src/queue-repository.ts`): `dueCards(asOf, limit)`
    (joins `review_states.due_at` to live, non-suspended `card` elements, soonest first),
    `nextCard(asOf, exclude[])`, `dueCardCount`, `dueAttentionItems` (kept separate — the split).
    The review deck (T037) and sibling burying (T039) build on `dueCards`/`nextCard`.
  - `ElementRepository` (`update`, `softDelete`, `reschedule`), `OperationLogRepository.append`
    (the `tx`-composable seam), `newReviewLogId`/`newSiblingGroupId`/`nowIso`
    (`packages/local-db/src/ids.ts`), `schedulerKindForType` + FSRS `SchedulerSignals`
    (`inspector-query.ts`).
- **`SettingsRepository` (T011):** typed `getAppSettings()`/`updateAppSettings(patch)` with
  `defaultDesiredRetention` (FSRS retention input) and `dailyReviewBudget` (session cap).
- **Inspector (T010):** already renders the FSRS `SchedulerChip` from seeded `review_states`;
  M7 makes those values live for real cards.

### What M7 must add (the gaps)

- **`ts-fsrs` is NOT installed** — confirmed: no `ts-fsrs` in any `package.json`, `node_modules`,
  or `pnpm-lock.yaml`. T036 adds it as a dependency of `packages/scheduler`.
- **`packages/scheduler` is still a placeholder** (`packages/scheduler/src/index.ts` exports only
  `schedulerPlaceholder`). T036 adds the `SchedulerService` (FSRS wrapper); the attention
  scheduler is M5/T028 (separate, do not build it here).
- **No `window.appApi` surface for review yet** — the contract (`apps/desktop/src/shared/`
  `channels.ts` + `contract.ts`), preload, IPC router, `DbService`, and the renderer client
  (`apps/web/src/lib/appApi.ts`) expose `app`/`db`/`settings`/`inspector`/`lineage`/`sources`/
  `inbox`/`documents`/`extractions`/`extracts`/`readPoints` — **no `review`/`cards` group**. M7
  adds `review.*` (queue/next, grade, log) and `cards.*` (edit, suspend, delete, flag/leech).
- **`/review` is a `Placeholder`** (`apps/web/src/router.tsx` `reviewRoute`). T037 replaces it
  with the real `ReviewScreen`.
- **No `buryS​iblings` setting** — T039 adds a sibling-burying toggle to the T011 `AppSettings`
  model (`packages/core/src/settings.ts`) so burying can be disabled.
- **No leech surfacing** — `review_states.lapses` exists and increments; T040 adds a leech
  *flag* (a card attribute), a leech threshold (warn at 4 lapses), and a cleanup view.

> **Dependency note (resolved).** Per the roadmap, **T036 depends on T032** (the card model)
> and T037–T040 depend on T036. T032 (`card_type`, `prompt`, `answer`, `cloze_text`,
> `source_extract_id`, `sibling_group_id`) is **M6** and must be `[x]` first. Today's `cards`
> table already has `kind`/`prompt`/`answer`/`cloze`/`sourceLocationId` and `review_states`/
> `review_logs` are complete; M6/T032 is expected to add `sibling_group_id` to cards (or wire
> the existing `element_relations.sibling_group` edge). **T039 below specifies both options so
> it works whichever M6 chose** — confirm the M6 shape before building T039. Generate
> `tasks/M5-priority-scheduling-queue.md` and `tasks/M6-cards.md` before their tasks (neither
> spec file exists yet); this M7 file is generated ahead per the orchestration loop.

Build order is the task order. T036 → T037 → {T038, T039, T040}. T038/T039/T040 all depend on
T037's session and may land in any order after it.

---

## T036 — Integrate `ts-fsrs`

- **Status:** `[ ]`  · **Depends on:** T032
- **Roadmap line:** Done when: a `SchedulerService` wraps `ts-fsrs` and persists FSRS state
  (due/stability/difficulty/elapsed/scheduled/reps/lapses) on `review_states`; new cards
  reschedule by rating.

### Goal

A `SchedulerService` in `packages/scheduler` wraps `ts-fsrs` behind **our own interface** so
the engine is swappable and testable, and is the single source of FSRS scheduling math. Given a
card's current `review_states` row, the current time, a rating, and the response time, it
computes the next FSRS memory state (stability/difficulty/elapsed/scheduled/reps/lapses/state/
due) and hands a typed `ReviewOutcome` to `ReviewRepository.recordReview`, which persists it +
appends the `review_logs` row in one transaction. It also previews the four possible next
intervals (for T037's grade buttons) without mutating state. **FSRS is for `card` elements only**
(distinct from the M5 attention scheduler) — calling it for any non-card element is a bug.

### Context to load first

- Reference: `scheduling-and-priority.md` "Card scheduler (FSRS)"; `domain-model.md` review
  types; `CLAUDE.md` "Scheduling rules".
- Existing code to inspect: `packages/scheduler/src/index.ts` (the placeholder + the
  two-scheduler doc comment — keep it, fill the FSRS half); `packages/local-db/src/`
  `review-repository.ts` (`ReviewOutcome`, `recordReview`, `findReviewState`, `createCard`);
  `packages/core/src/review.ts` (`ReviewState`/`ReviewLog`), `packages/core/src/enums.ts`
  (`REVIEW_RATINGS`, `REVIEW_RATING_VALUE`, `FSRS_STATES`); `packages/db/src/schema/cards.ts`
  (the exact `review_states` columns); `packages/core/src/settings.ts`
  (`defaultDesiredRetention`).
- `ts-fsrs` API (fetched, current): `fsrs(params?)` → scheduler; `generatorParameters({
  request_retention, maximum_interval, enable_fuzz, … })`; `createEmptyCard(now?)` → a `Card`;
  `scheduler.repeat(card, now)` → a `RecordLog` keyed by `Rating` (preview all four outcomes,
  each `{ card, log }`); `scheduler.next(card, now, Rating)` → `{ card, log }` (apply one
  rating); `Rating.Again|Hard|Good|Easy` (= `1|2|3|4`, matching `REVIEW_RATING_VALUE`);
  `State.New|Learning|Review|Relearning` (lowercase ↔ our `FSRS_STATES`). The `Card` fields
  `due/stability/difficulty/elapsed_days/scheduled_days/reps/lapses/state/last_review` map 1:1
  onto our `review_states` columns.
- Invariants in play: FSRS = cards only; FSRS math lives here, not in React or the repository;
  desired retention from settings is a first-class input; `review_states`/`review_logs` shapes
  are fixed (no migration).

### Deliverables

- [ ] **Add the dependency:** `ts-fsrs` in `packages/scheduler/package.json`; install (updates
      `pnpm-lock.yaml`). Pin a known-good version. `ts-fsrs` is pure TS (no native deps), safe
      in the Electron main / `packages/scheduler` side. The renderer never imports it.
- [ ] **`SchedulerService`** in `packages/scheduler/src/card-scheduler.ts` (export from
      `packages/scheduler/src/index.ts`, replacing the placeholder for the FSRS half), wrapping
      `ts-fsrs` behind our interface:
      - construction takes a `desiredRetention` (and optional FSRS params) so it reads the
        T011 setting; builds the `ts-fsrs` scheduler via `generatorParameters` + `fsrs()`.
      - `toFsrsCard(state: ReviewState, now): Card` and `fromFsrsCard(card: Card): ReviewState`
        adapters mapping our snake/camel + lowercase-state vocabulary to/from `ts-fsrs`
        (`State`/`Rating`), so the rest of the app never imports `ts-fsrs` types.
      - `previewIntervals(state, now): Record<ReviewRating, { dueAt; scheduledDays; label }>`
        using `scheduler.repeat(card, now)` — the next-interval previews T037's grade buttons
        render (e.g. "10m" / "2d" / "5d"), **mutating nothing**.
      - `gradeCard(state, rating, now, responseMs): ReviewOutcome` using
        `scheduler.next(card, now, Rating)`, returning the exact `ReviewOutcome` shape
        `ReviewRepository.recordReview` already consumes (prev/next `FsrsState`, next stability/
        difficulty/dueAt, elapsed/scheduled days, reps, lapses).
      - a `newCardState(): ReviewState` helper for `createEmptyCard()` mapping (so T032/M6 card
        creation and seeds agree on the initial state).
- [ ] **Wire it into the main process:** the `DbService`
      (`apps/desktop/src/main/db-service.ts`) constructs one `SchedulerService` per open DB
      (reading `defaultDesiredRetention` from `SettingsRepository`), alongside the existing
      `createRepositories(...)` + `ExtractService` wiring (mirror that pattern). The grade path
      is `SchedulerService.gradeCard(...)` → `ReviewRepository.recordReview(...)`; the preview
      path is `SchedulerService.previewIntervals(...)`. The renderer reaches both only via the
      T037 `review.*` IPC commands.
- [ ] **Tests (Vitest, `packages/scheduler`):** FSRS state transitions by rating —
      - a brand-new card (`fsrsState: "new"`, `reps: 0`) graded `Good` advances to a real
        `learning`/`review` state with `dueAt > now`, `reps: 1`, and stability/difficulty set;
      - grading `Again` on a `review`-state card increments `lapses` and shortens `dueAt`
        relative to `Good`/`Easy` (assert the interval ordering `again < hard < good < easy`);
      - `previewIntervals` returns four outcomes whose `scheduledDays` are non-decreasing across
        `again→hard→good→easy` and **does not mutate** the input state;
      - the round-trip `fromFsrsCard(toFsrsCard(state)) ≈ state` is stable;
      - higher `desiredRetention` yields shorter intervals (a first-class-input smoke check).
- [ ] **Tests (Vitest, `packages/local-db`):** an integration test (in-memory `better-sqlite3`
      via `packages/local-db/src/test-db.ts`) that `SchedulerService.gradeCard` →
      `ReviewRepository.recordReview` persists the new `review_states` (due/stability/difficulty/
      elapsed/scheduled/reps/lapses/fsrs_state advanced), appends exactly one `review_logs` row,
      advances `elements.due_at`, and logs `add_review_log` — all in one transaction.

### Done when

- A `SchedulerService` wrapping `ts-fsrs` persists FSRS state (due/stability/difficulty/
  elapsed/scheduled/reps/lapses/fsrs_state) on `review_states` via `ReviewRepository`, and a
  newly created card reschedules correctly by rating (Again/Hard/Good/Easy produce distinct,
  ordered next intervals); the previews are pure (no mutation).
- FSRS is invoked for `card` elements only (no `review_states` row is ever created for a
  non-card element).
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- Do **not** rewrite `ReviewRepository.recordReview` — it already persists `ReviewOutcome` +
  logs `add_review_log` in one transaction. T036 only supplies the `ReviewOutcome`.
- Map `State`/`Rating` ↔ our `FSRS_STATES`/`REVIEW_RATINGS` in one place (the adapters); never
  leak `ts-fsrs` enums past `SchedulerService`.
- Keep `enable_fuzz` **off in tests** (deterministic intervals) and a configurable default in
  the live service; T080 (gold-standard) will optimize FSRS parameters from history — leave a
  seam for per-card/per-concept params, don't build it.
- Store nothing new: the `review_states` columns are already a superset of FSRS `Card`. No
  migration in T036.
- The attention scheduler (M5/T028) is a **separate** service in the same package — do not
  touch or generalize it here.

---

## T037 — Review UI

- **Status:** `[ ]`  · **Depends on:** T036, T004
- **Roadmap line:** Done when: `/review` shows prompt → reveal → grade Again/Hard/Good/Easy,
  logs response time, updates scheduler state, advances; every review writes a durable
  `review_logs` row.

### Goal

`/review` becomes a real active-recall session matching `design/kit/app/screen-review.jsx`: it
loads the due-card deck (FSRS `due_at ≤ now`, soonest first), shows one card's prompt, reveals
the answer on `Space`/click, shows the four grade buttons with **next-interval previews** and
`FsrsStats`, and on grade Again/Hard/Good/Easy (`1`/`2`/`3`/`4`) **records the response time**,
updates FSRS state via `SchedulerService` → `ReviewRepository.recordReview`, appends a durable
`review_logs` row, and advances to the next card. The session shows progress (reviewed / left /
clock) and a completion summary.

### Context to load first

- Reference: `CLAUDE.md` "Review rules" (reveal / grade / next-interval previews / durable log);
  `scheduling-and-priority.md` (due flashcards first; the daily budget cap); `design-system.md`
  `screen-review` row.
- Existing code to inspect: `design/kit/app/screen-review.jsx` (the `ReviewScreen`: `rcard`,
  reveal-on-`Space`, `grades` with `card.intervals[g]` + `1`/`2`/`3`/`4` keys, `FsrsStats`,
  `pbar`, `SessionClock`, `EmptyState` summary, cloze `{{…}}` front rendering); `design/kit/
  app/components.jsx` (`FsrsStats`, `Retr`, `SchedulerChip`, `Metric`, `EmptyState`);
  `packages/local-db/src/queue-repository.ts` (`dueCards`, `nextCard`, `dueCardCount`);
  `packages/local-db/src/review-repository.ts` (`findCardById`, `findReviewState`,
  `recordReview`); `apps/web/src/router.tsx` (`reviewRoute` Placeholder to replace);
  `apps/web/src/shell/` (Topbar, `Kbd`, shortcuts) and the design `.css` for `rcard`/`grades`/
  `pbar`/`refblock`.
- Invariants in play: the renderer holds only UI/session state (deck order, current index,
  revealed, response timer) — **no** FSRS math, no SQL; FSRS + logging happen main-side; every
  grade is a durable `review_logs` row; the renderer measures `responseMs` (reveal → grade) and
  passes it through.

### Deliverables

- [ ] **`review.*` `window.appApi` surface** added across the established seam, Zod-validated,
      following the `extractions.*`/`extracts.*` pattern exactly:
      - channels (`apps/desktop/src/shared/channels.ts`): `reviewSessionNext` (`review:session:next`),
        `reviewPreview` (`review:preview`), `reviewGrade` (`review:grade`);
      - contract (`apps/desktop/src/shared/contract.ts`): request Zod schemas + result types —
        - `review.session.next({ exclude?: string[], asOf?: string }) → { card: ReviewCardView | null,
          remaining: number, total: number }` where `ReviewCardView` carries everything the
          face needs **without revealing the answer in the prompt payload until needed**:
          `{ id, kind, prompt, answer, cloze, priority, stage, concept?, sourceTitle, sourceLocationLabel,
          ref, schedulerSignals (fsrs), leech, lapses }` (the answer/ref travel with the card but
          the renderer hides them until reveal — review is fast and local; do not round-trip on reveal);
        - `review.preview({ cardId, asOf? }) → { intervals: Record<ReviewRating,{ dueAt, scheduledDays, label }> }`
          (calls `SchedulerService.previewIntervals` — pure, no mutation);
        - `review.grade({ cardId, rating, responseMs, asOf? }) → { reviewLog: ReviewLogSummary,
          reviewState: ReviewStateSummary }` (calls `SchedulerService.gradeCard` →
          `ReviewRepository.recordReview`);
      - preload (`apps/desktop/src/preload/index.ts`): a `review` group mirroring the methods;
      - IPC router (`apps/desktop/src/main/ipc.ts`): three validated handlers;
      - `DbService` (`apps/desktop/src/main/db-service.ts`): `sessionNextCard`, `previewCard`,
        `gradeCard` methods composing `QueueRepository` + `SchedulerService` + `ReviewRepository`;
      - renderer client (`apps/web/src/lib/appApi.ts`): the mirrored `review` group + types.
- [ ] **`ReviewScreen`** in `apps/web` (e.g. `apps/web/src/review/ReviewScreen.tsx`) replacing
      the `/review` Placeholder in `apps/web/src/router.tsx`, rebuilt from
      `design/kit/app/screen-review.jsx` pixel-for-pixel (in our React 19 + Tailwind v4 +
      `lucide-react` stack):
      - load the deck via `review.session.next` (or an initial `dueCards` list + iterate);
      - show the card metadata row (`badge` Q&A/Cloze, `ConceptTag`, `Prio`, `Stage`,
        `SchedulerChip` FSRS), the `rcard` with `rcard__prompt`; cloze fronts render `[ … ]` for
        each `{{c1::…}}` until reveal;
      - **reveal** on `Space` / "Reveal answer" button → show `rcard__answer` + the `refblock`
        with the source line; fetch the four interval previews (lazily via `review.preview` or
        eagerly with the card) and render them on the grade buttons;
      - **grade** on click or `1`/`2`/`3`/`4` → call `review.grade` with the measured
        `responseMs` (reveal → grade), then advance to the next card;
      - **progress + completion**: `pbar`, `SessionClock`, "N reviewed · M left", and the
        `EmptyState` "Session complete" summary with per-grade `Metric`s.
      - keep all keyboard handling consistent with the shell (`Space` reveal; `1–4` grade;
        ignore while focus is in an input/textarea — exactly as the prototype's `onKey`).
- [ ] **Sequence within a session:** the deck is **due cards first** (the M7 scope is cards;
      mixing in attention items is M5/M16). Respect the `dailyReviewBudget` setting as the deck
      cap. Sibling spacing (T039) and leech surfacing (T040) layer onto this deck.
- [ ] **Tests (Vitest, renderer component):** reveal toggles the answer; grading calls
      `appApi.review.grade` with a plausible `responseMs` and the correct rating; the grade
      buttons render the four preview intervals; cloze fronts mask `{{…}}` until reveal; the
      summary tallies per-grade counts. Mock `window.appApi.review`.
- [ ] **Tests (Vitest, `DbService`):** `gradeCard` advances `review_states` + appends a
      `review_logs` row + logs `add_review_log` (composing the real `SchedulerService` +
      `ReviewRepository` against an in-memory DB).
- [ ] **Playwright E2E (the milestone flow)** in `tests/electron/` (e.g.
      `tests/electron/review.spec.ts`): open `/review` on the seeded card (T009 seeds a Q&A +
      cloze card with review state) → reveal → grade across **each** of Again/Hard/Good/Easy on
      successive cards → assert a `review_logs` row was written and `review_states.due_at`
      advanced per rating → **restart the Electron app** → the new due dates + logs persist and
      the card's next due reflects the last grade.

### Done when

- `/review` shows prompt → reveal → grade Again/Hard/Good/Easy with next-interval previews,
  logs the response time, updates FSRS scheduler state through `SchedulerService` →
  `ReviewRepository`, and advances; **every** review writes a durable `review_logs` row and the
  rescheduling **survives app restart**.
- The renderer contains no FSRS math and no SQL — it only calls `review.*` over the typed
  `window.appApi`.
- `pnpm typecheck`, `pnpm test`, and the review Playwright spec pass.

### Notes / risks

- Measure `responseMs` in the renderer (the time from reveal to grade) and pass it through;
  `review_logs.responseMs` already exists and `recordReview` persists it.
- **Sibling burying (T039)** and **leech surfacing (T040)** are separate tasks; T037 ships the
  plain due-card session. Keep the deck-selection logic in a place T039 can wrap (prefer
  driving each step through `review.session.next({ exclude })` so T039 can add sibling-aware
  exclusion main-side rather than reordering in React).
- Do not reveal-fetch the answer from the DB on each card if it's already in the payload — keep
  review local and fast (the answer ships with the card; the renderer hides it). This matches
  the prototype, which already holds the full card and only toggles visibility.
- Sources/extracts are **not** part of this session (they're attention items; the combined
  daily queue is M5/T029). Do not pull `dueAttentionItems` into `/review`.

---

## T038 — Review editing

- **Status:** `[ ]`  · **Depends on:** T037
- **Roadmap line:** Done when: during review the user can edit prompt/answer, open source,
  suspend, delete, and flag-as-bad — fixing a bad card at the moment it fails.

### Goal

The review session's repair-action row (`design/kit/app/screen-review.jsx`: Edit / Open source /
Add context / Suspend / Mark leech / Delete) becomes functional, so the user can fix a bad card
the moment it surfaces without leaving review: **edit** the prompt/answer (or cloze) inline,
**open source** (jump back to the exact originating paragraph via the card's lineage),
**suspend** (status `suspended` — leaves the deck, recoverable), **delete** (soft-delete), and
**flag-as-bad** (a non-destructive marker for later triage). Every action is one transaction +
an `operation_log` row, and every edit keeps `card → source location → source` lineage intact.

### Context to load first

- Reference: `CLAUDE.md` "Review rules" (edit / open source / suspend / delete / mark leech /
  add context) + "Card-quality rules"; `domain-model.md` lineage + soft-delete;
  `design-system.md` `Status` (`suspended`).
- Existing code to inspect: `design/kit/app/screen-review.jsx` (the repair-action `Btn` row +
  the `jumpToSource` handler + the context drawer); `packages/local-db/src/review-repository.ts`
  (`findCardById` for current prompt/answer/cloze + `sourceLocationId`);
  `packages/local-db/src/element-repository.ts` (`update`, `softDelete`);
  `packages/local-db/src/source-repository.ts` (`findLocationById` — the jump target);
  the **T022 jump-to-source flow** (`apps/web` `navigateToLocation` + the reader `jumped`
  flash) — reuse it; `apps/desktop/src/main/db-service.ts` (the `extracts.*` action handlers as
  the pattern for `cards.*`).
- Invariants in play: edits are `update_element` (card body fields live on the `card` element /
  `cards` row); suspend/flag are `update_element`; delete is `soft_delete_element`; lineage and
  the `review_logs` history are never destroyed by an edit; all one transaction + op.

### Deliverables

- [ ] **`cards.*` `window.appApi` surface** (channels + contract + preload + ipc + db-service +
      renderer client), Zod-validated, following the `extracts.*` pattern:
      - `cards.update({ cardId, prompt?, answer?, cloze? }) → { card: CardSummary }` — edit the
        card body; updates the `cards` row (and `elements.updatedAt`) and logs `update_element`.
        Validate that a `qa` card keeps prompt/answer and a `cloze` card keeps cloze text
        (reuse / forward to the M6 card-quality checks where they exist; otherwise minimal
        non-empty validation, leaving the full quality gate to T035/M6).
      - `cards.suspend({ cardId }) → { card }` — status `suspended`; logs `update_element`.
        The card leaves the due-card query (`QueueRepository.dueCards` already excludes
        `suspended`) but keeps its `review_states`/logs (recoverable).
      - `cards.delete({ cardId }) → { card }` — soft-delete (`deletedAt` set, status `deleted`);
        logs `soft_delete_element`; lineage rows remain valid (recoverable via trash, T044).
      - `cards.flag({ cardId, flagged: boolean, reason? }) → { card }` — a non-destructive
        "flag-as-bad" marker for later quality triage. **Storage:** persist the flag without a
        new column where possible — store it on the card's `operation_log`/an attribute the
        inspector can read; if a durable flag is needed, see the migration note below. Logs
        `update_element`.
- [ ] **Wire the repair row** in `ReviewScreen` (T037) to these commands: Edit opens an inline
      prompt/answer editor (a small form or the M6 builder fields) saving via `cards.update`;
      Open source calls the **T022** `navigateToLocation` using the card's `sourceLocationId`
      (resolve via the existing inspector/location read) — opening `/source/$id` scrolled to and
      flashing the originating paragraph; Suspend/Delete/Flag call their commands and advance the
      session (the graded/edited card is removed from the remaining deck).
- [ ] **Add context** (the kit's "Add context" button) is in M7 scope as a thin affordance:
      either append to the card's `answer`/a notes field via `cards.update`, or open the source
      drawer (the kit's context drawer) — implement the drawer + open-source at minimum; richer
      context capture is M17/T085 leech remediation (note the deferral).
- [ ] **Tests (Vitest, `DbService`/`local-db`):** `cards.update` changes prompt/answer and logs
      `update_element` while leaving `review_states`, `review_logs`, and `sourceLocationId`
      intact (lineage preserved); `cards.suspend` sets status `suspended` and the card drops out
      of `dueCards`; `cards.delete` soft-deletes (status `deleted`, `deletedAt` set) and logs
      `soft_delete_element`; `cards.flag` toggles the flag + logs `update_element`.
- [ ] **Playwright E2E** (extend `tests/electron/review.spec.ts` or a new
      `tests/electron/review-edit.spec.ts`): in review, edit a card's answer → grade → reopen →
      the edit persisted; suspend a card → it no longer appears in the session; Open source →
      lands on the originating paragraph; **survives app restart**.

### Done when

- During review the user can edit prompt/answer, open source (correct paragraph via lineage),
  suspend, delete, and flag-as-bad; each is one transaction + the correct existing
  `operation_log` op; edits preserve `card → source location → source` lineage and the
  `review_logs` history; suspend/delete remove the card from the live deck; all survive **app
  restart**.
- `pnpm typecheck`, `pnpm test`, and the review-editing Playwright spec pass.

### Notes / risks

- **Open source reuses T022** — do not build a second jump-to-source path. The card's
  `sourceLocationId` → `SourceRepository.findLocationById` → `navigateToLocation`.
- "Flag-as-bad" and "Mark leech" (T040) are different: flag is a manual *quality* marker the
  user sets; leech is *automatic* after repeated lapses. If both need a durable card attribute,
  add them together in T040's migration (see T040) to avoid two migrations.
- Full card-quality warnings on edit are **M6/T035** — T038 reuses them if present, otherwise
  does minimal validation and leaves a TODO.
- Editing a card mid-review must not corrupt the in-flight FSRS state — edit the body only;
  never touch `review_states` from an edit.

---

## T039 — Sibling burying

- **Status:** `[ ]`  · **Depends on:** T037, T032
- **Roadmap line:** Done when: cards from the same extract/cloze group don't appear back-to-back
  in a session unless burying is disabled.

### Goal

Within a review session, two cards that share a sibling group (the same parent extract, or the
same cloze group — e.g. `{{c1}}`/`{{c2}}` from one passage) must **not** appear back-to-back, so
sibling cards don't prime each other's answers. Burying is on by default and can be **disabled**
via a setting; when disabled, the natural due order is used unchanged. This is the
`scheduling-and-priority.md` rule "sibling cards must not appear back-to-back unless the user
explicitly asks."

### Context to load first

- Reference: `scheduling-and-priority.md` (sibling cards not back-to-back); `domain-model.md`
  (`sibling_group` relation keeps cloze/Q&A siblings from interfering); `CLAUDE.md` "Review
  rules".
- Existing code to inspect: `packages/db/src/schema/relations.ts` (`relationType:
  "sibling_group"` + `siblingGroupId` column already exist); `packages/core/src/enums.ts`
  (`RELATION_TYPES` incl. `sibling_group`); `packages/core/src/ids.ts` (`SiblingGroupId`),
  `packages/local-db/src/ids.ts` (`newSiblingGroupId`); the **M6/T032** card model — confirm
  whether siblings are recorded as `cards.sibling_group_id` (a column) **or** as
  `element_relations` `sibling_group` edges; `packages/local-db/src/queue-repository.ts`
  (`dueCards`, `nextCard(asOf, exclude)`); the T011 settings model
  (`packages/core/src/settings.ts` `AppSettings`).
- Invariants in play: burying is **session-ordering only** — it never changes `review_states`,
  `due_at`, or the durable log; the sibling-group source of truth is the M6 shape; the toggle is
  a stable settings key.

### Deliverables

- [ ] **A `burySiblings` setting** added to the T011 `AppSettings` model
      (`packages/core/src/settings.ts`): a boolean defaulting `true`, with a stable
      `SETTINGS_KEYS.burySiblings` (e.g. `"review.burySiblings"`), coercion in
      `coerceSettingValue`, and inclusion in `appSettingsFromStored`/`coerceSettingsPatch`.
      Mirror the type in the renderer `AppSettings` (`apps/web/src/lib/appApi.ts`) and add a
      toggle to `/settings` (`apps/web/src/pages/Settings.tsx`). Update the T011 settings tests.
- [ ] **A `siblingGroupOf(cardElementId): SiblingGroupId | null` read** in `packages/local-db`
      (on `ReviewRepository` or a small `sibling-query.ts`) that resolves a card's sibling group
      from **whichever** M6 shape exists: the `cards.sibling_group_id` column **or** the
      `element_relations` `sibling_group` edge (prefer the column if T032 added it; otherwise the
      relation). A card with no group returns `null` (never buried).
- [ ] **Sibling-aware deck ordering**, kept in `packages/local-db`/`packages/scheduler` (NOT
      React): a `nextReviewCard(asOf, { recentSiblingGroups, exclude, burySiblings })` selection
      (extend `QueueRepository.nextCard` or a thin `ReviewSessionService`) that, when
      `burySiblings` is on, skips the soonest-due card whose sibling group was just shown and
      returns the next non-sibling due card instead — falling back to the original card only if
      every remaining due card is a sibling (never starve the session). When `burySiblings` is
      off, behaves exactly like `nextCard`.
- [ ] **Wire it through `review.session.next`** (T037): the renderer tracks the last-shown
      sibling group(s) as opaque session state and passes them (and the `burySiblings` setting)
      to `review.session.next`; the **main side** does the sibling-aware selection. The renderer
      does not compute sibling relationships.
- [ ] **Tests (Vitest, `local-db`):** given three due cards where two share a sibling group, the
      session never returns the two siblings consecutively when burying is on, and returns
      natural due order when off; a degenerate all-siblings deck still drains (no infinite skip);
      `siblingGroupOf` resolves the group from the M6 shape.
- [ ] **Playwright E2E** (extend the review spec): seed two cloze siblings from one extract +
      one unrelated card; with burying on, the two siblings are not consecutive; toggle the
      setting off in `/settings` and confirm consecutive siblings are allowed; **survives app
      restart** (the setting persists).

### Done when

- Cards from the same extract/cloze sibling group do not appear back-to-back in a session unless
  `burySiblings` is disabled; the natural due order is otherwise preserved; burying changes only
  session ordering, never FSRS state or logs; the setting persists across **app restart**.
- The sibling-ordering logic lives in `packages/local-db`/`packages/scheduler`, not React.
- `pnpm typecheck`, `pnpm test`, and the sibling Playwright spec pass.

### Notes / risks

- **Confirm the M6 sibling shape before building.** The roadmap's T032 line names
  `sibling_group_id` on cards, but today only `element_relations.sibling_group` +
  `siblingGroupId` exist. Build `siblingGroupOf` to read whichever M6 chose; do not add a
  redundant column.
- Burying is "don't show back-to-back," **not** "reschedule the sibling" — never mutate
  `due_at`/`review_states` to enforce spacing in the MVP (concept diversity + spacing scoring is
  M16/T076).
- Keep the "recently shown sibling groups" window small (the immediately preceding card is the
  MVP requirement); a larger spacing window is a later refinement.

---

## T040 — Basic leech detection

- **Status:** `[ ]`  · **Depends on:** T037
- **Roadmap line:** Done when: a card is marked leech after repeated failures (warn at 4 lapses)
  and appears in a cleanup view with rewrite/suspend/delete.

### Goal

A card that keeps failing (`review_states.lapses` reaching the threshold — **warn at 4 lapses**)
is flagged a **leech**: the review session shows the leech `Banner` (`design/kit/app/
screen-review.jsx`) and a `leech` `Status` badge, and the card appears in a **cleanup view** that
offers rewrite / suspend / delete (the start of the M17/T085 remediation workflow). Leech
detection is automatic and source-grounded; flagging never destroys the card or its history.

### Context to load first

- Reference: `CLAUDE.md` "Review rules" (mark leech) + "Card-quality rules"; `scheduling-and-
  priority.md` (lapses tracked for leech detection); `design-system.md` `Status` (`leech`),
  `Banner` (leech).
- Existing code to inspect: `packages/db/src/schema/cards.ts` (`review_states.lapses` —
  "drives leech detection"); `packages/local-db/src/review-repository.ts` (`recordReview`
  already increments `lapses` on `again`; `findReviewState`); `design/kit/app/screen-review.jsx`
  (the leech `Banner` + `badge--leech` + the repair row); `design/kit/app/components.jsx`
  (`Banner`, `Status`); the T038 `cards.*` surface (reuse `cards.suspend`/`cards.delete`/
  `cards.update`); `apps/web` (the inspector + a place for a maintenance/cleanup view — the
  `screen-analytics`/`screen-extra` family, M9).
- Invariants in play: leech is a derived/flag attribute of a card; the threshold is a constant
  (4 lapses) the scheduler exposes; flagging is `update_element` (one transaction + op); the
  card and its `review_logs` are never destroyed.

### Deliverables

- [ ] **A leech threshold + detector** in `packages/scheduler` (e.g. `LEECH_LAPSE_THRESHOLD = 4`
      + `isLeech(state: ReviewState): boolean`), the single source of the rule. `recordReview`
      (or the `DbService.gradeCard` path) consults it after a grade and, when a card crosses the
      threshold, **sets the leech flag** in the same transaction (logging `update_element`) and
      (optionally) suspends per a setting — MVP default is *flag + warn*, not auto-suspend.
- [ ] **Leech flag storage (the one migration this milestone may need).** Today there is no
      leech column. Add a durable card attribute via a Drizzle migration
      (`packages/db`, `pnpm db:generate`/`db:migrate`): the simplest is a boolean `isLeech`
      (and reuse it for T038's `flagged`/`reason` if a durable manual flag is also wanted) on
      `cards` (or a small `card_flags` shape) — keep it on the card side, not `review_states`,
      since it's a quality attribute. Update `@interleave/core` (extend the card/`CardSummary`
      types) + `packages/db` schema + `mappers` + the seed (T009) accordingly. **If M6/T032
      already added a leech/flag column, reuse it and add no migration** — confirm first.
- [ ] **Surface the leech in review** (T037 `ReviewScreen`): when the current card is a leech,
      render the leech `Banner` ("This card keeps lapsing") + the `badge--leech` `Status` with
      the lapse count, matching the kit. The `ReviewCardView` already carries `leech`/`lapses`
      (T037) — make them real.
- [ ] **A cleanup view** in `apps/web` (e.g. `apps/web/src/maintenance/LeechCleanup.tsx`, reached
      from settings/maintenance nav or the analytics surface) listing all leech cards with their
      lapse counts + source, each offering **rewrite** (open the T038 inline editor / builder),
      **suspend** (`cards.suspend`), and **delete** (`cards.delete`). Back it with a read command
      `review.leeches() → { cards: LeechSummary[] }` (channels + contract + preload + ipc +
      db-service + renderer client), composed from `ReviewRepository` (cards whose state/flag is
      leech), excluding soft-deleted/suspended as appropriate.
- [ ] **A `cards.markLeech({ cardId, leech: boolean }) → { card }`** command (or fold into
      T038's `cards.flag`) so the kit's manual "Mark leech" button works and a remediated card
      can be **un-leeched** after rewrite; logs `update_element`.
- [ ] **Tests (Vitest):** `isLeech` true at ≥4 lapses, false below (scheduler); grading a card
      to its 4th lapse sets the leech flag in the same transaction as the `add_review_log`
      (`DbService`/`local-db` integration); `review.leeches()` returns only leech cards;
      `cards.markLeech` toggles + logs `update_element`.
- [ ] **Playwright E2E** (extend the review spec or a new `tests/electron/leech.spec.ts`): grade
      a seeded card `Again` enough times to cross 4 lapses → the leech `Banner`/badge appears in
      review → the card shows in the cleanup view with rewrite/suspend/delete → suspend it →
      it leaves review → **survives app restart**.

### Done when

- A card is automatically marked a leech after repeated failures (warn at **4 lapses**), the
  review session shows the leech warning, and the card appears in a cleanup view offering
  rewrite / suspend / delete; flagging never destroys the card or its `review_logs`; the leech
  state and the cleanup actions survive **app restart**.
- The leech threshold + detection live in `packages/scheduler`/`packages/local-db`, not React.
- `pnpm typecheck`, `pnpm test`, and the leech Playwright spec pass.

### Notes / risks

- The threshold (4) is the SuperMemo/Anki-style default; keep it a named constant so a future
  setting (`leechLapseThreshold`) can override it — do not hard-code `4` across the codebase.
- MVP behavior is **flag + warn**, not auto-suspend (auto-suspend-on-leech can be a later
  setting); the full split/add-context/lower-priority remediation screen is **M17/T085** — T040
  ships the minimal cleanup view (rewrite/suspend/delete) and notes the deferral.
- Coordinate the leech-flag migration with T038's manual flag so the milestone adds **at most
  one** card-attribute migration; if M6/T032 already provisioned a flag/leech column, add none.
- Leech is derived from `lapses` but stored as a flag so the cleanup view + analytics (M9/T045,
  M17/T083) can query it cheaply without recomputing.

---

## Exit criteria for M7

- All of T036–T040 are `[x]` in [`../roadmap.md`](../roadmap.md).
- The **active-recall review loop** works end to end in the Electron desktop app: `/review`
  loads due cards, reveals, grades Again/Hard/Good/Easy with next-interval previews, logs the
  response time, reschedules via FSRS, and advances — and every review writes a durable
  `review_logs` row that **survives an app restart**, with `review_states` advanced per rating.
- The **two-scheduler split** is intact: a `SchedulerService` in `packages/scheduler` wraps
  `ts-fsrs` and schedules **cards only**, persisting FSRS state on `review_states`; no
  `review_states`/FSRS row is ever created for a `source`/`topic`/`extract` (those stay on the
  M5 attention scheduler). FSRS math + review-state transitions live in `packages/scheduler`
  (and the `ReviewRepository` persistence seam), **never** in React.
- In-review repair works: edit prompt/answer, open source (lineage jump-back via T022), suspend,
  delete, and flag-as-bad — each one transaction + the correct existing `operation_log` op
  (`update_element` / `soft_delete_element` / `add_review_log`), preserving
  `card → source location → source` lineage and the append-only `review_logs` history.
- Sibling cards from one extract/cloze group are not shown back-to-back unless `burySiblings` is
  disabled (a persisted setting); leech cards are flagged after 4 lapses, warned in review, and
  remediable in a cleanup view (rewrite/suspend/delete).
- All new capabilities reach the renderer **only** through new typed `window.appApi` commands
  (`review.*`, `cards.*`) with Zod-validated IPC; **no raw DB/filesystem access is exposed to
  the renderer**, and no generic `db.query`.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M7 Playwright specs (review across grades →
  logs/reschedule → restart; edit/suspend/open-source; sibling burying; leech) are green.

When M7 is complete, generate `tasks/M8-organize-search.md` from the roadmap before starting
T041.
