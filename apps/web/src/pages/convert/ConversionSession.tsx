import { canonicalizeCloze, evaluateCardQuality, renderClozePrompt } from "@interleave/core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { Prio, SchedulerChip, Stage, typeLabel } from "../../components/inspector/primitives";
import { RefBlock } from "../../components/RefBlock";
import {
  appApi,
  type ConversionDraftSummary,
  type ConversionPrefetchDraftsResult,
  type ConversionSessionItem,
  type ConversionSessionPreviewResult,
  type DirectExtractFate,
  isDesktop,
  type PriorityLabel,
} from "../../lib/appApi";
import "../../components/inspector/inspector.css";
import "./conversion-session.css";

type CardMode = "qa" | "cloze";

interface BuilderState {
  readonly mode: CardMode;
  readonly prompt: string;
  readonly answer: string;
  readonly cloze: string;
  readonly priority: PriorityLabel;
  readonly suggestionId?: string;
  readonly status:
    | "clean"
    | "manual-dirty"
    | "draft-prefilled"
    | "draft-edited"
    | "creating"
    | "created"
    | "blocked"
    | "stale";
}

const PRIORITIES: readonly PriorityLabel[] = ["A", "B", "C", "D"];

function priorityLabel(priority: number): PriorityLabel {
  const v = Math.min(1, Math.max(0, priority));
  if (v >= 0.75) return "A";
  if (v >= 0.5) return "B";
  if (v >= 0.25) return "C";
  return "D";
}

function initialBuilder(item: ConversionSessionItem): BuilderState {
  const body = item.plainText.trim() || item.excerpt.trim();
  return {
    mode: "qa",
    prompt: "",
    answer: body,
    cloze: body,
    priority: priorityLabel(item.priority),
    status: "clean",
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

function isDirty(builder: BuilderState): boolean {
  return (
    builder.status === "manual-dirty" ||
    builder.status === "draft-prefilled" ||
    builder.status === "draft-edited"
  );
}

function draftToBuilder(
  item: ConversionSessionItem,
  draft: ConversionDraftSummary,
): Omit<BuilderState, "priority" | "status"> {
  const card = draft.cards[0];
  if (card?.kind === "cloze") {
    return {
      mode: "cloze",
      prompt: "",
      answer: item.plainText.trim(),
      cloze: card.cloze?.trim() || draft.suggestionText.trim() || item.plainText.trim(),
      suggestionId: draft.id,
    };
  }
  if (card?.kind === "qa") {
    return {
      mode: "qa",
      prompt: card.prompt?.trim() ?? "",
      answer: card.answer?.trim() || draft.suggestionText.trim() || item.plainText.trim(),
      cloze: item.plainText.trim(),
      suggestionId: draft.id,
    };
  }
  if (draft.action === "suggest_cloze" || draft.kind === "card_cloze") {
    return {
      mode: "cloze",
      prompt: "",
      answer: item.plainText.trim(),
      cloze: draft.suggestionText.trim() || item.plainText.trim(),
      suggestionId: draft.id,
    };
  }
  return {
    mode: "qa",
    prompt: "",
    answer: draft.suggestionText.trim() || item.plainText.trim(),
    cloze: item.plainText.trim(),
    suggestionId: draft.id,
  };
}

function formatDateTime(value: string | null): string {
  if (!value) return "No due date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function skipReasonLabel(reason: string): string {
  return reason.replaceAll("_", " ");
}

function activeItems(
  items: readonly ConversionSessionItem[],
  consumedIds: ReadonlySet<string>,
): readonly ConversionSessionItem[] {
  return items.filter((item) => !consumedIds.has(item.id));
}

function isBuilderDirty(builder: BuilderState | undefined): boolean {
  return builder ? isDirty(builder) : false;
}

export function ConversionSession() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<ConversionSessionPreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [consumedIds, setConsumedIds] = useState<Set<string>>(() => new Set());
  const [builders, setBuilders] = useState<Record<string, BuilderState>>({});
  const [pendingReplacement, setPendingReplacement] = useState<ConversionDraftSummary | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [aiAction, setAiAction] = useState<"suggest_qa" | "suggest_cloze">("suggest_qa");
  const [aiBusy, setAiBusy] = useState(false);
  const [fatePending, setFatePending] = useState(false);
  const [aiResult, setAiResult] = useState<ConversionPrefetchDraftsResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (mode: "initial" | "refresh" = "initial", sessionId?: string) => {
    if (!isDesktop()) {
      setLoading(false);
      return;
    }
    if (mode === "refresh") setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const result = await appApi.previewConversionSession({
        limit: 25,
        ...(mode === "refresh" && sessionId ? { sessionId } : {}),
      });
      setPreview(result);
      if (mode === "refresh" && result.staleItemIds.length > 0) {
        setNotice(`${result.staleItemIds.length} session item(s) changed and were removed`);
      }
      setConsumedIds((prior) => {
        const liveIds = new Set(result.items.map((item) => item.id));
        return new Set([...prior].filter((id) => liveIds.has(id)));
      });
      setBuilders((prior) => {
        const next: Record<string, BuilderState> = {};
        for (const item of result.items) {
          next[item.id] = prior[item.id] ?? initialBuilder(item);
        }
        return next;
      });
      setCursor((current) => Math.min(current, Math.max(0, result.items.length - 1)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load conversion session");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(
    () => activeItems(preview?.items ?? [], consumedIds),
    [preview, consumedIds],
  );
  const selected = items.length > 0 ? items[Math.min(cursor, items.length - 1)] : null;
  const builder = selected ? (builders[selected.id] ?? initialBuilder(selected)) : null;

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  const patchBuilder = useCallback((itemId: string, patch: Partial<BuilderState>) => {
    setBuilders((prior) => {
      const current = prior[itemId];
      if (!current) return prior;
      return { ...prior, [itemId]: { ...current, ...patch } };
    });
  }, []);

  const markEdited = useCallback((itemId: string, patch: Partial<BuilderState>) => {
    setBuilders((prior) => {
      const current = prior[itemId];
      if (!current) return prior;
      const nextStatus =
        current.status === "draft-prefilled" || current.status === "draft-edited"
          ? "draft-edited"
          : "manual-dirty";
      const next: BuilderState = {
        ...current,
        ...patch,
        status: nextStatus,
        ...(patch.suggestionId !== undefined ? { suggestionId: patch.suggestionId } : {}),
      };
      if (patch.suggestionId === undefined) delete (next as { suggestionId?: string }).suggestionId;
      return { ...prior, [itemId]: next };
    });
  }, []);

  const quality = useMemo(() => {
    if (!builder) return { hasBlocker: true, checks: [] };
    return evaluateCardQuality(
      builder.mode === "qa"
        ? { kind: "qa", prompt: builder.prompt, answer: builder.answer, hasSource: true }
        : { kind: "cloze", cloze: builder.cloze, hasSource: true },
    );
  }, [builder]);

  const canCreate = Boolean(
    builder && selected && !quality.hasBlocker && builder.status !== "creating",
  );
  const mutationPending = builder?.status === "creating" || fatePending;

  const advance = useCallback(() => {
    if (mutationPending) return;
    setCursor((current) => Math.min(current + 1, Math.max(0, items.length - 1)));
  }, [items.length, mutationPending]);

  const retreat = useCallback(() => {
    if (mutationPending) return;
    setCursor((current) => Math.max(0, current - 1));
  }, [mutationPending]);

  const consumeSelected = useCallback(
    (itemId: string) => {
      setConsumedIds((prior) => new Set(prior).add(itemId));
      setCursor((current) => Math.min(current, Math.max(0, items.length - 2)));
    },
    [items.length],
  );

  const applyDraft = useCallback(
    (draft: ConversionDraftSummary, replaceDirty = false) => {
      if (!selected || !builder) return;
      if (builder.status === "creating") return;
      if (isDirty(builder) && !replaceDirty) {
        setPendingReplacement(draft);
        return;
      }
      const draftState = draftToBuilder(selected, draft);
      patchBuilder(selected.id, {
        ...draftState,
        priority: builder.priority,
        status: "draft-prefilled",
      });
      setPendingReplacement(null);
      setNotice("Draft copied into the builder");
    },
    [builder, patchBuilder, selected],
  );

  const createCard = useCallback(async () => {
    if (!selected || !builder || !preview || !canCreate) return;
    patchBuilder(selected.id, { status: "creating" });
    try {
      await appApi.createConversionCard({
        sessionId: preview.sessionId,
        extractId: selected.id,
        kind: builder.mode,
        priority: builder.priority,
        ...(builder.suggestionId ? { suggestionId: builder.suggestionId } : {}),
        ...(builder.mode === "qa"
          ? { prompt: builder.prompt.trim(), answer: builder.answer.trim() }
          : { cloze: canonicalizeCloze(builder.cloze) }),
      });
      patchBuilder(selected.id, { status: "created" });
      consumeSelected(selected.id);
      setNotice("Card created");
    } catch {
      patchBuilder(selected.id, { status: "stale" });
      setNotice("This statement changed. Refresh or skip it.");
    }
  }, [builder, canCreate, consumeSelected, patchBuilder, preview, selected]);

  const applyFate = useCallback(
    async (fate: DirectExtractFate) => {
      if (!selected || !preview || mutationPending) return;
      setFatePending(true);
      try {
        await appApi.setConversionFate({ sessionId: preview.sessionId, id: selected.id, fate });
        consumeSelected(selected.id);
        setNotice(fate === "reference" ? "Marked as reference" : "Marked done without card");
      } catch {
        patchBuilder(selected.id, { status: "stale" });
        setNotice("Could not apply fate. Refresh the session.");
      } finally {
        setFatePending(false);
      }
    },
    [consumeSelected, mutationPending, patchBuilder, preview, selected],
  );

  const requestAiDrafts = useCallback(async () => {
    if (!preview || aiBusy || mutationPending) return;
    setAiBusy(true);
    try {
      const result = await appApi.prefetchConversionDrafts({
        sessionId: preview.sessionId,
        action: aiAction,
        consentedAt: new Date().toISOString(),
      });
      setAiResult(result);
      setConsentOpen(false);
      setNotice("AI draft request queued");
    } catch {
      setNotice("Could not queue AI drafts");
    } finally {
      setAiBusy(false);
    }
  }, [aiAction, aiBusy, mutationPending, preview]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (isTypingTarget(event.target)) return;
      if (mutationPending) return;
      if (event.key === "ArrowRight" || event.key.toLowerCase() === "n") {
        event.preventDefault();
        advance();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        retreat();
      } else if (event.key.toLowerCase() === "q" && selected) {
        event.preventDefault();
        patchBuilder(selected.id, { mode: "qa" });
        if (canCreate && builder?.mode === "qa") void createCard();
      } else if (event.key.toLowerCase() === "c" && selected) {
        event.preventDefault();
        patchBuilder(selected.id, { mode: "cloze" });
        if (canCreate && builder?.mode === "cloze") void createCard();
      } else if (event.key.toLowerCase() === "d") {
        event.preventDefault();
        setConsentOpen(true);
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        const fate = document.querySelector<HTMLButtonElement>(
          "[data-testid='convert-fate-reference']",
        );
        fate?.focus();
      } else if (event.key.toLowerCase() === "o" && selected?.sourceRef.sourceElementId) {
        event.preventDefault();
        void navigate({ to: "/source/$id", params: { id: selected.sourceRef.sourceElementId } });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    advance,
    builder?.mode,
    canCreate,
    createCard,
    mutationPending,
    navigate,
    patchBuilder,
    retreat,
    selected,
  ]);

  if (!desktop) {
    return (
      <main className="convert-shell">
        <div className="convert-empty" data-testid="convert-non-desktop">
          <Icon name="warning" size={18} />
          <h1>Desktop app required</h1>
          <p>
            Batch conversion uses the local database bridge and is unavailable in renderer-only
            mode.
          </p>
        </div>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="convert-shell">
        <div className="convert-empty" data-testid="convert-loading">
          <Icon name="hourglass" size={18} />
          <h1>Loading conversion session</h1>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="convert-shell">
        <div className="convert-empty convert-empty--error" data-testid="convert-error">
          <Icon name="warning" size={18} />
          <h1>Could not load conversion session</h1>
          <p>{error}</p>
          <div className="convert-empty__actions">
            <button
              type="button"
              className="convert-btn convert-btn--primary"
              onClick={() => void load()}
            >
              Retry
            </button>
            <button
              type="button"
              className="convert-btn"
              onClick={() => void navigate({ to: "/queue" })}
            >
              Back to queue
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (!preview || preview.items.length === 0 || !selected || !builder) {
    return (
      <main className="convert-shell">
        <div className="convert-empty" data-testid="convert-empty">
          <Icon name="checkCircle" size={18} />
          <h1>No atomic statements ready</h1>
          <p>The conversion backlog is clear for this snapshot.</p>
          <button
            type="button"
            className="convert-btn convert-btn--primary"
            onClick={() => void navigate({ to: "/queue" })}
          >
            Back to queue
          </button>
        </div>
      </main>
    );
  }

  const currentNumber = preview.items.findIndex((item) => item.id === selected.id) + 1;
  const progressPct =
    preview.items.length === 0 ? 0 : (consumedIds.size / preview.items.length) * 100;
  const clozePreview = renderClozePrompt(builder.cloze, { revealAll: false }).map(
    (part, index) => ({
      ...part,
      previewKey: `${part.kind}:${part.content}:${index}`,
    }),
  );
  const draftCount = selected.drafts.length;

  return (
    <main className="convert-shell" data-testid="convert-session">
      <header className="convert-head">
        <button
          type="button"
          className="convert-btn"
          data-testid="convert-back-queue"
          onClick={() => void navigate({ to: "/queue" })}
        >
          <Icon name="chevronLeft" size={14} />
          Queue
        </button>
        <div className="convert-progress" data-testid="convert-session-meta">
          <div className="convert-progress__nums">
            <span>
              Session {preview.sessionId} · {preview.candidateCount} candidates · item{" "}
              {currentNumber} of {preview.items.length}
            </span>
            <span>expires {formatDateTime(preview.expiresAt)}</span>
          </div>
          <span className="convert-progress__bar">
            <i style={{ width: `${progressPct}%` }} />
          </span>
        </div>
        <button
          type="button"
          className="convert-btn"
          data-testid="convert-refresh"
          disabled={refreshing || mutationPending}
          onClick={() => void load("refresh", preview.sessionId)}
        >
          <Icon name="review" size={14} />
          {refreshing ? "Refreshing" : "Refresh"}
        </button>
      </header>

      {notice ? (
        <div className="convert-notice" data-testid="convert-notice" role="status">
          {notice}
          <button type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : null}

      {consentOpen ? (
        <section className="convert-consent" data-testid="convert-ai-consent">
          <Icon name="sparkle" size={16} />
          <div>
            <h2>Draft cards for this session</h2>
            <p>
              AI drafts are generated only for this frozen session snapshot. They stay inert until
              copied into the builder and submitted.
            </p>
          </div>
          <div className="convert-consent__actions">
            <select
              aria-label="AI draft action"
              value={aiAction}
              onChange={(event) =>
                setAiAction(event.target.value as "suggest_qa" | "suggest_cloze")
              }
            >
              <option value="suggest_qa">Q&A drafts</option>
              <option value="suggest_cloze">Cloze drafts</option>
            </select>
            <button
              type="button"
              className="convert-btn convert-btn--primary"
              data-testid="convert-ai-confirm"
              disabled={aiBusy || mutationPending}
              onClick={() => void requestAiDrafts()}
            >
              {aiBusy ? "Queueing" : "Start AI drafts"}
            </button>
            <button type="button" className="convert-btn" onClick={() => setConsentOpen(false)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {aiResult ? (
        <div className="convert-ai-result" data-testid="convert-ai-result">
          {aiResult.queued} queued · {aiResult.alreadyDrafted} already drafted ·{" "}
          {aiResult.skipped.length} skipped
          {aiResult.skipped.length > 0 ? (
            <span>
              {" "}
              ({aiResult.skipped.map((item) => skipReasonLabel(item.reason)).join(", ")})
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="convert-grid">
        <aside className="convert-list" aria-label="Conversion candidates">
          {items.map((item, index) => (
            <button
              type="button"
              key={item.id}
              className="convert-item"
              data-testid="convert-item"
              data-active={item.id === selected.id ? "true" : "false"}
              disabled={mutationPending}
              onClick={() => setCursor(index)}
            >
              <span className="convert-item__title">{item.title}</span>
              <span className="convert-item__meta">
                <Prio priority={item.priority} />
                <span>{formatDateTime(item.dueAt)}</span>
                {isBuilderDirty(builders[item.id]) ? (
                  <span className="badge badge--soft">draft</span>
                ) : null}
              </span>
            </button>
          ))}
        </aside>

        <section className="convert-context">
          <div className="convert-context__head">
            <div>
              <span className="convert-kicker">{typeLabel("extract")}</span>
              <h1 data-testid="convert-selected-title">{selected.title}</h1>
            </div>
            <div className="convert-chips">
              <Stage stage="atomic_statement" />
              <Prio priority={selected.priority} />
              <SchedulerChip
                scheduler={{
                  kind: selected.schedulerSignals.kind,
                  retrievability: selected.schedulerSignals.retrievability,
                  stability: selected.schedulerSignals.stability,
                  difficulty: null,
                  reps: null,
                  lapses: selected.schedulerSignals.lapses,
                  fsrsState: selected.schedulerSignals.fsrsState,
                  stage: selected.schedulerSignals.stage,
                  postponed: selected.schedulerSignals.postponed,
                  scheduleReason: selected.schedulerSignals.scheduleReason ?? null,
                  lastProcessedAt: null,
                }}
              />
            </div>
          </div>

          <blockquote className="convert-statement" data-testid="convert-statement">
            {selected.plainText || selected.excerpt}
          </blockquote>

          <RefBlock
            ref={selected.sourceRef}
            dedupeSnippetAgainst={selected.plainText}
            {...(selected.sourceRef.sourceElementId
              ? {
                  onOpenSource: () =>
                    void navigate({
                      to: "/source/$id",
                      params: {
                        id:
                          selected.sourceRef.sourceElementId ??
                          selected.aiGrounding.sourceElementId,
                      },
                    }),
                }
              : {})}
            testId="convert-source-ref"
          />

          <div className="convert-grounding" data-testid="convert-grounding">
            <span>Grounding</span>
            <code>{selected.aiGrounding.blockIds.join(", ") || "no blocks"}</code>
            <span>{selected.aiGrounding.selectedText}</span>
          </div>

          {builder.status === "stale" ? (
            <div className="convert-stale" data-testid="convert-stale">
              <Icon name="warning" size={14} />
              This item may already be converted or no longer eligible.
              <button
                type="button"
                className="convert-link"
                onClick={() => void load("refresh", preview.sessionId)}
              >
                Refresh
              </button>
            </div>
          ) : null}

          <div className="convert-actions">
            <button
              type="button"
              className="convert-btn"
              data-testid="convert-prev"
              onClick={retreat}
              disabled={cursor === 0 || mutationPending}
            >
              <Icon name="chevronLeft" size={14} />
              Previous
            </button>
            <button
              type="button"
              className="convert-btn"
              data-testid="convert-skip"
              onClick={advance}
              disabled={items.length <= 1 || mutationPending}
            >
              Skip
              <Icon name="chevronRight" size={14} />
            </button>
            <button
              type="button"
              className="convert-btn"
              data-testid="convert-ai-open"
              disabled={mutationPending}
              onClick={() => setConsentOpen(true)}
            >
              <Icon name="sparkle" size={14} />
              Draft with AI
            </button>
            <button
              type="button"
              className="convert-btn"
              data-testid="convert-fate-reference"
              disabled={mutationPending}
              onClick={() => void applyFate("reference")}
            >
              Reference
            </button>
            <button
              type="button"
              className="convert-btn"
              data-testid="convert-fate-done"
              disabled={mutationPending}
              onClick={() => void applyFate("done_without_card")}
            >
              Done without card
            </button>
          </div>
        </section>

        <aside className="convert-builder" data-testid="convert-builder">
          <div className="convert-builder__tabs" role="tablist" aria-label="Card type">
            <button
              type="button"
              role="tab"
              aria-selected={builder.mode === "qa"}
              className="convert-tab"
              data-active={builder.mode === "qa" ? "true" : "false"}
              data-testid="convert-tab-qa"
              disabled={mutationPending}
              onClick={() => markEdited(selected.id, { mode: "qa" })}
            >
              Q&amp;A
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={builder.mode === "cloze"}
              className="convert-tab"
              data-active={builder.mode === "cloze" ? "true" : "false"}
              data-testid="convert-tab-cloze"
              disabled={mutationPending}
              onClick={() => markEdited(selected.id, { mode: "cloze" })}
            >
              Cloze
            </button>
          </div>

          {builder.mode === "qa" ? (
            <>
              <label className="convert-field">
                <span>Front · question</span>
                <textarea
                  rows={3}
                  data-testid="convert-prompt"
                  value={builder.prompt}
                  disabled={mutationPending}
                  onChange={(event) => markEdited(selected.id, { prompt: event.target.value })}
                />
              </label>
              <label className="convert-field">
                <span>Back · answer</span>
                <textarea
                  rows={4}
                  data-testid="convert-answer"
                  value={builder.answer}
                  disabled={mutationPending}
                  onChange={(event) => markEdited(selected.id, { answer: event.target.value })}
                />
              </label>
            </>
          ) : (
            <label className="convert-field">
              <span>Cloze text</span>
              <textarea
                rows={6}
                data-testid="convert-cloze"
                value={builder.cloze}
                disabled={mutationPending}
                onChange={(event) => markEdited(selected.id, { cloze: event.target.value })}
              />
            </label>
          )}

          <fieldset className="convert-priority">
            <legend className="sr-only">Priority</legend>
            {PRIORITIES.map((priority) => (
              <button
                key={priority}
                type="button"
                className="convert-prio"
                data-active={builder.priority === priority ? "true" : "false"}
                data-testid={`convert-priority-${priority}`}
                disabled={mutationPending}
                onClick={() => markEdited(selected.id, { priority })}
              >
                {priority}
              </button>
            ))}
          </fieldset>

          <div className="convert-preview" data-testid="convert-card-preview">
            {builder.mode === "qa" ? (
              <>
                <strong>{builder.prompt.trim() || "Question"}</strong>
                <span>{builder.answer.trim() || "Answer"}</span>
              </>
            ) : (
              <span>
                {clozePreview.map((part) =>
                  part.kind === "deletion" ? (
                    <mark key={part.previewKey}>{part.content}</mark>
                  ) : (
                    <span key={part.previewKey}>{part.content}</span>
                  ),
                )}
              </span>
            )}
          </div>

          <div className="convert-quality" data-testid="convert-quality">
            {quality.checks
              .filter((check) => check.severity !== "ok")
              .map((check) => (
                <span key={check.id} className={`qc qc--${check.severity}`}>
                  <Icon name={check.severity === "block" ? "warning" : "info"} size={13} />
                  {check.message}
                </span>
              ))}
            {!quality.hasBlocker ? (
              <span className="qc qc--ok">
                <Icon name="checkCircle" size={13} />
                Ready
              </span>
            ) : null}
          </div>

          <button
            type="button"
            className="convert-create"
            data-testid="convert-create"
            disabled={!canCreate || mutationPending}
            onClick={() => void createCard()}
          >
            <Icon name="card" size={14} />
            {builder.status === "creating"
              ? "Creating"
              : `Create ${builder.mode === "qa" ? "Q&A" : "cloze"} card`}
          </button>

          <section className="convert-drafts" data-testid="convert-drafts">
            <div className="convert-drafts__head">
              <h2>Drafts</h2>
              <span>{draftCount}</span>
            </div>
            {selected.drafts.length === 0 ? (
              <p>No live drafts for this statement.</p>
            ) : (
              selected.drafts.map((draft) => (
                <article key={draft.id} className="convert-draft" data-testid="convert-draft">
                  <div>
                    <strong>
                      {draft.action === "suggest_cloze" ? "Cloze draft" : "Q&A draft"}
                    </strong>
                    <span>{draft.providerKind}</span>
                  </div>
                  <p>{draft.suggestionText}</p>
                  <button
                    type="button"
                    className="convert-btn"
                    data-testid={`convert-use-draft-${draft.id}`}
                    disabled={mutationPending}
                    onClick={() => applyDraft(draft)}
                  >
                    Use draft
                  </button>
                </article>
              ))
            )}
          </section>
        </aside>
      </div>

      {pendingReplacement ? (
        <div
          className="convert-confirm"
          data-testid="convert-replace-confirm"
          role="dialog"
          aria-modal="true"
        >
          <div>
            <strong>Replace current builder text?</strong>
            <p>
              This statement has session-local edits. Replacing copies the AI draft into the form.
            </p>
          </div>
          <button
            type="button"
            className="convert-btn convert-btn--primary"
            data-testid="convert-replace-confirm-yes"
            onClick={() => applyDraft(pendingReplacement, true)}
          >
            Replace
          </button>
          <button type="button" className="convert-btn" onClick={() => setPendingReplacement(null)}>
            Keep edits
          </button>
        </div>
      ) : null}
    </main>
  );
}
