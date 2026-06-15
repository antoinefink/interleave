# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Knowledge Processing

### Source

An imported or manually created body of material that the user may read, triage, extract from, and schedule for later processing.

### Inbox source

A source that has been captured but not yet accepted into the user's active knowledge-processing rotation.

### Source provenance

The origin and reliability context attached to a source, including where it came from and how the app should describe that origin to the user.

### Capture origin

The feeder a source entered the system through — browser-extension capture, URL import, highlight import, a manual note, or a file import — recorded durably at creation so the inbox can group a morning's arrivals by where they came from.

Capture origin is a single provenance facet distinct from source type (the kind of material) and reliability. It is recorded only going forward; sources captured before it was tracked have no recorded origin and group under an explicit "Other" bucket rather than being guessed.

### Topic

A schedulable knowledge-processing element that groups or narrows work under a broader source or idea.

A Topic can carry its own document-like reading surface while still inheriting source lineage from the material it belongs to. Extracts made from that surface should preserve the Topic as the local location while keeping the original Source as evidence root.

### Concept

A hierarchical first-class organizing element used to group knowledge work by domain and to carry concept-scoped review policy.

A Concept is distinct from a Topic: a Topic is schedulable work, while a Concept is an organizing axis that can have child concepts, member elements, and recall-retention policy for assigned cards.

### Knowledge-state receipt

A read-only maturity summary for a Topic or Concept, derived from durable processing, review, retention, and verification facts.

Knowledge-state receipts explain current maturity without changing scheduling, creating history, or deciding future work. Surfaces can render or compose them, but commands remain responsible for mutations.

### Knowledge graduation

The current-state judgment that a Topic or Concept has enough active-card, review, maturity, retention, and freshness evidence to count as mature knowledge.

Knowledge graduation is not a stored lifecycle transition by itself. Until a separate ledger owns history, it is a deterministic receipt that can appear or disappear as the underlying evidence changes.

### Source lineage

The chain that lets a derived element point back to the source evidence it came from, including source identity, selected text, citation or link metadata, and a location the reader can jump to.

Source lineage is different from general hierarchy: it is evidence grounding, so it must stay coherent when extracts, cards, or media fragments are inspected or reviewed.

### Lineage tombstone

A soft-deleted middle element preserved in tombstone-aware lineage as a muted anchor so its live descendants never vanish from their own chain. Deleting an element with live descendants must never silently orphan them (a hard delete would null `parentId`/`sourceId`) or silently hide them from their own work surface; instead the deleted node remains revealable as a tombstone that the descendants still hang from, with one-click restore.

A lineage tombstone is a display state derived from the existing `deleted` status, not a new status or operation. Live descendants can stay visible while tombstones are collapsed by default, but the tombstone-aware lineage must still keep restore and source-lineage recovery available on demand.

### Browser capture

A browser-extension initiated import flow that turns the current page or selected browser content into a Source while leaving validation, activation, and local reader navigation inside the desktop app.

Browser capture surfaces may collect selected text, page context, and priority intent, but they remain untrusted request surfaces. The desktop app owns pairing validation, source creation, activation, and reader navigation.

### Read now

The inbox action that accepts a source into active reading, gives it an attention return date, and immediately opens the local reader for that source.

### Queue soon

The inbox action that accepts a source into the Due queue by scheduling it for immediate attention without opening the local reader.

Queue soon is distinct from Read now because it does not imply the user started reading, and distinct from Save for later because it creates due work instead of parking the source.

### Save for later

The inbox action that parks a source: it records a deliberate deferral without creating due work and without treating the source as abandoned.

### Parked source

A source the user deliberately set aside for later, visible in inventory but excluded from Inbox, Due queue, and daily-work routing until the user restores or schedules it.

### Parked resurfacing

The maintenance process that periodically brings old Parked sources back to the user's attention for an explicit keep, queue, or let-go decision without automatically scheduling them.

Resurfacing is not queue eligibility: it is a review prompt for deferred intent, and the user's decision owns any durable status change.

### Chronic-postpone reckoning

The maintenance process that surfaces work that has been postponed repeatedly and asks for an explicit keep, demote, done, or delete decision before further silent recession.

Reckoning uses effective postpone debt, not lifetime history: a keep-style decision starts a new counting window while preserving the old postpones as audit evidence. While an item is in reckoning, attention scheduling should stop pushing it farther away until the user makes a decision.

### Topic fallow

A deliberate rest state for a Topic that moves the topic and its eligible attention-scheduled descendants to a chosen return date without treating the work as missed, abandoned, or chronically postponed.

Topic fallow is attention-only. It does not pause descendant card reviews or mutate FSRS review state; cards can continue reviewing while the surrounding topic work rests.

### Source reader

The local reading surface for processing a source inside the app, distinct from opening the source's external canonical URL.

### Extract

A scheduled element created from selected source or extract material so the user can process that fragment independently while preserving source lineage.

An Extract is not just a highlight: it carries its own lifecycle, priority, distillation stage, due date, body, and source location so it can become cleaner notes, child extracts, or cards.

### Atomic statement

An Extract distillation stage for a single self-contained idea that is ready to become an active-recall card without further prose cleanup.

Atomic statements remain Extracts until a card is explicitly created from them. They use attention scheduling and source lineage, not FSRS card scheduling.

### Selection toolbar

The floating action surface that appears over a live text selection in a reader or extract workspace and offers selection-scoped actions such as extract, sub-extract, highlight, copy, or card-entry actions.

The toolbar is tied to the current visible selection and should remain reachable without becoming the persistence boundary itself; the action it dispatches owns any durable mutation.

### Read point

The saved position inside a Source that tells the Source reader where the user should resume.

A Read point is not a schedule. It answers where reading stopped, while the Attention scheduler answers when the source should return.

### Source block processing

The per-block progress model that records what happened to each stable block in a Source as the user reads, ignores, extracts from, or defers that block.

Source block processing is source progress, not decoration: visual marks may display the outcome, but completion, scheduling, analytics, and later source edits must reason from the durable block outcome.

### Block processing outcome

The explicit result assigned to a source block, distinguishing unresolved reading work from blocks that produced output, were intentionally ignored, were processed without output, need later attention, or became stale after the source text changed.

### Content staleness

A derived element (Extract, atomic statement, or card) whose body may no longer match its Source because a source block it was distilled from has since been edited — surfaced as a queryable "needs re-verify" flag that the user resolves by confirming, rebasing, or detaching the derived knowledge.

Content staleness is distinct from a block's own *stale after edit* Block processing outcome (which marks the block, not its descendants) and from calendar staleness (a fact going out of date with the passage of time, not with a source edit). It is additive metadata, never a lifecycle status: a content-stale card keeps its schedule until the user resolves it, and the flag clears automatically when the source block's content is restored.

### Re-verify

The per-source, session-capped drain by which a user resolves Content staleness on flagged outputs, with three verbs: **confirm** (the drift is immaterial — clear the flag), **rebase** (re-anchor to the corrected source text; for raw/clean extracts, re-derive the body), and **detach** (freeze a provenance snapshot and keep the output standalone, so a future edit of that block never re-flags it). Each resolution is op-logged and undoable through its sitting's receipt; resolving clears the flag everywhere it shows.

A **detach** is *not* a Lineage tombstone (a soft-deleted middle element): the output stays live and its `source_locations` anchor is never touched. The standalone guarantee comes from a frozen detach-snapshot row that the staleness-propagation walk skips, so the output keeps its lineage while opting out of future re-flagging.

### Source yield

The durable productive output attributed to processing a Source or Extract, such as derived extracts, cards, synthesis work, and honorable non-card outcomes.

Source yield is evidence for attention scheduling and stagnation analysis, not a card-only score. It should come from lineage and processing outcomes rather than from renderer inference or lifetime totals treated as one visit.

### Attention scheduler

The scheduling model for sources, topics, extracts, and other non-card work that should return for further processing rather than recall testing.

Attention scheduling is distinct from active-recall scheduling: it decides when to bring work back to the user's attention, not whether the user can remember an answer.

Attention scheduling includes both heuristic returns and explicit user commands. Heuristic returns may use prior processing evidence, while explicit commands such as Queue soon or a manual return date express user intent directly and should not be reinterpreted as heuristic recency evidence.

### Adaptive attention interval

A learned adjustment to an attention-scheduled element's return cadence based on the productive yield of recent processing.

Adaptive attention intervals are bounded attention-scheduler state. They do not apply to FSRS card reviews, and any persisted change should remain explainable, transactional, and undoable like the schedule change it modifies.

### Attention schedule reason

A structured explanation for why an attention-scheduled element is returning sooner, later, or unchanged at its current return date.

An Attention schedule reason is trusted only while durable scheduling evidence still governs that return date. It is not renderer inference, and it does not apply to FSRS card reviews or explicit user commands such as Queue soon.

### Descendant health

The recent review-health signal from cards derived from a Source, used only to decide whether that parent Source should return sooner for attention.

Descendant health is evidence about the Source's surrounding comprehension debt, not a card schedule. It can influence a Source's Attention scheduler decision while FSRS remains the owner of each descendant card's review state.

### Due queue

The currently actionable processing set: due active-recall cards plus due attention-scheduled sources, topics, extracts, and similar non-card work.

Due queue work is distinct from inbox sources, which still need triage, and from future review load, which may be forecast without being actionable yet.

### Queue time estimate

A read-only minute estimate for current Due queue work, scoped to the queue-eligible set and labeled by whether timing was learned or defaulted.

Queue time estimates should preserve the distinction between active-recall card reviews and attention-scheduled processing work. They explain expected effort without changing scheduling, priority, review state, or queue eligibility.

### Daily budget

The user's intended amount of Due queue work for a day, expressed as estimated minutes rather than item count.

The Daily budget is a soft overload boundary, not a hard eligibility rule: it informs gauges, session planning, and postponement suggestions while the Due queue remains the source of what is actionable.

### Distillation quota

The protected share of a Daily budget reserved for due Extract distillation work before card-heavy fill or overload trimming can consume the whole day.

The quota changes daily composition, not due dates or priority scores. When no due Extract distillation work exists, the share returns to other Due queue work instead of creating make-work.

### Session assembly

The read-only process that selects a bounded deck of current Due queue work to fit a target amount of estimated time before handing that exact deck to the processing loop.

Session assembly is distinct from Auto-postpone: it does not move work or change schedules. Acceptance creates a short-lived execution handoff, not a durable scheduling decision.

### Auto-postpone

The overload-management process that moves lower-value due work later so the remaining Due queue better fits the Daily budget.

Auto-postpone is advisory and bounded by protection rules. It should preserve source lineage, review state, and operation-log auditability while avoiding high-priority, fragile, or otherwise protected work.

### Standing auto-postpone policy

The opt-in form of Auto-postpone that evaluates the current local day automatically before trusted Due queue or daily-work reads.

Standing auto-postpone is not owned by renderer clocks or wall-clock jobs. It writes a durable daily receipt when it moves work, and a day already evaluated by the policy must not be trimmed again unless a future policy explicitly defines re-evaluation.

### Extract aging policy

The opt-in process that moves repeatedly returned, unproductive Extracts out of the Due queue by demoting them to an honorable reference state instead of deleting them.

Extract aging uses backend-owned stagnation and queue-eligibility evidence, writes a durable receipt when it acts automatically or by preview, and must remain reversible without treating the demotion as user-authored distillation progress.

### Auto-postpone receipt

The daily explanation of an automatic Auto-postpone run, including what was moved, which budget impact remains, and the batch that can be targeted for undo.

The receipt is distinct from a toast: it persists for the local day, is backed by operation-log evidence, and can become `undone` without deleting the historical postponement facts.

### System-owned task

A scheduled Task element created and maintained by Interleave itself for a product ritual or integrity workflow, not by generic user task creation.

System-owned tasks can appear in the Due queue for discoverability, but their lifecycle belongs to a dedicated service because generic queue actions cannot safely preserve singleton, cadence, mirror-row, or progress invariants.

### Weekly review

The recurring system-owned task that brings the weekly ledger, priority-integrity receipt, and maintenance decision prompts into one resumable session.

Weekly review is a ritual surface, not a dashboard: it arrives through attention scheduling, opens on its dedicated route, composes existing read models and maintenance commands, and reschedules itself after completion or dismissal.

### Queue eligibility

The backend-owned decision that an element belongs in the current Due queue at a specific read clock.

Queue eligibility is stricter than having scheduler history: terminal statuses, deleted elements, retired cards, missing return dates, and future return dates can all make an inventory row not actionable even when it has a due-related timestamp.

### Inventory scheduler state

The scheduler label and diagnostics shown on Browse, Search, Concept members, or related inventory surfaces for a live element.

Inventory scheduler state may explain why an item is not in the Due queue, such as "Done", "No return scheduled", or "Returns Jun 13". Action-colored due badges should be reserved for queue-eligible rows.

### Import/process balance

A read-only advisory signal that compares how much material the user has imported with how much processing output they have produced.

Import/process balance can be analytically imbalanced even when no due queue work exists. UI actions from this signal should route only to surfaces that currently contain work, such as inbox triage or the due queue.

### Priority integrity

Priority integrity is the advisory measure of whether recently serviced, deferred, and live work still reflects the user's declared priorities rather than letting high-priority material drift behind lower-priority processing.

It is a read-only receipt: it explains drift from existing review, attention, and scheduling facts, but it does not reschedule, demote, or mutate work by itself.

### Article image

An image discovered while importing a web article and copied into the local Asset vault so the source remains readable without hotlinking the original remote image.

Article images render from `article-image://<source_id>/<asset_id>` references in the source document. Electron main resolves those ids to source-owned image assets; the renderer never receives raw filesystem paths or remote image URLs.

## Public Surfaces

### Public site

A browser-only presentation surface for explaining or demonstrating Interleave outside the desktop app.

It may reuse design tokens, static assets, and non-persistent demos, but it does not participate in local-first storage and must not expose desktop capabilities such as preload APIs, SQLite, or filesystem access.

## Discovery

### Collection Explorer

The shared discovery surface that presents the user's collection through explicit Browse and Search modes.

Browse mode is inventory-first: it lists live browsable elements by facets. Search mode is retrieval-first: it finds indexed source, extract, and card content by keyword or semantic match.

### Search result

A source, extract, or card returned from a user's library search, enriched enough for the user to inspect its priority, concept context, scheduling state, and source lineage before opening it.

### Semantic search

The local discovery capability that ranks sources, extracts, and cards by meaning rather than only by exact keyword overlap.

Semantic search is part of the local-first knowledge store: the app owns the embedding model, derived vector index, and fallback behavior on-device, and remote embedding providers are not a user-selectable mode.

### Embedding

A derived numeric representation of searchable source, extract, or card text used only for local semantic retrieval.

An Embedding belongs to the model that produced it. Equal vector length is not enough to compare two embeddings safely; semantic consumers should compare only embeddings from the same model space.

### Local vector index

The rebuildable on-device index that stores embeddings for nearest-neighbor semantic retrieval while the canonical knowledge data remains in the local database and asset vault.

The Local vector index is derived state, not source lineage or user-authored content. If its shape no longer matches the active embedding model, it can be cleared and rebuilt from canonical elements. It is self-maintaining: a background supervisor brings it up to date after launch and keeps it healthy without user action. When the real embedding model cannot load, the producer runs in a degraded fallback mode whose vectors are never persisted into the index (so the index never silently fills with meaningless results), and its coverage and health are surfaced honestly rather than reported only as a count. Background maintenance may be deferred under a power or cost policy; such a pause is surfaced as a distinct state rather than as a stalled build, and a manual rebuild always overrides it.

### Related item

A derived suggestion that points from the current element to another live element that may be similar, duplicate-like, or useful context.

Related items are advisory discovery hints. They do not create durable relations, mutate lineage, or merge elements by themselves.

### Contradiction detection

The advisory process that compares semantically similar claim-bearing elements for signs that one may oppose or supersede another.

Contradiction detection is suggestive, not authoritative: it can surface possible conflicts for inspection, but it does not edit, suspend, merge, or reschedule the elements it compares.

### Facet

A filter dimension on a search or library surface that narrows a result set by a project-specific attribute such as element type, concept, or priority.

### Drill-down count

A facet count that answers how many results would appear if that facet value were selected while keeping the other active facets.

The count deliberately drops its own facet predicate but preserves the other active predicates, so it is distinct from a global volume or total membership count.

### Concept volume

The global count of live elements assigned to a concept, independent of any active search query or filter.

## Active Recall

### Card

An active-recall prompt and answer derived from earlier knowledge-processing work, reviewed to test whether the user can recall the idea.

### Active card

A card that has left drafting and participates in active recall review.

### Card builder

The authoring surface that turns selected source or extract material into a draft Q&A or cloze card while keeping recall preview, priority, scheduling, and quality feedback in one flow.

### Conversion session

A short-lived batch authoring flow that presents a frozen ordered set of due atomic statements for card creation while revalidating each item against current source lineage before any durable mutation.

The session snapshot stabilizes navigation, not authorization: card creation, AI draft prefetch, and fate changes must still prove the item is live, grounded, and unchanged at the desktop service boundary.

### Card quality check

A live guardrail in the card builder that evaluates whether a draft card is blocked, advisory, or ready without changing card creation semantics.

Blockers prevent creation, warnings remain advisory, and passed checks can be inspected without dominating dense authoring surfaces.

### Review session

The flow that presents due cards for recall practice and records the user's grading outcome.

### Review log

The durable, append-only record of one graded card review, including the grade, review timing, and the scheduling transition produced by that grade.

Review logs are the source of truth for historical review stats. Aggregate reports derive from them later rather than being captured in a separate analytics history. Not every review-log row is a grade: a Card re-stabilization writes a non-grade marker row (a re-stabilization marker) into the same table, which every stats reader excludes so it never counts as a real review.

### Review activity

Review-log volume bucketed by the user's local calendar day or year so the user can understand consistency, streaks, and review load over time.

Review activity is analytics over completed reviews, not the set of currently due cards and not the Review session flow itself.

### Reveal

The review action that intentionally exposes a card's answer and source context after the user has attempted recall.

Before reveal, answer and source context stay hidden across the review surface, global shortcuts, and persistent inspector so the user cannot accidentally inspect the evidence first.

### Card re-stabilization

The card-edit write barrier: when a card's answer is rewritten substantively, its persisted FSRS schedule is demoted to a short confirmation interval so the new wording is re-verified soon instead of inheriting the stability its old formulation earned. A typo edit changes nothing.

Re-stabilization mutates only the persisted review state — never the in-flight review the user is grading — and is the user's explicit choice (keep-schedule vs re-verify), reversible through a guarded "Keep schedule instead" receipt. It is recorded as a non-grade re-stabilization marker on the Review log, excluded from every review stat.

## Local Durability

### Local backup

A restore-ready copy of the user's local application data, covering both the canonical local database and the filesystem-owned asset vault.

### Automatic backup

A local backup created quietly by the desktop app lifecycle rather than by a direct user command.

Automatic backups are owned by automatic retention and may be thinned or deleted by that policy. They are distinct from manual backups, even when both use the same restore-ready backup format.

### Manual backup

A local backup explicitly created by the user.

Manual backups may satisfy an automatic due check because they prove the data was recently backed up, but automatic retention must not prune them.

### Asset vault

The filesystem-owned store for large internal data such as source files, media, snapshots, and app-managed artifacts, with the local database retaining metadata and references.

The Asset vault is distinct from a user export artifact: vault files support the app's own durable state, while user export artifacts are files the user is expected to find and use outside the app.

### User export artifact

A file produced by Interleave for use outside the app, such as a Markdown export, CSV export, or Anki package.

User export artifacts are written by trusted desktop code to a standard user-visible destination and are reported back to the renderer with display-safe metadata, not raw filesystem paths.

### Local data replacement

A high-risk durability operation that swaps or rebuilds the canonical local database and Asset vault as one unit.

Local data replacement is an app-lifecycle boundary, not a normal domain mutation. Backup restore and fresh start reset both use it, and normal work resumes only after the app restarts into the replacement store.

### Restore-ready backup

A backup artifact whose structure and manifest are sufficient for a restore flow to verify and rebuild the local store.

### Backup restore

The data-recovery flow that verifies a restore-ready backup and replaces the current local database and Asset vault with that backup's contents.

### Fresh start reset

The destructive local durability action that discards the current knowledge store and rebuilds an empty local store while preserving recovery and export artifacts.

### Automatic retention

The policy that thins automatic backups over time and enforces a storage cap while preserving manual backups.

### Operation log

The durable, append-only record of every meaningful mutation, where each entry is a command-shaped row written in the same transaction as the state change it describes.
*Avoid:* op log, oplog

The operation log is the substrate for command-level undo, audit, backup, and eventual sync. It is never edited or deleted; reversing a command appends a new inverse entry rather than removing the original, so the log stays append-only and auditable. A mutation that changes durable user data without a matching log entry is a defect.

### Operation batch

The set of operation-log entries produced by one bulk action — a bulk postpone, an inbox bulk sweep, an auto-postpone or extract-aging run — tagged with a shared batch id so the whole action can be undone as a single unit.

A single-op action carries no batch id. The batch id is the durable handle a receipt or snackbar targets for undo; entries in one batch are reversed in reverse insertion order so the inverses replay correctly.

### Command-level undo

The general undo that reverses the most recent operation-log entry — or, when that entry belongs to an Operation batch, the whole batch — by applying each entry's inverse through the normal write paths, so the undo is itself logged and re-doable.

Command-level undo is distinct from FSRS review correction, the queue's removing-only recipe undo, and a receipt-scoped undo (auto-postpone, extract-aging, re-verify), each of which has its own narrower affordance. It inverts only entries that carry a usable pre-image; non-invertible commands such as creations and document edits are left untouched.
