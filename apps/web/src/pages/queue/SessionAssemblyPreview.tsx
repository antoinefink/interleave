import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { TypeIcon } from "../../components/inspector/primitives";
import {
  appApi,
  type QueueSessionPlanRequest,
  type QueueSessionPlanResult,
} from "../../lib/appApi";
import {
  acceptSessionAssembly,
  type SessionAssemblyOrigin,
  sessionMinuteLabel,
} from "./sessionAssemblyState";

const PRESETS = [15, 25, 45] as const;

export function SessionAssemblyPreview({
  open,
  origin,
  asOf,
  defaultTargetMinutes,
  request,
  onClose,
}: {
  open: boolean;
  origin: SessionAssemblyOrigin;
  asOf?: string;
  defaultTargetMinutes: number;
  request?: Omit<QueueSessionPlanRequest, "targetMinutes">;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const titleId = useId();
  const [target, setTarget] = useState(defaultTargetMinutes);
  const [plan, setPlan] = useState<QueueSessionPlanResult | null>(null);
  const [planRequestKey, setPlanRequestKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const loadSeqRef = useRef(0);
  const invalid = !Number.isFinite(target) || !Number.isInteger(target) || target < 0;

  const fullRequest = useMemo<QueueSessionPlanRequest | null>(() => {
    if (invalid) return null;
    return {
      ...(request ?? {}),
      ...(asOf ? { asOf } : {}),
      targetMinutes: target,
    };
  }, [asOf, invalid, request, target]);
  const requestKey = useMemo(
    () => (fullRequest ? JSON.stringify(fullRequest) : null),
    [fullRequest],
  );

  const load = useCallback(async () => {
    if (!open || !fullRequest || !requestKey) return;
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    setLoading(true);
    setPlan(null);
    setPlanRequestKey(null);
    setError(null);
    try {
      const next = await appApi.previewSessionPlan(fullRequest);
      if (loadSeqRef.current !== seq) return;
      setPlan(next);
      setPlanRequestKey(requestKey);
      window.setTimeout(() => statusRef.current?.focus(), 0);
    } catch (e) {
      if (loadSeqRef.current !== seq) return;
      setPlan(null);
      setPlanRequestKey(null);
      setError(e instanceof Error ? e.message : String(e));
      window.setTimeout(() => statusRef.current?.focus(), 0);
    } finally {
      if (loadSeqRef.current === seq) setLoading(false);
    }
  }, [fullRequest, open, requestKey]);

  useEffect(() => {
    if (!open) return;
    setTarget(defaultTargetMinutes);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [defaultTargetMinutes, open]);

  useEffect(() => {
    if (!open || invalid) return;
    void load();
  }, [invalid, load, open]);

  if (!open) return null;

  const approximate = plan?.usesDefaultEstimate ?? false;
  const canStart =
    !!plan && planRequestKey === requestKey && plan.items.length > 0 && !loading && !confirming;

  return (
    <section className="q-session-preview" data-testid="session-preview" aria-labelledby={titleId}>
      <div className="q-session-preview__head">
        <div>
          <h2 id={titleId}>Plan session</h2>
          <p>Choose a time box, then start the exact deck shown here.</p>
        </div>
        <button
          type="button"
          className="q-session-preview__close"
          aria-label="Close session preview"
          onClick={onClose}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="q-session-preview__controls">
        <fieldset className="q-session-preview__presets">
          <legend className="sr-only">Session length presets</legend>
          {PRESETS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={`q-session-preview__preset${target === minutes ? " q-session-preview__preset--on" : ""}`}
              aria-pressed={target === minutes}
              onClick={() => setTarget(minutes)}
            >
              {minutes}
            </button>
          ))}
        </fieldset>
        <label className="q-session-preview__field">
          <span>Minutes</span>
          <input
            ref={inputRef}
            data-testid="session-target-minutes"
            inputMode="numeric"
            type="number"
            min={0}
            step={1}
            value={target}
            onChange={(event) => setTarget(Number(event.currentTarget.value))}
          />
        </label>
        <button
          type="button"
          className="q-overload-banner__btn"
          disabled={invalid || loading}
          onClick={() => void load()}
        >
          <Icon name="review" size={13} />
          Preview
        </button>
      </div>

      {invalid ? (
        <div
          ref={statusRef}
          tabIndex={-1}
          className="q-session-preview__status"
          data-testid="session-preview-error"
          role="alert"
        >
          Enter a whole number of minutes.
        </div>
      ) : loading ? (
        <div
          ref={statusRef}
          tabIndex={-1}
          className="q-session-preview__status"
          role="status"
          aria-live="polite"
        >
          Planning session...
        </div>
      ) : error ? (
        <div
          ref={statusRef}
          tabIndex={-1}
          className="q-session-preview__status q-session-preview__status--error"
          data-testid="session-preview-error"
          role="alert"
        >
          {error}
        </div>
      ) : plan ? (
        <div ref={statusRef} tabIndex={-1} role="status" aria-live="polite">
          <div className="q-session-preview__summary">
            <span>
              Plan {plan.plannedCount} of {plan.candidateCount} due item
              {plan.candidateCount === 1 ? "" : "s"}
            </span>
            <strong data-testid="session-planned-minutes">
              {sessionMinuteLabel(plan.plannedMinutes, approximate)}
            </strong>
          </div>
          {sessionCompositionCopy(plan) ? (
            <p className="q-session-preview__note" data-testid="session-composition">
              {sessionCompositionCopy(plan)}
            </p>
          ) : null}
          {plan.overTarget ? (
            <p className="q-session-preview__note">
              The first item is larger than the target, so this session starts with that one item.
            </p>
          ) : approximate ? (
            <p className="q-session-preview__note">Minute estimates include documented defaults.</p>
          ) : null}

          {plan.items.length === 0 ? (
            <div className="q-session-preview__empty">No due work fits this target.</div>
          ) : (
            <ul className="q-session-preview__list" aria-label="Planned session items">
              {plan.items.slice(0, 6).map((row) => (
                <li key={row.item.id} className="q-session-preview__row">
                  <TypeIcon type={row.item.type} />
                  <span className="q-session-preview__row-title">{row.item.title}</span>
                  <span data-testid="session-planned-row-minutes">
                    {sessionMinuteLabel(row.estimatedMinutes, row.estimateConfidence === "default")}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="q-session-preview__cut" data-testid="session-cut-list">
            <span data-testid="session-cut-count">
              Left out {plan.cut.totalCount} item{plan.cut.totalCount === 1 ? "" : "s"}
            </span>
            <strong>{sessionMinuteLabel(plan.cut.totalMinutes, approximate)}</strong>
          </div>
          {plan.cut.items.length > 0 ? (
            <ul className="q-session-preview__list" aria-label="Left-out session items">
              {plan.cut.items.slice(0, 4).map((row) => (
                <li key={row.item.id} className="q-session-preview__row">
                  <TypeIcon type={row.item.type} />
                  <span className="q-session-preview__row-title">{row.item.title}</span>
                  <span>{row.reason === "did_not_fit" ? "Did not fit" : row.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="q-session-preview__actions">
        <button
          type="button"
          className="q-overload-banner__btn"
          disabled={confirming}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="sessionbar__start"
          data-testid="session-preview-start"
          disabled={!canStart}
          onClick={() => {
            if (!plan || planRequestKey !== requestKey) return;
            setConfirming(true);
            acceptSessionAssembly({
              origin,
              ...(asOf ? { asOf } : {}),
              mode: request?.mode ?? "full",
              filters: {
                ...(request?.types ? { types: request.types } : {}),
                ...(request?.statuses ? { statuses: request.statuses } : {}),
                ...(request?.protectedOnly ? { protectedOnly: true } : {}),
                ...(request?.concept ? { concept: request.concept } : {}),
                ...(request?.tag ? { tag: request.tag } : {}),
              },
              plan,
            });
            void navigate({
              to: "/process",
              search: { ...(asOf ? { asOf } : {}), assembled: 1 },
            });
          }}
        >
          <Icon name="play" size={14} />
          Start planned deck
        </button>
      </div>
    </section>
  );
}

function sessionCompositionCopy(plan: QueueSessionPlanResult): string | null {
  const { composition } = plan;
  if (!composition) return null;
  if (composition.status === "unavailable_no_time_estimate") return null;
  let first: string;
  if (composition.status === "active") {
    first = `Distillation floor active: ${composition.quotaFloorMinutes} min reserved.`;
  } else if (composition.status === "returned_empty_backlog") {
    first = "Distillation share returned: no due extracts.";
  } else if (composition.status === "inactive_filtered_out") {
    return "Current filter: distillation quota inactive.";
  } else {
    return "Distillation floor off.";
  }
  const other = composition.otherMinutes
    ? `, ${Math.round(composition.otherMinutes)} min other work`
    : "";
  return `${first} Planned ${Math.round(composition.distillationMinutes)} min distillation, ${Math.round(
    composition.cardMinutes,
  )} min cards${other}.`;
}
