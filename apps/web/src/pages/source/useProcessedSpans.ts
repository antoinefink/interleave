/**
 * Reader block-processing adapter.
 *
 * The old T026 "processed span" affordance was persisted as `document_marks`.
 * Source blocks now have a durable processing outcome owned by the main-process
 * block-processing service. This hook keeps the reader integration small by
 * projecting those block outcomes into the same decoration/button shape the page
 * already uses.
 */

import type { ProcessedDecoration } from "@interleave/editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appApi,
  isDesktop,
  type SourceBlockProcessingState,
  type SourceBlockProcessingSummaryPayload,
  type SourceBlockProcessingViewPayload,
} from "../../lib/appApi";

const MARK_PREFIX = "bp:";
const TERMINAL_STATES = new Set<SourceBlockProcessingState>([
  "extracted",
  "ignored",
  "processed_without_output",
]);

export interface UseProcessedSpansResult {
  /** Source blocks projected as reader node decorations. */
  readonly processed: readonly ProcessedDecoration[];
  /** Full block-processing views, in document order. */
  readonly blocks: readonly SourceBlockProcessingViewPayload[];
  /** Source-level progress/yield summary. */
  readonly summary: SourceBlockProcessingSummaryPayload | null;
  /** Whether a block is in a terminal outcome. */
  readonly isProcessed: (blockId: string) => boolean;
  /** The synthetic decoration id for a block, or `null` if unknown. */
  readonly markIdFor: (blockId: string) => string | null;
  /** Current processing state for a block, or `null` if it is not loaded. */
  readonly stateFor: (blockId: string) => SourceBlockProcessingState | null;
  /** Mark a block processed without output. */
  readonly mark: (blockId: string) => Promise<boolean>;
  /** Restore a block to explicit unread from a synthetic decoration id. */
  readonly restore: (markId: string) => Promise<boolean>;
  /** Toggle processed-without-output vs unread. */
  readonly toggle: (blockId: string) => Promise<"marked" | "restored" | null>;
  /** Mark a block ignored. */
  readonly markIgnored: (blockId: string) => Promise<boolean>;
  /** Mark a block as needing a later pass. */
  readonly markNeedsLater: (blockId: string) => Promise<boolean>;
  /** Reload block-processing state from the desktop bridge. */
  readonly reload: () => Promise<void>;
  /** The last load/mutate error message, if any. */
  readonly error: string | null;
}

function toDecoration(block: SourceBlockProcessingViewPayload): ProcessedDecoration {
  return {
    markId: `${MARK_PREFIX}${block.stableBlockId}`,
    blockId: block.stableBlockId,
    state: block.state,
    derivedFrom: block.derivedFrom,
  };
}

function blockIdFromSyntheticMark(markId: string): string | null {
  return markId.startsWith(MARK_PREFIX) ? markId.slice(MARK_PREFIX.length) : null;
}

export function useProcessedSpans(elementId: string | null | undefined): UseProcessedSpansResult {
  const [blocks, setBlocks] = useState<readonly SourceBlockProcessingViewPayload[]>([]);
  const [summary, setSummary] = useState<SourceBlockProcessingSummaryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeElementId = useRef<string | null>(elementId ?? null);
  const requestVersion = useRef(0);

  if (activeElementId.current !== (elementId ?? null)) {
    activeElementId.current = elementId ?? null;
    requestVersion.current += 1;
  }

  const isCurrentRequest = useCallback((sourceId: string, version: number): boolean => {
    return activeElementId.current === sourceId && requestVersion.current === version;
  }, []);

  const reload = useCallback(async () => {
    if (!elementId || !isDesktop()) {
      setBlocks([]);
      setSummary(null);
      return;
    }
    const requestSourceId = elementId;
    const version = requestVersion.current;
    try {
      const result = await appApi.listBlockProcessing({ sourceElementId: requestSourceId });
      if (!isCurrentRequest(requestSourceId, version)) return;
      setBlocks(result.blocks);
      setSummary(result.summary);
      setError(null);
    } catch (e) {
      if (!isCurrentRequest(requestSourceId, version)) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [elementId, isCurrentRequest]);

  useEffect(() => {
    let cancelled = false;
    if (!elementId || !isDesktop()) {
      setBlocks([]);
      setSummary(null);
      return;
    }
    const requestSourceId = elementId;
    const version = requestVersion.current;
    void appApi
      .listBlockProcessing({ sourceElementId: requestSourceId })
      .then((result) => {
        if (!cancelled && isCurrentRequest(requestSourceId, version)) {
          setBlocks(result.blocks);
          setSummary(result.summary);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled && isCurrentRequest(requestSourceId, version)) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [elementId, isCurrentRequest]);

  const byBlock = useMemo(
    () => new Map(blocks.map((block) => [block.stableBlockId, block])),
    [blocks],
  );

  const processed = useMemo(() => blocks.map(toDecoration), [blocks]);

  const stateFor = useCallback(
    (blockId: string): SourceBlockProcessingState | null => byBlock.get(blockId)?.state ?? null,
    [byBlock],
  );

  const isProcessed = useCallback(
    (blockId: string): boolean => {
      const state = stateFor(blockId);
      return state != null && TERMINAL_STATES.has(state);
    },
    [stateFor],
  );

  const markIdFor = useCallback(
    (blockId: string): string | null => (byBlock.has(blockId) ? `${MARK_PREFIX}${blockId}` : null),
    [byBlock],
  );

  const mutate = useCallback(
    async (
      blockId: string,
      fn: (request: { sourceElementId: string; stableBlockId: string }) => Promise<{
        readonly block: SourceBlockProcessingViewPayload;
        readonly summary: SourceBlockProcessingSummaryPayload;
      }>,
    ) => {
      if (!elementId || !isDesktop() || blockId.length === 0) return false;
      const requestSourceId = elementId;
      const version = requestVersion.current;
      try {
        const result = await fn({ sourceElementId: requestSourceId, stableBlockId: blockId });
        if (!isCurrentRequest(requestSourceId, version)) return false;
        setBlocks((current) => {
          const next = current.map((block) =>
            block.stableBlockId === result.block.stableBlockId ? result.block : block,
          );
          return next.some((block) => block.stableBlockId === result.block.stableBlockId)
            ? next
            : [...next, result.block].sort((a, b) => a.order - b.order);
        });
        setSummary(result.summary);
        setError(null);
        return true;
      } catch (e) {
        if (!isCurrentRequest(requestSourceId, version)) return false;
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [elementId, isCurrentRequest],
  );

  const mark = useCallback(
    async (blockId: string) => mutate(blockId, (request) => appApi.markBlockProcessed(request)),
    [mutate],
  );

  const markIgnored = useCallback(
    async (blockId: string) =>
      stateFor(blockId) === "extracted"
        ? false
        : mutate(blockId, (request) => appApi.markBlockIgnored(request)),
    [mutate, stateFor],
  );

  const markNeedsLater = useCallback(
    async (blockId: string) =>
      stateFor(blockId) === "extracted"
        ? false
        : mutate(blockId, (request) => appApi.markBlockNeedsLater(request)),
    [mutate, stateFor],
  );

  const restore = useCallback(
    async (markId: string) => {
      const blockId = blockIdFromSyntheticMark(markId);
      if (!blockId) return false;
      return mutate(blockId, (request) => appApi.markBlockUnread(request));
    },
    [mutate],
  );

  const toggle = useCallback(
    async (blockId: string) => {
      if (stateFor(blockId) === "extracted") return null;
      if (isProcessed(blockId)) {
        return (await mutate(blockId, (request) => appApi.markBlockUnread(request)))
          ? "restored"
          : null;
      }
      return (await mark(blockId)) ? "marked" : null;
    },
    [isProcessed, mark, mutate, stateFor],
  );

  return {
    processed,
    blocks,
    summary,
    isProcessed,
    markIdFor,
    stateFor,
    mark,
    restore,
    toggle,
    markIgnored,
    markNeedsLater,
    reload,
    error,
  };
}
