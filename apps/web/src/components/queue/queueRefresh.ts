/**
 * Cross-surface queue refresh signal.
 *
 * Queue mutations can originate outside the queue screens, for example the
 * inspector's compact attention scheduler. This UI-only event lets queue views
 * re-read through their normal typed appApi paths without sharing component state.
 */
export const QUEUE_REFRESH_EVENT = "interleave:queue-refresh";

/** Ask any mounted queue surface to re-read its current queue state. */
export function requestQueueRefresh(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(QUEUE_REFRESH_EVENT));
  }
}

/** Subscribe to external queue refresh requests. */
export function listenQueueRefresh(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(QUEUE_REFRESH_EVENT, handler);
  return () => window.removeEventListener(QUEUE_REFRESH_EVENT, handler);
}
