/**
 * Card builder (T033 — Q&A card creation; T034 — cloze card creation).
 *
 * The RIGHT column of `design/kit/app/screen-builder.jsx`, rebuilt for our stack.
 * From the extract distillation workspace ({@link ExtractView}) the user opens this
 * panel and authors a card:
 *
 *  - the `Cloze` / `Q&A` tabs (Image occlusion stays disabled — M15);
 *  - the Q&A `Front · question` + `Back · answer` textareas;
 *  - the Cloze `Cloze text` textarea — wrap answers in `{{ }}`; the preview renders
 *    each deletion as `[ … ]` and reveals the answers on toggle, driven by the
 *    `@interleave/core` `renderClozePrompt` helper (NOT ad-hoc regex here);
 *  - a live `cardprev` preview that shows the front and toggles to the back / reveals
 *    cloze answers (Space, mirroring the kit's `Kbd ␣`);
 *  - the `qc` quality-checklist (T035): the `@interleave/core` `evaluateCardQuality`
 *    heuristics run live as the user types and render as `ok` / `warn` / `block` rows
 *    (the component calls the pure domain function — it holds NO heuristic logic). A
 *    `block`-severity check (empty Q&A side, no cloze deletion) disables Create;
 *    `warn`s are advisory and never block;
 *  - the A/B/C/D priority chips (default = the extract's label) + the FSRS
 *    `SchedulerChip` (FSRS side; schedule values are previews/`—` until M7);
 *  - a `Create Q&A card` / `Create cloze card` block button.
 *
 * Pressing Create calls the typed `cards.create` command (T032) — the renderer
 * ships ONLY the authored strings + the `extractId` + the chosen priority label.
 * For a cloze card the renderer canonicalizes the `{{ }}` text to the numbered
 * `{{c1::answer}}` form via `@interleave/core` before sending it (the main side
 * re-canonicalizes + derives the structured metadata + persists the `cloze`
 * document_marks; the renderer never touches SQL). All lineage/priority/tag
 * inheritance happens main-side in `CardService`; this component is presentational —
 * NO SQL, NO priority-numeric math, NO lineage resolution, NO cloze parsing logic of
 * its own (Architectural rules). On success the builder stays open and threads the
 * returned `siblingGroupId` so a Q&A + cloze pair (or a multi-cloze set) can be
 * authored back-to-back as siblings.
 *
 * The card is created at `card_draft` with an UN-DUE `review_states` row (M6 does
 * no FSRS math); it appears in the inspector + lineage tree immediately and enters
 * FSRS rotation in M7.
 */

import {
  type CardQualityInput,
  canonicalizeCloze,
  evaluateCardQuality,
  parseCloze,
  renderClozePrompt,
} from "@interleave/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { priorityLabel } from "../components/inspector/primitives";
import { appApi, type CardKind, type PriorityLabel } from "../lib/appApi";
import { OcclusionEditor } from "./OcclusionEditor";

/**
 * The builder's tabs. `qa`/`cloze` are the text-card tabs; `image_occlusion`
 * (T071) is enabled ONLY for an image extract — it mounts the {@link OcclusionEditor}
 * instead of the textarea surface. For a non-image extract that tab stays disabled.
 */
type BuilderTab = CardKind;

const PRIORITY_LABELS: readonly PriorityLabel[] = ["A", "B", "C", "D"];

export interface CardBuilderProps {
  /** The originating extract id — the only id the renderer ships to `cards.create`. */
  readonly extractId: string;
  /** The extract's numeric priority — the default A/B/C/D chip selection. */
  readonly extractPriority: number;
  /**
   * Whether the current element is a `media_fragment` IMAGE extract (T071). When
   * true, the third "Image occlusion" tab is enabled and mounts the
   * {@link OcclusionEditor} (the diagram-→-masks surface); when false it stays
   * disabled with a hint. Defaults to `false`.
   */
  readonly isImageExtract?: boolean;
  /**
   * Whether the extract carries a source location the card will inherit (lineage to
   * source). Feeds the T035 "missing source" quality check; defaults to `false` so a
   * lineage-less card warns. The renderer derives this from the inspector payload —
   * it ships only the boolean, never resolves the location itself.
   */
  readonly hasSource?: boolean;
  /**
   * Seed text for the answer / cloze body (usually the extract's atomic
   * statement). The user edits both fields freely from here.
   */
  readonly seedBody?: string;
  /** The tab to open on (Q&A by default; the Cloze toolbar action opens `cloze`). */
  readonly initialTab?: BuilderTab;
  /** Pre-wrapped cloze text (T034 — the selection wrapped as `{{c1::…}}`). */
  readonly initialClozeText?: string;
  /** Surface a transient status message (reuses the host view's toast). */
  readonly onToast: (message: string) => void;
  /** Re-fetch the inspector + lineage so the new card appears under the extract. */
  readonly onCardCreated: () => void;
  /** Close the builder column (returns to the two-column distill surface). */
  readonly onClose: () => void;
}

/**
 * Author a card from an extract. Both tabs are fully wired: Q&A (T033) and Cloze
 * (T034 — `{{ }}` authoring, `[ … ]` preview + reveal, canonical numbered send).
 */
export function CardBuilder({
  extractId,
  extractPriority,
  isImageExtract = false,
  hasSource = false,
  seedBody,
  initialTab = "qa",
  initialClozeText,
  onToast,
  onCardCreated,
  onClose,
}: CardBuilderProps) {
  const defaultLabel = priorityLabel(extractPriority);

  // An image extract opens straight on the occlusion tab — its text-card tabs
  // would have no body. A text extract opens on the requested text tab.
  const [tab, setTab] = useState<BuilderTab>(isImageExtract ? "image_occlusion" : initialTab);
  const [front, setFront] = useState("");
  const [back, setBack] = useState(seedBody?.trim() ?? "");
  const [cloze, setCloze] = useState(initialClozeText ?? seedBody?.trim() ?? "");
  const [priority, setPriority] = useState<PriorityLabel>(defaultLabel);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  // The sibling group the FIRST card from this extract minted; threaded into the
  // next create so a Q&A + cloze pair are recorded as siblings.
  const [siblingGroupId, setSiblingGroupId] = useState<string | undefined>(undefined);

  // When the host re-seeds the builder (a new extract / a Cloze-toolbar open), pick
  // up the new tab + cloze pre-wrap without remounting. An image extract forces the
  // occlusion tab (its text-card tabs have no body).
  useEffect(() => {
    setTab(isImageExtract ? "image_occlusion" : initialTab);
  }, [initialTab, isImageExtract]);
  useEffect(() => {
    if (initialClozeText !== undefined) setCloze(initialClozeText);
  }, [initialClozeText]);

  // Reset the priority chip to the extract's band when the extract changes.
  useEffect(() => {
    setPriority(defaultLabel);
  }, [defaultLabel]);

  // The card-quality report (T035) runs live on every edit. The component holds NO
  // heuristic logic — it calls the pure `@interleave/core` `evaluateCardQuality` and
  // renders the ordered `ok` / `warn` / `block` rows as the `qc` checklist. A
  // `block`-severity check (empty Q&A side / no cloze deletion) gates Create; `warn`s
  // are advisory and never block (the card-quality rule: warnings inform).
  const quality = useMemo(() => {
    const input: CardQualityInput =
      tab === "qa"
        ? { kind: "qa", prompt: front, answer: back, hasSource }
        : { kind: "cloze", cloze, hasSource };
    return evaluateCardQuality(input);
  }, [tab, front, back, cloze, hasSource]);

  // Create is allowed with warnings; only a `block`-severity check (the hollow-card
  // set) disables it. This is the create-time precondition M7's activation reuses.
  const canCreate = !quality.hasBlocker;

  // The Q&A preview face: front, toggling to back on reveal.
  const previewFace = useMemo(() => {
    return revealed ? back : front;
  }, [revealed, front, back]);

  // The cloze preview spans (T034): each `{{cN::…}}` renders as `[ … ]` and reveals
  // its answer on toggle, via the core helper — no ad-hoc regex in the component. The
  // distinct-deletion count drives the "Create cloze card" affordance + (later) T035.
  const clozeSpans = useMemo(
    () => renderClozePrompt(cloze, { revealAll: revealed }),
    [cloze, revealed],
  );
  const clozeCount = useMemo(() => parseCloze(cloze).clozeCount, [cloze]);

  const toggleReveal = useCallback(() => setRevealed((r) => !r), []);

  // Space toggles the preview reveal on BOTH tabs (mirrors the kit's `Kbd ␣`), but
  // only when the user is NOT typing into a field — a bare Space inside a textarea
  // must type a space. Bound once; the handler reads no render-scoped state.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space" && e.key !== " ") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      e.preventDefault();
      setRevealed((r) => !r);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const create = useCallback(async () => {
    if (!canCreate || busy) return;
    setBusy(true);
    try {
      const result = await appApi.createCard({
        extractId,
        kind: tab,
        priority,
        ...(siblingGroupId ? { siblingGroupId } : {}),
        ...(tab === "qa"
          ? { prompt: front.trim(), answer: back.trim() }
          : // Canonicalize `{{ }}` → numbered `{{c1::…}}` before sending so the
            // stored `cards.cloze` is always canonical (the main side re-canonicalizes
            // and derives the structured metadata + `cloze` document_marks).
            { cloze: canonicalizeCloze(cloze) }),
      });
      // Thread the (minted/reused) group so the next card from this extract is a sibling.
      setSiblingGroupId(result.card.siblingGroupId);
      onToast(tab === "qa" ? "Q&A card created" : "Cloze card created");
      onCardCreated();
      // Leave the builder ready for another card: keep the body context, clear the
      // authored prompt so the user does not accidentally re-create the same card.
      if (tab === "qa") {
        setFront("");
      }
      setRevealed(false);
    } catch {
      onToast("Could not create card");
    } finally {
      setBusy(false);
    }
  }, [
    canCreate,
    busy,
    extractId,
    tab,
    priority,
    siblingGroupId,
    front,
    back,
    cloze,
    onToast,
    onCardCreated,
  ]);

  // An image extract (T071) gets the dedicated occlusion editor as the WHOLE builder
  // — its text-card tabs have no body. The editor draws masks over the base image and
  // generates one sibling `image_occlusion` card per mask.
  if (isImageExtract) {
    return (
      <OcclusionEditor
        imageElementId={extractId}
        imagePriority={extractPriority}
        onToast={onToast}
        onCardsCreated={onCardCreated}
        onClose={onClose}
      />
    );
  }

  return (
    <aside className="card-builder" data-testid="card-builder">
      <div className="card-builder__tabs" role="tablist" aria-label="Card type">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "qa"}
          className="cb-tab"
          data-on={tab === "qa" ? "true" : "false"}
          data-testid="cb-tab-qa"
          onClick={() => setTab("qa")}
        >
          Q&amp;A
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "cloze"}
          className="cb-tab"
          data-on={tab === "cloze" ? "true" : "false"}
          data-testid="cb-tab-cloze"
          onClick={() => setTab("cloze")}
        >
          Cloze
        </button>
        <button
          type="button"
          className="cb-tab cb-tab--disabled"
          disabled
          title="Open an image extract to occlude"
          aria-disabled="true"
          data-testid="cb-tab-occlusion-disabled"
        >
          Image occlusion
        </button>
        <button
          type="button"
          className="cb-tab cb-tab--close"
          aria-label="Close card builder"
          data-testid="cb-close"
          onClick={onClose}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="card-builder__body">
        {tab === "qa" ? (
          <>
            <div className="cb-field">
              <div className="cb-field__labelrow">
                <label className="cb-field__label" htmlFor="cb-qa-front">
                  Front · question
                </label>
                {/* T072: a "Predict output" code-card template — pre-seed the prompt
                    as a fenced code block from the extract body so the front renders
                    highlighted code and the answer is the expected output. It is a
                    plain `qa` card (no new kind); the code-aware quality checks apply. */}
                <button
                  type="button"
                  className="cb-template"
                  data-testid="cb-predict-output"
                  title="Seed the prompt with the code; answer is the expected output"
                  onClick={() => {
                    const code = (seedBody ?? back).trim();
                    setFront(
                      code.length > 0
                        ? `What does this code output?\n\`\`\`\n${code}\n\`\`\``
                        : "What does this code output?\n```\n\n```",
                    );
                    setBack("");
                  }}
                >
                  <Icon name="code" size={12} /> Predict output
                </button>
              </div>
              <textarea
                id="cb-qa-front"
                className="cb-textarea"
                rows={2}
                data-testid="cb-qa-front"
                value={front}
                onChange={(e) => setFront(e.target.value)}
                placeholder="Ask one clear, single-fact question…"
              />
            </div>
            <div className="cb-field">
              <label className="cb-field__label" htmlFor="cb-qa-back">
                Back · answer
              </label>
              <textarea
                id="cb-qa-back"
                className="cb-textarea"
                rows={2}
                data-testid="cb-qa-back"
                value={back}
                onChange={(e) => setBack(e.target.value)}
                placeholder="One atomic answer…"
              />
            </div>
            <div className="cb-preview">
              <div className="cardprev__label">Preview · {revealed ? "back" : "front"}</div>
              <div className="cardprev" data-testid="cb-preview">
                <div className="cardprev__face">
                  {previewFace.trim() ? previewFace : <span className="dimmed">—</span>}
                </div>
              </div>
              <button
                type="button"
                className="cb-reveal"
                data-testid="cb-reveal"
                onClick={toggleReveal}
              >
                <Icon name="eye" size={14} /> {revealed ? "Show front" : "Show back"}
                <kbd className="cb-kbd">␣</kbd>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="cb-field">
              <label className="cb-field__label" htmlFor="cb-cloze-text">
                Cloze text · wrap answers in {"{{ }}"}
              </label>
              <textarea
                id="cb-cloze-text"
                className="cb-textarea"
                rows={4}
                data-testid="cb-cloze-text"
                value={cloze}
                onChange={(e) => setCloze(e.target.value)}
                placeholder="Wrap each answer like {{c1::answer}}…"
              />
              <div className="cb-field__hint" data-testid="cb-cloze-count">
                {clozeCount === 0
                  ? "No cloze deletion yet — wrap a phrase in {{ }}"
                  : `${clozeCount} cloze deletion${clozeCount > 1 ? "s" : ""}`}
              </div>
            </div>
            <div className="cb-preview">
              <div className="cardprev__label">Preview · {revealed ? "answers" : "deletions"}</div>
              <div className="cardprev" data-testid="cb-preview">
                <div className="cardprev__face cardprev__face--cloze">
                  {clozeCount === 0 ? (
                    <span className="dimmed">—</span>
                  ) : (
                    clozeSpans.map((span, i) =>
                      span.kind === "deletion" ? (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
                          key={i}
                          className={`cloze${span.revealed ? " cloze--revealed" : ""}`}
                          data-testid="cb-cloze-deletion"
                        >
                          {span.content}
                        </span>
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
                        <span key={i}>{span.content}</span>
                      ),
                    )
                  )}
                </div>
              </div>
              <button
                type="button"
                className="cb-reveal"
                data-testid="cb-reveal"
                onClick={toggleReveal}
              >
                <Icon name="eye" size={14} /> {revealed ? "Hide answers" : "Reveal answers"}
                <kbd className="cb-kbd">␣</kbd>
              </button>
            </div>
          </>
        )}

        {/* Quality checks (T035) — `evaluateCardQuality` runs live; each row is an
            `ok` / `warn` / `block` from the pure core heuristic. `block` rows disable
            Create; `warn` rows are advisory. */}
        <div className="insp-sec cb-quality" data-testid="cb-quality">
          <div className="insp-sec__title">Quality checks</div>
          <div className="cb-quality__rows">
            {quality.checks.map((c) => (
              <div
                key={c.id}
                className={`qc qc--${c.severity}`}
                data-testid={`cb-qc-${c.id}`}
                data-severity={c.severity}
              >
                <Icon name={c.severity === "ok" ? "checkCircle" : "warning"} size={14} />
                {c.message}
              </div>
            ))}
          </div>
        </div>

        {/* Priority & schedule — A/B/C/D chips + the FSRS preview chip. */}
        <div className="insp-sec cb-schedule">
          <div className="insp-sec__title">Priority &amp; schedule</div>
          <div className="cb-prio-row" data-testid="cb-priority">
            {PRIORITY_LABELS.map((p) => (
              <button
                key={p}
                type="button"
                className="cb-prio-chip"
                data-active={priority === p ? "true" : "false"}
                data-testid={`cb-priority-${p}`}
                onClick={() => setPriority(p)}
              >
                <span className={`prio-dot prio-dot--${p.toLowerCase()}`} />
                {p}
              </button>
            ))}
          </div>
          <div className="cb-meta">
            <div className="cb-meta__row">
              <span className="cb-meta__k">First due</span>
              <span className="cb-meta__v">— (M7)</span>
            </div>
            <div className="cb-meta__row">
              <span className="cb-meta__k">Scheduler</span>
              <span className="cb-meta__v">
                <span className="sched sched--fsrs" data-testid="cb-scheduler-fsrs">
                  <Icon name="brain" size={12} /> FSRS
                </span>
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          className="cb-create"
          data-testid="cb-create"
          disabled={!canCreate || busy}
          onClick={() => void create()}
        >
          <Icon name="card" size={14} /> Create {tab === "qa" ? "Q&A" : "cloze"} card
        </button>
      </div>
    </aside>
  );
}
