/**
 * Inbox-row triage suggestion fetch hook (T127 — U6).
 *
 * Owns the batched `triage.suggest` fetch that decorates inbox rows with an advisory
 * band + justification. Extracted from `InboxScreen` so the fetch lifecycle is testable
 * and the screen stays lean.
 *
 * Two deliberate properties (code-review fixes):
 *  - **Refetch only on the id SET, never on item content.** The effect keys on a stable
 *    id-signature string, so accepting / re-prioritizing ONE row does not re-arm every
 *    row to pending and re-run the per-row KNN over the whole visible list. A single
 *    triage write changes an item's priority but not the id set, so no refetch fires.
 *  - **Cap the fetch at the IPC bound.** A >1000-item inbox would otherwise have the
 *    whole `ids` batch rejected by the channel's `max(1000)` guard — suppressing every
 *    suggestion for exactly the large-inbox users T127 targets. Cap to the first N so
 *    the feature degrades gracefully instead of vanishing.
 *
 * Read-only + advisory: it only READS `suggestTriage`; nothing is auto-applied (R12).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { appApi, isDesktop } from "../../lib/appApi";
import type { InboxRowSuggestion } from "./InboxGroupedList";

/** Matches the `triage:suggest` contract bound so a huge inbox still suggests the first N. */
export const SUGGESTION_FETCH_CAP = 1000;

export interface InboxSuggestionsState {
  /** Per-id verdict; a MISSING key renders the neutral pending placeholder. */
  readonly suggestions: ReadonlyMap<string, InboxRowSuggestion>;
  /** Drop a stale chip for one id (no clobber) — used by the accept staleness path. */
  readonly dropSuggestion: (id: string) => void;
}

/**
 * Fetch suggestions for the listed inbox ids. `itemIds` may be a fresh array each render;
 * the hook derives a stable signature so the fetch fires only when the id SET changes.
 */
export function useInboxSuggestions(itemIds: readonly string[]): InboxSuggestionsState {
  const [suggestions, setSuggestions] = useState<ReadonlyMap<string, InboxRowSuggestion>>(
    () => new Map(),
  );
  // The effect keys on this string, not the array reference, so a content-only change
  // (a row's priority) does not refire the fetch.
  const idSignature = useMemo(() => itemIds.join("\n"), [itemIds]);

  useEffect(() => {
    if (!isDesktop() || idSignature === "") {
      setSuggestions(new Map());
      return;
    }
    const ids = idSignature.split("\n").slice(0, SUGGESTION_FETCH_CAP);
    let cancelled = false;
    // Carry forward verdicts already known for surviving ids (no flash); drop removed
    // ids; genuinely-new ids are absent → they render pending until the fetch resolves.
    setSuggestions((prev) => {
      const carried = new Map<string, InboxRowSuggestion>();
      for (const id of ids) {
        const known = prev.get(id);
        if (known) carried.set(id, known);
      }
      return carried;
    });
    void (async () => {
      try {
        const { results } = await appApi.suggestTriage({ ids });
        if (cancelled) return;
        setSuggestions((prev) => {
          const next = new Map(prev);
          for (const entry of results) next.set(entry.id, entry.suggestion);
          return next;
        });
      } catch {
        // Suggestions are advisory; on failure resolve the still-pending ids to a
        // suppressed verdict so the rows stop "computing" and simply show no chip.
        if (cancelled) return;
        setSuggestions((prev) => {
          const next = new Map(prev);
          for (const id of ids) {
            if (!next.has(id)) {
              next.set(id, { kind: "insufficient_signal", reason: "no_signal_fired" });
            }
          }
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idSignature]);

  const dropSuggestion = useCallback((id: string) => {
    setSuggestions((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, { kind: "insufficient_signal", reason: "matches_current" });
      return next;
    });
  }, []);

  return { suggestions, dropSuggestion };
}
