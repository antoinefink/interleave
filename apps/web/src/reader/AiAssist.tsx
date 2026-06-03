/**
 * AI-assisted distillation surface (T093/T094).
 *
 * Mounted in the extract distillation / card builder. It offers the seven AI
 * formulation actions over the extract's selected span (the extract's own
 * `source_locations` anchor is the grounding), shows each returned DRAFT suggestion
 * with its grounding refblock (the source quote it was made about) + the card-quality
 * warnings, an **Approve** button (mints a parked, un-due `card_draft`) for the
 * card-shaped drafts and a **Dismiss**, and a calm DISABLED state when AI is off
 * ("Turn on AI assistance in Settings →") plus the managed-proxy disclosure banner.
 *
 * The renderer NEVER calls a model, holds a key, or mints a card directly — it sends
 * intents through `window.appApi.ai.*` and shows what main computed. It observes the
 * `ai` job via the existing `jobs.subscribe` surface, then refetches the drafts.
 */

import { useCallback, useEffect, useState } from "react";
import { RefBlock } from "../components/RefBlock";
import type {
  AiActionType,
  AiGroundingLocation,
  AiStatusResult,
  AiSuggestionView,
  LocationSummary,
} from "../lib/appApi";
import { appApi, isDesktop } from "../lib/appApi";
import { useNavigateToLocation } from "./navigateToLocation";

/**
 * Build a full `LocationSummary` from a suggestion's resolved grounding span (T094)
 * so the drafts panel can reuse the shared jump-to-source navigation — an AI draft's
 * refblock jumps to the originating block exactly like an extract/card. AI grounding
 * has no PDF page / region / media clip, so those degrade to `null`.
 */
function locationFromGrounding(g: AiGroundingLocation): LocationSummary {
  return {
    label: g.label,
    selectedText: g.selectedText,
    page: null,
    region: null,
    clip: null,
    timestampMs: null,
    sourceElementId: g.sourceElementId,
    blockIds: g.blockIds,
    startOffset: g.startOffset,
    endOffset: g.endOffset,
  };
}

/** The seven actions + their human labels, in display order. */
const AI_ACTIONS: ReadonlyArray<{ action: AiActionType; label: string }> = [
  { action: "explain", label: "Explain" },
  { action: "simplify", label: "Simplify" },
  { action: "suggest_qa", label: "Suggest Q&A" },
  { action: "suggest_cloze", label: "Suggest cloze" },
  { action: "detect_ambiguity", label: "Detect ambiguity" },
  { action: "propose_prerequisites", label: "Prerequisites" },
  { action: "summarize", label: "Summarize" },
];

/** The grounding span the AI action runs over (the extract's own anchor). */
export interface AiAssistGrounding {
  readonly sourceElementId: string;
  readonly blockIds: readonly string[];
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  readonly selectedText: string;
}

export interface AiAssistProps {
  /** The extract/source the actions run ON (the suggestions' owner). */
  readonly owningElementId: string;
  /** The grounding span (the extract's `source_locations` anchor), or `null` when none. */
  readonly grounding: AiAssistGrounding | null;
}

export function AiAssist({ owningElementId, grounding }: AiAssistProps): React.ReactElement | null {
  const [status, setStatus] = useState<AiStatusResult | null>(null);
  const [suggestions, setSuggestions] = useState<readonly AiSuggestionView[]>([]);
  const [busyAction, setBusyAction] = useState<AiActionType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigateToLocation = useNavigateToLocation();

  const refreshStatus = useCallback(async () => {
    if (!isDesktop() || typeof appApi.aiStatus !== "function") return;
    try {
      setStatus(await appApi.aiStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  const refreshSuggestions = useCallback(async () => {
    if (!isDesktop() || typeof appApi.listAiSuggestions !== "function") return;
    try {
      const res = await appApi.listAiSuggestions({ elementId: owningElementId });
      setSuggestions(res.suggestions);
    } catch {
      setSuggestions([]);
    }
  }, [owningElementId]);

  useEffect(() => {
    void refreshStatus();
    void refreshSuggestions();
  }, [refreshStatus, refreshSuggestions]);

  // Refetch the drafts as the runner finishes each `ai` job.
  useEffect(() => {
    if (!isDesktop() || typeof appApi.subscribeJobs !== "function") return;
    const unsubscribe = appApi.subscribeJobs((job) => {
      if (job.type === "ai" && job.status === "succeeded") {
        void refreshSuggestions();
        setBusyAction(null);
      }
      if (job.type === "ai" && job.status === "failed") {
        setBusyAction(null);
        setError("The AI request failed — check your provider in Settings.");
      }
    });
    return unsubscribe;
  }, [refreshSuggestions]);

  const onRun = useCallback(
    async (action: AiActionType) => {
      if (!grounding || grounding.selectedText.trim().length === 0) return;
      setError(null);
      setBusyAction(action);
      try {
        await appApi.runAi({
          owningElementId,
          action,
          sourceRef: {
            sourceElementId: grounding.sourceElementId,
            blockIds: grounding.blockIds,
            startOffset: grounding.startOffset,
            endOffset: grounding.endOffset,
            selectedText: grounding.selectedText,
          },
        });
        // The result arrives via the jobs subscription (refreshSuggestions).
      } catch (err) {
        setBusyAction(null);
        setError(err instanceof Error ? err.message : "Failed to run the AI action.");
      }
    },
    [grounding, owningElementId],
  );

  const onApprove = useCallback(
    async (suggestionId: string) => {
      await appApi.approveAiCard({ suggestionId });
      await refreshSuggestions();
    },
    [refreshSuggestions],
  );

  const onDismiss = useCallback(
    async (suggestionId: string) => {
      await appApi.dismissAiSuggestion({ suggestionId });
      await refreshSuggestions();
    },
    [refreshSuggestions],
  );

  // Calm DISABLED state — AI is off by default.
  if (status && !status.enabled) {
    return (
      <section className="ai-assist" data-testid="ai-assist-disabled">
        <div className="insp-sec__title">AI assistance</div>
        <p className="dimmed text-sm" style={{ marginTop: 6 }}>
          Turn on AI assistance in Settings → to draft cards from this extract. Every suggestion is
          a draft — it never schedules a card.
        </p>
      </section>
    );
  }

  return (
    <section className="ai-assist" data-testid="ai-assist">
      <div className="insp-sec__title">AI assistance</div>

      {status?.managedProxyEnabled ? (
        <div className="ai-assist__disclosure text-sm" data-testid="ai-assist-proxy-disclosure">
          Managed proxy is on — your selected text is sent off-device to generate suggestions.
        </div>
      ) : null}

      <div
        className="ai-assist__actions"
        data-testid="ai-assist-actions"
        style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}
      >
        {AI_ACTIONS.map(({ action, label }) => (
          <button
            key={action}
            type="button"
            className="reader-btn"
            data-testid={`ai-action-${action}`}
            disabled={busyAction != null || !grounding}
            onClick={() => void onRun(action)}
          >
            {busyAction === action ? "Thinking…" : label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="text-danger text-sm" data-testid="ai-assist-error" style={{ marginTop: 6 }}>
          {error}
        </p>
      ) : null}

      <div className="ai-assist__drafts" data-testid="ai-assist-drafts" style={{ marginTop: 10 }}>
        {suggestions.length === 0 ? (
          <p className="dimmed text-sm">No AI drafts yet. Run an action above.</p>
        ) : (
          suggestions.map((s) => (
            <article
              key={s.id}
              className="ai-draft"
              data-testid="ai-draft"
              data-suggestion-id={s.id}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 10,
                marginBottom: 8,
              }}
            >
              <div className="ai-draft__meta reader-meta reader-meta--mono">{s.action}</div>
              {/* The MODEL output — stored separately from the source quote. */}
              <p
                className="ai-draft__text text-sm"
                data-testid="ai-draft-text"
                style={{ marginTop: 4 }}
              >
                {s.text}
              </p>

              {/* The grounding refblock — the source span this was made ABOUT (T094).
                  When the span resolves a source, the refblock carries a working
                  in-app "jump to source" that lands on the originating block, exactly
                  like an extract/card refblock. */}
              <div
                className="ai-draft__grounding"
                data-testid="ai-draft-grounding"
                style={{ marginTop: 6 }}
              >
                <RefBlock
                  ref={s.grounding}
                  {...(s.groundingLocation
                    ? {
                        onOpenSource: () => {
                          if (s.groundingLocation) {
                            navigateToLocation(locationFromGrounding(s.groundingLocation));
                          }
                        },
                      }
                    : {})}
                />
              </div>

              {/* The card-quality warnings (the same T035/T086 checks). */}
              {s.qualityChecks.some((c) => c.severity !== "ok") ? (
                <ul
                  className="ai-draft__quality"
                  data-testid="ai-draft-quality"
                  style={{ marginTop: 6 }}
                >
                  {s.qualityChecks
                    .filter((c) => c.severity !== "ok")
                    .map((c) => (
                      <li
                        key={c.id}
                        className={
                          c.severity === "block" ? "text-danger text-sm" : "text-sm dimmed"
                        }
                      >
                        {c.message}
                      </li>
                    ))}
                </ul>
              ) : null}

              <div className="ai-draft__actions" style={{ display: "flex", gap: 6, marginTop: 8 }}>
                {(s.kind === "card_qa" || s.kind === "card_cloze") && s.cards.length > 0 ? (
                  <button
                    type="button"
                    className="reader-btn reader-btn--accent"
                    data-testid="ai-draft-approve"
                    onClick={() => void onApprove(s.id)}
                  >
                    Approve → card draft
                  </button>
                ) : null}
                <button
                  type="button"
                  className="reader-btn"
                  data-testid="ai-draft-dismiss"
                  onClick={() => void onDismiss(s.id)}
                >
                  Dismiss
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
