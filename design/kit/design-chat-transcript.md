# Knowledge Tool Design System

_Started 2026-05-29 10:53 UTC_

---

## User

<system-info comment="Only acknowledge these if relevant">
Project title is now "Incremental reading"
Project is currently empty (no files)
Current date is now May 29, 2026
</system-info>

<default aesthetic_system_instructions>
The user has not attached a design system. If they have ALSO not attached references or art direction, and the project is empty, you must ASK the user what visual aesthetic they want. Use the questions_v2 tool to ask about preferred vibe, audience, colors, type, mood, etc. Do NOT just pick your own visual aesthetic without getting the user's aesthetic input -- this is how you get slop!

Once answered, use this guidance when creating designs:
- Choose a type pairing from web-safe set or Google Fonts. Helvetica is a good choice. Avoid hard-to-read or overly stylized fonts. Use 1-3 fonts only.
- Foreground and background: choose a color tone (warm, cool, neutral, something in-between). Use subtly-toned whites and blacks; avoid saturations above 0.02 for whites.
- Accents: choose 0-2 additional accent colors using oklch. All accents should share same chroma and lightness; vary hue.
- NEVER write out an SVG yourself that's more complicated than a square, circle, diamond, etc.
- For imagery, never hand-draw SVGs; use subtly-striped SVG placeholders instead with monospace explainers for what should be dropped there (e.g. “product shot”)

CRITICAL: ignore default aesthetic entirely if given other aesthetic instructions like reference images, design systems or guidance, or if there are files in the project already.
</default aesthetic_system_instructions>

<pasted_text name="Pasted text (121 lines)">
We are designing a desktop-first web application for incremental reading: a local-first knowledge tool where users import articles, PDFs, books, notes, and media; read them gradually; extract important fragments; distill those fragments into better notes; and eventually convert the most valuable ideas into active-recall flashcards reviewed with spaced repetition. The app should feel like a serious long-term thinking environment, not a gamified learning app.

The visual style should be efficient, minimal, modern, calm, and keyboard-first. Think “professional knowledge workspace”: dense but not cluttered, excellent typography, subtle borders, clear hierarchy, fast actions, and strong support for power users. Prefer a clean neutral palette, restrained accent colors for priority/status, and a design system that works well in both light mode and future dark mode. Design for a 1440px desktop viewport first.

Please design these 6 key screens and the reusable components needed across them.

1. Daily Queue / Home Command Center

Purpose:
The user starts here every day to process due reading, extracts, and flashcards.

Elements to include:
- Left sidebar navigation: Queue, Inbox, Library, Review, Search, Concepts, Analytics, Settings.
- Top command/search bar with placeholder like “Search, import, or run command…”.
- Main queue area with mixed due items: source articles, extracts, card reviews, verification tasks.
- Each queue item should show title, type icon, source, priority badge, due status, concept/tag, and suggested next action.
- Queue filters: All, Cards, Sources, Extracts, Tasks, High Priority.
- Session controls: “Start session”, time budget selector, review-only mode, reading-only mode, catch-up mode.
- Right-side status panel: due today, overdue, high-priority protected items, review forecast, extract backlog, leech warnings.
- Empty/healthy state showing that the queue is clear.

2. Import & Inbox Triage

Purpose:
New material lands here before entering the learning system.

Elements to include:
- Import options: paste URL, paste text, upload PDF/EPUB, browser capture, manual note.
- Inbox list of newly imported items with source type, title, URL/source, imported date, estimated length, duplicate warning if any.
- Main preview panel showing cleaned article text or source preview.
- Metadata fields: title, author, URL, publication date, concept, tags, reason saved.
- Priority picker: A / B / C / D or numeric priority hidden behind simple labels.
- Triage actions: Activate, Read soon, Save for later, Archive, Delete, Merge duplicate.
- Duplicate/conflict banner example: “This source may already exist.”
- Compact keyboard shortcut hints for fast triage.

3. Source Reader / Incremental Reading Workspace

Purpose:
The user reads a source gradually, sets read-points, extracts useful fragments, and sees what has already been processed.

Elements to include:
- Top source header: title, author/source, URL, concept, priority, status, last seen, next scheduled date.
- Main reading area with beautiful long-form typography.
- Visible read-point marker.
- Highlighted spans, extracted spans, processed/dimmed spans.
- Floating text-selection toolbar with actions: Extract, Cloze, Highlight, Create task, Copy.
- Right inspector panel showing source metadata, children/extracts created from this source, notes, source reliability, and references.
- Bottom or top action bar: Set read-point, Postpone, Mark done, Lower priority, Delete, Open original.
- Small hierarchy breadcrumb: Source → Extracts → Cards.
- Example of an extracted paragraph visually marked in the document.

4. Extract Distillation & Card Builder

Purpose:
The user turns raw extracts into clean extracts, atomic notes, cloze cards, or Q&A cards.

Elements to include:
- Split layout: parent/source context on the left, active extract editor in the center, card builder/inspector on the right.
- Extract title, stage badge: Raw extract → Clean extract → Atomic statement → Card draft.
- Rich text editor for rewriting/simplifying the extract.
- Actions: Trim, Split extract, Create sub-extract, Create cloze, Create Q&A, Postpone, Mark done, Delete.
- Card creation panel with tabs: Cloze, Q&A, Image occlusion later.
- Card preview showing front/back or cloze reveal state.
- Card quality warnings: too long, ambiguous, missing source, multiple facts, no context.
- Source lineage area: original source, parent extract, child cards.
- Priority and scheduling controls for the extract/card.

5. Active Recall Review Session

Purpose:
The user reviews flashcards using spaced repetition, with minimal friction and fast repair tools.

Elements to include:
- Centered review card with prompt on front.
- Reveal answer interaction.
- After reveal: answer, source/reference snippet, confidence/grade buttons: Again, Hard, Good, Easy.
- Show next interval preview on each grade button.
- Top progress indicator: reviewed today, remaining, session time.
- Small metadata row: concept, priority, source, lapse count, sibling indicator.
- Quick repair actions: Edit, Open source, Suspend, Delete, Mark leech, Add context.
- Example of cloze card and Q&A card states.
- Right-side optional source/context drawer that can open without leaving review.

6. Library, Search & Knowledge Map

Purpose:
The user finds, audits, and navigates all sources, extracts, cards, concepts, and relationships.

Elements to include:
- Global search input with filters.
- Results grouped by type: Sources, Extracts, Cards, Concepts, Tasks.
- Filter sidebar: type, concept, tag, priority, status, due date, source type, stale/outdated, leeches, no-source cards.
- Main results list with dense metadata and highlighted matches.
- Detail preview panel for selected item.
- Relationship/hierarchy view: source → extracts → cards.
- Concept map or graph-like compact visualization showing related concepts/sources, but keep it practical and not decorative.
- Bulk actions: raise/lower priority, postpone, archive, delete, assign concept, export.
- Maintenance warnings: orphan cards, stale facts, low-yield sources, stagnant extracts.

Reusable design system components to define:
- App shell with sidebar, command bar, main pane, right inspector.
- Priority badges.
- Element type icons: Source, Extract, Card, Task, Concept, Media.
- Status/stage badges.
- Queue item cards.
- Review card.
- Rich text editor styling.
- Floating selection toolbar.
- Metadata inspector panels.
- Keyboard shortcut hints.
- Empty states.
- Warning banners.
- Source reference block.
- Breadcrumb/hierarchy component.
- Search/filter chips.
- Modal/drawer patterns.
- Analytics mini-cards.

Overall direction:
The app should feel fast, serious, and elegant. Avoid playful gamification, excessive colors, cartoon illustrations, or consumer learning-app aesthetics. Prioritize clarity, speed, trust, and long-term daily use.
</pasted_text>

<!-- The user explicitly selected the following skills for this project, as attachments to their message. These are not optional context — they define how you work. Use them. -->
<attached-skill name="Hi-fi design">
Create a high-fidelity, polished design.

Follow this general design process (use the todo list to remember):
(1) ask questions, (2) find existing UI kits and collect design context — copy ALL relevant components and read ALL relevant examples; ask the user if you can't find them, (3) start your file with assumptions + context + design reasoning (as if you are a junior designer and the user is your manager), with placeholders for the designs, and show it to the user early, (4) build out the designs and show the user again ASAP; append some next steps, (5) use your tools to check, verify and iterate on the design.

Good hi-fi designs do not start from scratch — they are rooted in existing design context. Ask the user to Import their codebase, or find a suitable UI kit / design resources, or ask for screenshots of existing UI. You MUST spend time trying to acquire design context, including components. If you cannot find them, ask the user for them. In the Import menu, they can link a local codebase, provide screenshots or Figma links; they can also link another project. Mocking a full product from scratch is a LAST RESORT and will lead to poor design. If stuck, try listing design assets and ls'ing design system files — be proactive! Some designs may need multiple design systems — get them all. Use the starter components (device frames, design canvas) to get high-quality scaffolding for free.

When designing, asking many good questions is ESSENTIAL.

Give options: try to give 3+ variations across several dimensions. Mix by-the-book designs that match existing patterns with new and novel interactions, including interesting layouts, metaphors, and visual styles. Have some options that use color or advanced CSS; some with iconography and some without. Start your variations basic and get more advanced and creative as you go! Try remixing the brand assets and visual DNA in interesting ways — play with scale, fills, texture, visual rhythm, layering, novel layouts, type treatments. The goal is not the perfect option; it's exploring atomic variations the user can mix and match.

CSS, HTML, JS and SVG are amazing. Users often don't know what they can do. Surprise the user.

If you do not have an icon, asset or component, draw a placeholder: in hi-fi design, a placeholder is better than a bad attempt at the real thing.
</attached-skill>

<attached-skill name="Interactive prototype">
Create a fully interactive prototype with realistic state management and transitions. Use React useState/useEffect for dynamic behavior. Include hover states, click interactions, form validation, animated transitions, and multi-step navigation flows. It should feel like a real working app, not a static mockup.
</attached-skill>


<system-reminder>Auto-injected reminder (ignore if not relevant): do not recreate copyrighted or branded UI unless the user's email domain matches that company. Create original designs instead.</system-reminder>

## Assistant

_[tool: questions_v2]_

This is a meaty, well-specified brief. Before I start building, let me lock down the aesthetic direction and scope — the spec nails the *functionality* but is open on the *look* and on how many variations you want to see.

## User

Questions answered:
- starting_point: Nothing yet — design from scratch with your taste
- aesthetic: Dense pro-tool — Linear/Notion-like, compact, fast
- type_pairing: Serif for reading + sans UI (classic knowledge-tool)
- accent: 1
- mode: Build both, toggleable
- scope: A design-system page first, then screens
- interactivity: Fully interactive — real state, selection→extract, reveal cards, filters work
- variations: Just give me one strong direction
- keyboard: Present but subtle — hints on hover/in corners
- density: Decide for me

## Assistant

_[tool: update_todos]_

Got it — here's my read on the direction:

- **Aesthetic:** Dense pro-tool (Linear/Notion energy), compact and fast
- **Type:** Serif for reading + sans UI → I'll use the **IBM Plex** superfamily (Sans for UI, Serif for long-form reading, Mono for metadata & shortcuts) — coherent, serious, distinctly "knowledge tool," and avoids the overused Inter/Roboto trap
- **Accent:** a calm professional blue, used sparingly for priority/status
- **Both light + dark, toggleable**
- **Delivery:** design-system page first, then a single fully-interactive prototype linking all 6 screens
- **Keyboard-first but subtle; one strong direction (no variations)**

Let me set up the foundation and todos.

_[tool: write_file]_

Let me build the foundation — design tokens first.

_[tool: write_file]_

Now the component CSS library — the heart of the design system.

_[tool: write_file]_

Now icons — a clean line-icon set (Lucide-style) shared by both the design-system page and the React prototype.

_[tool: write_file]_

Now the design-system showcase page — it leads with my design reasoning (per the hi-fi process) and then lays out every token and component.Let me check the design system page renders cleanly before showing the user.

_[tool: show_html]_

_[tool: show_html]_

_[tool: get_webview_logs]_

_[tool: save_screenshot]_

_[tool: save_screenshot]_

_[tool: view_image]_

The design system looks clean. Let me capture more of the page to verify components render correctly.

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

Queue items look great. Let me verify dark mode works, then move to building the prototype.

_[tool: view_image]_

_[tool: show_to_user]_

Design system is solid in both themes. Let me surface it to you now, then build the interactive prototype.

_[tool: update_todos]_

_[tool: write_file]_

Now the prototype. Starting with realistic interconnected mock data.

_[tool: write_file]_

Now shared React components.

_[tool: str_replace_edit]_

I need to add CSS for the shell layout and the new controls (segmented, toggle, menu). Let me append to app.css.

_[tool: write_file]_

Now the app shell — sidebar, command bar, and command palette.

_[tool: write_file]_

Now the screens. Starting with the Daily Queue — the most important screen.

_[tool: str_replace_edit]_

Let me switch the app shell to a flex layout so each screen can compose its own columns, then build the host + main.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: write_file]_

Now the main app controller and HTML host. I'll stub unbuilt screens so I can test the Queue first.

_[tool: write_file]_

_[tool: show_html]_

Let me test the Queue screen renders before building the rest.

_[tool: get_webview_logs]_

_[tool: save_screenshot]_

_[tool: write_file]_

The missing files block the rest of the bundle. Let me build all remaining screens. Screen 2 — Import & Inbox Triage.

_[tool: write_file]_

Screen 3 — Source Reader with real text-selection → extract interaction.

_[tool: write_file]_

Screen 4 — Extract Distillation & Card Builder (3-column split).

_[tool: write_file]_

Screen 5 — Active Recall Review Session.

_[tool: write_file]_

Screen 6 — Library, Search & Knowledge Map.

_[tool: write_file]_

Finally, a polished Analytics screen (it's a nav item and the file is referenced).Now let me add the analytics script to the HTML and test the full prototype.

_[tool: show_html]_

_[tool: get_webview_logs]_

No errors. Let me screenshot the Queue and walk through screens.

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

The layout is correct but cramped because the preview pane is much narrower than the 1440px target (sidebar + inspector eat most of it). I'll fix the command-bar text wrapping and let the session controls wrap gracefully at narrow widths.

_[tool: str_replace_edit]_

_[tool: save_screenshot]_

The preview is narrower than the 1440 target, but let me verify each screen works. Review session:

_[tool: view_image]_

_[tool: get_webview_logs]_

The review card area is blank — likely a runtime error. Let me check.

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

The component renders (topbar shows) but the card area is blank with no errors. Let me probe the DOM.

_[tool: view_image]_

_[tool: save_screenshot]_

Card exists (h223, opacity 1) but isn't visible — likely the `.fade-up` wrapper's opacity. Let me probe its bounding box.

_[tool: view_image]_

_[tool: str_replace_edit]_

Found it — the per-second timer re-renders the whole card, restarting its entrance animation so it's caught mid-fade at opacity 0. I'll isolate the clock into its own component so the card stops re-rendering every second.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now update the topbar clock and the done-panel time references.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

Still blank — so it's the `fade-up` animation itself stuck at opacity 0 for this element. Let me remove it from the review wrapper and confirm.

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

`fade-up` works — the card renders perfectly. The `both` fill-mode was leaving this element stuck on the `from` (opacity:0) keyframe. Let me make `.fade-up` robust (drop backwards-fill so it can never get stuck hidden) and restore it on the card.

_[tool: str_replace_edit]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: view_image]_

_[tool: save_screenshot]_

The CSS may be cached. Let me probe the actual computed animation state.

_[tool: view_image]_

_[tool: str_replace_edit]_

Diagnosis: the screenshot iframe pauses CSS animations at frame 0, freezing `fade-up` elements at `opacity:0`. The fix: animate only the transform, never opacity — so elements are always visible regardless of animation state. Still gives a subtle slide-in.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Let me also fix the drawer's `slideIn` (same opacity-stick risk).

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

Queue works now. Let me verify the remaining screens. Reader:

_[tool: view_image]_

_[tool: save_screenshot]_

Reader looks excellent. Builder:

_[tool: view_image]_

_[tool: save_screenshot]_

Builder's 3-column split works (tight at this width, comfortable at 1440). Library/map and inbox:

_[tool: view_image]_

_[tool: save_screenshot]_

Library works (banner wraps tightly only because the preview is far narrower than 1440). Concept map and inbox:

_[tool: view_image]_

_[tool: save_screenshot]_

Concept map renders (nodes look tiny only because the graph panel is squeezed at this width). Inbox and analytics:

_[tool: view_image]_

_[tool: update_todos]_

All six screens plus analytics are working. The only "tightness" is because the preview pane is far narrower than the 1440px target — at full width everything has room to breathe. Let me mark progress and reset the landing route.

_[tool: str_replace_edit]_

_[tool: done]_

Now let me finalize and hand off.

_[tool: fork_verifier_agent]_

Both files are delivered. Here's what I built:

**Two deliverables**

1. **Design System** — leads with my design rationale, then lays out every token and component (type, color, spacing, icons, badges, priority, controls, queue items, review card, panels, banners, empty states) in both **light and dark**.

2. **Incremental Reading** — a single fully-interactive prototype linking all 6 screens.

**The system**: IBM Plex superfamily (Sans for UI · Serif for reading & card faces · Mono for metadata/shortcuts), a cool-neutral canvas where color only ever means something (priority A–D, status, element type), a compact 4px grid, and a quiet keyboard-first layer (⌘K palette, `G`-then-key nav, subtle shortcut hints).

**What's actually wired**
- **Queue** — working filters, session/mode/budget controls, dismissable items that reveal the healthy empty state, live status rail
- **Inbox** — import strip, list→preview→triage flow with duplicate banner and keyboard triage (`1–6`)
- **Reader** — real text selection pops the floating toolbar; **Extract/Cloze/Highlight** mark the text and push into the extracts inspector (`E`/`C`/`H`)
- **Builder** — 3-pane distill flow, stage stepper, live cloze/Q&A preview, dynamic quality checks
- **Review** — `Space` to reveal, `1–4` to grade with interval previews, session timer, context drawer, completion summary
- **Library/Map** — type/concept/priority filters, grouped search with match highlighting, bulk-action bar, relationship view, and a clickable concept graph
- Global **light/dark toggle** persists across screens.

**One note**: it's designed for a 1440px desktop, so the sidebar + right inspector look tight in a narrow preview pane — give it room and the columns breathe as intended.

Want me to push on any direction next — e.g. flesh out **Settings**, add **Tweaks** for live theming/density, or build out the dark-mode polish pass?

## User

Apply comment

## User

Address these comments from my teammates:

**Antoine** (on `Incremental Reading.html` at `[data-comment-anchor="30453da6a8-div-123-9"]`):
The background here and in general of the main column is not white. I feel that is kind of strange and not very usual of this type of application.

## Assistant

_[tool: snip]_

Let me snip the resolved debugging iterations to free up context, then tone down the streak.

_[tool: str_replace_edit]_

Two changes: make the main column white (Antoine), and tone down the streak (your note).

**1. Main column → white.** Right now the canvas is a faintly cool off-white. I'll make it true white and keep only the sidebar subtly gray for separation:

_[tool: str_replace_edit]_

**2. Streak too visible.** I'll drop the bordered card treatment and make it a quiet muted line.

_[tool: str_replace_edit]_

_[tool: save_screenshot]_

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: get_webview_logs]_

_[tool: save_screenshot]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: show_html]_

The preview tooling is hiccuping. Let me verify via the lighter design-system page (same tokens).

_[tool: save_screenshot]_

_[tool: show_html]_

Design-system page loads fine. Now the prototype (it needs more time for Babel):

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

The streak is nicely toned down. This is dark mode (my iframe's leftover setting) — let me check light mode to verify the white canvas Antoine asked for.

_[tool: view_image]_

_[tool: done]_

Both addressed:
- **Main column is now white** — the sidebar is the only subtly-gray surface, which reads as the conventional pattern for this kind of tool.
- **Streak toned right down** — no more bordered card; it's a quiet muted line with a small flame and the retention figure tucked to the right.Done — main column is white throughout (sidebar stays subtly gray for separation), and the streak is now a quiet one-line element instead of a prominent card. Both light and dark modes updated.

## User

Address these comments from my teammates:

**Antoine** (on `Incremental Reading.html` at `#root .sidebar .spread .icn`):
This should be in a submenu not aways visible

**Antoine** (on `Incremental Reading.html` at `#root .inspector [width="15"]`):
Why this?

**Antoine** (on `Incremental Reading.html` at `#root > div:nth-child(1) > aside:nth-child(3) > div:nth-child(2) > div:nth-child(1) > div:nth-child(1) > div:nth-child(3)`):
No gap between those cards

**Antoine** (on `Incremental Reading.html` at `[data-comment-anchor="e8bf7b44aa-div-91-13"]`):
Is this section maybe a bit too big?

**Antoine** (on `Incremental Reading.html` at `[data-comment-anchor="1972907921-div-66-9"]`):
The maintenance section is also too strong.

## Assistant

_[tool: snip]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

Let me look at the current sidebar foot and a fresh screenshot of the inspector to ground these.

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: grep]_

I found it: the metric cards use `className="grid"` with inline `gridTemplateColumns`/`gap`, but **nothing sets `display: grid`** — so they're falling back to full-width stacked blocks with no gap (exactly Antoine's "no gap" note), which also makes the section feel oversized. Let me fix the root cause and address all five comments.

First, check `.grid` isn't already defined:

_[tool: read_file]_

`.grid` is undefined. Let me add it plus a compact metric variant, and a softer maintenance note style.

_[tool: str_replace_edit]_

Now add the `.grid` base rule (so all `className="grid"` usages get `display:grid`):

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: grep]_

Now update the Metric component to support a compact size, then apply the fixes in the queue inspector. Let me re-read the (user-edited) Metric:

_[tool: read_file]_

_[tool: str_replace_edit]_

Now the queue inspector: remove the head icon, make metrics compact, and soften the maintenance section.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

Now move the theme toggle into a user submenu (Antoine #1) instead of an always-visible button.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

The userchip is now the only child of `.spread`, so it needs to fill the width for the chevron to sit right. Let me make it stretch.

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

Much calmer now — metrics are a proper compact 2×2 grid with gaps, the decorative shield is gone, and maintenance is a quiet single line. Let me verify the user submenu opens.

_[tool: view_image]_

The submenu works — Dark mode, Settings, and vault status now live in a popover above the user chip rather than an always-visible icon. All five comments are addressed. Let me hand off.

_[tool: done]_

All five of Antoine's comments addressed:

1. **Theme toggle → submenu** — moved into a popover on the user chip (with Settings + vault status); no longer an always-visible icon.
2. **`[width="15"]` shield icon** — that was a decorative icon in the status header; removed.
3. **No gap between cards** — root cause: the metric grid had `gridTemplateColumns`/`gap` but nothing set `display:grid`, so they stacked edge-to-edge. Fixed globally; they're now a clean 2×2 grid.
4. **Section too big** — added a compact metric variant for the rail (smaller numbers, dropped the sub-labels), so it reads as a quiet status block.
5. **Maintenance too strong** — replaced the filled warning banner with a single subdued line.

The `display:grid` fix also tightens up the metric grids on the Analytics screen, since they shared the same root cause.

## User

<pasted_text name="Pasted text (30 lines)">
Love this — the shell, the IBM Plex + OKLCH token system, dark mode, the ⌘K command palette, and the domain-aware color language (priority A/B/C/D, per-element-type hues, highlight/extract marks, the read-point marker) are all excellent. Please keep them. A few changes would make it match our product's core mechanics precisely:

P1 — conceptual must-fixes

1. Cards use FSRS, not SM-2. The card model currently carries SM-2 fields (ease: 2.4, rep, lapses, "ease factor"). Re-model card scheduling around FSRS: Stability (memory strength in days), Difficulty (0–10), Retrievability (current recall probability %, e.g. "82% recall"), plus due/reps/lapses and a desired-retention target. Replace "ease 2.4" in the card inspector/review with Stability / Difficulty / Retrievability. Keep the Again/Hard/Good/Easy buttons with interval previews — those are already FSRS-compatible.

2. Show two distinct schedulers. Cards answer "can I recall this?" (FSRS). Sources/extracts answer "should I process this again, when?" (a priority/attention scheduler). Right now everything just shows "Due today." Differentiate them: card chips → retrievability/stability/next interval; source & extract chips → priority + stage + last-processed + postponed ×N + stagnant? + yield (N extracts / M cards). Different label/icon so the user always knows which scheduler an item is on.

3. Use the full vocabulary. Add the missing element types (topic, synthesis_note, and a real surface for task), statuses (suspended, dismissed, trashed — not just due/overdue/done/leech), and distillation stages (the Stage badge stops at "Card draft"; add active_card, mature_card, synthesis).

4. Make lineage actionable. A card must trace back to its source. In review, turn the static reference block into a button: "Open source at this location" (jumps to and highlights the exact paragraph in the reader). Add a lineage/hierarchy tree (source → extract → sub-extract → card, navigable both ways) and design sub-extracts (selecting text inside an extract creates a child extract).

P2 — important additions

5. Overload management (a defining feature): a daily-budget meter on the Queue ("42 / 60"), an auto-postpone/overload banner ("38 over budget — postpone low-priority? high-priority cards protected"), an import↔process balance warning, and catch-up/vacation modes showing the cost of postponement.

6. Local-first integrity: a trash view with restore, an undo toast/snackbar ("Extract deleted · Undo"), and a backup/export panel.

7. A real Settings screen (currently a placeholder): daily review budget, default desired retention, default topic interval, default source priority, theme, keyboard layout, backup/export.

8. A distillation pipeline visual (Source → Extract → Clean → Atomic → Card → Mature) usable in the inspector/builder — it's our north star.

9. Light surfaces for synthesis notes (incremental writing) and tasks/verification.

P3 — nice to have

A ? keyboard cheat-sheet overlay + contextual shortcut footer; first-run/onboarding empty states; hierarchical concepts (ours are a tree); leave structural room for later image-occlusion/audio/formula cards; and a "mark-processed" dim/collapse interaction in the reader.

One-liner: keep the shell/tokens/palette; make cards FSRS not SM-2, visually split the two schedulers, adopt the full type/status/stage vocabulary, and make lineage clickable — then add overload management, trash/undo/backup, and real Settings.

</pasted_text>

## Assistant

_[tool: snip]_

This is a substantial, well-specified revision. Let me clear settled context and lay out a plan.

_[tool: update_todos]_

_[tool: str_replace_edit]_

Let me build the foundation. First, new icons for the expanded vocabulary:

_[tool: write_file]_

Now the data model — re-modeling cards to FSRS, adding the attention scheduler fields, the full vocabulary, and lineage. This is the foundation everything else builds on:

_[tool: str_replace_edit]_

Now tokens for the two new element types:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now add CSS for the new components — scheduler chips, budget meter, distillation pipeline, lineage tree, FSRS stat bars, undo snackbar, new status/type styles:

_[tool: str_replace_edit]_

_[tool: read_file]_

Now extend the shared components. Let me read the relevant parts:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Let me fix a stray character in the scheduler chip and add the pipeline, lineage tree, budget meter, snackbar, and cheat-sheet components.Now add the larger components (pipeline, lineage tree, budget meter, snackbar, cheat-sheet) and update the export list. Let me check the end of the file:

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

Now the screens. Queue first — scheduler chips on items, budget meter, and overload banner. Let me re-read the (user-edited) queue file:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now fix the backlog calc and add the overload-management UI (budget meter + overload banner). Let me view the rest of the queue screen:

_[tool: str_replace_edit]_

Now insert the budget meter + overload banner after the page-head:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

Now the Review screen — FSRS stats and clickable lineage. Let me read it:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: read_file]_

Review screen is FSRS-ready. Now the Reader — I need to re-read it (you edited it) before adding jump-to-location, mark-processed, and lineage:

_[tool: str_replace_edit]_

The reader edit was just Antoine's comment anchor. Now let me update it: fix renamed fields, add the scheduler chip, jump-to-location highlight, mark-processed, and a lineage tree. Edit the header meta first:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now the inspector: fix the extract yield field and add a lineage tree. Let me update that section:

_[tool: str_replace_edit]_

Now CSS for the mark-processed affordance:

_[tool: read_file]_

Now the Builder — add the distillation pipeline and extend stages. Let me read it:

_[tool: str_replace_edit]_

Now update the Builder — pipeline visual, FSRS scheduling fields, and a proper lineage tree with sub-extracts:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: write_file]_

Now a real Settings screen (P2.7):

_[tool: write_file]_

Now a Trash view, plus light surfaces for synthesis notes and tasks (P2.6, P2.9):

_[tool: read_file]_

Now wire it all in main.jsx — new routes, cheat-sheet overlay, undo snackbar, and entity routing. Let me read it:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Add the screen scripts to the HTML and a cheat-sheet entry in the user menu. First the HTML:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

Now let me update the Library for the new vocabulary and trash link. Let me read it:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now fix the result-row meta (replace SM-2 ease with scheduler chip) and the detail relationship:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: show_html]_

All wired. Let me load and check for errors.

_[tool: sleep]_

_[tool: get_webview_logs]_

_[tool: save_screenshot]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: get_webview_logs]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: done]_

The preview pane is being flaky. Let me use `done` which reliably surfaces the file and reports console errors.

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: show_html]_

Let me reset the preview by loading the lighter design-system page, then return to the prototype.

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

Renders cleanly with the budget meter and overload metrics. To showcase the overload banner (a defining feature), let me set the data into an over-budget state — matching their "38 over budget" example:

_[tool: save_screenshot]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

The overload management is working — budget meter with over-budget split and the auto-postpone banner. Let me verify the FSRS review (key P1 item):

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

Route is in-memory now (ignores localStorage). Let me navigate via the UI:

_[tool: view_image]_

_[tool: save_screenshot]_

FSRS is working perfectly — Stability 18.4d, Difficulty 4.2/10, Retrievability 91%, plus the clickable "Open source at this location". Let me verify the jump-to-source lands in the reader with the highlight:

_[tool: view_image]_

_[tool: save_screenshot]_

Jump-to-source works (note the toast and the attention-scheduler chip "Reading · postponed ×1" in the header — visibly distinct from cards' FSRS chip). Let me verify Settings and Trash:

_[tool: view_image]_

_[tool: save_screenshot]_

Settings looks great. The Settings nav item should be highlighted though — let me check the steady state and the Trash view:

_[tool: view_image]_

_[tool: save_screenshot]_

Trash works. Let me double-check the nav-highlight state, which looked off — I'll probe it directly:

_[tool: view_image]_

_[tool: update_todos]_

Confirmed — nav highlight is correct ("active nav = Settings"). Everything works. Let me update todos and fix one consistency gap — the design-system page still shows the old SM-2 "ease" values.

_[tool: grep]_

_[tool: grep]_

_[tool: grep]_

_[tool: grep]_

_[tool: done]_

The design-system page has no stale SM-2 references. Everything's consistent. Let me do the final handoff.

_[tool: fork_verifier_agent]_

Major revision done — the shell, tokens, palette, and ⌘K palette are untouched; the mechanics now match the product. Verifier is checking in the background.

**P1 — must-fixes**
- **FSRS, not SM-2** — cards now carry Stability / Difficulty / Retrievability + reps/lapses; the review screen shows three stat tiles ("18.4d · 4.2/10 · 91%") and Again/Hard/Good/Easy keep their interval previews.
- **Two visible schedulers** — a `SchedulerChip` distinguishes every item: cards get a 🧠 "91% recall · S 18d" chip; sources/extracts/topics/notes get a ⌐ gauge chip with stage + "postponed ×N", plus stagnant flags and yield (Ne·Mc).
- **Full vocabulary** — added `topic`, `synthesis_note`, and real `task` surfaces; statuses (suspended/dismissed/trashed/stagnant); stages now run to Active card → Mature card → Synthesis.
- **Clickable lineage** — the review reference is now an "Open source at this location" button that jumps to the reader and rings the exact paragraph; a navigable lineage tree (topic → source → extract → sub-extract → card) lives in the reader/builder/library; sub-extracts are modeled.

**P2**
- **Overload management** — daily budget meter (98/60 with over-budget split), auto-postpone banner, import:process ratio, vacation cost, catch-up mode.
- **Local-first** — Trash view with Restore / Empty, plus an undo snackbar.
- **Real Settings** — review budget, desired retention, topic interval, default priority, theme, keyboard layout, backup/export.
- **Distillation pipeline** — Source → Extract → Clean → Atomic → Card → Mature, shown in the builder.
- **Synthesis & task surfaces** — incremental-writing editor and a verification-task view.

**P3** — `?` keyboard cheat-sheet overlay, mark-processed dim/restore in the reader, and onboarding empty states (queue clear, inbox zero, empty trash).

One thing I left for your call: hierarchical concepts exist in the data (parent links) but the concept map still renders flat — say the word and I'll make the map and concept filter render the tree. Want me to take that on, or adjust anything above?

## User

Verifier agent check completed

## Assistant

The verifier passed. Let me snip the resolved build-and-verify range for this revision.

_[tool: snip]_

Verifier passed clean — FSRS stats, scheduler chips, jump-to-source, and all the new screens render without errors.

The prototype now faithfully reflects the product's core mechanics: cards on FSRS, sources/extracts/topics on the attention scheduler (visibly distinguished), the full type/status/stage vocabulary, clickable lineage, overload management, trash/undo/backup, real Settings, the distillation pipeline, and synthesis/task surfaces — all while keeping the shell, IBM Plex + OKLCH tokens, dark mode, and ⌘K palette intact.

The one open item is hierarchical concepts (data has the parent links; the concept map still renders flat). Happy to build the tree view next, or take on anything else.

