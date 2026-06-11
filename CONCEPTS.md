# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Knowledge Processing

### Source

An imported or manually created body of material that the user may read, triage, extract from, and schedule for later processing.

### Inbox source

A source that has been captured but not yet accepted into the user's active knowledge-processing rotation.

### Source provenance

The origin and reliability context attached to a source, including where it came from and how the app should describe that origin to the user.

### Topic

A schedulable knowledge-processing element that groups or narrows work under a broader source or idea.

A Topic can carry its own document-like reading surface while still inheriting source lineage from the material it belongs to. Extracts made from that surface should preserve the Topic as the local location while keeping the original Source as evidence root.

### Source lineage

The chain that lets a derived element point back to the source evidence it came from, including source identity, selected text, citation or link metadata, and a location the reader can jump to.

Source lineage is different from general hierarchy: it is evidence grounding, so it must stay coherent when extracts, cards, or media fragments are inspected or reviewed.

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

### Source reader

The local reading surface for processing a source inside the app, distinct from opening the source's external canonical URL.

### Extract

A scheduled element created from selected source or extract material so the user can process that fragment independently while preserving source lineage.

An Extract is not just a highlight: it carries its own lifecycle, priority, distillation stage, due date, body, and source location so it can become cleaner notes, child extracts, or cards.

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

### Attention scheduler

The scheduling model for sources, topics, extracts, and other non-card work that should return for further processing rather than recall testing.

Attention scheduling is distinct from active-recall scheduling: it decides when to bring work back to the user's attention, not whether the user can remember an answer.

### Due queue

The currently actionable processing set: due active-recall cards plus due attention-scheduled sources, topics, extracts, and similar non-card work.

Due queue work is distinct from inbox sources, which still need triage, and from future review load, which may be forecast without being actionable yet.

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

### Card quality check

A live guardrail in the card builder that evaluates whether a draft card is blocked, advisory, or ready without changing card creation semantics.

Blockers prevent creation, warnings remain advisory, and passed checks can be inspected without dominating dense authoring surfaces.

### Review session

The flow that presents due cards for recall practice and records the user's grading outcome.

### Review log

The durable record of one graded card review, including the grade, review timing, and the scheduling transition produced by that grade.

Review logs are the source of truth for historical review stats. Aggregate reports derive from them later rather than being captured in a separate analytics history.

### Review activity

Review-log volume bucketed by the user's local calendar day or year so the user can understand consistency, streaks, and review load over time.

Review activity is analytics over completed reviews, not the set of currently due cards and not the Review session flow itself.

### Reveal

The review action that intentionally exposes a card's answer and source context after the user has attempted recall.

Before reveal, answer and source context stay hidden across the review surface, global shortcuts, and persistent inspector so the user cannot accidentally inspect the evidence first.

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
