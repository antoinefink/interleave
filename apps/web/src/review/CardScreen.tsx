/**
 * Standalone card detail surface. Unlike `/review`, this route opens ONE card by
 * id, so queue/library clicks inspect and repair the clicked `active_card` instead
 * of starting the due-card session.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Prio, SchedulerChip, Stage } from "../components/inspector/primitives";
import { RefBlock } from "../components/RefBlock";
import { appApi, isDesktop, type ReviewCardView, type SchedulerSignals } from "../lib/appApi";
import { useNavigateToLocation } from "../reader/navigateToLocation";
import { useActiveScope } from "../shell/activeScope";
import { useSelection } from "../shell/selection";
import { CardAudioFace } from "./CardAudioFace";
import { CardBody } from "./CardBody";
import { CardFront } from "./CardFront";
import { CardOcclusionFace } from "./CardOcclusionFace";
import { ExpiryBanner } from "./ExpiryBanner";
import { type ReviewCardPatch, ReviewRepairBar } from "./ReviewRepairBar";
import "./review.css";

function chipSignals(card: ReviewCardView): SchedulerSignals {
  return {
    kind: "fsrs",
    retrievability: card.schedulerSignals.retrievability,
    stability: card.schedulerSignals.stability,
    difficulty: card.schedulerSignals.difficulty,
    reps: card.schedulerSignals.reps,
    lapses: card.schedulerSignals.lapses,
    fsrsState: card.schedulerSignals.fsrsState,
    stage: card.stage,
    postponed: 0,
    lastProcessedAt: null,
  };
}

function kindLabel(kind: string): string {
  if (kind === "cloze") return "Cloze";
  if (kind === "image_occlusion") return "Occlusion";
  return "Q&A";
}

export function CardScreen() {
  const { id } = useParams({ from: "/card/$id" });
  const desktop = isDesktop();
  const navigate = useNavigate();
  const navigateToLocation = useNavigateToLocation();
  const { select } = useSelection();

  const [card, setCard] = useState<ReviewCardView | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(false);
  const currentRouteCardIdRef = useRef(id);
  const cardId = card?.id ?? null;
  currentRouteCardIdRef.current = id;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    setCard(null);
    select(null);
    setRevealed(false);
    setDrawerOpen(false);
    setLoading(true);
    setError(null);
    void appApi
      .reviewCard({ cardId: id })
      .then((res) => {
        if (cancelled) return;
        setCard(res.card);
      })
      .catch((e) => {
        if (!cancelled) {
          setCard(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [desktop, id, select]);

  useEffect(() => {
    if (!desktop) return;
    if (revealed && cardId) {
      select(cardId);
    } else {
      select(null);
    }
  }, [desktop, revealed, cardId, select]);

  const openSource = useCallback(() => {
    if (!card?.sourceLocationLabel) return;
    const requestedCardId = card.id;
    void (async () => {
      try {
        const res = await appApi.getInspectorData({ id: requestedCardId });
        if (!mountedRef.current || currentRouteCardIdRef.current !== requestedCardId) return;
        if (res.data?.location) navigateToLocation(res.data.location);
      } catch {
        // Non-fatal: the card remains usable if source navigation fails.
      }
    })();
  }, [card, navigateToLocation]);

  const createVerifyTask = useCallback(async () => {
    if (!card) return;
    await appApi.createTask({
      taskType: "verify_claim",
      title: card.sourceTitle ? `Verify claim from ${card.sourceTitle}` : "Verify this claim",
      linkedElementId: card.id,
    });
  }, [card]);

  const patchCard = useCallback((patch: ReviewCardPatch) => {
    setCard((current) => (current && current.id === patch.id ? { ...current, ...patch } : current));
  }, []);

  const leaveAfterRemoval = useCallback(() => {
    void navigate({ to: "/queue" });
  }, [navigate]);

  // Before reveal, the card detail page must own global source/navigation shortcuts:
  // selecting the card should not let the command palette or `o` reveal source context.
  useActiveScope("review", desktop && !revealed && (loading || card !== null));

  if (!desktop) {
    return (
      <div className="rv-shell" data-testid="route-card">
        <div className="rv-blank">
          <div className="rv-empty">
            <div className="rv-empty__icon">
              <Icon name="brain" size={26} />
            </div>
            <h1 className="rv-empty__title">Card</h1>
            <p className="rv-empty__body">
              Card detail reads through the desktop bridge — open the Electron app to view it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rv-shell" data-testid="route-card">
        <div className="rv-page">
          <div className="rv-summary" data-testid="card-loading">
            <div className="rv-empty">
              <div className="rv-empty__icon">
                <Icon name="brain" size={26} />
              </div>
              <h1 className="rv-empty__title">Opening card…</h1>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!card) {
    return (
      <div className="rv-shell" data-testid="route-card">
        <div className="rv-page">
          <div className="rv-summary" data-testid="card-empty">
            <div className="rv-empty">
              <div className="rv-empty__icon">
                <Icon name="x" size={26} />
              </div>
              <h1 className="rv-empty__title">Card not found</h1>
              <p className="rv-empty__body">
                {error ??
                  "This card may have been deleted, suspended, or imported without a live card row."}
              </p>
              <div className="rv-empty__actions">
                <button
                  type="button"
                  className="rv-btn rv-btn--primary"
                  data-testid="card-back"
                  onClick={() => navigate({ to: "/queue" })}
                >
                  <Icon name="return" size={14} />
                  Back to queue
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rv-shell" data-testid="route-card">
      <div className="rv-top">
        <div className="rv-progress">
          <div className="rv-progress__nums">
            <span className="rv-progress__count" data-testid="card-title">
              {kindLabel(card.kind)} card
            </span>
          </div>
          <div className="pbar">
            <div className="pbar__fill" style={{ width: revealed ? "100%" : "0%" }} />
          </div>
        </div>
        <button
          type="button"
          className="rv-end"
          data-testid="card-back-to-queue"
          onClick={() => navigate({ to: "/queue" })}
        >
          <Icon name="return" size={14} />
          Back to queue
        </button>
      </div>

      {error ? (
        <p className="pq-error" data-testid="card-error" style={{ padding: "8px 24px" }}>
          {error}
        </p>
      ) : null}

      <div className="rv-page">
        <div
          className="rv-stage rv-fade"
          data-testid="card-detail"
          data-card-id={card.id}
          data-card-kind={card.kind}
        >
          <div className="rv-meta">
            <div className="rv-meta__chips">
              <span className="badge badge--soft" data-testid="card-kind">
                {kindLabel(card.kind)}
              </span>
              {card.mediaRef ? (
                <span className="badge badge--soft" data-testid="card-audio-badge">
                  <Icon name="play" size={11} /> Audio
                </span>
              ) : null}
              {card.concept ? <span className="concept-tag">{card.concept}</span> : null}
              <Prio priority={card.priority} />
              <Stage stage={card.stage} />
              {card.flagged ? <span className="badge badge--soft">Flagged</span> : null}
              {card.leech ? (
                <span className="badge badge--leech">Leech · {card.lapses} lapses</span>
              ) : null}
            </div>
            <SchedulerChip scheduler={chipSignals(card)} />
          </div>

          <div className="rcard">
            <div className="rcard__face">
              {card.kind === "image_occlusion" && card.occlusion ? (
                <>
                  <div className="rcard__prompt" data-testid="card-prompt">
                    <CardOcclusionFace occlusion={card.occlusion} revealed={revealed} />
                  </div>
                  {revealed ? (
                    <div className="rcard__reveal-wrap rv-fade" data-testid="card-answer">
                      {card.sourceRef ? (
                        <RefBlock
                          ref={card.sourceRef}
                          testId="card-refblock"
                          {...(card.sourceLocationLabel ? { onOpenSource: openSource } : {})}
                        />
                      ) : null}
                      {card.expiry ? (
                        <ExpiryBanner expiry={card.expiry} onCreateTask={createVerifyTask} />
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="rcard__prompt" data-testid="card-prompt">
                    {card.mediaRef &&
                    (card.mediaRef.on === "prompt" || card.mediaRef.on === "both") ? (
                      <CardAudioFace
                        mediaRef={card.mediaRef}
                        mediaSource={card.mediaSource}
                        youtubeId={card.youtubeId}
                        face="prompt"
                      />
                    ) : null}
                    <CardFront card={card} revealed={false} />
                  </div>
                  {revealed ? (
                    <div className="rcard__reveal-wrap rv-fade" data-testid="card-answer">
                      {card.mediaRef &&
                      (card.mediaRef.on === "answer" || card.mediaRef.on === "both") ? (
                        <CardAudioFace
                          mediaRef={card.mediaRef}
                          mediaSource={card.mediaSource}
                          youtubeId={card.youtubeId}
                          face="answer"
                        />
                      ) : null}
                      <div className="rcard__answer">
                        {card.kind === "cloze" ? (
                          <CardFront card={card} revealed={true} />
                        ) : (
                          <CardBody body={card.answer ?? ""} />
                        )}
                      </div>
                      {card.sourceRef ? (
                        <RefBlock
                          ref={card.sourceRef}
                          dedupeSnippetAgainst={card.kind === "qa" ? card.answer : null}
                          testId="card-refblock"
                          {...(card.sourceLocationLabel ? { onOpenSource: openSource } : {})}
                        />
                      ) : null}
                      {card.expiry ? (
                        <ExpiryBanner expiry={card.expiry} onCreateTask={createVerifyTask} />
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <hr className="card-sep" />
            <div className="rcard__pad">
              {!revealed ? (
                <button
                  type="button"
                  className="rv-reveal"
                  data-testid="card-reveal"
                  onClick={() => setRevealed(true)}
                >
                  <Icon name="eye" size={16} />
                  Reveal answer
                </button>
              ) : (
                <button
                  type="button"
                  className="rv-reveal"
                  data-testid="card-hide"
                  onClick={() => setRevealed(false)}
                >
                  <Icon name="eye" size={16} />
                  Hide answer
                </button>
              )}
            </div>
          </div>

          {revealed ? (
            <ReviewRepairBar
              card={card}
              busy={false}
              onOpenSource={openSource}
              onCardUpdated={patchCard}
              onCardRemoved={leaveAfterRemoval}
              drawerOpen={drawerOpen}
              onDrawerOpenChange={setDrawerOpen}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
