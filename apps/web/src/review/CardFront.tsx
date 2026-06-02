/**
 * The shared card-front renderer (T037/T031) — masks cloze deletions until reveal.
 *
 * Extracted from `ReviewScreen` so BOTH the review session and the `/process` loop
 * render a card's prompt/answer identically: a Q&A card renders its `prompt`
 * verbatim; a cloze card renders its `{{cN::…}}` spans via the core
 * `renderClozePrompt` helper (which masks EVERY deletion until reveal — no ad-hoc
 * non-global regex that leaks the 2nd+ deletion). Masking logic stays in core; this
 * is a thin presentational mapper. No SQL, no scheduling, no `window.appApi`.
 *
 * T072: the literal text of a Q&A prompt and the literal/revealed text of a cloze
 * card render through {@link CardBody}, so inline `$…$`/block `$$…$$` math (KaTeX)
 * and fenced ```lang code (Shiki) render in REVIEW exactly as in source/extract —
 * not as raw LaTeX/source. A cloze deletion stays masked as `[ … ]` until reveal,
 * then its revealed content is itself math/code-rendered (a code cloze reveals
 * highlighted code). Plain-text bodies are unaffected.
 */

import { renderClozePrompt } from "@interleave/core";
import { CardBody } from "./CardBody";

/** The minimal card shape the front needs (a subset of `ReviewCardView`). */
export interface CardFrontInput {
  readonly kind: string;
  /** The Q&A prompt, or the cloze `{{cN::…}}` text the front masks until reveal. */
  readonly prompt: string;
}

/**
 * Render a card's front. A cloze card masks each `{{cN::…}}` deletion as `[ … ]`
 * until `revealed`, then shows its content; a Q&A card renders `prompt` verbatim.
 * Literal + revealed text is math/code-rendered via {@link CardBody}.
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
              {span.revealed ? <CardBody body={span.content} /> : "[ … ]"}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable positional literal spans
            <span key={i}>
              <CardBody body={span.content} />
            </span>
          ),
        )}
      </>
    );
  }
  return <CardBody body={card.prompt} />;
}
