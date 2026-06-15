/**
 * New source modal (T013) — the manual text-import dialog.
 *
 * A keyboard-driven dialog reached from the inbox import strip's "Paste text" /
 * "Manual note" options (and the ⌘K command palette). It captures the source's
 * Title, URL, Author, Date (published), and Body, plus an A/B/C/D priority, and
 * creates an inbox source through the single typed `appApi.importManualSource`
 * command. On save the main process converts the body to plain text +
 * ProseMirror JSON and stores both; pasting an article's text + a title makes it
 * appear immediately in the inbox list. Submittable with ⌘↵ / Enter, closeable
 * with Esc.
 *
 * Pure UI: it gathers field values and calls ONE bridge command; the main process
 * owns persistence + the label→numeric priority mapping AND the plain-text →
 * ProseMirror conversion (the layering rule — no PM-building in the renderer).
 */

import { canonicalizeUrl } from "@interleave/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { appApi, type PriorityLabelInput, type SourcesImportManualRequest } from "../../lib/appApi";
import { Kbd } from "../../shell/Kbd";
import { formatTriageJustification, SuggestionChip } from "./SuggestionChip";
import { useTriageMetadataSuggestion } from "./useTriageMetadataSuggestion";

const PRIORITY_LABELS: readonly PriorityLabelInput[] = ["A", "B", "C", "D"];

/** Today's date as a `yyyy-mm-dd` string for the accessed-date field default. */
function todayDateInput(): string {
  return new Date().toISOString().slice(0, 10);
}

export type NewSourceModalProps = {
  open: boolean;
  onClose: () => void;
  /** Called with the new source id after a successful create. */
  onCreated: (id: string) => void;
  /** Priority seeded from Settings for newly imported sources. */
  defaultPriority?: PriorityLabelInput;
};

export function NewSourceModal({
  open,
  onClose,
  onCreated,
  defaultPriority = "C",
}: NewSourceModalProps) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [author, setAuthor] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [accessedAt, setAccessedAt] = useState(todayDateInput);
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<PriorityLabelInput>(defaultPriority);
  const [priorityTouched, setPriorityTouched] = useState(false);
  // When on, the body is parsed as Markdown (T068) — routed to `importMarkdownText`
  // so headings/code/links/lists become the structured document body, not flat text.
  const [asMarkdown, setAsMarkdown] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openedRef = useRef(false);

  // A live read-back of the canonical URL the main process WILL derive (T014).
  // Uses the same pure `@interleave/core` normalizer the main process uses, so
  // the preview is faithful; the renderer still never persists it — it only
  // sends the raw URL and the main process re-derives + stores it.
  const canonicalPreview = useMemo(() => canonicalizeUrl(url), [url]);

  // T127: a metadata-keyed suggestion (yield + reliability) from the entered author/URL.
  // Advisory — defaults the picker but never auto-submits; semantic is thin at intake.
  const suggestion = useTriageMetadataSuggestion({
    open,
    url,
    author,
    canonicalUrl: canonicalPreview,
    currentBand: priority,
  });

  // Reset the form once per open. Keep this guarded so an async Settings load
  // can update the untouched priority without wiping already-entered content.
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    setTitle("");
    setUrl("");
    setAuthor("");
    setPublishedAt("");
    setAccessedAt(todayDateInput());
    setBody("");
    setPriority(defaultPriority);
    setPriorityTouched(false);
    setAsMarkdown(false);
    setError(null);
    setSubmitting(false);
  }, [open, defaultPriority]);

  useEffect(() => {
    if (!open || priorityTouched) return;
    setPriority(defaultPriority);
  }, [open, defaultPriority, priorityTouched]);

  // Focus when opened.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  const submit = useCallback(async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      // Markdown path (T068): parse the body as Markdown into a structured source.
      if (asMarkdown) {
        if (body.trim().length === 0) {
          setError("Add some Markdown to the body to import.");
          setSubmitting(false);
          return;
        }
        const { id } = await appApi.importMarkdownText({ text: body, title: trimmed, priority });
        onCreated(id);
        return;
      }
      // Build the request omitting empty optional fields (exactOptionalPropertyTypes:
      // a missing key is correct, an explicit `undefined` is not).
      const request: SourcesImportManualRequest = { title: trimmed, priority };
      const trimmedUrl = url.trim();
      const trimmedAuthor = author.trim();
      const trimmedDate = publishedAt.trim();
      const trimmedAccessed = accessedAt.trim();
      // The accessed-date field is a `yyyy-mm-dd` string; send it as an ISO
      // timestamp when set so it overrides the main process's auto-stamp. When
      // cleared, omit it and let the main process stamp "now" (T014).
      const accessedIso = trimmedAccessed
        ? new Date(`${trimmedAccessed}T00:00:00.000Z`).toISOString()
        : "";
      const req: SourcesImportManualRequest = {
        ...request,
        ...(trimmedUrl ? { url: trimmedUrl } : {}),
        ...(trimmedAuthor ? { author: trimmedAuthor } : {}),
        ...(trimmedDate ? { publishedAt: trimmedDate } : {}),
        ...(accessedIso ? { accessedAt: accessedIso } : {}),
        ...(body.length > 0 ? { body } : {}),
      };
      const { id } = await appApi.importManualSource(req);
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [
    title,
    url,
    author,
    publishedAt,
    accessedAt,
    body,
    priority,
    asMarkdown,
    submitting,
    onCreated,
  ]);

  // Esc to close, ⌘↵ to submit while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, submit]);

  if (!open) return null;

  const fieldClass =
    "w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      data-testid="new-source-modal"
    >
      {/* Backdrop is a real button so click-to-dismiss is keyboard-accessible
          (Esc also closes via the global handler above). */}
      <button
        type="button"
        className="absolute inset-0 bg-black/30"
        aria-label="Close New source"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        className="relative flex max-h-[80vh] w-full max-w-xl flex-col rounded-xl border border-border bg-surface shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label="New source"
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center justify-between border-border border-b px-4 py-3">
            <h2 className="font-semibold text-base text-text">New source</h2>
            <button
              type="button"
              data-testid="new-source-close"
              aria-label="Close"
              onClick={onClose}
              className="rounded p-1 text-text-3 hover:text-text"
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <label className="block">
              <span className="mb-1 block font-medium text-sm text-text-2">Title</span>
              <input
                ref={inputRef}
                data-testid="new-source-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title of the article, note, or idea…"
                className={fieldClass}
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block font-medium text-sm text-text-2">URL</span>
                <input
                  data-testid="new-source-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://…"
                  className={fieldClass}
                />
              </label>
              <label className="block">
                <span className="mb-1 block font-medium text-sm text-text-2">Author</span>
                <input
                  data-testid="new-source-author"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="Add author…"
                  className={fieldClass}
                />
              </label>
            </div>

            {/* Read-back of the canonical URL the app derives from the entered
                URL (T014). Provenance only; the renderer never persists it. */}
            {canonicalPreview && canonicalPreview !== url.trim() ? (
              <p className="text-text-3 text-xs" data-testid="new-source-canonical">
                Canonical: <span className="break-all font-mono">{canonicalPreview}</span>
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block font-medium text-sm text-text-2">Published date</span>
                <input
                  data-testid="new-source-date"
                  type="date"
                  value={publishedAt}
                  onChange={(e) => setPublishedAt(e.target.value)}
                  className={fieldClass}
                />
              </label>
              <label className="block">
                <span className="mb-1 block font-medium text-sm text-text-2">Accessed date</span>
                <input
                  data-testid="new-source-accessed"
                  type="date"
                  value={accessedAt}
                  onChange={(e) => setAccessedAt(e.target.value)}
                  className={fieldClass}
                />
              </label>
            </div>

            <label className="block">
              <span className="mb-1 block font-medium text-sm text-text-2">Body</span>
              <textarea
                data-testid="new-source-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                placeholder={
                  asMarkdown
                    ? "Paste Markdown here. # Headings, **bold**, `code`, - lists are preserved…"
                    : "Paste the article text here. Blank lines separate paragraphs…"
                }
                className={`${fieldClass} resize-y font-read leading-relaxed`}
              />
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="new-source-markdown"
                checked={asMarkdown}
                onChange={(e) => setAsMarkdown(e.target.checked)}
                className="size-4 rounded border-border accent-[var(--accent)]"
              />
              <span className="text-sm text-text-2">Treat body as Markdown</span>
            </label>

            <div>
              <span className="mb-1.5 block font-medium text-sm text-text-2">Priority</span>
              <div className="flex gap-1.5" data-testid="new-source-priority">
                {PRIORITY_LABELS.map((p) => {
                  const active = priority === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      data-testid={`new-source-priority-${p}`}
                      aria-pressed={active}
                      onClick={() => {
                        setPriority(p);
                        setPriorityTouched(true);
                      }}
                      className={
                        active
                          ? "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-accent-soft-bd bg-accent-soft px-2 py-1 font-medium text-accent-text text-sm"
                          : "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-medium text-sm text-text-2 hover:text-text"
                      }
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ background: `var(--prio-${p.toLowerCase()})` }}
                      />
                      {p}
                    </button>
                  );
                })}
              </div>
              {suggestion ? (
                <div className="mt-2 flex flex-col gap-1" data-testid="new-source-suggestion">
                  <SuggestionChip
                    band={suggestion.band}
                    onAccept={() => {
                      setPriority(suggestion.band);
                      setPriorityTouched(true);
                    }}
                  />
                  {formatTriageJustification(suggestion.justification) ? (
                    <p
                      className="text-text-3 text-xs"
                      data-testid="new-source-suggestion-justification"
                    >
                      {formatTriageJustification(suggestion.justification)}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            {error ? (
              <p className="text-danger text-sm" data-testid="new-source-error">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-border border-t px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border bg-surface px-3 py-1.5 font-medium text-sm text-text-2 hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="new-source-submit"
              disabled={title.trim().length === 0 || submitting}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-1.5 font-medium text-sm text-text-on-accent disabled:opacity-50"
            >
              Create source
              <Kbd keys={["⌘", "↵"]} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
