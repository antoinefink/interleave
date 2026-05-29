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

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { appApi, type PriorityLabelInput, type SourcesImportManualRequest } from "../../lib/appApi";
import { Kbd } from "../../shell/Kbd";

const PRIORITY_LABELS: readonly PriorityLabelInput[] = ["A", "B", "C", "D"];

export type NewSourceModalProps = {
  open: boolean;
  onClose: () => void;
  /** Called with the new source id after a successful create. */
  onCreated: (id: string) => void;
};

export function NewSourceModal({ open, onClose, onCreated }: NewSourceModalProps) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [author, setAuthor] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<PriorityLabelInput>("C");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus when opened.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setUrl("");
    setAuthor("");
    setPublishedAt("");
    setBody("");
    setPriority("C");
    setError(null);
    setSubmitting(false);
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  const submit = useCallback(async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      // Build the request omitting empty optional fields (exactOptionalPropertyTypes:
      // a missing key is correct, an explicit `undefined` is not).
      const request: SourcesImportManualRequest = { title: trimmed, priority };
      const trimmedUrl = url.trim();
      const trimmedAuthor = author.trim();
      const trimmedDate = publishedAt.trim();
      const req: SourcesImportManualRequest = {
        ...request,
        ...(trimmedUrl ? { url: trimmedUrl } : {}),
        ...(trimmedAuthor ? { author: trimmedAuthor } : {}),
        ...(trimmedDate ? { publishedAt: trimmedDate } : {}),
        ...(body.length > 0 ? { body } : {}),
      };
      const { id } = await appApi.importManualSource(req);
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [title, url, author, publishedAt, body, priority, submitting, onCreated]);

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

            <label className="block">
              <span className="mb-1 block font-medium text-sm text-text-2">Date</span>
              <input
                data-testid="new-source-date"
                type="date"
                value={publishedAt}
                onChange={(e) => setPublishedAt(e.target.value)}
                className={fieldClass}
              />
            </label>

            <label className="block">
              <span className="mb-1 block font-medium text-sm text-text-2">Body</span>
              <textarea
                data-testid="new-source-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                placeholder="Paste the article text here. Blank lines separate paragraphs…"
                className={`${fieldClass} resize-y font-read leading-relaxed`}
              />
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
                      onClick={() => setPriority(p)}
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
