/**
 * The shared card-front renderer (T037/T031) — masks cloze deletions until reveal.
 *
 * Extracted from `ReviewScreen` so BOTH the review session and the `/process` loop
 * render a card's prompt/answer identically: a Q&A card renders its `prompt`
 * verbatim; a cloze card renders its `{{cN::…}}` spans via the core
 * `renderClozePrompt` helper (which masks EVERY deletion until reveal — no ad-hoc
 * non-global regex that leaks the 2nd+ deletion). Masking logic stays in core; this
 * is a thin presentational mapper. No SQL, no scheduling, no `window.appApi`.
 */

import { renderClozePrompt } from "@interleave/core";

/** The minimal card shape the front needs (a subset of `ReviewCardView`). */
export interface CardFrontInput {
  readonly kind: string;
  /** The Q&A prompt, or the cloze `{{cN::…}}` text the front masks until reveal. */
  readonly prompt: string;
}

/**
 * Render a card's front. A cloze card masks each `{{cN::…}}` deletion as `[ … ]`
 * until `revealed`, then shows its content; a Q&A card renders `prompt` verbatim.
 */
export function CardFront({ card, revealed }: { card: CardFrontInput; revealed: boolean }) {
  if (card.kind === "cloze") {
    const spans = renderClozePrompt(card.prompt, { revealAll: revealed });
    return (
      <>
        {spans.map((span, i) =>
          span.kind === "deletion" ? (
            <span
              // Spans are positional + never reordered within a single render.
              // biome-ignore lint/suspicious/noArrayIndexKey: stable positional cloze spans
              key={i}
              className={`cloze${span.revealed ? " cloze--revealed" : ""}`}
            >
              {span.revealed ? span.content : "[ … ]"}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable positional literal spans
            <span key={i}>{span.content}</span>
          ),
        )}
      </>
    );
  }
  return <>{card.prompt}</>;
}
