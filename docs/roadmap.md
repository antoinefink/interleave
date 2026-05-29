# Roadmap — the build queue

This is the **single source of truth for orchestration**. Each entry is one buildable
task. An agent picks the lowest-numbered unchecked task whose dependencies are all `[x]`,
builds the feature + tests in Docker, then checks the box and records the commit.

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked.
Add `· (branch/commit)` after the title when you start/finish.

Format per task:

```
- [ ] **T0NN — Title** · _deps: T0xx, T0yy_
  Done when: <criterion>.
```

Reference docs: [`concept`](./concept.md) · [`architecture`](./architecture.md) ·
[`domain-model`](./domain-model.md) · [`scheduling-and-priority`](./scheduling-and-priority.md)
· [`design-system`](./design-system.md) · charter: [`../CLAUDE.md`](../CLAUDE.md).

> **UI tasks follow the design kit.** Every screen below has a matching prototype in
> [`../design/kit/`](../design/) — see the screen→milestone map in
> [`design-system.md`](./design-system.md). Use `design/tokens.css` and `lucide-react`; match
> the design pixel-for-pixel.

---

# Part I — Decent MVP (T001–T050)

Goal: a genuinely useful single-person, local-first incremental reading app. **No** PDF,
sync, AI, browser extension, or mobile yet.

## M1 — Foundations & local persistence (T001–T011)
Detailed specs: [`tasks/M1-foundations.md`](./tasks/M1-foundations.md)

- [ ] **T001 — Create the monorepo** · _deps: none_
  Done when: pnpm workspace with `apps/web`, `apps/api`, `packages/{core,db,scheduler,editor,ui,testing}` exists and `make dev`, `make test`, `make typecheck`, `make lint` run from the repo root.
- [ ] **T002 — Tooling + Docker + CI gates** · _deps: T001_
  Done when: strict TypeScript, Biome, Vitest, Playwright, the Dockerfiles/`docker-compose.yml`/`Makefile`, and CI are wired so CI rejects type errors, lint errors, unit failures, and one smoke E2E failure.
- [ ] **T003 — Scaffold the React app** · _deps: T002_
  Done when: `apps/web` runs with Vite + React + TS + TanStack Router + Tailwind v4 and has routes `/`, `/inbox`, `/queue`, `/source/$id`, `/review`, `/search`, `/settings`.
- [ ] **T004 — App shell skeleton** · _deps: T003_
  Done when: left sidebar, top command bar, central work area, right inspector, bottom status bar; every main route uses the same shell and is keyboard-navigable.
- [ ] **T005 — Domain language in `packages/core`** · _deps: T001_
  Done when: documented TS types for `Element`, `ElementType`, `ElementStatus`, `DistillationStage`, `Priority`, `ReviewState`, `ReviewLog`, `Source`, `Document`, `ElementRelation`, used by app and tests.
- [ ] **T006 — Initial Drizzle schema** · _deps: T005_
  Done when: Drizzle tables for `elements`, `documents`, `sources`, `element_relations`, `element_locations`, `review_states`, `review_logs`, `concepts`, `tags`, `element_tags`, `settings`; migrations can create and reset a dev database.
- [ ] **T007 — PGlite local persistence** · _deps: T006, T003_
  Done when: the web app reads/writes via PGlite (IndexedDB VFS) behind a data-layer interface; data persists after page reload and browser restart.
- [ ] **T008 — Repository classes** · _deps: T007_
  Done when: `ElementRepository`, `DocumentRepository`, `ReviewRepository`, `SourceRepository`, `SettingsRepository` exist with tests; no React component writes SQL directly.
- [ ] **T009 — Seed data & fixtures** · _deps: T008_
  Done when: `make seed` creates a realistic demo collection (≥1 source with children, ≥1 extract chain, ≥1 card) usable in dev and tests.
- [ ] **T010 — Universal element inspector** · _deps: T008, T004_
  Done when: the right panel shows any selected element's type, status, stage, priority, due date, parent, children, source, tags, and review metadata.
- [ ] **T011 — Local settings** · _deps: T008_
  Done when: settings for daily review budget, default desired retention, default topic interval, default source priority, keyboard layout, and theme persist locally and are read by scheduler code.

## M2 — Capture & inbox (T012–T014)

- [ ] **T012 — Inbox** · _deps: T008, T004_
  Done when: a source can be created in inbox, listed, viewed, kept, prioritized, accepted into active learning, or deleted.
- [ ] **T013 — Manual text import** · _deps: T012_
  Done when: a "New source" modal accepts title/URL/author/date/body and stores body as both plain text and ProseMirror JSON; a pasted article appears as a source in the inbox.
- [ ] **T014 — Source provenance fields (no auto-fetch)** · _deps: T013_
  Done when: schema/UI capture canonical URL, original URL, accessed date, and snapshot fields for manual imports (no remote fetching yet).

## M3 — Document editor & reading (T015–T018)

- [ ] **T015 — Tiptap document editor** · _deps: T013, T005_
  Done when: a source body renders/edits with a constrained schema (headings, paragraphs, bold, italic, links, blockquotes, lists, code, hr); edits save and reload.
- [ ] **T016 — Stable block IDs** · _deps: T015_
  Done when: every block node has a stable ID preserved across imports and saves (basis for extraction/read-points/sync).
- [ ] **T017 — Read-points** · _deps: T016_
  Done when: `read_point` (block ID + offset) is stored on source/topic; set/jump/auto-update-on-extract work; reopening a source resumes near the last read-point.
- [ ] **T018 — Source reading mode** · _deps: T017, T004_
  Done when: a clean reader shows title, metadata, body, read-point marker, extracted-span markers, and keyboard actions — pleasant enough to process a long article.

## M4 — Highlights, extraction & lineage (T019–T026)

- [ ] **T019 — Text-selection toolbar** · _deps: T018_
  Done when: selecting text in the reader shows an inline toolbar (Extract, Cloze, Highlight, Copy, Cancel) without breaking editor selection.
- [ ] **T020 — Highlights** · _deps: T019_
  Done when: highlight marks persist as document annotations and can be removed (highlights are NOT extracts).
- [ ] **T021 — Extraction** · _deps: T019, T008_
  Done when: Extract creates a child `extract` element with its own document body, source reference, parent link, source location, inherited priority, and scheduled review state; the parent text is visually marked extracted.
- [ ] **T022 — Source locations** · _deps: T021_
  Done when: each extract stores source element ID, block IDs, start/end offsets, and a human-readable label; the user can jump from an extract back to the exact paragraph.
- [ ] **T023 — Element hierarchy view** · _deps: T021, T010_
  Done when: source pages show a tree of children (extracts/sub-extracts/cards) and extract pages show parent + children; navigation works both directions.
- [ ] **T024 — Extract review mode** · _deps: T021_
  Done when: extracts appear as readable mini-topics with trim/rewrite/split/convert/postpone/done/delete; an extract can move raw → clean → atomic.
- [ ] **T025 — Extract splitting (sub-extracts)** · _deps: T024, T022_
  Done when: selecting part of an extract creates a sub-extract with preserved lineage (source → extract → sub-extract).
- [ ] **T026 — Mark processed on source text** · _deps: T020_
  Done when: processed spans can be collapsed/dimmed so the user can hide processed text without deleting the archived source.

## M5 — Priority, scheduling & queue (T027–T031)

- [ ] **T027 — Priorities** · _deps: T008_
  Done when: priority is stored numerically and surfaced as A/B/C/D; every source/extract/card can be raised/lowered.
- [ ] **T028 — Topic/extract scheduler** · _deps: T027, T005_
  Done when: a non-card scheduler computes `due_at` from priority, stage, last-seen, and action; items can be scheduled for tomorrow/next week/next month/manual. (See [`scheduling-and-priority`](./scheduling-and-priority.md).)
- [ ] **T029 — Due queue** · _deps: T028, T004_
  Done when: `/queue` shows due sources/extracts/cards sorted by priority then due date, with filters for type/concept/status.
- [ ] **T030 — Queue actions** · _deps: T029_
  Done when: each due item supports open/postpone/raise/lower/done/dismiss/delete without leaving the list.
- [ ] **T031 — "Process queue" learning loop** · _deps: T030_
  Done when: a single mode shows one element at a time and advances after action; the user can process ten mixed elements without returning to a list.

## M6 — Cards (T032–T035)

- [ ] **T032 — Card model & templates** · _deps: T008, T005_
  Done when: `card` elements have `card_type`, `prompt`, `answer`, `cloze_text`, `source_extract_id`, `sibling_group_id`; Q&A and cloze types exist as first-class elements with parents, priority, and review state.
- [ ] **T033 — Q&A card creation** · _deps: T032, T024_
  Done when: from an extract, "Create Q&A card" shows prompt/answer/source-context/preview; the card appears in review.
- [ ] **T034 — Cloze card creation** · _deps: T032, T024_
  Done when: selecting text in an extract creates a cloze card linked to the extract; clozes store `{{c1::answer}}` text plus structured cloze metadata.
- [ ] **T035 — Card-quality warnings** · _deps: T033, T034_
  Done when: warnings flag prompt-too-long, answer-too-long, missing source, multiple clozes, ambiguous pronouns, and empty answer before activation.

## M7 — FSRS review (T036–T040)

- [ ] **T036 — Integrate `ts-fsrs`** · _deps: T032_
  Done when: a `SchedulerService` wraps `ts-fsrs` and persists FSRS state (due/stability/difficulty/elapsed/scheduled/reps/lapses) on `review_states`; new cards reschedule by rating.
- [ ] **T037 — Review UI** · _deps: T036, T004_
  Done when: `/review` shows prompt → reveal → grade Again/Hard/Good/Easy, logs response time, updates scheduler state, advances; every review writes a durable `review_logs` row.
- [ ] **T038 — Review editing** · _deps: T037_
  Done when: during review the user can edit prompt/answer, open source, suspend, delete, and flag-as-bad — fixing a bad card at the moment it fails.
- [ ] **T039 — Sibling burying** · _deps: T037, T032_
  Done when: cards from the same extract/cloze group don't appear back-to-back in a session unless burying is disabled.
- [ ] **T040 — Basic leech detection** · _deps: T037_
  Done when: a card is marked leech after repeated failures (warn at 4 lapses) and appears in a cleanup view with rewrite/suspend/delete.

## M8 — Organize: concepts, tags, search, references (T041–T043)

- [ ] **T041 — Concepts & tags** · _deps: T008_
  Done when: concepts (hierarchical) and tags (flat) can be created/assigned; elements filter by concept and tags.
- [ ] **T042 — Search** · _deps: T008_
  Done when: local full-text search over source title/body, extract body, card prompt/answer, and tags returns sources/extracts/cards quickly with simple ranking.
- [ ] **T043 — Source/reference display** · _deps: T022, T032_
  Done when: every extract and card shows source title/URL/author/date/location (review hides it until answer reveal); nothing feels orphaned.

## M9 — Safety, analytics & backup (T044–T047)

- [ ] **T044 — Deletion, trash & undo** · _deps: T008_
  Done when: soft delete + trash view + restore exist; command-level undo covers delete/mark-done/suspend/bulk-postpone; accidental deletion is recoverable.
- [ ] **T045 — Basic analytics** · _deps: T037, T028_
  Done when: a view shows daily reviews, due cards/topics, new cards/extracts, deletions, leeches, and 30-day retention.
- [ ] **T046 — Import/process balance warnings** · _deps: T045_
  Done when: the app warns when imports outpace processing, showing sources imported / extracts created / cards created / reviews due this week.
- [ ] **T047 — Backup / export** · _deps: T008_
  Done when: local export to JSON (+ media) covers elements/documents/review-states/review-logs/sources/relations/settings/schema-version, and re-imports into a fresh app.

## M10 — Keyboard, E2E & ship MVP (T048–T050)

- [ ] **T048 — Keyboard shortcuts & command palette** · _deps: T031, T037, T021_
  Done when: shortcuts exist for next-item, extract, cloze, postpone, done, delete, raise/lower priority, search, open-parent, open-source, and command palette; the main workflow is mouse-free.
- [ ] **T049 — MVP end-to-end tests** · _deps: T048, T047_
  Done when: Playwright covers import → activate → read → extract → convert-to-card → review → reschedule → search → backup.
- [ ] **T050 — Ship MVP as local-first PWA** · _deps: T049_
  Done when: installability, offline loading, persistence warnings, backup prompts, and onboarding are polished; one person can use it daily for a week with no manual DB edits.

---

# Part II — Gold-standard application (T051–T100)

Goal: turn the useful MVP into a serious long-term system — imports, PDFs, capture, sync,
overload management, semantic search, AI, media, reliability, scale.

## M11 — Backend & sync foundations (T051–T057)

- [ ] **T051 — Backend API skeleton** · _deps: T050_
  Done when: `apps/api` (Hono) has auth middleware, typed RPC routes, health checks, structured errors; the frontend can call a typed endpoint in dev.
- [ ] **T052 — Server PostgreSQL schema** · _deps: T051, T006_
  Done when: the local schema is mirrored in PostgreSQL with server-only fields (user/device/sync version/storage keys/audit timestamps); server migrations create a working DB.
- [ ] **T053 — Authentication** · _deps: T052_
  Done when: email/password or passkey-first auth identifies the user and protects cloud data; self-host/personal mode remains possible.
- [ ] **T054 — Operation-log sync design** · _deps: T052_
  Done when: every local mutation appends a deterministic op (`create_element`, `update_element`, …) to `operation_log`.
- [ ] **T055 — One-way backup sync** · _deps: T054, T053_
  Done when: a user can back up local data to the server and restore onto a fresh browser profile (no multi-device conflict resolution yet).
- [ ] **T056 — Two-way sync** · _deps: T055_
  Done when: device IDs, op IDs, sync cursors, conflict detection, and safe-field LWW let two devices converge after divergent edits (documents not silently merged).
- [ ] **T057 — Conflict UI** · _deps: T056_
  Done when: same-document/card edits on two devices surface a resolver (local/remote/source history); destructive conflicts require explicit choice.

## M12 — Workers, storage & web import (T058–T061)

- [ ] **T058 — Background job worker** · _deps: T052_
  Done when: `apps/worker` with pg-boss processes import/snapshot/AI/embedding/cleanup jobs; the API can enqueue an import job.
- [ ] **T059 — Object storage** · _deps: T058_
  Done when: S3-compatible storage handles PDFs/images/clips/snapshots/backups via presigned URLs; the app can upload/retrieve a snapshot.
- [ ] **T060 — Automatic URL import** · _deps: T058, T059_
  Done when: URL import fetches the page, runs Readability, stores the original snapshot + cleaned HTML, converts to ProseMirror JSON, and creates a source.
- [ ] **T061 — Canonical URL & duplicate detection** · _deps: T060_
  Done when: URLs are normalized (tracking params removed), already-imported canonical URLs are detected, content hashes computed; re-importing prompts reuse-or-new-version.

## M13 — Browser extension (T062–T063)

- [ ] **T062 — Browser extension MVP** · _deps: T060, T053_
  Done when: a Manifest V3 extension can "save page" / "save selection" / "save to inbox" via its service worker.
- [ ] **T063 — Side-panel capture** · _deps: T062_
  Done when: the extension's Side Panel shows inbox/import UI beside the page and can save a selection with priority + reason.

## M14 — PDF / EPUB / document import (T064–T070)

- [ ] **T064 — PDF import** · _deps: T059, T018_
  Done when: PDF.js renders PDFs, extracts selectable text, tracks page read-points, and stores page-level source locations; PDF text extracts link to page numbers.
- [ ] **T065 — PDF region extraction** · _deps: T064_
  Done when: drawing a rectangle around a figure/table creates an image extract with page number + coordinates as its own scheduled topic.
- [ ] **T066 — OCR fallback** · _deps: T064, T058_
  Done when: OCR jobs produce searchable/extractable text for scanned pages/images with confidence metadata attached to page/region (not blindly inserted into the body).
- [ ] **T067 — EPUB import** · _deps: T059, T018_
  Done when: EPUBs parse into book/chapter/section sources preserving chapters/headings/footnotes/locations; a chapter can be read incrementally.
- [ ] **T068 — Markdown & HTML import/export** · _deps: T015_
  Done when: Markdown and HTML are first-class imports preserving code/headings/links/images; exported Markdown round-trips back with acceptable fidelity.
- [ ] **T069 — Highlight import (Readwise/Kindle-style)** · _deps: T012_
  Done when: a generic highlight import format + adapters turn external highlights into inbox extracts (not active cards).
- [ ] **T070 — Anki import/export** · _deps: T032_
  Done when: cards export to Anki-compatible packages/CSV with source refs, and Anki cards import as card elements preserving review history when available.

## M15 — Rich media cards (T071–T075)

- [ ] **T071 — Image occlusion** · _deps: T065_
  Done when: image-occlusion cards generate from image extracts with masks/regions stored separately from the base image; one diagram yields multiple sibling cards.
- [ ] **T072 — Formula & code cards** · _deps: T015, T032_
  Done when: MathJax/LaTeX, syntax-highlighted code, and code-specific prompts render correctly in source/extract/review.
- [ ] **T073 — Video import** · _deps: T059_
  Done when: YouTube/local video metadata + transcript (if available) + timestamped read-points create video sources resumable from a saved timestamp.
- [ ] **T074 — Video/audio clip extraction** · _deps: T073_
  Done when: selecting start/end timestamps creates a scheduled `media_fragment` storing transcript segment + clip metadata + source timestamp.
- [ ] **T075 — Audio review cards** · _deps: T074, T036_
  Done when: audio prompt/answer/looped-fragment cards can be reviewed as active recall.

## M16 — Advanced scheduling & overload (T076–T082)

- [ ] **T076 — Advanced auto-sort** · _deps: T029, T036_
  Done when: queue sorting uses a scoring function over priority, due date, retrievability, type, sibling spacing, concept diversity, and session mode.
- [ ] **T077 — Auto-postpone** · _deps: T076_
  Done when: when due load exceeds the daily budget, low-priority topics then low-priority mature cards are postponed first while high-priority fragile cards are protected.
- [ ] **T078 — Catch-up & vacation modes** · _deps: T077_
  Done when: catch-up recovers from backlog and vacation pre-adjusts future load, both showing the cost of postponement.
- [ ] **T079 — Desired retention by priority/concept** · _deps: T036, T041_
  Done when: retention targets can differ by concept or priority band.
- [ ] **T080 — FSRS parameter optimization** · _deps: T036_
  Done when: accumulated review history can optimize FSRS parameters per preset/concept, with suggested updates and a workload-impact preview.
- [ ] **T081 — Workload simulation** · _deps: T080, T079_
  Done when: the user can preview how load changes from altering desired retention, adding cards, or postponing low-priority material before committing.
- [ ] **T082 — Mature-card retirement** · _deps: T036_
  Done when: cards can be retired/archived/moved to very-low retention so low-value mature cards leave active review gracefully.

## M17 — Analytics, quality & maintenance (T083–T086)

- [ ] **T083 — Source-yield analytics** · _deps: T045_
  Done when: each source shows read %, extracts/cards/mature-cards created, leeches, and time spent; low-yield sources are identifiable.
- [ ] **T084 — Extract-stagnation analytics** · _deps: T045, T024_
  Done when: extracts that keep returning without progressing are detected and surfaced with rewrite/convert/postpone/delete suggestions.
- [ ] **T085 — Leech remediation workflow** · _deps: T040_
  Done when: a repair screen offers split/add-context/open-source/back-to-extract/lower-priority/suspend/delete for repeated failures.
- [ ] **T086 — Minimum-information-principle checks** · _deps: T035_
  Done when: quality warnings extend to multiple facts, long lists, vague pronouns, unsupported claims, similar answers, no/outdated source, and oversized clozes.

## M18 — Semantic search & AI (T087–T095)

- [ ] **T087 — Semantic search** · _deps: T052, T042_
  Done when: embeddings for sources/extracts/cards are stored in Postgres/pgvector (optionally local) and search finds conceptually related material without keyword match.
- [ ] **T088 — Related-item suggestions** · _deps: T087_
  Done when: each element shows similar extracts, possible duplicates, prerequisite concepts, and sibling sources.
- [ ] **T089 — Contradiction detection** · _deps: T087_
  Done when: semantic similarity + claim metadata flag possibly conflicting cards/extracts ("newer source conflicts with older card").
- [ ] **T090 — Staleness & expiry** · _deps: T032_
  Done when: `fact_stability`, `valid_from`, `valid_until`, `jurisdiction`, `software_version`, `review_by` let facts expire and trigger verification.
- [ ] **T091 — Source-reliability metadata** · _deps: T043_
  Done when: source type, author, date, primary/secondary/tertiary, confidence, and notes can show reliability/uncertainty on important cards.
- [ ] **T092 — Verification tasks** · _deps: T090, T091_
  Done when: scheduled `task` elements ("verify this claim", "find better source", "update outdated card", "check current version") keep time-sensitive knowledge from rotting.
- [ ] **T093 — AI-assisted distillation** · _deps: T058, T024_
  Done when: AI actions (explain/simplify/suggest Q&A/suggest cloze/detect ambiguity/propose prerequisites/summarize) help formulation but never schedule unapproved cards (drafts only).
- [ ] **T094 — AI source grounding** · _deps: T093_
  Done when: every AI suggestion links back to selected source text and AI output is stored separately from source quotes.
- [ ] **T095 — Incremental writing / synthesis notes** · _deps: T024, T028_
  Done when: scheduled `synthesis_note` elements collect linked extracts/cards and return for refinement.

## M19 — Review modes, desktop & encryption (T096–T098)

- [ ] **T096 — Branch/subset/semantic review modes** · _deps: T087, T037_
  Done when: review by concept, source, search query, branch, stale items, leeches, or random audit works outside normal scheduling.
- [ ] **T097 — Tauri desktop app** · _deps: T050_
  Done when: `apps/desktop` wraps the web app with local file access, native menus, global shortcuts, clipboard helpers, filesystem backups, and local media storage.
- [ ] **T098 — End-to-end encryption for sync** · _deps: T055_
  Done when: user content is encrypted before upload where practical (at minimum encrypted backups; ideally per-user keys + device recovery) so server compromise doesn't trivially reveal data.

## M20 — Scale & hardening (T099–T100)

- [ ] **T099 — Large-collection maintenance tools** · _deps: T044, T083_
  Done when: dedup, orphan-media cleanup, broken-source reports, cards-without-sources, bulk low-priority postpone/archive, and DB integrity checks keep a 100k-element collection maintainable.
- [ ] **T100 — Gold-standard QA & performance hardening** · _deps: T099, T096, T097, T098_
  Done when: load-tested at 100k cards / 100k extracts / thousands of sources / large PDFs / long histories / multiple devices, with indexes, rendering, search, queue calc, and sync optimized so the app stays fast, safe, backed up, and searchable after years of use.

---

## Progress log

Record notable completions / decisions here as tasks land (newest first).

- _(none yet)_
</content>
