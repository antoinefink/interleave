# Concept: what incremental reading is and why we're building it

This is the product "why". Every agent should understand it, because feature
decisions are only correct if they serve this workflow.

## The one-sentence version

Incremental reading turns reading into long-term knowledge: instead of reading one
text linearly start-to-finish, you keep many texts in a **prioritized queue**, read
them in **small pieces over time**, **extract** the useful fragments, gradually
**distill** those fragments into atomic statements, and convert the best into
**flashcards** reviewed with **spaced repetition**.

The canonical implementation is SuperMemo, framed around five skills: importing
articles, reading/decomposing them, converting pieces into Q&A material, reviewing
for recall, and handling inevitable **information overflow**.

## The refinery pipeline

```txt
Article / book / paper
    ↓ skim and triage
Important paragraph
    ↓ extract
Shorter self-contained extract
    ↓ edit / simplify / add context
Atomic sentence
    ↓ cloze or Q&A
Flashcard
    ↓ spaced repetition
Long-term usable knowledge
```

Think of it as a **personal knowledge refinery**. Raw information goes in. Most is
discarded. Some becomes extracts. A smaller portion becomes durable memory. The best
bits become part of how the user thinks.

## The four problems it solves

1. **Reading produces weak memory.** Normal reading feels productive but mostly
   evaporates. Incremental reading converts passive exposure into repeated active recall.
2. **The amount worth reading is infinite.** There are always more books/papers/posts
   than anyone can finish. A prioritized queue lets the best material get more attention
   while low-value material decays, is postponed, or deleted.
3. **Some texts are too hard right now.** You can postpone material, read
   prerequisites first, and return when you have the background.
4. **Highlights are not knowledge.** A highlight says "this looked important once." An
   extract that survives a delayed re-read and becomes a card you can answer is a much
   stronger filter.

## Why it plausibly works

There is no large trial of "incremental reading" as one package, but its **components**
are well supported: the spacing effect (Cepeda et al.; Kang), the testing/retrieval
effect (Roediger & Karpicke), and the high-utility ratings for practice testing and
distributed practice (Dunlosky et al.) versus the low-utility ratings for highlighting
and rereading. Incremental reading is a clever workflow that **combines several
well-supported learning mechanisms and adds a practical prioritization system for
information overload.**

## The five mechanics (these map directly to features)

1. **A prioritized, scheduled queue** of sources — not a "read later" list. Each source
   has metadata and a next-review date; it can return tomorrow, next month, or never.
2. **Read-points** — when you stop, the system remembers where, so resuming 100 parallel
   articles isn't chaos. Highlighting/extracting can move the read-point automatically.
3. **Extracts** — a useful passage becomes its *own* scheduled mini-item, no longer buried
   in the source. **This is the key difference from highlighting** (a highlight stays
   inside the source; an extract is an independently scheduled element).
4. **Distillation** — each time an extract returns, you improve it: cut fluff, add context,
   split it, rewrite it, or convert it. Gradual refinement is the heart of the method.
5. **Flashcards / clozes** — at the end of the pipeline, important knowledge becomes active
   recall material. Clozes should come from short sentences, not long paragraphs.

## Distillation in practice

```txt
Long extract:
"Distributed practice refers to distributing learning episodes over time rather than
massing them together. A large meta-analysis found that retention depends jointly on
the interstudy interval and retention interval."

Shorter extract:
"Distributed practice = learning episodes spaced over time rather than massed together."

Q&A card:
Q: What is distributed practice?
A: Learning/study episodes spaced over time rather than massed together.

Cloze:
Distributed practice means learning episodes are spaced over time rather than [...].
Answer: massed together
```

The user is **not** expected to make perfect cards on first contact. Repeated exposure
reveals what is actually important. **Delay is a filter.**

## What it's good and bad for

**Good candidates** (fact/concept-rich, stable, divisible, worth remembering for months/
years): textbooks, encyclopedia-style articles, technical overviews, scientific reviews,
history, language explanations, philosophy summaries, business concepts, selected parts of
papers, the user's own notes.

**Weak candidates** (value is in narrative flow, recency, or continuous working memory):
fiction, breaking news, fast-changing product info, chatty newsletters, long argumentative
essays, dense proofs, programming tutorials where the skill comes from building/debugging,
material not yet understood at all.

> A core rule: **do not incrementally read everything you save.** The system works
> *because* the user deletes, postpones, and deprioritizes aggressively.

## The daily rhythm we are designing for

A session should feel like **clearing a smart queue**, not "reading a book":

```txt
0–5 min:   due flashcard reviews first (active recall, honest grading)
5–25 min:  process due reading/extract items
           for each: read until value drops → extract / rewrite / cloze / postpone / delete
                     → set/confirm next interval → move on
25–30 min: optionally import a few sources or clean the queue
```

Per reading item, the decision loop is:

```txt
Do I still want this?      no → delete
Do I understand it?        no → add prerequisite / postpone / rewrite simpler
Is there an atomic idea?   yes → extract or create card
Is the source exhausted?   yes → mark done/archive ; no → set read-point and reschedule
```

Interrupted reading is **normal, not an exception.** When time is short, an increment can
be one or two paragraphs.

## Overload is a feature, not a bug

Overload becomes a prioritization problem, not guilt: top material keeps returning, medium
waits, low fades, bad gets deleted. The product must protect high-priority fragile memory
and sacrifice low-priority material first. **The goal is not to finish sources — it is to
extract value.** Reading 5% and keeping one durable idea is a success; reading 100% and
remembering nothing is not.

## A healthy vs. unhealthy system (our UX target)

**Healthy:** you remember why you saved things; you delete without regret; important ideas
resurface just as you're ready to deepen them; cards are easy but not trivial; you write
ideas in your own words; the backlog is large but not stressful.

**Unhealthy:** every source feels like an obligation; you card everything; you don't
understand your own clozes; reviews pile up; you avoid the app; you import to escape
processing.

The recommended operating mix we should nudge users toward: **~70% reviewing/refining,
~20% extracting, ~10% importing.** Most people do the opposite and drown — the product's
job is to fight that.

## Product north star

Every piece of knowledge should know: **where it came from, why it matters, what stage it
is in, when it should return, how important it is, and what action is needed next.**
</content>
