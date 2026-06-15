/**
 * Import-modal triage suggestion hook (T127 — U7).
 *
 * Drives the metadata-keyed suggestion shown next to an import modal's priority
 * picker. The source does not exist or get embedded until AFTER import, so the
 * semantic signal is structurally thin at intake — this path is yield + reliability
 * only, keyed on the author/URL the user has entered. The richer (semantic)
 * suggestion appears later on the inbox row once the source is embedded (U6); that
 * acceptable flip is documented in the plan.
 *
 * Read-only + advisory: the hook only READS `appApi.suggestTriageForMetadata` (no
 * mutation) and the modal defaults the picker to the band but never auto-submits.
 * Passing `currentBand` means an accepted suggestion (band == current) suppresses to
 * `null` on the next pass, so the chip cleanly disappears once taken.
 */

import { useEffect, useState } from "react";
import {
  appApi,
  isDesktop,
  type PriorityLabelInput,
  type TriageSuggestionSuggestionDto,
} from "../../lib/appApi";

/** Debounce (ms) so each keystroke in the URL/author field doesn't fire an IPC read. */
const SUGGEST_DEBOUNCE_MS = 350;

/**
 * Returns the banded suggestion for the entered metadata, or `null` when the signal
 * is thin (the modal shows nothing then). Re-computes, debounced, as the author/URL
 * or current band changes; clears immediately when the modal closes.
 */
export function useTriageMetadataSuggestion(input: {
  readonly open: boolean;
  readonly url: string;
  readonly author: string;
  readonly canonicalUrl: string | null;
  readonly currentBand: PriorityLabelInput;
}): TriageSuggestionSuggestionDto | null {
  const { open, url, author, canonicalUrl, currentBand } = input;
  const [suggestion, setSuggestion] = useState<TriageSuggestionSuggestionDto | null>(null);

  useEffect(() => {
    if (!open || !isDesktop()) {
      setSuggestion(null);
      return;
    }
    const author2 = author.trim();
    const url2 = url.trim();
    // Nothing to key on yet — no author, no URL — so there is no signal.
    if (!author2 && !url2 && !canonicalUrl) {
      setSuggestion(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await appApi.suggestTriageForMetadata({
            author: author2 || null,
            url: url2 || null,
            canonicalUrl,
            currentBand,
          });
          if (!cancelled) setSuggestion(result.kind === "suggestion" ? result : null);
        } catch {
          // A read failure is non-fatal — just show no suggestion.
          if (!cancelled) setSuggestion(null);
        }
      })();
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, url, author, canonicalUrl, currentBand]);

  return suggestion;
}
