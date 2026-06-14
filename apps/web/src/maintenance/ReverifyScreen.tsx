/**
 * Re-verify drain (T124) — the maintenance surface that resolves T123's content-staleness
 * flags. When a source block is edited, its derived outputs (extract / atomic statement /
 * card) gain a `needs_reverify` flag; T123 only made that VISIBLE. This screen DRAINS it:
 * per source, grouped, with the old→new anchor diff shown once per block, each flagged
 * output resolves as
 *  - **confirm** — drift immaterial, clear the flag (one keystroke, the default/safe action),
 *  - **rebase** — re-anchor to the corrected text (extracts re-derive the body main-side),
 *  - **detach** — freeze a provenance snapshot, keep the output standalone.
 *
 * Architecture (non-negotiable): UI ONLY. No resolution logic, no provenance math — every
 * action is a typed `appApi.reverify.*` call; the main process owns the transaction, the
 * `operation_log` op, and the receipt. The verb fires IMMEDIATELY (no select-then-Apply):
 * the spec's hardest constraint is that confirm be nearly free (enter-enter-enter through
 * immaterial drift) or users ignore the queue and the flags become noise.
 */

import { Link, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { SNACKBAR_TIMEOUT_LONG_MS, Snackbar } from "../components/Snackbar";
import {
  appApi,
  isDesktop,
  type ReverifyFlaggedSource,
  type ReverifyResolutionVerb,
  type ReverifyResolveSkipReason,
  type ReverifySessionItem,
} from "../lib/appApi";
import { UNDO_EVENT } from "../shell/nav";
import { reverifyDiff } from "./reverifyDiff";
import "../review/review.css";
import "./leech-cleanup.css";
import "./reverify.css";

/** The human label for each skip reason shown on a row that didn't resolve. */
const SKIP_LABEL: Record<ReverifyResolveSkipReason, string> = {
  "not-flagged": "Already resolved",
  "block-re-edited": "Re-edited since preview",
  "target-changed": "Re-edited since preview",
  deleted: "No longer present",
  "rebase-failed": "Re-verify failed — edit manually",
};

/** Readable extract-stage label for the row meta. */
function stageLabel(stage: string): string {
  switch (stage) {
    case "raw_extract":
      return "Raw";
    case "clean_extract":
      return "Clean";
    case "atomic_statement":
      return "Atomic";
    default:
      return stage;
  }
}

/** The small old→new diff shown once per changed block (context, not the action). */
function BlockDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const segments = reverifyDiff(oldText, newText);
  return (
    <div className="rv-block__diff" data-testid="reverify-diff">
      {segments.map((seg, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: diff segments have no stable id and the whole list re-renders when the source text changes, so positional keys are safe.
          key={`${seg.type}-${i}`}
          className={`rv-diff__${seg.type}`}
          data-diff={seg.type}
        >
          {seg.text}
        </span>
      ))}
    </div>
  );
}

/** A flagged item grouped under the block whose drift produced it. */
interface Grouped {
  readonly stableBlockId: string;
  readonly oldAnchorText: string;
  readonly currentBlockText: string;
  readonly items: ReverifySessionItem[];
}

/** Group a source's flagged items by the block they're anchored to, for one diff per block. */
function groupByBlock(items: readonly ReverifySessionItem[]): Grouped[] {
  const order: string[] = [];
  const map = new Map<string, Grouped>();
  for (const item of items) {
    let g = map.get(item.stableBlockId);
    if (!g) {
      g = {
        stableBlockId: item.stableBlockId,
        oldAnchorText: item.oldAnchorText,
        currentBlockText: item.currentBlockText,
        items: [],
      };
      map.set(item.stableBlockId, g);
      order.push(item.stableBlockId);
    }
    g.items.push(item);
  }
  return order.map((id) => map.get(id) as Grouped);
}

export function ReverifyScreen() {
  const desktop = isDesktop();
  // Optional `?source=<id>` scopes the screen to one source (entered from the chip /
  // source page); absent → every source with flagged outputs.
  const search = useSearch({ strict: false }) as { source?: string };
  const scopeSource = typeof search.source === "string" ? search.source : undefined;

  const [sources, setSources] = useState<readonly ReverifyFlaggedSource[]>([]);
  // Live, mutable per-source item lists (optimistic removal on resolve).
  const [itemsBySource, setItemsBySource] = useState<Record<string, ReverifySessionItem[]>>({});
  const [remainingBySource, setRemainingBySource] = useState<Record<string, number>>({});
  const [skips, setSkips] = useState<Record<string, ReverifyResolveSkipReason>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snack, setSnack] = useState<{ message: string; onUndo?: () => void } | null>(null);

  const mountedRef = useRef(true);
  // Confirm buttons keyed by elementId — for "enter-enter-enter" focus advancement.
  const confirmRefs = useRef(new Map<string, HTMLButtonElement | null>());
  // The flattened, ordered element ids across all groups (focus traversal order).
  const orderRef = useRef<string[]>([]);
  // In-flight guard for receipt undo (the snackbar Undo isn't gated by `busy`).
  const undoingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const summary = await appApi.reverifyFlaggedSources();
      const scoped = scopeSource
        ? summary.sources.filter((s) => s.sourceElementId === scopeSource)
        : summary.sources;
      // allSettled, not all: a single source's preview failing (a transient IPC error)
      // should degrade THAT source, not blank the whole drain and force a full retry.
      const previews = await Promise.allSettled(
        scoped.map((s) => appApi.reverifySessionPreview({ sourceElementId: s.sourceElementId })),
      );
      if (!mountedRef.current) return;
      const nextItems: Record<string, ReverifySessionItem[]> = {};
      const nextRemaining: Record<string, number> = {};
      scoped.forEach((s, i) => {
        const settled = previews[i];
        if (settled?.status !== "fulfilled") return;
        nextItems[s.sourceElementId] = [...settled.value.items];
        nextRemaining[s.sourceElementId] = settled.value.remaining;
      });
      setSources(scoped);
      setItemsBySource(nextItems);
      setRemainingBySource(nextRemaining);
      setSkips({});
      setError(null);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [scopeSource]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read after any global undo (⌘Z) so a restored flag reappears.
  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(UNDO_EVENT, handler);
    return () => window.removeEventListener(UNDO_EVENT, handler);
  }, [load]);

  // Keep the focus-traversal order in sync with what's rendered; focus the first
  // Confirm once items are loaded so the keyboard-first flow starts immediately.
  useEffect(() => {
    const order: string[] = [];
    for (const s of sources) {
      for (const item of itemsBySource[s.sourceElementId] ?? []) order.push(item.elementId);
    }
    orderRef.current = order;
    const first = order[0];
    if (first && !loading) {
      confirmRefs.current.get(first)?.focus();
    }
  }, [sources, itemsBySource, loading]);

  /** Focus the next still-present item's Confirm after one resolves (enter-enter-enter). */
  const focusAfter = useCallback((resolvedId: string) => {
    const order = orderRef.current;
    const idx = order.indexOf(resolvedId);
    for (let k = idx + 1; k < order.length; k++) {
      const nextId = order[k];
      const btn = nextId ? confirmRefs.current.get(nextId) : undefined;
      if (btn) {
        btn.focus();
        return;
      }
    }
    // None after it — fall back to the first remaining.
    for (const id of order) {
      const btn = confirmRefs.current.get(id);
      if (btn && id !== resolvedId) {
        btn.focus();
        return;
      }
    }
  }, []);

  /** Reverse a sitting through its receipt (NOT the global stack). Refuse → terminal toast. */
  const undoReceipt = useCallback((batchId: string) => {
    // In-flight guard: a fast double-tap on Undo would round-trip the second click against
    // an already-undone receipt and flash a confusing "receipt-not-actionable" refusal.
    if (undoingRef.current) return;
    undoingRef.current = true;
    void (async () => {
      try {
        const res = await appApi.reverifyUndoReceipt({ batchId });
        if (!mountedRef.current) return;
        if (!res.undone) {
          // The source drifted since the sitting — refuse, don't clobber. Terminal toast
          // (no Undo button): the user can't resolve the conflict from here.
          setSnack({ message: res.reason ?? "Couldn't undo — the source changed since." });
          return;
        }
        setSnack(null);
        window.dispatchEvent(new CustomEvent(UNDO_EVENT));
      } finally {
        undoingRef.current = false;
      }
    })();
  }, []);

  /** Apply one or more decisions for a source in a single op-logged batch. */
  const resolveDecisions = useCallback(
    async (sourceId: string, picks: ReverifySessionItem[], verb: ReverifyResolutionVerb) => {
      const last = picks[picks.length - 1];
      if (busy || !last) return;
      setBusy(true);
      const lastId = last.elementId;
      try {
        const res = await appApi.reverifyResolve({
          sourceElementId: sourceId,
          decisions: picks.map((p) => ({
            elementId: p.elementId,
            stableBlockId: p.stableBlockId,
            verb,
            fingerprint: p.fingerprint,
          })),
        });
        if (!mountedRef.current) return;
        const skipById = new Map(res.skipped.map((s) => [s.elementId, s.reason] as const));
        // Applied items drop optimistically; skipped items stay with an inline badge.
        setItemsBySource((prev) => {
          const list = prev[sourceId] ?? [];
          return { ...prev, [sourceId]: list.filter((it) => skipById.has(it.elementId)) };
        });
        if (skipById.size > 0) {
          setSkips((prev) => {
            const next = { ...prev };
            for (const [id, reason] of skipById) next[id] = reason;
            return next;
          });
        }
        if (res.applied > 0) {
          const noun = res.applied === 1 ? "item" : "items";
          const tail = skipById.size > 0 ? ` · ${skipById.size} need attention` : "";
          setSnack({
            message: `Re-verified ${res.applied} ${noun}${tail}`,
            onUndo: () => undoReceipt(res.batchId),
          });
        } else if (skipById.size > 0) {
          setSnack({ message: `${skipById.size} need attention — re-edited or removed since.` });
        }
        focusAfter(lastId);
      } catch (e) {
        if (mountedRef.current) {
          setError(e instanceof Error ? e.message : String(e));
          // The batch transaction rolls back atomically on an unexpected error; re-read so
          // the rendered list can't drift from the persisted state.
          void load();
        }
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, focusAfter, undoReceipt, load],
  );

  if (!desktop) {
    return (
      <div className="rv-shell" data-testid="route-reverify">
        <div className="rv-blank">
          <div className="rv-empty">
            <div className="rv-empty__icon">
              <Icon name="warning" size={26} />
            </div>
            <h1 className="rv-empty__title">Re-verify</h1>
            <p className="rv-empty__body">
              Outputs whose source was edited are listed here to confirm, rebase, or detach — open
              the Electron app to drain the queue.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const totalItems = sources.reduce(
    (n, s) => n + (itemsBySource[s.sourceElementId]?.length ?? 0),
    0,
  );

  return (
    <div className="rv-shell lc-shell" data-testid="route-reverify">
      <div className="lc-head">
        <div>
          <h1 className="lc-title">
            <Icon name="warning" size={18} />
            Re-verify
          </h1>
          <p className="lc-sub">
            A source you edited changed text these outputs were built from. Confirm if the drift is
            immaterial, rebase to the corrected text, or detach to keep the output standalone.
          </p>
        </div>
        <span className="lc-count" data-testid="reverify-count">
          {totalItems} to re-verify
        </span>
      </div>

      {error ? (
        <p className="pq-error" data-testid="reverify-error" style={{ padding: "8px 24px" }}>
          {error}
          <button
            type="button"
            className="rv-repair__btn"
            style={{ marginLeft: 8 }}
            onClick={() => void load()}
          >
            Retry
          </button>
        </p>
      ) : null}

      {loading ? (
        <p className="lc-loading" data-testid="reverify-loading" style={{ padding: "12px 24px" }}>
          Loading…
        </p>
      ) : totalItems === 0 ? (
        <div className="rv-empty" data-testid="reverify-empty">
          <div className="rv-empty__icon">
            <Icon name="checkCircle" size={26} />
          </div>
          <h2 className="rv-empty__title">All caught up</h2>
          <p className="rv-empty__body">
            No outputs need re-verification. When you edit a source, the outputs built from the
            changed text appear here to confirm, rebase, or detach.
          </p>
          <Link to="/maintenance" className="rv-repair__btn" data-testid="reverify-empty-hub">
            Back to maintenance
          </Link>
        </div>
      ) : (
        sources.map((source) => {
          const items = itemsBySource[source.sourceElementId] ?? [];
          if (items.length === 0) return null;
          const groups = groupByBlock(items);
          const remaining = remainingBySource[source.sourceElementId] ?? 0;
          return (
            <div className="rv-group" key={source.sourceElementId} data-testid="reverify-group">
              <div className="rv-group__head" style={{ cursor: "default" }}>
                <Icon name="source" size={14} />
                <span className="rv-group__title" title={source.title}>
                  {source.title}
                </span>
                <span className="rv-group__count">{items.length} flagged</span>
              </div>

              {groups.map((g) => (
                <div className="rv-block" key={g.stableBlockId} data-testid="reverify-block">
                  <BlockDiff oldText={g.oldAnchorText} newText={g.currentBlockText} />
                  {g.items.map((item) => {
                    const skip = skips[item.elementId];
                    return (
                      <div className="rv-item" key={item.elementId} data-testid="reverify-item">
                        <span className="rv-item__title" title={item.title}>
                          <span className="badge badge--soft">
                            {item.type === "extract" ? stageLabel(item.stage) : item.type}
                          </span>
                          {item.title}
                        </span>
                        {skip ? (
                          <span className="rv-item__skip" data-testid="reverify-skip">
                            {SKIP_LABEL[skip]}
                          </span>
                        ) : (
                          <div className="rv-item__actions">
                            <button
                              type="button"
                              ref={(el) => {
                                confirmRefs.current.set(item.elementId, el);
                              }}
                              className="rv-repair__btn se-btn--suggested"
                              data-testid="reverify-confirm"
                              disabled={busy}
                              title="Drift is immaterial — clear the flag"
                              onClick={() =>
                                void resolveDecisions(source.sourceElementId, [item], "confirm")
                              }
                            >
                              <Icon name="check" size={14} />
                              Confirm
                            </button>
                            <button
                              type="button"
                              className="rv-repair__btn"
                              data-testid="reverify-rebase"
                              disabled={busy}
                              title="Re-anchor to the corrected source text"
                              onClick={() =>
                                void resolveDecisions(source.sourceElementId, [item], "rebase")
                              }
                            >
                              <Icon name="review" size={14} />
                              Rebase
                            </button>
                            <button
                              type="button"
                              className="rv-repair__btn"
                              data-testid="reverify-detach"
                              disabled={busy}
                              title="Stands alone — won't re-flag on future source edits"
                              onClick={() =>
                                void resolveDecisions(source.sourceElementId, [item], "detach")
                              }
                            >
                              <Icon name="split" size={14} />
                              Detach
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}

              <div className="rv-bulk">
                <button
                  type="button"
                  className="rv-repair__btn"
                  data-testid="reverify-bulk-confirm"
                  disabled={busy}
                  onClick={() => void resolveDecisions(source.sourceElementId, items, "confirm")}
                >
                  <Icon name="check" size={14} />
                  Confirm all ({items.length})
                </button>
              </div>

              {remaining > 0 ? (
                <p className="rv-resume" data-testid="reverify-resume">
                  {remaining} more from this source — resume later.{" "}
                  <Link to="/maintenance">Back to maintenance</Link>
                </p>
              ) : null}
            </div>
          );
        })
      )}

      <Snackbar
        message={snack?.message ?? null}
        onUndo={snack?.onUndo}
        onClose={() => setSnack(null)}
        icon="checkCircle"
        timeoutMs={SNACKBAR_TIMEOUT_LONG_MS}
        testId="reverify-snackbar"
      />
    </div>
  );
}
