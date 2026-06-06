import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { FsrsStats, Prio, SchedulerChip, Stage } from "../components/inspector/primitives";
import { RefBlock } from "../components/RefBlock";
import "../components/inspector/inspector.css";
import { appApi, type ReviewCardView, type SchedulerSignals } from "../lib/appApi";
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

/** Adapt a review card's FSRS signals to the shared scheduler primitives shape. */
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

export interface CardDetailPanelProps {
  readonly cardId: string;
  readonly initiallyRevealed?: boolean;
  readonly backLabel?: string;
  readonly backTestId?: string;
  readonly emptyBackTestId?: string;
  readonly onBack?: () => void;
  readonly onCardRemoved: (cardId: string) => void | Promise<void>;
}

export function CardDetailPanel({
  cardId: targetCardId,
  initiallyRevealed = false,
  backLabel = "Back",
  backTestId = "card-back",
  emptyBackTestId = "card-back",
  onBack,
  onCardRemoved,
}: CardDetailPanelProps) {
  const navigateToLocation = useNavigateToLocation();
  const { select } = useSelection();

  const [card, setCard] = useState<ReviewCardView | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [repairBusy, setRepairBusy] = useState(false);
  const mountedRef = useRef(false);
  const currentTargetCardIdRef = useRef(targetCardId);
  const repairBusyRef = useRef(false);
  const sourceLookupSeqRef = useRef(0);
  const loadedCardId = card?.id ?? null;
  currentTargetCardIdRef.current = targetCardId;
  repairBusyRef.current = repairBusy;

  const setRepairBusyNow = useCallback((next: boolean) => {
    repairBusyRef.current = next;
    if (next) sourceLookupSeqRef.current += 1;
    setRepairBusy(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sourceLookupSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCard(null);
    select(null);
    setRevealed(initiallyRevealed);
    setDrawerOpen(false);
    setRepairBusyNow(false);
    setLoading(true);
    setError(null);
    sourceLookupSeqRef.current += 1;
    void appApi
      .reviewCard({ cardId: targetCardId })
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
  }, [targetCardId, initiallyRevealed, select, setRepairBusyNow]);

  useEffect(() => {
    if (revealed && loadedCardId) {
      select(loadedCardId);
    } else {
      select(null);
    }
  }, [revealed, loadedCardId, select]);

  const openSource = useCallback(() => {
    if (repairBusyRef.current) return;
    if (!card?.sourceLocationLabel) return;
    const requestedCardId = card.id;
    const requestSeq = ++sourceLookupSeqRef.current;
    void (async () => {
      try {
        const res = await appApi.getInspectorData({ id: requestedCardId });
        if (
          !mountedRef.current ||
          currentTargetCardIdRef.current !== requestedCardId ||
          sourceLookupSeqRef.current !== requestSeq
        ) {
          return;
        }
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

  const leaveAfterRemoval = useCallback(
    async (removedCardId: string) => {
      sourceLookupSeqRef.current += 1;
      if (!mountedRef.current || currentTargetCardIdRef.current !== removedCardId) return;
      await onCardRemoved(removedCardId);
    },
    [onCardRemoved],
  );

  // Before reveal, the card detail surface must own global source/navigation shortcuts:
  // selecting the card should not let the command palette or `o` reveal source context.
  useActiveScope("review", repairBusy || (!revealed && (loading || card !== null)));

  if (loading) {
    return (
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
    );
  }

  if (!card) {
    return (
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
            {onBack ? (
              <div className="rv-empty__actions">
                <button
                  type="button"
                  className="rv-btn rv-btn--primary"
                  data-testid={emptyBackTestId}
                  onClick={onBack}
                >
                  <Icon name="return" size={14} />
                  {backLabel}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const scheduler = chipSignals(card);
  const showRepair = revealed;

  const hideAnswer = () => {
    if (repairBusyRef.current) return;
    setRevealed(false);
    setDrawerOpen(false);
  };

  return (
    <>
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
        {onBack ? (
          <button
            type="button"
            className="rv-end"
            data-testid={backTestId}
            disabled={repairBusy}
            onClick={() => {
              if (!repairBusyRef.current) onBack();
            }}
          >
            <Icon name="return" size={14} />
            {backLabel}
          </button>
        ) : null}
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
            <SchedulerChip scheduler={scheduler} />
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
                  disabled={repairBusy}
                  onClick={hideAnswer}
                >
                  <Icon name="eye" size={16} />
                  Hide answer
                </button>
              )}
            </div>
          </div>

          {showRepair ? (
            <ReviewRepairBar
              card={card}
              busy={repairBusy}
              onBusyChange={setRepairBusyNow}
              onOpenSource={openSource}
              onCardUpdated={patchCard}
              onCardRemoved={leaveAfterRemoval}
              drawerOpen={drawerOpen}
              onDrawerOpenChange={setDrawerOpen}
            />
          ) : null}

          <div className="rv-stats-block">
            <FsrsStats scheduler={scheduler} />
          </div>
        </div>
      </div>
    </>
  );
}
