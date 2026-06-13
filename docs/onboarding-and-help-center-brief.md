# Interleave — Onboarding Flow & Help Center

## A design & content brief

**For:** the design agent who will produce the onboarding mockups, empty-state set, help-center IA, and contextual-help component specs.
**From:** an investigation of the real, shipped Interleave codebase (16 parallel area audits + 4 synthesis passes + 1 adversarial review).
**Status of the app:** mature. 91/100 roadmap tasks shipped across 20 milestones. The *only* unbuilt things are the server-side encrypted-backup tier and a Tauri shell (see §0.5). There is **no onboarding beyond a single welcome modal, and no help center or contextual help of any kind today** — that is exactly the gap this brief asks you to fill.

---

## §0.1 How to use this brief

The brief has four parts plus this front matter:

- **Part A — The First-Run Onboarding Flow.** What new users must learn, the guided golden path, sample data, progressive disclosure, milestone moments, anti-goals.
- **Part B — The Help Center / Documentation.** Full information architecture, every article (title · audience · what it must cover), the keyboard reference, the concepts glossary, search & cross-linking, formats, and a docs-stay-in-sync model.
- **Part C — In-App Contextual Help Map.** The concrete "help linked to throughout the app" surface: a hook-by-hook map per screen, every empty state as a teaching moment, global help affordances, a reusable component inventory, and rules for when *not* to show help.
- **Part D — Design & Content Direction.** How to make all of it feel native: tokens, type, the two load-bearing patterns, tone of voice (with do/don't copy), layout patterns, diagram direction, accessibility, and a **deliverables checklist (D7)**.

**Read §0.4 before Parts A–D.** Parts A–D are detailed and strong, but an adversarial review found a handful of places where they should be corrected or where a decision was left open. §0.4 resolves those; treat it as overriding the body where they conflict.

**What we need back from you:** the deliverables enumerated in **§D7** — onboarding mocks (light + dark), the empty-state set, the help-center IA + article template + surface layout, the contextual-help component specs, and the help iconography. Everything token-driven, both themes, no invented visual language.

---

## §0.2 The product in one page

Interleave is a **desktop-first, local-first incremental reading app** (Electron + native SQLite; data lives on the user's machine, no account, no cloud). It is **not** a read-it-later app, **not** a note app, **not** just flashcards. It is a long-term knowledge **refinery**:

```
Source → Topic → Extract → Clean extract → Atomic statement → Card → Review → Mature knowledge
```

Raw reading goes in; most is discarded; a little becomes extracts; less becomes flashcards the user can actually recall; the best becomes part of how they think. Users keep **many** sources in a **prioritized queue**, read them in **small increments**, lift the useful fragments out as independently-scheduled **extracts**, **distill** those into single atomic ideas, turn the best into **cards**, and **review** with spaced repetition.

**The surfaces (20 routes), so you can design without the codebase:**

| Route | Screen |
|---|---|
| `/` | Home command center (read-only daily dashboard) |
| `/inbox` | Import & inbox triage |
| `/queue` | Daily Queue (everything due, priority-then-due) |
| `/process` | One-at-a-time keyboard process loop |
| `/source/$id` | Source Reader (HTML / PDF / media variants) |
| `/extract/$id` | Extract distillation + card builder |
| `/review` | Active-recall FSRS review session |
| `/synthesis/new`, `/synthesis/$id` | Synthesis notes (incremental writing) |
| `/search` | Keyword FTS5 search |
| `/library` | Faceted browse of everything |
| `/concepts` | Concept knowledge map |
| `/maintenance` (+ `/leeches`, `/stagnant`, `/retired`) | Maintenance hub |
| `/trash` | Soft-deleted items |
| `/analytics` (+ `/sources`) | Learning-health + per-source yield |
| `/settings` | Local preferences |

**The existing design system (your raw material — reuse, don't reinvent):** OKLCH tokens in `design/tokens.css` (full light + dark; dark is the `[data-theme]` attribute, not a `dark:` class); the IBM Plex superfamily (Sans = UI, Serif = reading, Mono = keycaps/metadata); `lucide-react` icons via `design/icon-map.md`; and shipped primitives — `Prio` badge (A/B/C/D), `SchedulerChip` (brain/FSRS vs gauge/attention), `TypeIcon` (8 element colors), `Stage`, `LineageTree`, `Pipeline` stepper, `Tooltip`, `Banner`/`BalanceBanner`, `Snackbar`, and a de-facto empty-state pattern. Summary in `docs/design-system.md`; immutable reference in `design/kit/`.

---

## §0.3 The three mental models onboarding must install (the spine)

Almost every new user arrives with a read-later, note-app, or flashcard mental model — and the single biggest failure mode is a user who **highlights instead of extracts, cards everything, or treats the queue as a backlog to clear**, then quietly concludes "this does nothing for me." Onboarding's whole job is to replace those three models with these three:

1. **The refinery, not the reading list.** *"Raw reading goes in. Most you throw away. A little becomes extracts, less becomes cards, and the best becomes how you think. It's a funnel, not a to-do list."* Corollary: **you are not meant to finish what you import** — reading 5% and keeping one durable idea is a win.

2. **Two schedulers on purpose.** *"Cards ask 'can you recall this?' and are scheduled by FSRS — the brain chip. Sources and extracts ask 'should you look at this again, and when?' — the gauge chip. They never mix."* This single split explains the mixed queue, why a source has a return date but no recall %, and why grade buttons only appear on cards. Teach it on a **real `SchedulerChip`**, never as abstract theory.

3. **Lineage is sacred + overload is a feature.** Every card remembers exactly where it came from ("Jump to source"), which is what makes deleting/postponing aggressively *safe* — and delete is always soft and undoable (`⌘Z`). Overload isn't failure; it's the system working. These two ideas are the emotional permission slip for the whole method.

---

## §0.4 Corrections, decisions & known issues — read before Parts A–D

Parts A–D were drafted from the area investigations and then adversarially reviewed. The items below **override the body** where they conflict.

### ⚠️ A product bug to FIX, not to document

The Source Reader (`apps/web/src/pages/source/SourceReader.tsx`) still renders **disabled "Postpone / Mark done / Lower priority" buttons** titled *"Scheduling lands in M5 (T027–T031)"* / *"Priority controls land in M5 (T027)"* (lines 730/739/748), and the Cloze toolbar action still fires `toast("Cloze lands in M6")` (lines 342–343). **Those features have all shipped** (T027–T031 scheduling/queue/priority and T033–T034 Q&A/cloze are done). These are orphaned post-MVP stubs — i.e. **bugs**, not intended behavior.

- **Engineering:** wire these up (let the reader prioritize/schedule a source; route the reader's Cloze to the extract→card flow) or remove the dead controls.
- **Design/content:** do **not** write help that teaches "sources are deliberately un-prioritizable/un-schedulable from the reader" or that "Cloze is a dead end in the reader." Parts B (§4.10 `pruning-sources`) and C (Source Reader rows) currently rationalize the stubs — ignore that copy; treat the reader as able to prioritize once fixed.

### Decisions locked (where the drafts left a choice open)

- **Help center = an in-app surface, not a website.** The app is offline-first and desktop-only; a networked help site would contradict "Local vault · offline-first." Build help as an in-app routed/overlay surface (article list in an inspector-width rail), deep-linkable by `help://<slug>#<anchor>`.
- **Onboarding = layered just-in-time, not one long front-loaded tour.** A short first-run modal for the method + myth-busters + keyboard pillars, then contextual coachmarks fired on first encounter of each real surface, then every empty state as a teaching moment. (Details in Part A / D4.)
- **Re-sequence onboarding Step 7 (preferences).** Do **not** put a Daily-review-budget / Desired-retention settings panel inside the first-run tour — a brand-new user has no lived feel for daily volume, and it violates the "don't dump Settings / don't overwhelm" anti-goal. Keep only the **Theme** choice in/after the welcome modal; surface **budget** and **retention** contextually the first time the user is over budget (deep-link `review-budget` / `desired-retention`). This also shortens the tour toward the <3-minute target.
- **Canonical help homes (no duplicated articles):** leeches → `leeches`; stagnant → `stagnant-vs-leech`; two schedulers → `two-schedulers`; overload → `overload-is-a-feature`; backup-vs-export → `backup-vs-export`. The Maintenance-area mentions become thin pointers, not second copies.
- **The `⌘K` palette "Go to" group does NOT include Analytics** (only the `g a` keyboard chord reaches `/analytics`). Don't write any "open Analytics via ⌘K" copy. (Palette Go-to = Home, Queue, Inbox, Review, Library, Concept map, Settings.)
- **Trim the proposed `Help:` palette group** to two commands — `Help: Open help center` and `Help: Take the tour` — rather than enumerating ~8 concept commands in an already-dense palette; let the help center's own search handle the rest. (Overrides Part C §C.3 item 3.)

### Corrections to apply over the drafts

**Must**
- **Add an Analytics / Source-yield block to the Part C hook map.** It's currently missing entirely. Hooks needed: the retention metric (*"not graded Again, last 30 days; ~85–90% is healthy"*), the Source-yield "review time = card-review time, not reading time" / "Not started" vs "Low yield" / yield-band tooltips, the System-health banners, and the Analytics `BalanceBanner`.
- **Pre-empt the first *organic* empty `/review`.** Part A's tour cleverly dodges "No cards due" by routing into a one-card review, but a returning user who opens `/review` directly on day 2 with zero/no-due cards still lands there. Add a once-only milestone that reframes it via `no-cards-due`, independent of the tour.
- **Specify the sample-source flow once** — done below in §0.4 *Sample-source spec*. The drafts reference "Try a sample source" repeatedly but never defined it.
- **Audit every Part C `help://` target against the Part B slug list** before handoff (some Part C rows point at article *titles* that don't match the frozen Part B slugs). Slugs are the contract; titles can change.

**Should**
- **Add a "returning lapsed user → mountain of overdue" re-engagement beat** (distinct from "stalled loop"): on app open after a long gap with a large overdue count, surface a calm Catch-up / Vacation coachmark + the `overload-is-a-feature` framing. This is the canonical incremental-reading burnout moment.
- **Promote the good-vs-weak candidate hint to "should"** and surface it **inline in the import modals** (URL / New source), at the moment of importing — importing the wrong material ("a novel") is a silent churn cause.
- **Add a hook/note: manual-note cards always warn "missing source" — this is expected.** Otherwise note-authored cards show a permanent unexplained warning.
- **Add a reactive `g`-chord-failure hint and a "g armed" indicator** to the Part C component inventory and hook map (not just Part A's prose). The two-key chord has a ~700 ms window and is a documented high-severity confusion.
- **Add a first-encounter sibling-burying hook** in the review session (the moment burying visibly skips/reorders a card), beyond the Settings tooltip.
- **Add a "Skip & turn off tips" affordance to the welcome modal**, tied to the global "Show contextual tips" toggle (Part C §C.5 rule 4), so returning power users can opt out on day one.
- **Add a help-search disambiguation entry for "restore"**: *Restore a deleted item (Trash)* vs *Restore a backup (planned)*.
- **Strengthen the process-loop delete hint.** List deletes show an Undo snackbar; `/process` deletes are silent. Make the first-time `/process` delete hint prominent, and flag the list-vs-loop undo asymmetry to engineering as a candidate fix.

**Nice**
- **Add glossary entries** for **Task**, **Verification task**, **Media fragment / Clip / Region**, and a sharper **Topic** definition that says what *creates* a topic (a saved media clip, a cropped PDF region, an EPUB chapter) — and why a saved clip shows a Folder icon.
- **Add an article/hook for re-activating a "Save for later" (dismissed) item from Library** — the missing other half of the Save-for-later model.
- **Branch (or force the text sample for) Steps 3–5 when the user's own first import is a PDF or media file**, since read-point/extract gestures differ there (page-granular / timeline). See the sample-source spec.
- **Note in `import-documents` / Part C that OCR runs in the reader, not the inbox**, closing the "looks broken" loop on the inbox scanned-PDF note.

### Sample-source spec (defined once, referenced everywhere)

The guided golden path and several empty states ("Try a sample source") depend on a seeded demo. Specify it as **one shared flow**:

- **Content:** a single short (~500–800 word), fact-rich, clearly *divisible* explainer with sentences that make obviously good extracts (the app already ships a seed set; pick/curate one encyclopedic-style article — **not** fiction/news/tutorial, which would teach the wrong "what to import" lesson).
- **Behavior:** seeded into the Inbox at priority C, carrying a visible **"Sample" badge/tag**; **excluded from Analytics and Source-yield** so it never skews real metrics; offers **one-tap "Remove the sample"**; is **never auto-deleted** (that would violate "do not silently destroy user data").
- **Role:** it launches the guided read → set read-point → extract → distill → convert-to-card → review walkthrough, so every step lands deterministically on clean material.
- **PDF/media branch:** if the user instead imports their own PDF/media at Step 2, either branch the gestures to that reader variant **or** offer the text sample for the guided path so Space-to-read-point and select-text-Extract map cleanly.

---

## §0.5 Scope honesty: shipped vs planned

Everywhere in the docs, planned-not-shipped topics must be tagged so a user never hunts for a button that doesn't exist. **Shipped** (describe as real): everything in the pipeline, the two schedulers, priorities, FSRS review, leeches/stagnant/retired, search/library/concepts/tags, maintenance/trash/undo, **local ZIP backup** + Markdown/Anki export, synthesis notes, AI **draft** assistance + on-device semantic search (both off by default, bring-your-own key), and the local-loopback browser extension. **Planned / partial (tag clearly):** in-app *restore* of a backup ZIP; automatic/scheduled backups; the encrypted **server** backup tier and any multi-device **sync** (there is none); a managed AI proxy; the local AI model (stub); auto-purge of Trash after 30 days; keyboard-layout *remapping* (the setting exists but doesn't yet rebind keys); redo (`⌘⇧Z` unbound); a Tauri shell.

---


## Part A — The First-Run Onboarding Flow

### A.1 Goals & success metric

Onboarding exists to convert a confused arrival into someone who has **completed one full turn of the loop and understood why it is a loop**. Interleave is not a read-it-later app, a note app, or a flashcard app, and almost every new user arrives with one of those three mental models. The single biggest failure mode is a user who highlights instead of extracts, cards everything, or treats the queue as a backlog to clear — and quietly concludes "this does nothing for me."

**Definition of "activated" (the success metric):** within the first session, the user has

1. imported (or accepted a seeded) source,
2. set a read-point in the Source Reader (`/source/$id`),
3. created at least one **extract** (pressed `E`, not just `H`),
4. advanced or distilled that extract and converted it into one **card** via the Card Builder,
5. completed at least one **review grade** in `/review` (revealed with Space, graded 1–4), and
6. can articulate — measured by a one-tap comprehension check — that **extracts come back on their own schedule** and **you are not meant to finish sources.**

Secondary signals: the user has seen and dismissed the two-scheduler explanation, and has not been scared off by an empty `/review` ("No cards due") or a growing queue.

Persistence note: today the only first-run flag is `ui.seenOnboarding` (set by `Onboarding.tsx`, shown once when the collection is empty). The onboarding redesign needs **per-step progress flags** (e.g. `ui.onboarding.{importedSource, setReadPoint, firstExtract, firstCard, firstReview, comprehensionPassed}`) so the guided loop can resume if interrupted and so milestone nudges (A.6) can fire exactly once. These persist to the SQLite settings table like the existing flag.

---

### A.2 The three load-bearing mental models to teach FIRST

Teach these and almost nothing else up front. Everything else is contextual (A.5).

**1. The refinery, not the reading list (incremental-reading method).**
Plain language: *"Raw reading goes in. Most of it you throw away. A little becomes extracts, less becomes cards you can actually recall, and the best becomes part of how you think. It's a funnel, not a to-do list."*
How to teach simply: show the real `Pipeline` stepper primitive with the live element-type icons/colors — **Source → Extract → Clean → Atomic → Card → Mature** — as a single horizontal diagram, not custom art. One sentence under it: *"You'll do this once right now, in 60 seconds."* This reuses existing design primitives (per the design-system invariant: build onboarding *from* the kit, never invent per-surface art).

**2. Two schedulers on purpose (FSRS vs attention).**
Plain language: *"Cards ask 'can you recall this?' and are scheduled by FSRS — the brain chip. Sources and extracts ask 'should you look at this again, and when?' — the gauge chip. They never mix."*
How to teach simply: show the two real `SchedulerChip` variants side by side — brain icon + recall% vs gauge icon + stage/"postponed ×N" — with one line each. This is the single most likely point of confusion (it explains the mixed queue, why a source has a "next" date but no recall %, and why grade buttons only appear on cards). Do **not** front-load this as abstract theory; introduce it the first time the user actually sees both chip types (queue or process loop), and reinforce it as a tooltip/coachmark thereafter.

**3. Lineage is sacred + overload is a feature.**
Two ideas, taught together because they are the emotional permission slip for the whole method.
- *Lineage:* *"Every card remembers exactly where it came from. You can always Jump to source."* Teach by pointing at the real `LineageTree` and the reader's "Open original"/jump-to-source after the user's first extract.
- *Overload:* *"You're meant to import more than you can finish. Reading 5% and keeping one durable idea is a win. Deleting and postponing aggressively is how this stays healthy — and delete is soft and undoable (⌘Z)."*
How to teach simply: a single myth-buster line in the welcome ("You're **not** meant to finish what you import") plus a coachmark the first time the queue grows or the `OverloadBanner` appears.

---

### A.3 The step-by-step flow

The flow is a **guided golden path** layered over the real screens (not a sandboxed tutorial). Each step uses the actual routes, buttons, and shortcuts so the muscle memory transfers. A persistent, dismissible progress rail ("Step 3 of 7 · Skip tour") sits at the top of the work area; every step is individually skippable and the whole tour is skippable from step 0.

---

**Step 0 — Welcome (replaces/extends `Onboarding.tsx`)**
- **Purpose:** name the loop and pre-empt the three misconceptions before any screen is touched.
- **What is shown:** centered modal built from existing modal primitives. The real `Pipeline` stepper (Source → Extract → Clean → Atomic → Card → Mature). Three one-line myth-busters: *"You don't finish what you import. A highlight is not an extract. Don't card everything."* A "Local vault · offline-first" reassurance (shield icon). Primary button **"Start the 60-second tour"**; secondary **"Import my own source"**; tertiary **"Explore on my own."**
- **User action:** pick one of three paths.
- **The one idea:** *the app is a refinery, and it's local and yours.*
- **Success/skip/empty:** "Explore on my own" sets `ui.seenOnboarding` and drops the user on Home with passive coachmarks still armed (A.5). The modal only ever appears on first launch with an empty collection (current trigger preserved).

---

**Step 1 — The two questions (two-scheduler primer)**
- **Purpose:** install the FSRS-vs-attention split before the user ever sees a mixed queue.
- **What is shown:** a compact card showing the two real `SchedulerChip` variants side by side: *brain + 92% — "Can you recall this?" (cards)* and *gauge + "Raw extract · postponed ×0" — "Should you process this again, and when?" (sources & extracts)*.
- **User action:** read, click "Got it."
- **The one idea:** *cards and reading are scheduled by two different clocks on purpose.*
- **Skip/empty:** skippable; if skipped, the first-encounter coachmark on a live `SchedulerChip` (A.5) still fires later so the concept is never wholly lost.

---

**Step 2 — Get a source in (seed vs own import)**
- **Purpose:** ensure there is real material to walk the loop with, with zero blank-page friction.
- **What is shown:** two choices. **"Use a sample source"** (recommended, highlighted) seeds one curated demo source from the existing seed set into the Inbox. **"Import your own"** routes to `/inbox` and opens the **New source** modal (or "Paste URL"), with the inline good-vs-weak-candidate hint ("textbooks, overviews, your own notes — not fiction, breaking news, or tutorials").
- **User action:** click sample, or paste a URL/text and Create (`⌘↵`).
- **The one idea:** *capture lands in the Inbox at priority C and waits for triage — the inbox is a decision gate, not a reading list.*
- **Success:** a source appears in the inbox list selected. A one-line coachmark on the A/B/C/D `Prio` chips: *"A is protected and returns daily; D is background. New imports default to C so they don't drown older high-value work."* Then a single triage action: **Activate (1)**.
- **Empty/skip:** if the user imports something that fails (not-an-article, too large), show the existing terse error plus a contextual help link, and offer the sample as a fallback so the tour can always proceed.

---

**Step 3 — Read a little, mark your spot (`/source/$id`)**
- **Purpose:** install incremental reading + the read-point.
- **What is shown:** the Source Reader opens on the activated source, scrolled to top, with a coachmark on the reading column: *"Read a little — then press **Space** to mark where you stopped. You'll resume here. Reading happens in small increments."* The "↓ unread from here" divider is highlighted once set. Critical caveat surfaced inline: *"Space sets your read-point only when your cursor isn't in the text."*
- **User action:** read a paragraph or two, press **Space** (or click "Set read-point").
- **The one idea:** *you process sources in increments and the app remembers your place.*
- **Success:** divider appears; progress bar ticks; advance. **Empty/skip:** if the user clicks into the editable body and Space types a space, the coachmark re-states the caveat rather than failing silently.

---

**Step 4 — Extract, don't highlight (the pivotal step)**
- **Purpose:** this is THE differentiating gesture; if the user only ever highlights, the app does nothing for them.
- **What is shown:** prompt the user to select a sentence. The moment the floating **selection toolbar** appears (3+ chars), fire a first-run callout contrasting the two real buttons: *"**Extract (E)** lifts this into its own scheduled item that comes back to you. **Highlight (H)** just marks the text in place."* Use the real `--mark-extract` (violet, left border) vs `--mark-hl` (yellow) marks as the visual.
- **User action:** select text, press **E** (or click Extract).
- **The one idea:** *an extract is an independent, separately-scheduled item with lineage — not a highlight.*
- **Success:** "Extracted" toast, the source paragraph gets the extracted marker, the read-point auto-advances forward, and a follow-up coachmark points at the inspector's **"Extracts from this source"** list: *"Your extract lives here — and in your queue. Open it to refine it."* This directly fixes the documented "I pressed Extract and nothing happened / where did it go?" friction.
- **Empty/skip:** if the user presses H instead, allow it but show a gentle one-time nudge: *"That's a highlight — it won't come back. Try Extract (E) to feed the pipeline."* The step does not complete until one extract exists.

---

**Step 5 — Distill, then make a card (`/extract/$id` + Card Builder)**
- **Purpose:** teach the distillation stages and that you make a card *from a refined extract*, not from raw reading; counter "card everything."
- **What is shown:** the extract distillation view, with a coachmark on the **stage stepper**: *"Refine across repeated returns: trim, rewrite, split. Advance the stage as it becomes a single clean idea — raw → clean → atomic. An atomic statement is card-ready."* Then a coachmark on **"Convert to card"** opening the `CardBuilder` as the third column.
- **User action:** optionally Trim/edit, optionally Advance stage, then **Convert to card** → author a Q&A (or `C` for a cloze) → **Create**.
- **The one idea:** *distill to one self-contained idea before you card it; converting doesn't consume the extract, and the card inherits its lineage.*
- **Success:** "Card created" toast; explain the live **Quality checks** in one line — *"Yellow = advice, you can still create; red = blocks (a hollow card)."* — and that the new card is a **draft that enters FSRS review on its own schedule** (not due this instant). If the user opened the Cloze tab, surface the `{{ }}` convention inline so it doesn't look broken.
- **Empty/skip:** if the user tries Cloze with no braces, the empty-state hint shows the example sentence; the step completes on any successful card creation.

---

**Step 6 — Review it (`/review`)**
- **Purpose:** close the loop; install honest grading.
- **What is shown:** because a freshly created card may not be due, route into a **targeted review of the just-made card** (a one-card mode session) rather than risking the "No cards due" empty state. Coachmark on the Reveal button: *"Try to recall, then press **Space**."* On reveal, coachmark the grade row: *"Grade honestly — **1 Again / 2 Hard / 3 Good / 4 Easy**. The text under each button is when the card returns. Again isn't failure; it just brings the card back sooner."*
- **User action:** Space to reveal, press 1–4.
- **The one idea:** *spaced repetition reschedules from your honest self-grade; you don't have to track anything.*
- **Success:** the "Session complete" summary with a reassuring line: *"This card is now scheduled to return right before you'd forget. You completed the whole loop."*
- **Empty/skip:** if the user skips reviewing, still mark the loop "seen" but leave the milestone nudge (A.6) armed for their first real review.

---

**Step 7 — A few preferences, then hand off**
- **Purpose:** set the two dials that govern daily load, and the one cosmetic choice, without dumping the full Settings page.
- **What is shown:** a slim 3-control mini-panel (not the full `/settings`): **Daily review budget** slider (default 60) with *"a soft cap — going over triggers the overload tools, it's not a failure"*; **Desired retention** slider (default 90%) with *"~85–90% is healthy; 100% means your cards are too easy"*; **Theme** Light/Dark. A one-liner notes both schedulers are tuned separately (retention = cards/FSRS; topic interval lives in Settings). A final line: *"Everything's keyboard-first — press **?** anytime for shortcuts, **⌘K** to do anything."*
- **User action:** adjust or accept defaults; click **"Go to Home."**
- **The one idea:** *you control your daily volume; the system protects high-value work during overload.*
- **Hand-off:** land on the Home command center (`/`) with a final coachmark: *"This is your command center — it shows your day and points you to the next action. The real work happens in **Start session**."* Settings save instantly (no Save button), so reassure with the "Saved" chip behavior.

---

### A.4 Sample/seed data vs the user's own first import

**Recommendation: offer both at Step 2, default to and highlight the sample.**

- The sample (one curated demo source from the existing seed set) removes the blank-page barrier, guarantees the guided loop has clean, divisible, fact-rich material (so Extract → distill → card actually succeeds), and lets every subsequent step land deterministically. This is the single biggest lever against the documented "empty everything on day one" friction.
- But onboarding must **also** let the user bring their own source, because the activation that sticks is processing material they care about. Make "Import your own" a first-class, equal-prominence choice.
- **Cleanup:** clearly label seeded items (a "Sample" tag/badge) and offer a one-tap **"Remove the sample"** in the post-onboarding Home coachmark or Settings, so the demo never silently pollutes a real collection or skews Analytics/Source yield. Do not auto-delete it — that would violate "do not silently destroy user data."
- Do **not** seed a large fixture set for onboarding; one source is enough to teach the loop. A larger seed is a separate "explore demo data" affordance, not part of first run.

---

### A.5 Progressive disclosure — what to DEFER

First run teaches only the core loop + the three mental models. Everything below is **off the first-run path** and surfaced as just-in-time contextual coachmarks/tooltips/help-links (built from the `Tooltip`, `Banner`, and a new help-link primitive), each firing once at the natural moment:

- **Two-scheduler reinforcement** → first-encounter coachmark on a live `SchedulerChip` in the queue/process loop.
- **Priority depth (A/B/C/D as the protective lever)** → first inbox triage and first time the user raises/lowers priority (`+`/`-`).
- **Overload tools (`OverloadBanner` auto-postpone, `RecoveryPanel` catch-up/vacation, daily budget)** → first time the queue crosses budget or the banner appears.
- **Concepts & tags** → first time the collection is large / first Inspector visit with no concepts; teach "organize from the Inspector, organizing pays off later."
- **Search vs Library distinction** → first time `/search` shows the empty "Search your collection" prompt.
- **Synthesis notes (incremental writing)** → teased late, then a first-run callout when the user first opens `/synthesis/$id` (it has no left-nav entry, so a `⌘K` discovery hint matters).
- **AI drafts & semantic search** → never in first run; both are off-by-default and opt-in via Settings, with their own enable-time coachmarks (and the drafts-only trust rule).
- **Browser extension** → its own dedicated 5-step setup sub-flow launched from the Inbox "Browser capture" tile, not the first-run tour.
- **Maintenance / Trash / leeches / stagnant / retired** → surfaced via the first-destructive-action coachmark ("soft delete, ⌘Z to undo") and Analytics System-health banners.
- **Backup** → introduced by the existing 7-day reminder banner and reinforced after the user has content worth protecting; clarify Backup ≠ Export, and that in-app restore is planned, not shipped.

---

### A.6 Re-engagement & milestone moments

Each milestone fires **once** (gated by a settings flag), uses the calm `Banner`/`Snackbar`/coachmark vocabulary, and either celebrates *or* coaches — never both noisily, never gamified.

| Moment | Trigger | What it does |
|---|---|---|
| **First extract** | first `E` outside the tour | Coach: point to "Extracts from this source" + queue; *"It'll come back on its own schedule."* |
| **First card** | first card created | Celebrate quietly + reinforce lineage: *"This card can always Jump to source."* |
| **First review completed** | first graded card outside the tour | Reassure honest-grading and that the card is now scheduled by FSRS. |
| **First review streak (e.g. day 3)** | streak chip becomes non-trivial | Gentle acknowledgment only — the streak is intentionally low-gamification and hidden at 0; never shame a broken streak. |
| **First overload** | queue first exceeds the daily budget / `OverloadBanner` appears | Coach the philosophy: *"More due than your budget is normal — overload is a feature. Auto-postpone protects fragile high-priority cards and is undoable."* Link to the overload article. |
| **First leech** | a card hits 4 lapses / `review-leech-banner` renders | Explain what a leech is and route to remediation (rewrite/split/suspend/delete); reassure no history is lost. |
| **First "No cards due"** | empty `/review` with cards existing or not | Reframe: *"Empty means nothing's due, not broken. Cards come from distilling extracts."* — never let this read as an empty/broken app. |
| **Import outpacing processing** | `BalanceBanner` fires | Nudge the ~70% review / 20% extract / 10% import mix. |
| **Day-2 return with a stalled loop** | returns with extracts but zero cards, or sources but zero extracts | One contextual nudge toward the missing next step (distill an extract / make a card) — not a popup, a Home coachmark. |

Day-2+ nudges live **in-app** (Home coachmarks, banners), consistent with local-first/no-account: there is no email/push channel, so re-engagement is surfaced when the user opens the app, keyed off real state (stalled loop, growing backlog, no backup in N days).

---

### A.7 Tone, length, skippability, accessibility

- **Tone:** dense but calm, serious, plain-spoken. Match the product voice — *"a professional knowledge workspace,"* not a cartoon learning app. No mascots, no confetti, no exclamation-heavy copy, no progress-bar gamification beyond the quiet streak chip. Every line earns its place; prefer one precise sentence over three friendly ones.
- **Length:** the guided loop is *the* tour; target **under ~3 minutes** of active time. Steps 0–1 are read-only (seconds each); Steps 2–6 are the user doing real actions; Step 7 is three controls. No step should have more than one primary action.
- **Skippability:** every step skippable individually; the whole tour skippable from Step 0 ("Explore on my own") and from the persistent rail ("Skip tour"). Skipping never disables the contextual coachmarks (A.5) — the safety net remains. Resumable via per-step flags if the user quits mid-tour.
- **Accessibility / keyboard-first (non-negotiable):**
  - The entire tour must be completable from the keyboard, because keyboard-first *is* the product. Teach `?`, `⌘K`, `g`+letter, and the per-surface keys (`Space`, `E`, `C`, `H`, `1–4`) **by having the user press them**, not just reading them.
  - Explicitly coach the `g`-prefix as a **two-key chord within ~700ms** (a documented high-severity confusion: users hold the keys together or press too slowly). Consider a visible "g armed" indicator during the window.
  - Coachmarks/modals must be focus-trapped, dismissible with `Esc`, screen-reader-labeled, and never rely on color alone (priority/scheduler/marks all carry an icon + text label, per the design invariants).
  - Honor **both light and dark themes** for every onboarding surface (dark is the `[data-theme]` attribute, not a `dark:` class) — no baked single-theme imagery.
  - Respect reduced-motion preferences; keep transitions within the token motion budget (`--fast`/`--med`).

---

### A.8 Anti-goals (what onboarding must NOT do)

- **Must not imply you have to finish sources.** No "complete," no progress-to-100%, no completionist framing anywhere.
- **Must not let the user leave thinking a highlight is the deliverable.** The Extract-vs-Highlight beat (Step 4) is mandatory and cannot be the silently-skipped step.
- **Must not overwhelm.** No tour of all 20 screens, no feature catalog, no dumping the full Settings page. Defer everything in A.5.
- **Must not feel like a cartoon learning app.** No gamification, mascots, confetti, badges-for-everything, streak pressure, or playful oversized hero art. Build from the real design primitives; color only ever means priority/status/type/scheduler.
- **Must not teach the two schedulers as abstract theory.** Anchor every scheduling explanation to a real `SchedulerChip` the user is looking at.
- **Must not make the empty states (empty `/review`, "Queue clear", empty queue) read as broken.** Every empty state the user can reach during/after onboarding must reframe emptiness as calm, not failure.
- **Must not block the user.** Everything is skippable; nothing is modal-locked; the user can always "Explore on my own."
- **Must not pretend planned features are shipped** (server-side encrypted backup/restore, Tauri shell) or imply cloud sync exists — the welcome's "local vault, your data, your backups" framing must stay honest.
- **Must not silently leave demo data behind** that pollutes the real collection or skews Analytics — label and offer to remove the sample.

## Part B — The Help Center / Documentation

The help center is the canonical home for everything the onboarding flow can only tease. It is the deep-link target from every tooltip, coachmark, empty state, and banner described in the in-app help hooks. It must be browsable on its own, searchable, and addressable by stable slug + anchor so any in-app surface can jump straight to the exact paragraph that explains the thing under the user's cursor.

This section specifies the information architecture, every article (derived from the investigation findings), a canonical keyboard reference, a concepts glossary, cross-linking and search behavior, formatting/medium guidance, and a maintenance model that keeps the docs honest against the shipped app.

### B.0 Guiding principles for the help center

- **Honesty about shipped vs planned.** Only two things are unbuilt: the server-side encrypted-backup tier (T051–T057/T098) and a Tauri shell. Everywhere else the docs describe real, shipped behavior. Planned topics are explicitly tagged **[PLANNED — not yet shipped]** so a user never expects a button that doesn't exist (e.g. in-app restore of a backup ZIP, automatic/scheduled backups, the AI managed proxy, the local AI instruction model, auto-purge of Trash after 30 days).
- **Teach concepts, not just keys.** The in-app `?` cheat sheet already lists keycaps; the help center's job is the *why* — extracts vs highlights, the two schedulers, overload-as-a-feature, lineage.
- **Built from the design primitives.** Articles render in the same visual language (IBM Plex Serif for prose, Mono for keycaps/intervals, the real `Prio`/`SchedulerChip`/`TypeIcon`/`Stage` badges as inline "art"). No invented illustration style, no marketing hero art. Light and dark must both be correct.
- **Every article has a stable slug.** Slugs are kebab-case and never change once shipped (in-app deep links depend on them). Sub-sections get stable `#anchor` ids.

### B.1 Information architecture

Top-level categories, in browse order:

1. **Getting Started**
2. **The Method (Incremental Reading)**
3. **Importing & Inbox Triage**
4. **Reading & Extracting**
5. **Cards & Review**
6. **Scheduling, Priority & Overload**
7. **Organizing & Finding**
8. **Maintenance & Safety**
9. **Data, Backup & Settings**
10. **Advanced** (Synthesis Notes, AI & Semantic Search, Browser Extension)
11. **Keyboard Reference**
12. **Concepts Glossary**
13. **Troubleshooting & FAQ**

Each category page opens with a 2–3 sentence orientation, then its ordered article list. Articles carry an audience badge: **New**, **Intermediate**, or **Advanced**.

---

### B.2 Articles by category

#### 1. Getting Started

**1.1 Welcome to Interleave: what it is and isn't** · slug `welcome` · New
- Interleave is a long-term knowledge-processing system, not a read-it-later app, not a note app, not just flashcards.
- The one-sentence pipeline: Source → Topic → Extract → Clean extract → Atomic statement → Card → Review → Mature knowledge.
- The desktop-first, local-first identity: data lives on this machine, no account, no cloud (links to `where-your-data-lives`).
- What to read next: the method primer, the daily loop, the keyboard basics.

**1.2 Your first 15 minutes** · slug `first-15-minutes` · New
- Import one good source (paste a URL or text) → triage it → open it → set a read-point → extract one passage → distill it → make one card → review it.
- Frame as a guided "golden path"; link each step to its deep article.
- Set the expectation that you are not meant to finish the source.

**1.3 The Home command center: what each number means** · slug `home-dashboard` · New
- Home (`/`) is read-only and routes you into Process/Queue/Review/Inbox; clicking a Top-due row only navigates.
- Greeting + "due today" + "est. min" (rough ~2 min/item, 8-min floor) as guidance, not debt.
- The at-risk strip (due today / overdue / protected); the BudgetMeter; streak + 30-day retention.
- Row routing by type (source→reader, extract→extract view, card→review, topic/task/synthesis→process).
- An em-dash (—) means "couldn't load," not zero.

**1.4 Start session vs Open queue vs Review: which do I click?** · slug `start-session-vs-queue-vs-review` · New
- Start session → `/process` one-at-a-time loop (mixes all due types, priority then due).
- Open queue → `/queue`, where postpone/raise/lower/done/dismiss/delete and the schedule menu actually live.
- Review → `/review`, FSRS cards only (shown only when due cards > 0); why a topic can't enter the card review session.

**1.5 The app shell: sidebar, inspector, badges, status bar** · slug `app-shell` · New
- Left nav groups (primary vs the "Organize" group); live Queue/Inbox/Review badges and that 0 hides (calm = nothing due, not broken).
- The right Inspector and the selection model; the bottom status-bar hints.
- The user/identity chip is local-only ("Local vault · offline-first"), not a login.

#### 2. The Method (Incremental Reading)

**2.1 What is incremental reading (and why Interleave is not a read-it-later app)** · slug `what-is-incremental-reading` · New
- The one-sentence method; the refinery funnel Source → Extract → Atomic statement → Card → Mature knowledge.
- The four problems it solves: weak memory from normal reading, infinite reading list, some texts too hard now, highlights aren't knowledge.
- The goal is to extract value, not finish sources; it is not a note app, not just flashcards, not Pocket.

**2.2 Extracts vs highlights: the core difference** · slug `extracts-vs-highlights` · New
- A highlight stays inside the source and only marks "this looked important once."
- An extract is lifted out into its own independently-scheduled element with full lineage; it returns to you to be refined.
- How to extract (select + `E` or toolbar) vs highlight (`H`); why you should mostly extract; extracting auto-advances your read-point.
- Where an extract goes after creation (Inspector "Extracts from this source," the queue, the LineageTree).

**2.3 The two schedulers: cards (FSRS) vs sources/extracts (attention)** · slug `two-schedulers` · New
- The two questions: "can I recall this?" vs "should I process this again, and when?"
- The brain chip (recall % + stability) vs the gauge chip (stage + postponed ×N); why they never merge.
- Why cards have grades and an attention item never appears in `/review`.

**2.4 Overload is a feature: import more than you can finish** · slug `overload-is-a-feature` · New
- You are meant to import too much; success is harvesting value (read 5%, keep one durable idea).
- Delete/postpone/deprioritize aggressively; the queue, not guilt, manages overload.
- Soft delete + Trash + `⌘Z` make pruning safe.

**2.5 Priority A/B/C/D and protecting what matters** · slug `priority-abcd` · New
- Numeric priority surfaced as A/B/C/D: A = high value (protected, returns daily) → D = background (skimmed or deleted first).
- New imports default to C so fresh material doesn't drown older high-value items.
- How priority drives return cadence and protection during overload; raise/lower anywhere with `+`/`-`.

**2.6 Lineage: every card knows where it came from** · slug `lineage` · Intermediate
- The chain card → extract → source location → source metadata → document.
- "Jump to source" and the LineageTree; lineage preserved across split/sub-extract; the graceful "Source location moved" fallback.
- Why this lets you trust and re-verify months-old cards.

**2.7 Your daily rhythm and the 70/20/10 mix** · slug `daily-rhythm-70-20-10` · Intermediate
- Reviews first, then process reading/extracts, then a little import.
- The target ~70% review / 20% extract / 10% import; the BalanceBanner nudge; healthy vs unhealthy signs.

**2.8 What to import (and what not to)** · slug `what-to-import` · New
- Good candidates: textbooks, overviews, reviews, technical explainers, your own notes.
- Weak candidates: fiction, breaking news, fast-changing product info, do-it-to-learn tutorials, material not yet understood.
- How to import (URL/text/PDF/media/file).

#### 3. Importing & Inbox Triage

**3.1 Getting material into Interleave: every way to import** · slug `import-overview` · New
- The 7 import chips; Paste text vs Manual note (both open the New source modal); Paste URL fetches+cleans+snapshots locally.
- YouTube links pasted into Paste URL import as video; Import PDF / Import media open the OS file picker (media offers an optional `.vtt`/`.srt` subtitle).
- Import file's Format selector for EPUB / Markdown / HTML / highlights / Anki; everything imports at priority C into the inbox; nothing leaves your machine.
- The "Treat body as Markdown" checkbox.

**3.2 Triage your inbox: Activate, Save for later, Delete** · slug `inbox-triage` · New
- The inbox is a decision gate, not a reading list; "Inbox zero" = every item decided, not read.
- Activate (`1`) = start active reading (item leaves inbox, enters the pipeline).
- Save for later (`3`) = set aside as dismissed, **with no schedule, reminder, or due-queue entry** — find it again in Library.
- Delete (`6`) = soft delete, undoable; where Activated items go.

**3.3 Import from the web (URL & YouTube)** · slug `import-web` · Intermediate
- Fetch + Readability + local snapshot; the canonical-URL read-back; the duplicate panel (Open existing vs Import new version); the optional Reason field.
- YouTube auto-routing to the media importer with metadata + best-effort captions.
- Failure cases: not an article, too large (8MB), timeout (15s), blocked private/loopback host, page error.

**3.4 Import books, documents, and notes (EPUB, PDF, Markdown, HTML)** · slug `import-documents` · Intermediate
- EPUB imports as chapters; PDF copies the original into the vault and extracts per-page text.
- The "No embedded text — run OCR" note on scanned PDFs and how to OCR (in the reader, not the inbox).
- Markdown/HTML import; size/page limits (PDF 200MB/2000 pages, EPUB 200MB, docs 32MB, media 2GB) and friendly errors (DRM EPUB, password-protected PDF).

**3.5 Migrating from Readwise, Kindle, and Anki** · slug `migrating-readwise-kindle-anki` · Intermediate
- Open Import file, then switch Format; Readwise CSV/JSON and Kindle "My Clippings.txt" each become inbox **extracts** (one source per book/article) with a count summary.
- Anki `.apkg` becomes cards with approximate scheduling history; the "support older Anki versions" export requirement for newer `.apkg` compression; 500MB `.apkg` limit.

#### 4. Reading & Extracting

**4.1 How the Source Reader works** · slug `source-reader` · New
- The serif reading column, progress bar, read-point divider, extracted-span markers, dimmed processed paragraphs, selection toolbar.
- That the body is an **editable** rich-text editor (no separate read/edit mode); debounced autosave; stable block ids preserved through edits.
- That the reader processes, never "reviews."

**4.2 Read-points: bookmarking where you stopped** · slug `read-points` · New
- One read-point per source; set with `Space` or the button; the "↓ unread from here" divider; resume on reopen.
- Page-granular in PDFs, timestamp/cue-granular in media; auto-advance forward-only on extract.
- The "Space only works when not typing" gotcha; "Place the caret in the text first" if it can't resolve; graceful fallback if the bookmarked block was deleted.

**4.3 Extracting a passage into its own item** · slug `extracting` · New
- Select + `E` (or toolbar Extract) creates an independent attention-scheduled extract with full lineage and its own due date.
- The source paragraph gets the extracted marker; the read-point auto-advances; where the extract appears.
- Why you don't extract everything.

**4.4 Highlights and mark-processed: lightweight reading aids** · slug `highlights-and-processed` · New
- Highlight (`H`) creates no element and no schedule; click a highlight to remove it (no confirm).
- Mark-processed dims a finished paragraph reversibly (click to restore) to declutter; Copy is clipboard-only.
- The difference between dimming, highlighting, and extracting.

**4.5 Distilling extracts into atomic statements** · slug `distilling-extracts` · Intermediate
- The stage chain raw_extract → clean_extract → atomic_statement; Trim/Save/Rewrite/Split/Sub-extract.
- Aim for a single self-contained idea; you refine across repeated returns ("delay is a filter").
- Advancing the stage also **reschedules** the extract (raw +1..7d, clean +3..14d, atomic +1d); "atomic statement" means card-ready, not a card; stage is separate from status.

**4.6 The distillation workspace (`/extract/$id`)** · slug `extract-workspace` · Intermediate
- Tour of the three columns (source context + lineage / distill editor + actions / card builder).
- Every action-bar button: Trim, Save (Rewrite), Split, Sub-extract, Convert to card, Postpone, Mark done, Delete (soft, recoverable).
- The AI distillation drafts panel (drafts only; links to the AI article).

**4.7 Sub-extracts: splitting while keeping lineage** · slug `sub-extracts` · Intermediate
- Select text inside an extract → `E` or the Split/Sub-extract buttons (same action; need a live selection).
- `parent_id` = the current extract while `source_id` stays the original source; the source location anchors into the parent extract.
- The resulting source → extract → sub-extract chain in the LineageTree.

**4.8 Reading PDFs: pages, region figures, and OCR** · slug `reading-pdfs` · Intermediate
- Page-granular read-point; selecting + extracting text; Region (`R`) mode to crop a figure/table into an image topic + the caption popover; lazy page rendering.
- Scanned pages auto-OCR one at a time; the confidence badge; Accept-into-page vs Dismiss; OCR is never auto-merged.

**4.9 Reading video & audio: transcripts, timestamp read-points, and clips** · slug `reading-media` · Intermediate
- Local vs YouTube playback; click a transcript cue to seek; set a timestamp/cue read-point.
- Cut a clip with `[` (in) and `]` (out) — or Shift-click two cues — and save it as a topic; clips loop the original media without re-encoding; resume seeks to your saved time.
- The no-transcript empty state.

**4.10 Deleting, postponing, and pruning sources safely** · slug `pruning-sources` · New
- Soft delete to Trash, recover from `/trash`, `⌘Z` undo.
- Why Postpone/Mark done/Lower priority are **disabled in the source reader action bar** (they live on the queue and the extract view) — the reader is for reading and extracting.
- That Cloze (`C`) in the source reader is a dead end ("Cloze lands in M6"); cloze authoring happens in the extract view.

#### 5. Cards & Review

**5.1 Turning an extract into a flashcard** · slug `extract-to-card` · New
- Open the Card Builder via Convert to card; the extract is not consumed/changed and lineage is preserved.
- The three tabs (Q&A, Cloze, Image occlusion) and when each applies; the Create button and where the card appears.
- A new card is a **draft** and enters FSRS review separately — it is not due the instant you create it.

**5.2 Writing good cards: the minimum information principle** · slug `good-cards` · New
- One fact per card; short prompt, atomic answer; concrete good-vs-bad examples.
- How the Quality checks map to this rule; why long answers/lists/multiple clozes get flagged.

**5.3 Understanding the Quality checks (ok / warn / block)** · slug `quality-checks` · New
- Three severities; only **block** disables Create (empty/hollow card, or a cloze with no deletion).
- The full check list: prompt-too-long (~110 chars), answer-too-long (~90), giant cloze (>40 words), multiple clozes (>1), oversized cloze blank (>6 words), ambiguous/vague pronoun, multiple facts, long list (>5), missing source, unsupported claim, time-sensitive/outdated source, long audio clip (>30s), similar-answer interference.
- They are documented heuristics that can false-positive and are advisory.

**5.4 Cloze deletion cards** · slug `cloze-cards` · New
- The `{{ }}` and numbered `{{c1::answer}}` syntax; select extract text + Cloze (`C`) to auto-wrap.
- The `[ … ]` preview and reveal; grouped same-number deletions revealed together; keep one deletion per card; multi-cloze creates siblings.

**5.5 Image occlusion cards** · slug `image-occlusion` · Intermediate
- Needs an image extract (e.g. a cropped PDF figure); the disabled tab hint otherwise.
- Drawing/labeling/deleting masks; one mask = one sibling card; the original figure is never modified.
- How an occlusion card reviews (one region hidden, reveal shows it/label).

**5.6 Formula and code cards** · slug `formula-code-cards` · Intermediate
- Inline `$…$` and block `$$…$$` LaTeX (KaTeX); fenced ` ```lang ` code (Shiki) rendering in source, extract, and review.
- The "Predict output" template; code judged in lines (~12), not characters; unsupported languages degrade to plain code; malformed LaTeX shows a parse-error span.

**5.7 Sibling cards and priority** · slug `siblings-and-priority` · Intermediate
- Cards from one extract / one diagram / one multi-cloze become siblings; siblings are not shown back-to-back.
- Setting A/B/C/D priority; it defaults to the extract's band.

**5.8 Audio review cards** · slug `audio-cards` · Advanced
- Making an audio card from a clip extract; the Prompt/Answer/Both face toggle; the clip loops the original media; the long-audio-clip (>30s) warning.

**5.9 Reviewing flashcards: the active-recall session** · slug `review-session` · New
- `/review` shows only due flashcards; the loop: `Space` to reveal, `1`–`4` to grade; what the interval preview under each button means.
- The progress bar, session clock, End session, and the "Session complete" summary; how to get there.
- Why an attention item never enters review.

**5.10 How to grade honestly (and why it matters)** · slug `grading-honestly` · New
- What each rating means in terms of recall effort; Again is not a punishment and carries no streak penalty.
- Grade inflation quietly destroys the schedule and the learning benefit; how each grade changes the next interval.

**5.11 Why some cards aren't due yet / "No cards due" explained** · slug `no-cards-due` · New
- FSRS schedules each card to return just before you'd forget; an empty deck means nothing is due, not broken.
- How cards are created from extracts/atomic statements; the daily review budget; how to start a review mode to study before due.

**5.12 Fixing or removing a bad card during review** · slug `repair-cards` · Intermediate
- The repair row: Edit (`E`) without touching the schedule; Open source (`O`); Add context drawer.
- Suspend (`S`) vs Retire vs Delete vs Flag-as-bad vs Mark-leech — what each does, which are reversible/soft; when to split a card.

**5.13 Desired retention and your daily review load** · slug `desired-retention` · Intermediate
- What desired retention is (FSRS target recall, default 90%, range 80–97%); higher = more reviews + stronger memory, lower = fewer + more forgetting.
- Where to change it (Settings → Review & scheduling); per-priority-band and per-concept overrides; interaction with the daily budget and auto-postpone.

**5.14 Leeches: handling cards you keep failing** · slug `leeches` · Intermediate
- A leech is auto-flagged at 4 lapses; the in-review leech banner and badge.
- The leech remediation view (`/maintenance/leeches`) and its actions: Rewrite (un-leeches), Split, Suspend, Delete, "Not a leech"; manual mark/unmark; flagging never deletes history.

**5.15 Targeted review modes** · slug `review-modes` · Advanced
- Modes review a chosen subset **regardless of due date**, but grading still writes a real log and advances FSRS.
- How to launch each (the "Review these" / "Audit N random cards" / "Review leeches" buttons on concepts, library/search, a lineage branch, a source, stale, leeches, home); the mode header and "Exit mode"; the deck cap ("first 500 of N"); semantic vs keyword search modes.

**5.16 Card lifetimes and verification tasks** · slug `card-lifetimes` · Advanced
- The post-reveal expiry banner ("may be out of date" / "due for review by DATE"); the one-click "Create verify task."
- That a verify task is queued against the element it protects without interrupting review.

#### 6. Scheduling, Priority & Overload

**6.1 The daily loop: queue, process session, and review** · slug `daily-loop` · New
- The pipeline; `/queue` vs `/process` vs `/review`; "Start session"; overload is normal and the goal is to extract value, not finish; the ~70/20/10 mix.

**6.2 Running a Process session (keyboard-first)** · slug `process-session` · New
- Start session; one-at-a-time; `Space` reveals on cards vs advances on others; `1`–`4` grades; `n`/`p`/`d`/`x`/`Backspace`/`o`; Skip.
- The frozen session order; the progress readout; Mode (Full / Review-only / Reading-only) **re-orders, does not filter**; the "Queue clear" done state; note that delete in the loop has no undo snackbar (the list does).

**6.3 The daily review budget and over-budget overload** · slug `review-budget` · Intermediate
- The budget is a soft cap (default 60/day, 10–300), set in Settings; the budget meter + due/overdue/protected metrics.
- When the OverloadBanner appears; it is a soft cap you can exceed and never auto-trims.

**6.4 Auto-postpone: relieving an over-budget day** · slug `auto-postpone` · Intermediate
- The victim order: low-priority topics first, then low-priority **mature** cards; high-priority fragile cards and leeches are protected.
- The preview (what moves, +Nd, remaining); confirm + `⌘Z` Undo the whole batch; the "nothing can be safely postponed" case.

**6.5 Catch-up and Vacation: recovering from backlog or time away** · slug `catch-up-vacation` · Intermediate
- Catch up spreads a backlog over N days within budget (high-value first); Vacation suspends fragile cards / shifts the rest past a return date.
- Both show the before/after load curve + what slips before Apply; both reversible via Undo.

**6.6 Fragile vs mature cards (and why some get postponed)** · slug `fragile-vs-mature` · Advanced
- Mature = review-phase + high stability (~21-day) + healthy recall; fragile = new/learning/relearning or decaying.
- Only mature low-priority cards are sacrificed; deferring a card never changes FSRS state or writes a review log.

**6.7 Postpone vs Schedule (Tomorrow/Next week/Next month/manual)** · slug `postpone-vs-schedule` · Intermediate
- Postpone is the heuristic "further out, grows with repeats"; the Schedule menu pins an exact return.
- Cards can't be explicitly scheduled (they defer on FSRS); repeated postpones recede items toward the 180-day ceiling.

**6.8 Filters, the protected accent bar, and queue ordering** · slug `queue-filters-ordering` · Intermediate
- Type and status filter chips with counts; the high-priority filter; the `--protected` accent bar on A items.
- How the score orders (priority dominates, then due urgency, retrievability, type, de-clumping siblings/concepts); the deliberate 10–20% day-to-day jitter (stable within a day, varies across days).

**6.9 Simulating workload before a big change** · slug `workload-simulator` · Advanced
- The Settings workload simulator levers (alter desired retention / add N cards / postpone low-priority).
- The before/after daily-load chart with the budget overload line; peak and over-budget-day deltas; preview commits nothing until Commit.

#### 7. Organizing & Finding

**7.1 Finding things: Search vs Library** · slug `search-vs-library` · New
- `/search` = Collection Explorer Search mode: keyword FTS5 over source title+body, extract body, card prompt+answer, tag names; empty query shows a prompt/pending filters, not rows; only sources/extracts/cards.
- `/library` = Collection Explorer Browse mode: browse ALL live elements by Type/Concept/Priority/Status facets, no keyword, covers topics/synthesis notes/tasks too.
- The "Filter visible titles" box in Library is client-side, not a search; when to use which; how to reach each (`/`, `g l`, `⌘K`).

**7.2 Using keyword search** · slug `keyword-search` · New
- What gets indexed and what doesn't (topics/synthesis notes/tasks are not searchable).
- Ranking (title/prompt matches outrank body-only; tags get a light boost; grouped by type, highlighted); the 150ms debounce; filtering results while a query is active; "Review N matching cards"; why an empty query shows nothing.

**7.3 Browsing your whole collection (Library)** · slug `library-browse` · New
- Library lists everything by default; the four facets combine; drill-down chip counts (contextual, not totals).
- The optional title filter; the six browsable types and their open targets; the disabled Maintenance facets.

**7.4 Concepts vs tags: how to organize** · slug `concepts-vs-tags` · New
- Concepts are hierarchical (parent/child), a facet + map node, can carry a review target — the primary organizer.
- Tags are flat labels that only help via keyword search (there is **no tag filter facet anywhere**); both are created/assigned from the Inspector; extracts can inherit a source's tags.

**7.5 Creating and assigning concepts** · slug `creating-concepts` · New
- Creation/assignment happens **in the Inspector**, not on the Concepts/Library screens.
- Step-by-step: select an element → Concepts section → "Assign concept…" or "New concept…" (name + optional parent); building hierarchy; removing a concept; a fresh DB starts with no concepts.

**7.6 The concept knowledge map** · slug `concept-map` · Intermediate
- Nodes = concepts sized by member count; edges = parent→child; **read-only / auto-laid-out** (no dragging or saved layout).
- Click a node to filter (Search/Library) or explore members (`/concepts`); the member drill-in panel; the "Concepts by volume" rail; the shared Map tab.

**7.7 Per-concept review targets (desired retention)** · slug `concept-retention` · Advanced
- FSRS desired retention in plain terms; the 80–97% range; "Inherit" uses the default; the strictest concept among a card's concepts wins.
- How to set/reset on `/concepts`; the "Review N cards in this concept" button.

**7.8 How facet counts work (drill-down)** · slug `facet-counts` · Intermediate
- A chip's number is what you'd see given your other active filters, not a global total; counts update as you change filters; `/search` empty-query facet selections are pending constraints until the user types.

#### 8. Maintenance & Safety

**8.1 Nothing is lost: delete, Trash, and Undo** · slug `nothing-is-lost` · New
- Delete is a soft delete (status `deleted`, `deleted_at`) → Trash (`/trash`), described as recoverable for 30 days; Restore returns an item.
- Global `⌘Z` undoes the last action anywhere; per-action Undo snackbars; every meaningful change is logged.
- **The only two truly permanent actions:** Trash "Delete forever"/"Empty trash" and Maintenance "Reclaim orphan media."

**8.2 Using Trash: restore, purge, and empty** · slug `using-trash` · New
- What lands in Trash and how rows are labeled; Restore (itself undoable); per-item "Delete forever" and "Empty trash" confirmations.
- The 30-day note and the reality that **auto-purge on expiry is not yet implemented [PLANNED]** — items persist until manually purged; purge frees disk and removes assets.

**8.3 The Maintenance hub: keeping a large collection healthy** · slug `maintenance-hub` · Intermediate
- Reports are read-only; nothing changes without a confirm. Each report: Duplicates (a canonical "keep:" copy is preserved), Orphan media (byte reclaim), Broken sources, Cards without sources (lineage gaps), Low-value stale candidates.
- Which cleanups are undoable (dedupe, bulk trash/postpone/dismiss/retire) vs the one irreversible vault GC; the on-demand DB+vault integrity check never auto-runs.

**8.4 Fixing leeches: cards you keep getting wrong** · slug `fixing-leeches` · Intermediate
- (May share content with 5.14 / cross-link rather than duplicate.) The ≥4 lapses threshold; each remedy (Rewrite clears the flag, Split into two atomic cards with the original to Trash, Add context, Open source, Back to extract, lower priority, Suspend, "Not a leech," Delete); no remedy destroys review history; why Split (minimum-information principle).

**8.5 Stagnant extracts vs leeches: two kinds of "stuck"** · slug `stagnant-vs-leech` · Intermediate
- Leech = a failing **card** (recall); stagnant = an **extract** that keeps returning without progressing (attention/processing).
- The fired reasons (postponed repeatedly, no progress, no children, stale); the four remedies (Rewrite, Convert, Postpone, Delete); why the two schedulers are separate.

**8.6 Retiring cards: parking knowledge without losing it** · slug `retiring-cards` · Intermediate
- Retire = a low-value mature card leaves active review but keeps lineage and history; how it differs from Suspend (temporary pause) and Delete (to Trash).
- Where to retire (review repair bar, inspector) and un-retire (inspector, `/maintenance/retired`); un-retire returns the card to the due queue at its existing due date; fully reversible.

**8.7 Reading the integrity check** · slug `integrity-check` · Advanced
- What it runs (SQLite `integrity_check`/`foreign_key_check`, vault file scan); OK vs Issues and the counts (FK violations, missing/mismatched/extra vault files).
- It never auto-runs and changes nothing; next steps on Issues (re-run, restore from a backup, contact support).

**8.8 Pruning an overloaded library safely** · slug `pruning-library` · Intermediate
- Overload is expected; the triage tools (bulk low-value postpone/dismiss/trash, deprioritize, delete duplicates, postpone/drop stagnant extracts, retire low-value mature cards).
- Everything is reversible except the two named permanent actions; how priority protects high-value items.

#### 9. Data, Backup & Settings

**9.1 Where your Interleave data lives (local-first, no cloud)** · slug `where-your-data-lives` · New
- No account or cloud copy; all data is on this device. The folder layout: `app.sqlite`, `assets/`, `exports/`, `backups/`; macOS path `~/Library/Application Support/Interleave/`.
- Why settings are "desktop only" in a browser; **you** are responsible for backups because nothing is uploaded automatically.

**9.2 Backing up your vault** · slug `backing-up` · New
- A backup is a ZIP = consistent SQLite snapshot (VACUUM INTO) + the whole asset vault + a hashed `manifest.json`; it captures lineage/schedule/history — **not** just your notes.
- The five triggers (Settings "Back up now," the reminder banner, `⌘B`, `⌘K` "Create a backup," File → "Back up…") — all the same command; the success chip (size · file count · schema version); where the ZIP lands (`backups/<timestamp>.zip`); the Settings "Open backups folder" action for copying ZIPs off-device; the 7-day reminder.
- Honest notes: **restoring a backup back into the app, and automatic/scheduled backups, are [PLANNED — not yet shipped]**; manual periodic backups are current best practice; copy backups off-device yourself.

**9.3 Backup vs Export — which do I need?** · slug `backup-vs-export` · New
- Backup = full recoverable safety copy of everything (with the caveat in-app restore isn't shipped).
- Export = getting specific content out: "Export to Markdown" (source/topic/extract/synthesis) and "Export to Anki" .apkg/CSV (cards, carrying source references out).
- Where each lands (`backups/` vs `exports/`); why exports are not a backup (they omit sources, schedules, lineage, assets).

**9.4 Exporting to Anki and Markdown** · slug `exporting` · Intermediate
- Where the actions live (right Inspector); Markdown element types; Anki scope (this card / a concept / all), .apkg vs CSV, source carried as a Source field + tag; files go to `exports/` and the result shows a relative path + card count.

**9.5 Review & scheduling settings explained** · slug `review-scheduling-settings` · New
- Daily review budget (soft cap, overflow auto-postpones by priority); desired retention (links to `desired-retention`); default topic interval (3/7/14/30d) and how it differs from card retention; default source priority; bury siblings; import/process balance warnings.
- Changes save instantly (no Save button; the green "Saved" chip) and persist across restart.

**9.6 Protecting high-value memory with per-priority retention** · slug `per-priority-retention` · Intermediate
- What the A/B/C/D bands mean; enabling per-priority retention overrides the global target per band; "inherits global" vs an override; the Reset link; the load trade-off; protect A, sacrifice D first.

**9.7 Interface settings: theme, display name, keyboard layout** · slug `interface-settings` · New
- Light/dark theme (applied instantly, persisted); display name (sidebar only, local to the vault, no account).
- The keyboard-layout selector (QWERTY/Dvorak/Vim) and the honest note that it **does not yet remap shortcuts** [PARTIAL — bindings are currently fixed]; link to the keyboard reference.

**9.8 Undo, redo, and not losing your work** · slug `undo-redo` · New
- `⌘Z` is command-level undo across the app (delete/triage/grade), works outside text fields; inside a field `⌘Z` is the editor's text undo.
- There is currently **no redo** (`⌘Shift+Z` is unbound) [not shipped]; soft-deletes go to Trash.

**9.9 Light & dark theme and how theming works** · slug `theming` · Advanced
- Tokens in `design/tokens.css` are the source of truth; the Tailwind theme is derived; dark mode is the `[data-theme]` attribute (not a `dark:` class); keeping help imagery theme-correct (provide both captures).

**9.10 Encrypted server backup & sync** · slug `server-backup-sync` · Advanced · **[PLANNED — not yet shipped]**
- What is planned (T051–T057/T098): a thin encrypted-backup server, client-side end-to-end encryption, restore onto a fresh install, automatic/scheduled backups with retention, recovery keys.
- Explicit statement that it is NOT shipped, there is no live multi-device sync, and the server (when it arrives) only ever holds ciphertext. Until then, use manual local backups and copy them off-device.

#### 10. Advanced

##### 10a. Synthesis Notes (incremental writing)

**10.1 What is a synthesis note? (Incremental writing)** · slug `synthesis-notes-intro` · Intermediate
- The writing counterpart to incremental reading; your own prose woven from many sources over repeated passes.
- The three parts (writing canvas, linked-material panel, schedule-return); it is a first-class element (Library, inspector, due queue, lineage); advanced/optional within the loop.
- It is scheduled on the **attention scheduler, never reviewed as a flashcard**.

**10.2 Create and write a synthesis note** · slug `synthesis-create` · New
- Open the command palette → "New synthesis note…" (no left-nav button); the title field; write in the center canvas; autosave (the "saving…" indicator), no manual Save.
- Find it again in Library → Synthesis notes; desktop-only (Electron).

**10.3 Collect extracts and cards into a note** · slug `synthesis-collect` · Intermediate
- "Add to note" → filter and pick; **only extracts and cards** can be collected (not sources/topics/tasks).
- Linked material is **referenced, not pasted** — your body stays your own writing; each item is jump-to-able (extracts open their view; cards select into the inspector).
- Removing a link deletes nothing and never breaks source lineage; current limitation: you collect from inside the note (no "add to note" button on the extract/card yet).

**10.4 Scheduling a synthesis note to return** · slug `synthesis-schedule` · Intermediate
- A new note is **not** scheduled until you act ("not scheduled to return"); Tomorrow / Next week / Next month / manual date.
- It returns in the daily queue, processed in `/process` — not the flashcard Review session; priority affects how it competes.

##### 10b. AI & Semantic Search

**10.5 AI assistance: draft cards, never schedule them** · slug `ai-assistance` · New · **[PARTIAL]**
- The seven actions (Explain / Simplify / Suggest Q&A / Suggest cloze / Detect ambiguity / Prerequisites / Summarize); where they live (extract distillation view); off by default.
- The drafts-only rule; "Approve" mints a **parked, un-due** card draft you must still activate; Dismiss soft-dismisses; card-quality warnings on drafts; only Suggest Q&A / Suggest cloze produce approvable card drafts.

**10.6 Setting up AI: providers and your own API key** · slug `ai-setup` · New · **[PARTIAL]**
- Enable in Settings → AI assistance; provider picker; the **Local provider is experimental and currently unavailable** [stub], so use Anthropic or OpenAI with your own key.
- The write-only key field (shows "configured," never echoes the key); fixed models (claude-3-5-haiku / gpt-4o-mini); changing the key restarts the background worker when idle.

**10.7 Your data and AI: the local-first trust model** · slug `ai-trust-model` · New
- Local-first by default; your text and keys never leave the device except the direct call to your own provider; keys stored only in this vault's settings and never returned/logged.
- The managed proxy is off by default, discloses content is sent off-device, and is **[PLANNED — not yet available]**; embeddings stay on-device.

**10.8 On-device semantic search** · slug `semantic-search` · Intermediate · **[PARTIAL]**
- Conceptual matches with no shared keywords; off by default; one-time ~23 MB model download; "Build index (N of M embedded)" to embed existing material.
- The honest mode hints in `/search` (semantic vs keyword-only vs disabled); "related" badges; the semantic review mode; bring-your-own embedding key; why some machines show "semantic unavailable" (sqlite-vec not available on the host).

**10.9 Related items, possible duplicates, and possible conflicts** · slug `related-duplicates-conflicts` · Intermediate
- Derived, read-only, **heuristic** suggestions, not facts; what each bucket means (similar extracts, possible duplicates, prerequisite concepts, sibling sources).
- Conflict signals (opposing wording / differing numbers / newer source); they never edit/reschedule cards; dismissals are session-only and re-derive after restart; in review they appear only after reveal; a missing flag ≠ "no conflict."

**10.10 How AI suggestions stay grounded to your sources** · slug `ai-grounding` · Advanced
- Every suggestion stores which source span produced it; model text and source quote are kept separate; the grounding RefBlock + jump-to-source; approved cards inherit a real source location + derived-from lineage; the orphaned-source "source unavailable" fallback.

##### 10c. Browser Extension & Web Capture

**10.11 Install the Interleave browser extension** · slug `extension-install` · New
- Chrome/Chromium only; **no Web Store listing** — build it (`pnpm --filter @interleave/extension build`) and "Load unpacked" from `apps/extension/dist` with Developer mode on; `pnpm dev` does not build it.
- What the toolbar icon looks like; updating it (rebuild + reload).

**10.12 Pair the extension with the desktop app** · slug `extension-pairing` · New
- The full handshake: Settings → Browser capture → toggle Capture server ON → Copy token → extension Options → paste → Save & test connection → "Paired ✓."
- The port field (leave as-is); capture is OFF until paired; the app must be running; the "Paired with chrome-extension://<id>" confirmation; pairing is fully local (127.0.0.1) and offline.

**10.13 Capture pages and selections** · slug `extension-capture` · New
- Save page vs Save selection; the side panel for priority (A/B/C/D, default C) + reason; default priority C and why.
- Whole-page dedup vs selections always creating new items; the "why added"/Context anchor; captures land in the Inbox at priority C and need triage; reading the ✓/!/✕ badge; the Recent captures list.

**10.14 Troubleshooting capture (it's not saving)** · slug `extension-troubleshooting` · Intermediate
- "App not running / capture disabled," "Not paired," "Bad token" (often after Regenerate), "App not reachable" (wrong port / server not running / 47615 taken, fallback +1…).
- "Could not read this page" / "No text selected" on chrome://, the Web Store, PDFs, restricted pages; selection must be pulled with "Use current selection"; shortcuts not firing → bind at `chrome://extensions/shortcuts`; restart caveat.

**10.15 How browser capture works and stays private** · slug `extension-privacy` · Intermediate
- The 127.0.0.1 loopback server inside Electron main; per-install token + constant-time check; exact-origin CORS locked to your extension; bound to loopback only.
- Off until paired; no cloud, no SQLite/filesystem access from the extension; the token lives in your data dir and is included in backups; the same import pipeline as "Import from URL."

**10.16 Manage and re-pair: tokens, regenerate, and unpairing** · slug `extension-tokens` · Advanced
- Regenerate token unpairs the current extension; toggling capture off stops the server (frees the port) but keeps the stored origin; what "Paired with" means; pairing a different browser; what survives restart; load-unpacked ids change if you remove/re-add the folder (requires re-pairing).

---

### B.3 Keyboard Reference (its own article)

**Keyboard reference** · slug `keyboard-reference` · New. This is the canonical, exhaustive shortcut article. It is generated from the same `shortcuts.ts` registry that drives the in-app `?` cheat sheet and `⌘K` palette (see B.8), grouped by scope. It must explain the two cross-cutting rules: **shortcuts are scoped** (the same key means different things on different screens; exactly one handler fires per keystroke), and **element shortcuts act on the currently selected element** (no-op with nothing selected).

**Global**

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Open/close the command palette (filters command labels, not your content) |
| `?` | Open/close the keyboard cheat sheet |
| `/` | Open Search (`/search`) |
| `⌘Z` / `Ctrl+Z` | Command-level undo of the last action (outside text fields; no redo) |
| `⌘B` / `Ctrl+B` | Create a backup now |
| `⌘/` (native Help menu) | Help → Keyboard shortcuts (opens the cheat sheet) |

**Navigation (g + letter, sequential chord, ~700ms window)**

| Keys | Action |
|---|---|
| `g h` | Home |
| `g q` | Daily Queue |
| `g i` | Inbox |
| `g r` | Review (also "Start review") |
| `g l` | Library |
| `g c` | Concepts |
| `g a` | Analytics |
| `g s` | Settings |

**Selected-element actions (Inspector / lists)**

| Keys | Action |
|---|---|
| `o` / `Enter` | Open source (jump-to-source) / open in full |
| `u` | Open parent |
| `+` / `=` | Raise priority one band |
| `-` / `_` | Lower priority one band |

**Reader (and extract body)**

| Keys | Action |
|---|---|
| `Space` | Set read-point at the caret (ignored while typing) |
| `E` | Extract the selection (sub-extract inside an extract) |
| `C` | Cloze the selection (opens the card builder in the extract view; a dead-end "lands in M6" in the source reader) |
| `H` | Highlight the selection (source reader) |
| `R` | Toggle PDF Region (figure-crop) mode |
| `[` / `]` | Set media clip in-point / out-point |
| Shift-click cue | Set a media clip in/out from a transcript cue |
| `Esc` | Cancel the selection toolbar / pending PDF crop |

**Review**

| Keys | Action |
|---|---|
| `Space` | Reveal the answer |
| `1` / `2` / `3` / `4` | Grade Again / Hard / Good / Easy |
| `E` | Edit the card (no schedule change) |
| `O` | Open source |
| `S` | Suspend the card |

**Process loop**

| Keys | Action |
|---|---|
| `n` / `→` | Next / skip |
| `Space` | Reveal (on a card) / advance (on anything else) |
| `1`–`4` | Grade a revealed card |
| `p` | Postpone |
| `d` | Mark done |
| `x` | Dismiss |
| `Backspace` / `Delete` | Delete (soft, recoverable; no undo snackbar in the loop) |
| `o` / `Enter` | Open in full |

**Inbox triage**

| Keys | Action |
|---|---|
| `1` | Activate |
| `3` | Save for later |
| `6` | Delete (soft) |
| `⌘↵` / `Ctrl+Enter` | Submit/import in a modal |
| `Esc` | Close a modal |

**Browser extension (in Chrome; may need manual binding at `chrome://extensions/shortcuts`)**

| Keys | Action |
|---|---|
| `⌘Shift+S` / `Ctrl+Shift+S` | Save the whole page to Interleave |
| `⌘Shift+E` / `Ctrl+Shift+E` | Save the current selection |
| (unbound by default) | Open the Interleave capture side panel |

Honest notes to include in this article: the **g-prefix is a sequential two-key chord with a ~700ms window** (not a held combo, and it expires); the **Keyboard-layout setting (QWERTY/Dvorak/Vim) does not currently remap these bindings** [PARTIAL]; there is **no redo**.

---

### B.4 Concepts Glossary

**Concepts glossary** · slug `glossary` · New. A single alphabetical reference page; every term links to its primary article. Each entry is one or two plain sentences plus "why it matters."

- **Element** — the universal primitive; every source, topic, extract, card, task, concept, media fragment, and synthesis note is an element or belongs to one. → `welcome`
- **Source** — an imported text/PDF/media you read incrementally; the root of a lineage chain. → `source-reader`
- **Topic** — a scheduled unit of reading/processing on the attention scheduler (e.g. a media clip or chapter); answers "process this again, when?" → `two-schedulers`
- **Extract** — a passage lifted out of a source into its own independently-scheduled element with full lineage; **not** a highlight. → `extracts-vs-highlights`
- **Sub-extract** — an extract made from inside another extract; `parent_id` is the parent extract, `source_id` stays the original source. → `sub-extracts`
- **Highlight** — an in-document annotation only; no element, no schedule, no lineage; click to remove. → `highlights-and-processed`
- **Clean extract** — the second distillation stage: a tidied extract with the fluff trimmed. → `distilling-extracts`
- **Atomic statement** — the distillation stage meaning "one self-contained idea, card-ready" (not yet a card). → `distilling-extracts`
- **Card** — a flashcard scheduled by FSRS; created from an extract and inheriting its lineage; starts as a draft. → `extract-to-card`
- **Cloze** — a card type where you wrap the answer in `{{ }}` (or numbered `{{c1::…}}`) so it shows as a fill-in blank. → `cloze-cards`
- **Image occlusion** — a card type where each mask drawn over an image figure becomes its own sibling card. → `image-occlusion`
- **Read-point** — the single resume bookmark per source (set with `Space`); auto-advances forward when you extract. → `read-points`
- **Lineage** — the actionable chain card → extract → source location → source → document; "Jump to source" follows it. → `lineage`
- **FSRS** — the spaced-repetition algorithm that schedules **cards** by self-graded recall ("can I recall this?"); the brain chip. → `two-schedulers`
- **Attention scheduler** — the separate scheduler for sources/topics/extracts/tasks/synthesis notes ("process again, when?"); the gauge chip. → `two-schedulers`
- **SchedulerChip** — the badge that tells which scheduler an item is on (brain + recall % vs gauge + stage/postponed). → `two-schedulers`
- **Priority A/B/C/D** — first-class value bands; A = protected/returns daily, D = background/sacrificed first; new imports default to C. → `priority-abcd`
- **Stage** — where an item sits in the pipeline (raw_extract → clean_extract → atomic_statement → card_draft → active_card → mature_card → synthesis); separate from status. → `distilling-extracts`
- **Status** — lifecycle state (inbox, pending, active, scheduled, done, dismissed, suspended, deleted). → `inbox-triage`
- **Mature card** — a card whose FSRS stability has passed ~21 days (durable memory); only mature low-priority cards are sacrificed under overload. → `fragile-vs-mature`
- **Fragile card** — a new/learning/relearning or decaying card; protected during overload. → `fragile-vs-mature`
- **Leech** — a card auto-flagged at 4+ lapses (you keep failing it); routed to the leech remediation view. → `leeches`
- **Stagnant extract** — an extract that keeps returning without progressing (postponed repeatedly, stage never advanced, no children). → `stagnant-vs-leech`
- **Retire** — parking a low-value mature card out of active review while keeping its history; reversible; distinct from Suspend and Delete. → `retiring-cards`
- **Suspend** — temporarily removing a card from the deck without a grade; recoverable. → `repair-cards`
- **Soft delete** — moving an item to Trash (`deleted`/`deleted_at`), recoverable via Restore or `⌘Z`; not destruction. → `nothing-is-lost`
- **Synthesis note** — your own long-lived writing (incremental writing) woven from referenced extracts/cards; scheduled on attention, never reviewed. → `synthesis-notes-intro`
- **Concept** — a hierarchical, filterable, mappable organizing bucket that can carry a review target. → `concepts-vs-tags`
- **Tag** — a flat label, matchable by keyword search only (no filter facet). → `concepts-vs-tags`
- **Daily review budget** — a soft cap (default 60/day) that turns on the overload tools; not a hard limit. → `review-budget`
- **Desired retention** — the FSRS target recall probability (default 90%) that tunes how often cards return. → `desired-retention`
- **Operation log** — the append-only record of every meaningful mutation, the basis of undo, audit, and incremental backup. → `undo-redo`
- **Asset vault** — the filesystem store for large files (PDFs, snapshots, images, media); SQLite keeps only metadata/paths/hashes. → `where-your-data-lives`
- **Local vault** — your single on-device database + asset vault; the "you" in the user chip is its owner (no account). → `where-your-data-lives`

---

### B.5 Cross-linking strategy

- **Hub-and-spoke from the four pillar articles.** `what-is-incremental-reading`, `extracts-vs-highlights`, `two-schedulers`, and `overload-is-a-feature` are the conceptual hubs; nearly every feature article links back to whichever pillar grounds it (e.g. `review-budget` and `auto-postpone` both link `overload-is-a-feature`; every scheduler-bearing article links `two-schedulers`).
- **"Related articles" footer** on every page: 3–5 hand-curated links (not auto-generated), e.g. `extracting` → `read-points`, `distilling-extracts`, `extract-to-card`.
- **Inline term links** — the first occurrence of a glossary term in any article links to the glossary anchor (`glossary#extract`). Keep these sparse (first mention only) to avoid a sea of blue.
- **Avoid duplication; prefer canonical + cross-link.** Where two areas describe the same thing (leeches appear in both Cards & Review and Maintenance; the two-scheduler split appears everywhere), one article is canonical and the others link to it with a one-line summary. Canonical homes: leeches → `leeches`; stagnant → `stagnant-vs-leech`; two schedulers → `two-schedulers`; overload → `overload-is-a-feature`; backup-vs-export → `backup-vs-export`.
- **"Next in this flow" links** for sequential learning: `first-15-minutes` chains the golden path; `extracting` → `distilling-extracts` → `extract-to-card` → `review-session` forms the pipeline walk.

### B.6 Search, "Was this helpful?", and feedback

- **Search-first help home.** The help center opens on a search box plus the category grid. Search indexes article titles, slugs, section headings, body text, and glossary terms. Because the user already knows the in-app `⌘K` palette filters *commands* (not content), the help search must clearly be a *content* search of the docs; label it "Search the help center."
- **Synonym/alias map** so users find articles by the words they actually use: "highlight not working" → `extracts-vs-highlights`; "import Readwise" → `migrating-readwise-kindle-anki`; "too many cards" → `desired-retention` + `review-budget`; "restore backup" → `backing-up` (with the [PLANNED] caveat surfaced); "g key not working" → `keyboard-reference`.
- **"Was this helpful? 👍 / 👎"** at the foot of every article. A 👎 reveals an optional free-text box ("What were you trying to do?"). Submissions are stored locally and surfaced to the docs maintainer (this is a local-first app; do not phone home — keep feedback on-device and optionally include it in a diagnostics export). Track per-slug helpfulness to prioritize doc rewrites.
- **"Open the relevant screen"** action where applicable: an article about the Queue offers a button that routes to `/queue`; an article about Settings routes to the exact `#anchor` (e.g. `/settings#browser-capture`). This makes the help center bidirectional with the app.

### B.7 How articles map to in-app deep links

Every in-app help hook in the findings resolves to `help://<slug>` or `help://<slug>#<anchor>`. Examples (one per surface family):

- Reader selection toolbar Extract/Highlight tooltips → `help://extracts-vs-highlights`.
- Any `SchedulerChip` coachmark → `help://two-schedulers`.
- `'Set read-point'` button / the unread divider → `help://read-points`.
- Extract stage stepper / "Advance stage" → `help://distilling-extracts`.
- Inbox A/B/C/D chip group → `help://priority-abcd`.
- Queue OverloadBanner / BudgetMeter → `help://overload-is-a-feature` and `help://review-budget`.
- BalanceBanner → `help://daily-rhythm-70-20-10`.
- Card builder Cloze empty state → `help://cloze-cards`; Quality checks `?` → `help://quality-checks`.
- Review leech banner → `help://leeches`; repair row `?` → `help://repair-cards`.
- Trash "deleted items are recoverable for 30 days" → `help://using-trash`; first destructive action → `help://nothing-is-lost`.
- Settings → Data & backup `?` → `help://backing-up`; the export sections → `help://backup-vs-export`.
- Settings → Browser capture / Inbox "Browser capture" tile → `help://extension-pairing` (+ `extension-install`).
- AiAssist disabled state / Local-provider hint → `help://ai-assistance` + `help://ai-setup`.
- Synthesis schedule-return hint → `help://synthesis-schedule`.

Authoring rule: in-app code references the **slug**, never an article title or position, so titles can be edited without breaking links. Slugs are frozen at publish; renaming requires a redirect entry in a `help-redirects` map.

### B.8 Format & medium recommendations

- **Default to concise text** with the real in-app badges inline (`Prio` A–D, `SchedulerChip` brain/gauge, `TypeIcon`, `Stage` dots) so the docs visually match the app. Keycaps render in the Mono `.kbd` style; prose in Serif.
- **Short, silent, looping GIFs/MP4s (≤10s)** for motion-dependent, hard-to-discover interactions where a screenshot can't convey the gesture:
  - Extracting (select → `E` → extract appears in the Inspector list, read-point auto-advances) — `extracting`.
  - Setting a read-point and resuming (`read-points`).
  - `g`-prefix navigation showing the two-key chord and timing (`keyboard-reference`).
  - Auto-postpone preview → confirm → `⌘Z` undo (`auto-postpone`).
  - Drawing image-occlusion masks → "Generate N cards" (`image-occlusion`).
  - PDF Region crop (`reading-pdfs`); media clip with `[`/`]` (`reading-media`).
  - The extension pairing handshake (`extension-pairing`).
- **Provide every screenshot/GIF in both light and dark** (theming is first-class; mismatched captures look wrong). Store paired assets and let the help renderer pick by `[data-theme]`.
- **Diagrams** (clean, token-styled, not marketing art) for the genuinely structural ideas:
  - The refinery funnel Source → Extract → Atomic statement → Card → Mature knowledge (`what-is-incremental-reading`).
  - The two-scheduler split as two side-by-side chips (`two-schedulers`).
  - A LineageTree example source → extract → sub-extract → card (`lineage`).
  - The distillation stage chain with dot colors (`distilling-extracts`).
  - The reversible-vs-permanent action map (the two irreversible gates highlighted) (`nothing-is-lost`).
  - Backup vs Export (what each ZIP/file contains) (`backup-vs-export`).
- **Step lists with numbered callouts** for the multi-step setup flows: `extension-install` → `extension-pairing`, `backing-up`, `creating-concepts`.
- **No video voiceover, no long tutorials.** Keep with the "dense, calm, keyboard-first, no gamification" tone.

### B.9 Keeping the docs in sync with the app

- **Single source of truth for shortcuts.** The `?` cheat sheet and `⌘K` palette are already generated from one `shortcuts.ts` registry. The **`keyboard-reference` article and every inline keycap in the docs must be generated from that same registry** at build time, so a binding change updates the docs automatically and the docs can never drift from real handlers. (This is also why the keyboard layout caveat is load-bearing: the registry is the truth, and it currently ignores the layout setting.)
- **Slug ↔ deep-link contract test.** A CI check asserts that every `help://<slug>` referenced in app code resolves to a published article (and every `#anchor` exists). Removing or renaming an article without a `help-redirects` entry fails the build.
- **Shipped/planned tags are data, not prose.** Each article carries a `status` field (`shipped` / `partial` / `planned`) mirroring the investigation. A CI check flags any `planned`/`partial` article whose corresponding feature has shipped (so the caveat gets removed) — e.g. when in-app backup restore (T055), auto-purge, the AI managed proxy, the local AI model, or the server tier land, their articles must be reviewed.
- **Doc-debt anchors for known gaps.** Where the app behavior is a known rough edge (the keyboard-layout no-op, Trash auto-purge not implemented, no redo, the AI Local provider stub, no "reveal in Finder" for exports), the article states it plainly and links the relevant troubleshooting entry, so support answers stay consistent and the gap is visible to the PM.
- **"Last verified against build X" stamp** on each article, bumped when an author re-checks it against the current app; the `Was this helpful?` 👎 stream and the stamp together drive the rewrite queue.
- **Glossary is generated from the canonical term list** used in onboarding and tooltips, so a term's plain-language definition is written once and reused in the welcome modal, coachmarks, and the glossary page.

## Part C — In-App Contextual Help Map (the deep-link surface)

This section specifies *exactly* where contextual help appears in the shipped app, what it says, and which help article (or anchor) it deep-links into. It is the concrete realization of "help linked to throughout the app." The design agent should treat every row below as a placement spec, and the engineering agent should treat each as a wiring task (component + trigger + target).

Two ground rules carry through the whole map (from the design-system findings):

- **Build help from existing primitives.** There is currently **no help-center component, no in-app "Learn more" links, and no contextual help-link pattern** in the shell — only the first-run `Onboarding.tsx` modal, the `?` `CheatSheet.tsx`, and the `Tooltip.tsx` primitive (used today only on the queue action cluster and the schedule menu). Everything in this map must be built from the token-faithful primitives in §C.4, not invented per surface.
- **Respect the power user.** This is a dense, keyboard-first pro tool with "no gamification, no cartoon learning-app aesthetic." Contextual help must be dismissible, remembered, and quiet (see §C.5). Coachmarks fire once; tooltips are on-demand; banners are advisory, never modal-blocking.

---

### C.1 The contextual help hook map, by screen / route

Legend for **Type**: `tooltip` (hover/focus bubble on an icon/control) · `help-link` (a persistent "?" or "Learn more" affordance) · `coachmark` (one-time anchored callout) · `first-run-callout` (one-time, larger, on first visit to a surface) · `inline-hint` (always-present small helper text) · `empty-state` (teaching copy in a zero-data panel, detailed in §C.2).

Targets are help-article titles from Parts A/B; where an article has internal sections, an `#anchor` is suggested.

#### Global shell (every route) — `Shell.tsx`

| Location (component) | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| Top command bar button ("Search, import, or run command…") | hover | tooltip | "⌘K to open · type to filter commands · this searches commands, not your content (use / for content search)." | The command palette, in depth |
| Command palette footer row | palette open | help-link | "Keyboard shortcuts (?) · Learn the palette" | Getting around Interleave |
| Status bar "G then a key to navigate" hint | hover | tooltip | "Press g, then a letter within a moment: q Queue, r Review, i Inbox, l Library… (g h Home)." | Getting around Interleave |
| Status bar / command bar (⌘K, /, ? keycaps) | always | inline-hint | Real `.kbd` keycaps for ⌘K / g-nav / ? | Keyboard-first: the shortcuts that run the loop |
| Sidebar nav badges (Queue / Inbox / Review) | hover | tooltip | "Live count of what's due/waiting now. Empty = nothing due." | The shell: sidebar, inspector, badges, and status bar |
| User / identity chip menu | menu open | help-link | New "Help & docs" entry beneath "Keyboard shortcuts" — opens the help center | (help center root) |
| Any SchedulerChip (queue rows, reader/extract/review headers, inspector) | first encounter | coachmark | "Two schedulers: brain = can you recall this (cards); gauge = when to read this again (sources/extracts)." | The two schedulers: cards (FSRS) vs sources/extracts (attention) |
| Any Stage badge | hover | tooltip | Names the stage (e.g. "Atomic statement — card-ready") | The distillation stages |
| First destructive action anywhere (delete/dismiss) | first occurrence | coachmark | "Sent to Trash — recoverable for 30 days. Press ⌘Z to undo." | Nothing is lost: delete, Trash, and Undo |
| Global undo snackbar (`shell-undo-snackbar`) | first appearance | inline-hint | "Undid '<action>'. What is undo?" | Undo, redo, and not losing your work |
| Backup reminder banner (`BackupPrompt`) | when overdue | help-link | "Why backups?" beside "Create a backup now" | Backups and keeping your local vault safe |
| Right inspector header | always | help-link | (i) glyph by the panel title | Reading the two scheduler chips · Element types and their icons |
| Inspector when no selection | empty | empty-state | "New here? See how the inspector works" | The Interleave visual language at a glance |
| When o/u/+/- or a context palette Action fires with **no selection** | on attempt | inline-hint | "Select an item first — these actions apply to the selected element (shown in the Inspector)." | The shell: sidebar, inspector, badges |

#### Home command center — `/`

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| Page head / subtitle (`home-subtitle`) | first visit | first-run-callout | "This is your command center — it shows your day and points you to the next action. The real work happens when you Start a session." | Your Home command center: what each number means |
| "Start session" (`home-start-session`) | first visit | coachmark | "Start session processes your due items one at a time, sorted by priority then due date." | Start session vs Open queue vs Review |
| BudgetMeter "N over budget" (`budget-meter` / `budget-over`) | when over | tooltip | "Being over budget is normal — postpone or deprioritize freely. This meter never trims for you." | Reading the BudgetMeter |
| Overdue metric (`home-overdue-count`) | always | inline-hint | "Overdue items are fine to postpone or drop — incremental reading expects overload." | Why your queue is always 'too big' |
| Top-due preview header (`home-preview` / "See full queue") | always | help-link | "This is a read-only preview. To postpone, reprioritize, or remove items, open the full queue." | Start session vs Open queue vs Review |
| Streak / retention banner (`home-streak-retention`) | hover | tooltip | "Streak = consecutive review days. Retention = how often you recalled (not graded Again) over 30 days; ~85–90% is healthy." | Streaks, retention, and reviews-per-day explained |
| "Due cards" vs "Due topics" tiles (`metric-due` / `metric-topics`) | hover | tooltip | "Cards use FSRS (can I recall this?); topics/extracts use the attention scheduler (should I process this again?). Counted separately on purpose." | Two schedulers |
| Targeted review section (`home-review-modes`) | always | inline-hint | "These review a chosen subset of cards outside your normal schedule. Audit picks random cards; Stale picks cards overdue for review." | Targeted review modes |

#### Import & Inbox — `/inbox`

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| Import strip header ("Import & Inbox") | first visit | first-run-callout | "Paste a URL or some text to capture your first source. You can import more than you can finish — triage is how you cope." | Getting material into Interleave |
| Triage rail ("Triage 1 · 3 · 6", `inbox-accept`/`inbox-keep`/`inbox-delete`) | first item selected | coachmark | "Activate (1) = start reading · Save for later (3) = set aside, no reminder · Delete (6) = soft-delete, undoable." | Triage your inbox: Activate, Save for later, Delete |
| "Save for later" button (`inbox-keep`) | hover | tooltip | "Sets the item aside (dismissed). It won't be scheduled or appear in your queue — find it again in the Library." | Triage your inbox #save-for-later |
| Priority chip group (`inbox-priority` and `*-priority`) | hover / "?" | help-link | "A is protected and returns daily; D is background you'll skim or delete first. New imports default to C so they don't drown high-value items." | Priorities A/B/C/D explained |
| "Import file" chip (`inbox-import-import-file`) | hover | tooltip | "EPUB, Markdown, HTML, Readwise/Kindle highlights, and Anki decks — choose the format inside." | Migrating from Readwise, Kindle, and Anki |
| "Paste URL" chip / Import-URL modal hint | always | inline-hint | "Pages are fetched and cleaned locally. YouTube links import as video." | Import from the web (URL & YouTube) |
| "Treat body as Markdown" checkbox (`new-source-markdown`) | hover | tooltip | "Tick this to keep #headings, **bold**, lists, code, and links. Otherwise the body is plain text." | Import books, documents, and notes |
| Import error line (`import-url-error` / `import-file-error` / `inbox-error`) | on error | help-link | Appends a contextual link after a too_large/not_html/drm/encrypted/unsupported_compression error | the relevant import article (limits & fixes) |
| PDF preview with "No embedded text — run OCR" note | when scanned | inline-hint | "This PDF is scanned/image-only. Run OCR to make it searchable and extractable." | Import books, documents, and notes #pdf |
| BalanceBanner (`balance-banner`) | when firing | help-link | "Why am I seeing this? You're importing faster than you process — aim for ~70% reviewing, 20% extracting, 10% importing." | Your daily rhythm and the 70/20/10 mix |
| "Browser capture" tile (hint "Pair the extension") | always | help-link | "How to set up browser capture" (routes to `/settings#browser-capture`) | Install the Interleave browser extension · Pair the extension |

#### Source Reader — `/source/$id`

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| Floating selection toolbar (first 3+ char selection) | first ever | first-run-callout | "Extract (E) makes a new item you'll process later — Highlight (H) just marks the text here." | Extract vs Highlight |
| Selection toolbar — Extract button | hover | tooltip | "Lift this passage into its own scheduled item, linked back to this paragraph. Find it under Extracts from this source." | Extract vs Highlight |
| Selection toolbar — Highlight button | hover | tooltip | "Just a colored mark in this document. Creates no item and no schedule. Click a highlight to remove it." | Extract vs Highlight |
| After first "Extracted" toast | once | coachmark | "Your extract is now in the queue and listed under Extracts from this source in the Inspector. Open it to refine it." | How incremental reading works · Processing an extract |
| "Set read-point" primary button | hover | tooltip | "Bookmark where you stopped (Space). Reopening resumes here. Tip: Space only works when your cursor isn't in the text." | Read-points: bookmarking where you stopped |
| "↓ unread from here" divider | always | inline-hint | "This is your read-point — everything below is unread. It moves forward automatically when you extract." | Read-points |
| Disabled Postpone / Mark done / Lower priority buttons | hover | help-link | "Schedule and prioritize sources from the queue or an extract. Here, focus on reading and extracting." | Deleting, postponing, and pruning sources safely |
| Per-paragraph "mark processed" button | first hover | tooltip | "Dim this paragraph once you're done with it — fully reversible, nothing is deleted. Click a dimmed paragraph to restore it." | Reading the source body |
| Header SchedulerChip | hover | tooltip | "Attention schedule: when this source should come back to you. Cards use a different (FSRS) schedule." | The two schedulers |
| PDF Region button / first PDF open | first PDF | first-run-callout | "Press R to draw a box around a figure or table and save it as an image topic." | Reading PDFs |
| PDF OCR panel on a scanned page | on render | inline-hint | "This page is scanned. We recognized the text — review it and Accept into page to make it searchable and extractable." | Reading PDFs |
| Media reader with no transcript | empty | empty-state | "No transcript. Play the media, set timestamp read-points, and cut a clip with [ (in) and ] (out) — then save it as a topic." | Reading video & audio |
| Trash (delete) icon in any reader action bar | hover | tooltip | "Soft-delete to Trash — recover from Trash or undo with ⌘Z." | Deleting, postponing, and pruning sources safely |
| Desktop-only fallback (reader opened outside Electron) | render | empty-state | "The reader loads documents through the desktop app. Open Interleave desktop to read this source." | — |

#### Extract distillation — `/extract/$id`

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| Selection inside extract body, first time | first | coachmark | "Press E to extract — extracts come back so you can distill them into cards." | Extract vs highlight |
| Stage stepper / "Advance stage" (`extract-stage-stepper`) | "?" | help-link | "Each return, refine it: trim, split, rewrite. Advance the stage as it gets to a single clean idea (raw → clean → atomic), then convert to a card." | The distillation pipeline · Distilling extracts |
| Split / Sub-extract buttons | always | inline-hint | "Select text in the body first, then Split to break out a sub-extract." | Sub-extracts |
| "Jump to source" button (left column) | hover | tooltip | "Jump back to the exact paragraph this came from." | Actionable lineage |
| LineageTree (`lineage-tree`) header | always | help-link | Header link explaining source → extract → sub-extract → card and click-to-navigate | Actionable lineage |
| Delete (trash) button | hover | tooltip | "Soft delete — recoverable from Trash, and lineage stays intact." | Deleting, postponing, and pruning sources safely |
| Empty / no-source-context state | empty | empty-state | "No source location recorded." | Actionable lineage |

#### Card builder (third column of `/extract/$id`)

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| Cloze text field when empty (deletion count 0) | empty | empty-state | "Wrap the part to hide in double braces, e.g. The capital of France is {{Paris}}." | Cloze deletion cards |
| Quality checks header (`cb-quality`) | "?" | help-link | Explains green/yellow/red and that only red blocks Create | Understanding the Quality checks |
| First yellow warn row | first | coachmark | "This is advice, not an error — you can still create the card." | Writing good cards: the minimum information principle |
| Create button when a block row is present (disabled) | hover | tooltip | "Add a question and an answer (or a cloze deletion) to enable Create." | Understanding the Quality checks |
| Disabled "Image occlusion" tab (`cb-tab-occlusion-disabled`) | hover | tooltip | "Image occlusion needs an image extract (e.g. a figure cropped from a PDF)." | Image occlusion cards |
| Occlusion editor canvas before any mask (`occlusion-empty`) | empty | first-run-callout | "Drag a box over each part to hide — every box becomes its own sibling card. The figure itself is never changed." | Image occlusion cards |
| Reveal button (`cb-reveal`) | always | inline-hint | "Tip: press Space to flip the card (when your cursor isn't in a text field)." | — |
| "First due — (M7)" / FSRS chip row | always | help-link | "New cards are drafts and enter spaced-repetition review separately." | Turning an extract into a flashcard (two-schedulers note) |
| "Predict output" button (`cb-predict-output`) | hover | tooltip | "Seed the prompt with the code; the answer is the expected output." | Formula and code cards |
| After a successful Create (toast) | once | inline-hint | "Card created — find it under this extract in the lineage tree. The builder stays open so you can add a sibling." | — |

#### Review session — `/review`

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| First card of a daily session (`review-card`), before reveal | first | first-run-callout | "Try to recall the answer, then press Space (or click Reveal)." | Reviewing flashcards: the active-recall session |
| Grade button row (`review-grades`), right after first reveal | first | coachmark | "Grade how well you recalled it — honestly. The text under each button is when the card returns." | How to grade honestly (and why it matters) |
| Leech banner (`review-leech-banner`) | when leech | help-link | "This card keeps lapsing — it's a leech." (beside "Add context") | Leeches: handling cards you keep failing |
| Repair row (`review-repair`) | "?" | help-link | Clarifies Suspend vs Retire vs Delete vs Flag vs Mark leech | Fixing or removing a bad card during review |
| Expiry banner (`review-expiry-banner`), post-reveal | when present | inline-hint | "This fact has a lifetime and may be out of date." (explains "Create verify task") | card-lifetimes / verification tasks |
| Review mode header (`review-mode-header`) | mode active | inline-hint | "You're reviewing a subset outside the normal schedule — grading still counts." | Targeted review modes |
| "Review these" / "Audit N random" buttons (`review-mode-button`) | hover | tooltip | "Review this subset now, even cards that aren't due yet." | Targeted review modes |
| Session-complete summary (`review-summary`) | on complete | inline-hint | "Cards are now rescheduled and will return when you're about to forget." | Reviewing flashcards |

#### Daily Queue & Process loop — `/queue`, `/process`

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| Queue page head ("Daily Queue · N items due") | always | help-link | "How the queue works" | The daily loop |
| SchedulerChip on any row | hover | tooltip | "FSRS — can you recall this?" (cards) / "Attention scheduler — when to process this again?" (everything else) | Two schedulers |
| Prio badge / raise-lower buttons on first row | first | coachmark | "Priority A/B/C/D protects your best work. Raise the few things that matter — press + or use these arrows." | Priorities A/B/C/D |
| OverloadBanner ("N items over today's budget") | when over | help-link | "Why am I over budget? High-priority fragile cards are protected." | The daily review budget · Auto-postpone |
| OverloadBanner empty preview ("Nothing can be safely postponed") | when empty | inline-hint | "Everything over budget is high-value and protected. Try Catch up to spread it over days, or raise your budget in Settings." | Auto-postpone |
| RecoveryPanel Catch up / Vacation buttons | hover | tooltip | Catch up: "Behind? Spread the backlog over several days within budget." Vacation: "Away soon? Pause/shift what's due." | Catch-up and Vacation |
| `/process` Mode segmented control | first `/process` | coachmark | "Mode re-orders your session, it doesn't hide items — Review floats cards, Reading floats sources. Both stay in the deck." | Running a Process session |
| `/process` card surface, first card | first | first-run-callout | "Press Space to reveal, then 1–4 to grade. On non-card items, Space just moves to the next." | Running a Process session |
| `/process` Delete button / after first loop delete | first | inline-hint | "Deleted items are soft-deleted and recoverable from Trash — nothing is lost." | Nothing is lost |
| Schedule (calendar) menu on a non-card row | hover | tooltip | "Pin an exact return: Tomorrow / Next week / Next month / a date. Use Postpone to push it out automatically." | Postpone vs Schedule |

#### Library, Search, Concepts — `/search`, `/library`, `/concepts`

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| `/search` empty prompt (`library-prompt`) | empty | first-run-callout | "Type a keyword to find any source, extract or card. Looking to browse everything instead? Open Library." | Finding things: Search vs Library |
| `/search` zero-results (`library-empty`) | empty | inline-hint | "Searching for a topic, synthesis note, or task? Those aren't keyword-searchable — browse them in Library." | Using keyword search |
| `/library` top bar (count / title filter) | "?" | help-link | Clarifies facets, drill-down counts, and that the title box is a filter not a search | Browsing your whole collection (Library) |
| Inspector Concepts section (`concepts-section`) | "?" | help-link | Explains hierarchy, the facet/map payoff, parent/child | Concepts vs tags |
| Inspector Tags section (`tags-section`) | hover | tooltip | "Tags are flat labels found by keyword search. For filterable, mappable buckets, use Concepts." | Concepts vs tags |
| Concept Map tab header (`lib-map__head`) | open | coachmark | "This map is read-only — click a concept node to filter your results by it." | The concept knowledge map |
| Filterbar Maintenance group (disabled rows) | hover | tooltip | "Coming with analytics." | (analytics/maintenance help) |
| Filterbar facet count | hover | tooltip | "Items matching this filter combined with your current filters — not a global total." | How facet counts work |
| `/concepts` Retention slider (`concept-retention`) | hover | tooltip | "Desired retention: how well you want to remember cards in this concept. Inherit uses your default; the strictest concept on a card wins." | Per-concept review targets |
| Command palette results for Library / Concept map / Search | always | inline-hint | One-line descriptions ("Search — find by keyword", "Library — browse everything") | (their respective articles) |

#### Maintenance, Trash, Leeches, Stagnant, Retired

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| Maintenance hub header (`/maintenance`) | always | help-link | "How maintenance works" | The Maintenance hub |
| Trash sub-line "recoverable for 30 days" (`/trash`) | always | help-link | Links the retention phrase, clarifying 30 days and that purge is permanent | Using Trash: restore, purge, and empty |
| Trash "Delete forever" / "Empty trash" confirm | on confirm | inline-hint | "This cannot be undone." | Nothing is lost #irreversible |
| Maintenance Orphan media, above "Reclaim {size}" | always | inline-hint | "The one vault-side delete that cannot be undone (never touches a referenced file)." | The Maintenance hub |
| Leeches header (`/maintenance/leeches`) | always | help-link | "What is a leech?" (≥4 lapses; no repair destroys history) | Fixing leeches |
| Leech "Back to extract" when disabled | hover | tooltip | "No live parent extract." | Fixing leeches |
| Stagnant header (`/maintenance/stagnant`) | always | help-link | "Leech vs stagnant — pick the right screen." | Stagnant extracts vs leeches |
| Stagnant "Suggested:" line | hover | tooltip | Explains why a remedy is suggested; Delete is undoable from Trash | Stagnant extracts vs leeches |
| Retired empty state + inspector Retirement row | always | help-link | "Retire vs suspend vs delete." | Retiring cards |
| Cards-without-sources panel intro | always | inline-hint | "A sourceless card may be intentional — fix the lineage or trash it." | (lineage section) |
| Integrity card after a result (esp. "Issues") | on result | help-link | "What do these results mean?" | Reading the integrity check |

#### Backup, Export & Settings — `/settings`

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| Settings header ("Local-first · everything stays on this device") | first visit | first-run-callout | Reinforces local-first + backup responsibility | Where your Interleave data lives |
| Data & backup → "Back up now" row | "?" | help-link | "A full local ZIP (DB + assets). In-app restore isn't shipped yet." | Backing up your vault |
| "Last backup" schema-version tag | hover | tooltip | "The database version captured in this backup — used to verify a future restore." | — |
| Data & backup section header | always | inline-hint | One line distinguishing backup from export | Backup vs Export — which do I need? |
| Inspector Export / Export-to-Anki sections | "?" | help-link | So users don't mistake per-item export for a backup | Backup vs Export |
| Review & scheduling → Desired retention + Default topic interval rows | first visit | coachmark | Explains the two-scheduler split | Review & scheduling settings explained |
| Retention by priority section | "?" | help-link | "Hold high-value (A) cards to a higher target; let D drift." | Protecting high-value memory with per-priority retention |
| Daily review budget slider | always | help-link | "This is the line that triggers overload tools. Set it to what you can realistically process." | The daily review budget |
| Workload simulator | always | help-link | "Preview how a change to retention, a big import, or a postpone would shift your daily load before you commit." | Simulating workload |
| AI assistance → provider row when "Local" selected | on select | inline-hint | "The local AI model is experimental and not yet available — pick Anthropic or OpenAI and add your own key to use AI now." | Setting up AI: providers and your own API key |
| AI assistance → Managed proxy confirm dialog | on toggle | help-link | "Learn what is sent." (proxy not yet available) | Your data and AI: the local-first trust model |
| Semantic index status | first index build | first-run-callout | "Uses the local EmbeddingGemma model, then runs offline. Build the index to make existing material searchable by meaning." | On-device semantic search |
| Semantic "semantic-unavailable" notice | on render | help-link | "The on-device vector extension isn't available on this machine/build — search stays keyword-only." | (troubleshooting note) |
| Bury siblings row (`setting-bury-siblings`) | hover | tooltip | "Why related cards aren't shown back-to-back, and what turning it off does." | Sibling burying and FSRS scheduling details |
| Keyboard layout selector | always | inline-hint | "This preference does not yet remap shortcuts — bindings are fixed." | Customizing the keyboard layout (current limitations) |
| Settings "desktop only" fallback card (browser) | render | inline-hint | "Settings live in the native desktop database, only available in the Electron app." | Where your Interleave data lives |

#### AI & semantic surfaces — in the reader / inspector / review

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| AiAssist disabled state ("Turn on AI assistance in Settings →") | render | help-link | Links "AI assistance"; reinforces drafts-only + own-key | AI assistance: draft cards, never schedule them · Setting up AI |
| AiAssist first run / "Thinking…" | first | first-run-callout | "AI only drafts. Nothing is added to your review until you approve and then activate it." | Your data and AI: the local-first trust model |
| AiAssist "Approve → card draft" button | hover | tooltip | "Creates a parked card draft with source lineage. It is NOT scheduled — activate it later to add it to review." | AI assistance: draft cards |
| AI draft grounding RefBlock (jump-to-source) | hover | tooltip | "This suggestion was generated about this exact source text — click to jump there." | How AI suggestions stay grounded |
| Library semantic hint line ("Keyword search · semantic index unavailable…") | always | help-link | Explains why results may be keyword-only (not indexed / model not ready / unavailable) | On-device semantic search |
| Library "Build index (N of M embedded)" | hover | tooltip | "Embeds your existing sources, extracts, and cards so semantic search can find them. Runs in the background." | On-device semantic search |
| RelatedSection "possible duplicate" badge / ConflictSection "Possible conflict" chip | always | inline-hint | "What is this? Heuristic, read-only — never changes your cards. Dismissal is session-only." | Related items, possible duplicates, and possible conflicts |

#### Synthesis notes — `/synthesis/new`, `/synthesis/$id`

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| Command palette "New synthesis note…" item | hover / first | help-link | "What's this?" before creating one | What is a synthesis note? |
| `/synthesis/$id` workspace, first visit | first | first-run-callout | "This is incremental writing. Write your own understanding in the center; collect reference extracts/cards on the right; schedule it to return." | What is a synthesis note? |
| Write & refine canvas, empty after material linked | empty | empty-state | "Reference material is on the right — start writing your own synthesis here. Collected extracts/cards are NOT pasted in." | Collect extracts and cards into a note |
| Linked material panel empty state | empty | inline-hint | "Use Add to note to collect the extracts and cards you want to weave together — they stay linked, not copied." | Collect extracts and cards into a note |
| Schedule return section (while "not scheduled to return") | always | coachmark | "Schedule this note to return so it comes back in your daily queue for refinement. It returns on the attention scheduler — never as a flashcard." | Scheduling a synthesis note to return |
| "attention scheduler" hint text | always | help-link | Deep-links the phrase to explain the two-scheduler split | Scheduling a synthesis note to return |
| Add-to-note picker header | hover | tooltip | "Only extracts and cards can be collected. Linking is safe — it references the item and never moves or copies it." | Collect extracts and cards into a note |
| A linked CARD row | hover | tooltip | "Cards open in the inspector on the right (cards have no reader page)." | — |
| Library "Synthesis notes" section header | always | help-link | "Synthesis notes are your incremental-writing surface." | What is a synthesis note? |

#### Browser extension & web capture

| Location | Trigger | Type | Microcopy | Target |
|---|---|---|---|---|
| Settings → Browser capture card header | "?" | help-link | The desktop half of pairing | Pair the extension with the desktop app |
| Settings → Browser capture, first toggled ON | on enable | coachmark | "Now copy this token, install the extension, and paste it in the extension's Options → Save & test connection." | Install the extension · Pair the extension |
| Settings → "Regenerate" token | hover | tooltip | "Regenerating unpairs the current extension — you'll need to paste the new token into its Options again." | Manage and re-pair |
| Extension Options page, token empty / never paired | render | first-run-callout | "Get this token from the desktop app: Settings → Browser capture → Copy." | Pair the extension |
| Extension Options, "App not reachable" error | on error | inline-hint | "Is the Interleave desktop app open with Browser capture enabled? Check the port matches Settings." | Troubleshooting capture |
| Extension popup, "Not paired" / "Bad token" | on outcome | help-link | "Open Options to pair" / "Re-pair in Options" + "Why?" | Troubleshooting capture |
| Extension popup, "App not running" | on outcome | inline-hint | "Open the Interleave desktop app and enable Browser capture in Settings." | Troubleshooting capture |
| Extension side panel, empty selection state | empty | empty-state | "No text selected — select on the page, then 'Use current selection'. The panel doesn't auto-track selections; switching tabs clears it." | Capture pages and selections |
| Extension side panel, Recent captures empty | empty | empty-state | "Your saved pages and selections appear here. They land in the Inbox of the desktop app at priority C." | Capture pages and selections |

---

### C.2 Empty states as teaching surfaces

Empty states are the single biggest first-run teaching opportunity (and a high-severity friction point: "Empty everything on day one"). Each must have **(a)** plain teaching copy, **(b)** exactly one primary action that advances the pipeline, and **(c)** a help deep-link. Match the existing dense, calm `EmptyState` pattern — no oversized hero illustration.

| Empty state (component / route) | Teaching copy | Primary action | Secondary | Help link |
|---|---|---|---|---|
| **First-run / empty collection** (`Onboarding.tsx`) | "Interleave is a refinery: import many sources, read them in small pieces, lift out the bits worth keeping, distill them, and turn the best into flashcards. You're not meant to finish what you import." | "Import your first source" (→ `/inbox`, opens New source modal) | "Explore on my own" + "Learn how Interleave is different" | What is incremental reading |
| **Inbox zero** (`inbox-empty`, `/inbox`) | "Every captured item has been triaged. New manual notes appear here. Tip: import more than you can finish — triage is the skill." | "New source" | "What should I import? / Don't import everything" | Getting material into Interleave · Don't import everything |
| **Home empty** (`home-empty`, `/`) | "Queue clear for today — high-priority sources are protected and won't pile up. Keep the pipeline moving by importing or triaging." | "Go to inbox" | "Try a sample source" (seeds a demo + starts the guided read→extract→card→review walkthrough) | What is incremental reading · Why your queue is always 'too big' |
| **Queue clear** (`/queue` empty) | "Done for today — high-priority items are protected; the rest return when they're due. Processing a few items is the point, not finishing everything." | "Go to inbox" | "Audit random cards" | The daily loop |
| **Process loop "Queue clear"** (done panel) | "Your high-priority items are protected; the rest return when they're due. You processed N items — that's the whole point, not finishing every source." | "Back to queue" | "Reload queue" | Overload is a feature |
| **No cards due** (`review-empty`, `/review`) | "No cards are due — that means FSRS scheduled them to return later, not that anything is broken. Cards come from distilling extracts into atomic statements." | "Go to queue" (to process reading/extracts) | "Audit random cards" / "Make a card from an extract" | Why some flashcards aren't due yet |
| **Search prompt** (`library-prompt`, `/search`) | "Type a keyword to find any source, extract or card. To browse everything instead, open Library." | Focus the search box | "Open Library" | Finding things: Search vs Library |
| **Search zero-results** (`library-empty`) | "No matches. Topics, synthesis notes, and tasks aren't keyword-searchable — browse them in Library." | "Open Library" | — | Using keyword search |
| **Empty concept map** (`concepts-empty-map`, `/concepts`) | "No concepts yet. Concepts are created from the Inspector — select a source, extract or card, open the Concepts section, and choose New concept…" | "Open Library to pick an element" | — | Creating and assigning concepts |
| **Trash empty** (`/trash`) | "Trash is empty. Deleted items land here and stay recoverable for 30 days." | — | "How delete & undo work" | Using Trash |
| **First reader open** (`/source/$id`, first visit) | (not a zero-data state — use the first-run-callout) "Read a little, mark your spot, extract the good bits — you're not here to finish the source." | — (continue reading) | "How incremental reading works" | How incremental reading works in Interleave |
| **No extracts yet** (Inspector "Extracts from this source", empty) | "No extracts yet. Select text in the reader and press E to lift a passage into its own scheduled item — that's how the pipeline starts." | — (points at the reader) | "Extract vs highlight" | Extract vs highlight |
| **Media reader, no transcript** (`/source/$id` media) | "No transcript. Play the media, set timestamp read-points, and cut a clip with [ (in) and ] (out) — then save it as a topic." | — | "Reading video & audio" | Reading video & audio |
| **Maintenance "No maintenance needed"** (`/analytics` health panel) | "Nothing needs cleanup right now." | "Open maintenance" | — | The Maintenance hub |
| **Synthesis canvas empty after linking** (`/synthesis/$id`) | "Reference material is on the right — start writing your own synthesis here. Collected extracts/cards are NOT pasted in." | — (focus the canvas) | "How synthesis notes work" | Collect extracts and cards into a note |

> Note on "Try a sample source": several findings call for this (Home empty, first-run). It should seed a demo source and launch the guided golden-path tour (read → set read-point → extract → distill → card → review). Spec it once as a shared flow invoked from both the Onboarding modal's empty state and the Home empty state.

---

### C.3 Global help affordances

Three always-available entry points, layered from lightest to deepest:

1. **`?` keyboard cheat sheet (`CheatSheet.tsx`) — shipped.** The closest thing to in-app docs today. It lists every shortcut grouped Navigation / Actions / Reading / Review / Triage from the single shortcut registry. **Add to its header**: a "Full shortcut guide →" link to *Every keyboard shortcut, by area*, and a one-line caveat: "Reading/Review/Triage keys only work on those screens." This corrects the friction point where users try a scoped key (e.g. reader `E`) from the wrong screen.

2. **A persistent Help entry point — to build.** There is no help-center entry point besides `?`. Add a **"Help & docs"** item to the **user/identity chip menu** (in `Shell.tsx`), directly beneath the existing "Keyboard shortcuts" entry. This is the canonical home for the help center and the destination of every "Learn more" link in §C.1. It opens the help center (an in-app reader for the help articles enumerated in Parts A/B), deep-linkable by article id + `#anchor`. The same destination should be reachable from the native **Help menu** (which today only exposes "Keyboard shortcuts ⌘/").

3. **`⌘K` "Help: …" commands — to add.** The command palette already has Go to / Create / Action / Session groups. Add a **"Help"** group that surfaces help directly in the user's normal "do anything" flow:
   - `Help: Getting started` → *What is incremental reading*
   - `Help: Keyboard shortcuts` → opens the cheat sheet (`?`)
   - `Help: Extracts vs highlights` · `Help: The two schedulers` · `Help: Priorities A/B/C/D` · `Help: Overload is a feature` · `Help: Backups` · `Help: Browser capture` (each → its article)
   - `Help: Open help center` → the help center root
   - `Help: Take the tour` → re-launches the guided golden-path walkthrough on a sample source

   Because the palette today *filters command labels, not content*, prefixing these with "Help:" makes them discoverable by typing "help" and avoids colliding with content search (which lives on `/`). Add the same `Help: …` one-line descriptions noted in §C.1 so users distinguish them at a glance.

---

### C.4 Reusable component inventory (for the design agent)

There is **no existing help-link or coachmark/tour primitive** — these must be specced new, built from design tokens (`design/tokens.css`) and matching the dense/calm tone. Reuse `Tooltip.tsx`, `BalanceBanner`/`Banner`, `Snackbar`, and the `EmptyState` pattern where they already exist.

| Component | Purpose | States to spec | Notes / token constraints |
|---|---|---|---|
| **HelpLink** (new) | The inline "?" or "Learn more →" affordance used by every `help-link` row above | default · hover · focus (`--focus-ring`) · visited(none — local) | Two forms: (a) a compact "(?)" glyph (lucide via `Icon` at stroke 1.75) next to a section title; (b) an inline "Learn more →" text link. Mono/Sans per role. Opens the help center to a target id+anchor. Must be keyboard-focusable and have an accessible label. |
| **Coachmark / TourStep** (new) | One-time anchored callout pointing at a real control (e.g. SchedulerChip, Extract button, Start session); also the step unit of the guided golden-path tour | armed · visible (anchored, with arrow) · dismissed · "don't show again" · tour mode (Back / Next / Step N of M / Skip tour) | Anchors to a DOM element with a small arrow; uses `--med`/`--ease` motion; dismiss persists a per-coachmark flag in `settings` (see §C.5). Never modal-blocking; ESC and outside-click dismiss. Must survive theme toggle (both light + dark). |
| **EmptyState** (extend existing pattern) | The teaching zero-data panels in §C.2 | default · with primary action · with primary + secondary · with help link · desktop-only fallback variant | Already a de-facto pattern (`inbox-empty`, `home-empty`, `review-empty`). Formalize: icon (TypeIcon-style) + title + one-line teaching copy + one primary action + optional secondary + optional HelpLink. Keep compact; no marketing hero. |
| **Tooltip** (reuse `Tooltip.tsx`) | All `tooltip` rows above | hidden · hover-open · focus-open · with optional trailing HelpLink | Already token-faithful and portaled; extend to optionally render a trailing "Learn more →" so a tooltip can deep-link (e.g. SchedulerChip, Save-for-later). Instant, replaces native `title`. |
| **InlineHint** (new, lightweight) | The always-present small helper text (`inline-hint` rows, divider hints, mode header) | default · with HelpLink · dismissible variant (for first-occurrence hints like the loop-delete hint) | Mono/Sans small (`--t-sm`), muted color; sits under/next to a control. Distinct from Coachmark (not anchored/arrowed, not one-time by default). |
| **AdvisoryBanner** (reuse `BalanceBanner`/`Banner`) | OverloadBanner, BalanceBanner, BackupPrompt, expiry/leech banners — anywhere an educational notice needs a help link | info · warn (`--*-soft` tokens) · danger · with action button(s) · with HelpLink · dismissible | Already exists. Standard for advisory/educational banners; add a HelpLink slot. Dismissible ones remember dismissal for the session. |
| **HelpCenter reader** (new) | The destination for all deep links — renders the Part A/B articles | list/index · article view · deep-linked to `#anchor` · search-within-help · back/forward | Built from shell primitives (no new chrome language). Article ids + anchors are the deep-link contract used by every HelpLink. Both themes. |
| **Snackbar** (reuse `Snackbar.tsx`) | Undo confirmations doubling as teaching ("Sent to Trash — ⌘Z to undo") | default · with Undo action · with first-time HelpLink | Already shipped; on first destructive action attach a one-time "What is undo?" HelpLink. Fix the cosmetic issue where it always shows a trash icon for non-delete confirmations. |

All new components must honor: tokens only (no hard-coded color/px), both `[data-theme]` modes, lucide via `Icon` at stroke 1.75, IBM Plex role split (Sans UI / Serif reading / Mono keycaps & metadata), and the 4px spacing grid.

---

### C.5 When to show contextual help (and when to get out of the way)

This is a serious, keyboard-first pro tool. The governing principle: **help is opt-in by default, fires at most once unprompted, and is always dismissible and remembered.**

**Show proactively (one-time, unprompted) only for:**
- **First encounter of a load-bearing concept** the user *cannot* infer and that breaks the product if missed: the SchedulerChip (two schedulers), Extract-vs-Highlight on first selection, priority A/B/C/D on the first queue row, the read-point/Space interaction, "delete is soft + undoable" on the first destructive action. These are the high-severity friction points in the findings.
- **First visit to a surface** with a genuinely non-obvious model: the Process loop's Space-reveals-vs-advances + Mode-reorders behavior, the synthesis workspace's "your writing vs reference material" split, the first PDF/media reader, the AiAssist drafts-only rule.

**Always available on demand (never proactive):**
- Tooltips, HelpLinks ("?"/"Learn more"), the `?` cheat sheet, the `Help:` palette commands, and the help center. These never interrupt; they wait to be asked.

**Reactive (show only at the moment of confusion):**
- An action that silently no-ops (e.g. `o`/`+`/`-` with no selection) → a one-time inline hint, not a recurring nag.
- An error path (import failure, "App not reachable", "semantic unavailable", integrity "Issues") → a contextual HelpLink appended to the existing error, never a popup.
- A state that *looks* broken but is correct ("No cards due", "Queue clear", em-dash for unknown, "Nothing can be safely postponed") → reassurance copy in the empty/inline state.

**Rules to prevent nagging:**
1. **Fire-once + remember.** Every coachmark and first-run-callout sets a per-item flag in the `settings` table (persisted to SQLite, like `ui.seenOnboarding`), so it never reappears across restarts. Use granular flags (e.g. `ui.coach.schedulerChip`, `ui.coach.extractVsHighlight`) — not one global "seen help" flag.
2. **One at a time.** Never show two coachmarks simultaneously; queue them and only surface the next on a subsequent relevant action. Suppress all proactive help while a modal/command palette is open or during an active review/process session keystroke.
3. **Always dismissible.** Every proactive surface has an explicit dismiss (X / ESC / outside-click) and, for repeating-risk hints, a "Don't show again". Dismissing a coachmark sets its flag immediately.
4. **A global off switch.** Provide a Settings toggle ("Show contextual tips") that suppresses all *proactive* help (coachmarks, first-run callouts) while leaving on-demand help (tooltips, HelpLinks, cheat sheet, help center) fully available — for power users who want zero interruptions from day one.
5. **Re-summonable.** Because proactive tips fire once, every concept they teach must *also* be reachable on demand (its HelpLink/tooltip/article and a `Help: Take the tour` palette command), so a user who dismissed everything can still find it.
6. **Match the density.** No oversized hero callouts, no animated mascots, no progress-gamified "you've completed 3/8 tips!" Keep callouts compact, token-faithful, and serious — consistent with "dense but calm, no cartoon learning-app aesthetic."

## Part D — Design & Content Direction (for the design agent)

This section tells you how to build onboarding and a help center that feel *native* to Interleave — not bolted-on, not marketing. Interleave already has a complete, durable design system. Your job is to teach the method *through* that system, reusing its primitives, never inventing a parallel visual language for "education." Everything below is grounded in the shipped app: real tokens, real components, real routes, real shortcuts.

---

### D1. Visual language you must honor

The single source of truth is `design/tokens.css`, imported **once** in `apps/web/src/styles.css`. Tailwind v4's theme is *derived* from those CSS variables via `@theme inline` (e.g. `--color-surface: var(--surface)`), so utilities like `bg-surface` re-theme automatically. The visual rationale and component gallery live in `docs/design-system.md` and the immutable reference `design/kit/` (`Incremental Reading - Design System.html`, plus `screenshots/ds-light.png`, `ds-dark.png`, `ds-components.png`). The icon vocabulary is `design/icon-map.md`, wired through `apps/web/src/components/Icon.tsx`.

**Hard rule: nothing is hard-coded outside the tokens.** No hex, no px, no ad-hoc spacing, radii, or color in any onboarding/help surface. Reference `var(--…)` or the derived Tailwind utilities. Hard-coded values break dark mode and the design's coherence, and will be rejected.

What to honor specifically:

- **Color palette — OKLCH, cool-neutral, light + dark.** The canvas is ~95% neutral gray. Full light and dark token sets exist; dark is the `[data-theme="dark"]` attribute on the root, **not** Tailwind's `dark:` class. Color *only ever means something* — never decoration.
- **Type — IBM Plex superfamily, three roles that never mix:**
  - **Plex Sans** — all UI chrome, labels, help-panel body copy.
  - **Plex Serif** — long-form reading and card faces. Use it when help copy *samples* reading/extracting content, so it visually echoes the reader.
  - **Plex Mono** — metadata, intervals, counts, and **keycaps** (the `.kbd` / `.shell-kbd` style). Every shortcut you render in help must be mono keycaps.
  - Self-hosted via `@fontsource` over the `app://` protocol — zero font network requests. Do not pull web fonts.
- **Type scale & density** — 13.5px base, compact "pro-tool" scale (`--t-sm`, `--t-base`), 4px spacing grid (`--s-1`…`--s-12`), radii (`--r-xs`…`--r-full`). Onboarding must match this density: no oversized hero type, no big rounded marketing cards.
- **Layout dims** — `--sidebar-w 212px`, `--inspector-w 296px`, `--topbar-h 52px`. Any side-panel help must fit the 296px inspector column; any coachmark must respect the shell regions.
- **Priority colors (A/B/C/D)** — via the `Prio` badge: **A = high value (red band)**, **B = useful (amber)**, **C = maybe/default (blue)**, **D = low/background (neutral)**. Teaching copy must defuse the "red A = error/alert" misread: red here means *most important*, not *wrong*.
- **Element-type colors (8 hues)** — the `--el-*` tokens + Lucide glyphs via `TypeIcon`: `source` (FileText), `topic` (Folder), `extract` (Quote), `card` (SquareStack), `task` (SquareCheckBig), `concept` (Share2), `media_fragment` (SquarePlay), `synthesis_note` (NotebookPen). Use these as the "art" of onboarding — they *are* the iconography.
- **Scheduler color tokens** — `--sched-fsrs` (green, brain icon) for cards, `--sched-attn` (indigo, gauge icon) for attention items. These are load-bearing (see D2).
- **Reading-mark tokens** — `--mark-hl` (yellow highlight) vs `--mark-extract` (violet span with a left border) vs the dimmed processed-span style. The yellow-vs-violet distinction *is* the highlight-vs-extract lesson.
- **Icons — `lucide-react` only, via the `Icon` wrapper at `strokeWidth ~1.75`.** Do not introduce a second icon set or hand-drawn SVGs when a Lucide glyph exists. Unknown names fall back to `FileText`. Pull semantic names from `design/icon-map.md` (`brain`, `gauge`, `extract`, `source`, `card`, `layers`, `flame`, `shield`, etc.).
- **Motion** — `--ease`, `--fast 110ms`, `--med 200ms`. Transitions are quick and subtle. No bouncy, springy, or attention-grabbing animation.

---

### D2. The two load-bearing patterns to reuse in teaching material

These are the two ideas most likely to confuse a new user and the two patterns the whole product hangs on. **Teach them with the real components, side by side — never with a new diagram you invented.**

**1. The FSRS-vs-attention `SchedulerChip` split.**
Cards run on **FSRS** (brain icon, `--sched-fsrs` green) and answer *"Can I recall this?"* — they show recall % and stability. Sources/topics/extracts/tasks/synthesis notes run on the **attention scheduler** (gauge icon, `--sched-attn` indigo) and answer *"Should I process this again, and when?"* — they show stage + postponed×N. The chip lives in `apps/web/src/components/inspector/primitives.tsx` and appears on queue rows, the reader/extract headers, and review. Every help illustration of scheduling must render **both chips together** with one plain sentence each. Never imply a single unified "due" model.

**2. Actionable lineage / the `LineageTree`.**
`apps/web/src/components/inspector/LineageTree.tsx` renders a depth-indented, click-navigable `source → extract → sub-extract → card` chain (treeBranch/Network icon); the reader and inspector both expose **jump-to-source** / "Open original." Any help about *"where did this come from?"* must point at the real `LineageTree` + jump-to-source, not a bespoke provenance graphic. Reuse it to teach that lineage is sacred and one click away.

A corollary teaching primitive: the **`Pipeline` stepper** (Source → Raw extract → Clean extract → Atomic statement → Card draft → Active card → Mature card → Synthesis), each stage with its own dot color. Use the *real* stepper vocabulary to teach the refinery, not custom icons.

---

### D3. Tone of voice & content principles

Interleave is "dense but calm, minimal but not sparse, serious, keyboard-first." The product explicitly rejects gamification and the cartoon learning-app aesthetic. Copy must match.

Principles:

- **Precise and concrete.** Name the real button, route, key, and result. "Press `E` to extract" beats "capture ideas easily."
- **Calm, not anxious.** Big due counts and overload are *normal* — copy should reassure, never alarm. Frame deletion/postponing as healthy.
- **Minimal but complete.** One clear sentence per idea. Don't pad, but don't leave a concept half-explained.
- **Serious, no hype.** No exclamation-driven excitement, no emoji, no "Let's go!", no badges/points/celebration.
- **Keyboard-first.** Surface real shortcuts in mono keycaps wherever an action is mentioned.
- **Honest about scope.** Where something is planned-not-shipped (in-app backup *restore*, the encrypted server tier, the managed AI proxy, keyboard-layout remapping), say so plainly.

**Do — copy that hits the tone:**

- "An extract is its own scheduled item, not a highlight. It comes back to you so you can refine it."
- "Press `Space` to mark where you stopped. You'll resume here next time."
- "More due than your budget? That's expected — postpone or deprioritize freely. Nothing is lost."
- "Cards use FSRS (can you recall this?). Sources and extracts use the attention scheduler (when to revisit?)."
- "Deleting is soft and undoable — items go to Trash, and `⌘Z` reverses your last action."
- "You're not meant to finish what you import. The goal is to extract value, not reach zero."

**Don't — copy that violates the tone:**

- "🎉 Great job! You imported your first source!" (gamified, emoji, celebratory)
- "Capture everything you love and never lose an idea again!" (hype, read-it-later framing, false promise)
- "Oh no — you have 142 items overdue!" (alarmist; overload is a feature)
- "Highlight the good stuff to remember it later." (teaches the wrong mental model — highlight ≠ extract)
- "Keep your streak alive — review every day to level up!" (gamification the product explicitly rejects)
- "Reviewing is easy and fun — let the AI build your cards for you!" (hype; also false — AI only ever drafts, user approves)

---

### D4. Layout patterns

**For onboarding:**

| Pattern | Use it for | Avoid for |
|---|---|---|
| **First-run modal** (extend the existing `Onboarding.tsx`, centered, built from modal primitives) | The one-time method primer + myth-busters + keyboard pillars, shown once when the collection is empty | Anything that must reference a live on-screen element |
| **Inline coachmark** (anchored to a real component, built from the `Tooltip` primitive + token-driven callout) | Just-in-time, single-concept teaching anchored to the actual `SchedulerChip`, `Prio` badge, selection toolbar, read-point divider, "Start session" button | Multi-step tours; long explanations |
| **Empty-state teaching** (reuse the existing empty-state pattern, e.g. "Queue clear for today", "Inbox zero", "Search your collection") | Turning dead screens into guidance: compact loop diagram + "Try a sample source" + a help deep-link | Replacing necessary contextual coachmarks |
| **Side-panel walkthrough** (fits the 296px inspector column) | An optional guided "golden path" (read → set read-point → extract → distill → card → review) on a seeded sample | Blocking the user before they've imported anything |

**Recommendation:** A **layered, just-in-time** model, not a single front-loaded tour. (1) Keep/extend the **first-run modal** for the one-sentence method, the three myth-busters ("you don't finish what you import / a highlight is not an extract / don't card everything"), and the keyboard pillars (`⌘K`, `g`+letter, `?`). (2) Do the heavy teaching with **contextual coachmarks** fired the first time each real surface appears (first selection → extract-vs-highlight; first mixed queue → the two schedulers; first inbox triage → A/B/C/D; first `/review` card → reveal + honest grading). (3) Make **every empty state** a teaching moment with a deep-link into the help center. Rationale: the app is dense and keyboard-first; a long modal tour fights its character and is forgotten in one click. Teaching *on the real components* reinforces the design vocabulary the user must learn anyway.

**For the help center:**

- **In-app panel (recommended), not a separate website.** Interleave is local-first, offline-first, desktop-only — a help center that requires the network or a browser contradicts that identity and would break the "Local vault · offline-first" promise. Build help as an **in-app surface** that the existing contextual hooks deep-link into. There is **no help-center component today** — only the first-run modal, the `?` cheat sheet, and the `Tooltip` primitive — so you are defining this pattern. Build it from existing primitives (modal/overlay or a dedicated routed surface inside the shell, with the inspector-width side rail for the article list).
- Wire a **persistent entry point**: add a "Help & docs" item in the user/vault chip menu (beside the existing "Keyboard shortcuts" `?` entry), and make the `?` cheat sheet link out to the full keyboard article.
- Keep the **`?` cheat sheet** as-is (derived from the single shortcut registry in `shortcuts.ts`) — it's the canonical keycap reference; the help center should *link to* it, not duplicate it. Add a one-line note that Reading/Review/Triage keys are scope-specific.

---

### D5. Illustration & diagram direction

**What to illustrate** (these are the recurring conceptual surfaces):

1. **The refinery pipeline / funnel** — Source → Topic → Extract → Clean extract → Atomic statement → Card → Mature knowledge. Render with the real `Pipeline` stepper stages and `TypeIcon` glyphs/colors. Emphasize the *funnel* shape: much goes in, little comes out, that's the point.
2. **Highlight vs Extract** — a side-by-side using the actual `--mark-hl` (yellow) vs `--mark-extract` (violet, left border) marks: highlight stays in the document; extract lifts out into its own scheduled item with a lineage line back.
3. **The two schedulers** — both `SchedulerChip`s (brain/green/recall% vs gauge/indigo/stage+postponed) side by side, each with its one-line question.
4. **The daily rhythm / 70-20-10 mix** — review / extract / import proportions, tied to the `BalanceBanner` warning. A restrained proportional bar, not a pie-chart-with-mascot.

**Visual style:** **schematic, restrained, token-driven.** Built from the same icons, type, spacing, and color tokens as the app — a help diagram should look like it could be a real inspector panel. Specifically:

- Use `TypeIcon`, `Prio`, `SchedulerChip`, `Pipeline`, `LineageTree`, and reading-mark styles as the diagram's building blocks.
- Color only to signal meaning (priority/type/scheduler/marks) — **no decorative gradients, no spot illustrations, no characters/mascots, no isometric scenes, no brand color splashes.**
- Line weight matches Lucide at `strokeWidth ~1.75`. Diagram connectors should feel like the `LineageTree`'s indentation/branch lines.
- Both light and dark renderings of every diagram (see D6).

---

### D6. Accessibility, keyboard, dark-mode parity, motion

- **Dark-mode parity is mandatory.** Light and dark are *equally canonical*. Every onboarding screen, coachmark, empty state, and help diagram must be authored from tokens so it themes automatically, and must be visually verified in both. **Do not bake screenshots at one theme only** — any baked imagery needs a light *and* a dark version, and prefer token-driven live components over static images so theming is automatic.
- **Keyboard operability.** Everything must be operable without a mouse, matching the app's keyboard-first promise: modals/coachmarks dismissible with `Esc`, the help center navigable by keyboard, focus moved into and trapped within overlays, focus returned on close. Respect the existing `--focus-ring` token for visible focus. Don't let onboarding overlays swallow the global `⌘K` / `?` shortcuts unless intentionally modal.
- **Contrast & legibility.** Honor the token contrast pairs (surface/text); don't place teaching copy on low-contrast soft-tint backgrounds (`*-soft` tokens are for banner fills, with their paired text token). Maintain the 13.5px minimum body size — don't shrink help text below the app's scale.
- **Don't rely on color alone.** Priority, scheduler, and mark distinctions must also carry an icon or label (they already do: `Prio` letter, brain/gauge glyph, the extract-span left border). Preserve those redundant cues in teaching material.
- **Motion restraint.** Use only `--fast`/`--med` with `--ease`. Coachmarks should fade/position calmly, not bounce or pulse. Honor `prefers-reduced-motion` — provide a non-animated path. No looping/auto-playing animation in help.
- **Screen-reader semantics.** Coachmarks and tooltips need accessible names and proper roles; the help center articles need real heading structure; keycaps need text equivalents (e.g. `⌘K` announced as "Command K").

---

### D7. Deliverables checklist

Produce the following, all token-driven and in **both light and dark**:

**Onboarding mocks (screen by screen):**
- [ ] Extended **first-run modal** (`Onboarding.tsx` successor): one-sentence method, the funnel framing, three myth-busters, keyboard pillars (`⌘K` / `g`+letter / `?`), local-first/no-account reassurance, and "Import your first source" / "Explore on my own" / "Read the basics" actions.
- [ ] **Coachmark set** (anchored to real components), at minimum: extract-vs-highlight (selection toolbar, first 3+ char selection); the two schedulers (first mixed Queue/Process row + first `SchedulerChip`); priority A/B/C/D (first `Prio` badge / queue row); read-point + `Space` (reader, with the "Space only works when not typing" caveat); first `/review` card (reveal + honest grading); first destructive action ("soft delete, `⌘Z` to undo"); overload (`OverloadBanner`/`BudgetMeter` first over-budget).
- [ ] Optional **side-panel golden-path walkthrough** on a seeded sample source (read → read-point → extract → distill → convert to card → review).

**Empty-state set (teaching versions of each):**
- [ ] Home "Queue clear for today" / fresh-install empty Home; Inbox "Inbox zero"; first-run empty Queue; `/search` "Search your collection" + zero-results ("use Library for topics/notes/tasks"); `/review` "No cards due" (with zero-cards-ever path); empty Concept map ("concepts are created in the Inspector"); Trash empty; Linked-material empty (synthesis). Each pairs a compact, token-built diagram or hint with a help deep-link.

**Help center:**
- [ ] **Information architecture** grouping the articles surfaced across the investigation (Method & mental model; Getting around / keyboard; Import & triage; Reader, read-points & highlights; Extraction & lineage; Cards & quality; Review (FSRS); Queue, priority & overload; Home & analytics; Library, search & concepts; Maintenance, trash & safety; Backup, export & settings; Synthesis notes; AI & semantic search; Browser capture). Mark planned-not-shipped topics clearly.
- [ ] **Article template** spec: title, audience tag (new/intermediate/advanced), body using Sans copy + Serif for sampled reading content + Mono keycaps, embedded token-driven diagrams, "Related articles," and a "Shortcuts used here" footer. Includes a **planned-not-shipped callout** style (reuse the `Banner` pattern).
- [ ] **Help-center surface** layout (in-app panel/routed surface; article list in an inspector-width rail; keyboard-navigable; light + dark).

**Contextual-help components (specs, built from existing primitives):**
- [ ] **Help-link** (small `?`/`(i)` affordance → opens a specific article) — define placement rules so it sits calmly next to section headers (Quality checks, Concepts, Priority, Schedule menu, etc.).
- [ ] **Coachmark** (token-driven, anchored, dismissible, first-run-once, fade with `--med`/`--ease`) — built on the `Tooltip` primitive.
- [ ] **First-run callout** and **inline hint** variants — define how they differ from a tooltip and when each is used.
- [ ] **Reuse mandate:** specs must compose `Tooltip`, `Banner`/`BalanceBanner`, `Snackbar`, the empty-state pattern, `TypeIcon`/`Prio`/`Status`/`Stage`/`SchedulerChip`, `Pipeline`, `LineageTree`, and `Kbd` — **no new visual language.**

**Iconography for help:**
- [ ] A mapped set of help/teaching icons drawn **only** from `lucide-react` via the `Icon` wrapper at `strokeWidth ~1.75`, using `design/icon-map.md` semantic names (e.g. `brain`, `gauge`, `extract`, `source`, `card`, `layers`, `shield`, `flame`). No new glyphs; if a concept lacks an icon, propose the closest existing Lucide name rather than drawing one.


---

## Appendix — How this brief was produced (provenance)

This brief was assembled from a structured investigation of the shipped codebase, not from the product docs alone:

- **16 parallel area audits** — one agent per product area (method & mental model; shell/nav/keyboard; import & inbox; reader/read-points/highlights; extraction/distillation/lineage; cards/builder/quality; FSRS review; queue/process/priority/overload; home & analytics; library/search/concepts/tags; maintenance/trash/safety; backup/export/settings; synthesis notes; AI/semantic/trust; browser extension; design system). Each read the real screens, components, and keyboard registry and reported what a new user must learn, where they get confused, and which help is needed.
- **4 synthesis passes** produced Parts A–D from the merged findings.
- **1 adversarial review** stress-tested the drafts for coverage gaps, inaccuracies, missing user journeys, and IA problems; its findings are resolved in **§0.4**.

Two facts to keep front-of-mind while designing: (1) there is **no onboarding today** beyond a single first-run welcome modal (`Onboarding.tsx`) and **no help center / contextual help at all** — you are defining these patterns, not restyling them; (2) the in-app `?` cheat sheet and `⌘K` palette are already generated from a **single shortcut registry** (`shortcuts.ts`) — the keyboard-reference article and every inline keycap in the docs should be generated from that same source so they can never drift.
