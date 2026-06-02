/**
 * Import & Inbox screen (T012) — the first capture/triage surface.
 *
 * Rebuilt from the kit's `screen-inbox.jsx` for React 19 + Tailwind v4: an import
 * strip on top, then a two-pane body — a left list of inbox-status sources and a
 * right preview pane with a metadata rail, an A/B/C/D priority chip group, and a
 * triage action list (Activate / Save for later / Delete with keyboard hints).
 *
 * Data flows STRICTLY through the typed `window.appApi` bridge (the renderer never
 * touches SQLite): `inbox.list()` / `inbox.get(id)` to read, `sources.importManual`
 * to create, and `inbox.triage` to accept / keep / prioritize / delete. Selecting
 * an item also sets `useSelection().select(id)` so the shell's universal inspector
 * reacts. The component is pure UI orchestration — no SQL, no scheduling rules, no
 * priority math (priority labels map to numbers on the main side).
 *
 * Every import chip is live: "Paste text" / "Manual note" open the New-source
 * modal, "Paste URL" the Import-from-URL modal, "Import PDF" / "Import file" the
 * file picker (PDF / EPUB), and "Browser capture" routes to the extension pairing.
 * Scheduling ("Read soon"), dedup/Merge, and the concept field are deferred.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { BalanceBanner } from "../../components/BalanceBanner";
import { Icon, type IconName } from "../../components/Icon";
import { Prio, Status, TypeIcon } from "../../components/inspector/primitives";
import {
  appApi,
  type InboxItemDetail,
  type InboxItemSummary,
  isDesktop,
  type PriorityLabelInput,
} from "../../lib/appApi";
import { Kbd } from "../../shell/Kbd";
import { NEW_SOURCE_EVENT } from "../../shell/nav";
import { useSelection } from "../../shell/selection";
import { ImportFileModal } from "./ImportFileModal";
import { ImportUrlModal } from "./ImportUrlModal";
import { NewSourceModal } from "./NewSourceModal";

/** Numeric priority `0.0`–`1.0` → coarse A/B/C/D label (mirrors core/priority). */
function priorityToLabel(priority: number): PriorityLabelInput {
  const v = Math.min(1, Math.max(0, priority));
  if (v >= 0.75) return "A";
  if (v >= 0.5) return "B";
  if (v >= 0.25) return "C";
  return "D";
}

const PRIORITY_LABELS: readonly PriorityLabelInput[] = ["A", "B", "C", "D"];
const PRIORITY_HINT: Record<PriorityLabelInput, string> = {
  A: "Protected · review daily",
  B: "Important · frequent",
  C: "Normal cadence",
  D: "Someday · low cadence",
};

/**
 * Import-strip options, all live. "Paste text" / "Manual note" open the New-source
 * modal; "Paste URL" (T060) opens the Import-from-URL modal; "Import PDF" (T064) and
 * "Import file" (T067, EPUB) open the file picker; "Browser capture" routes to the
 * extension pairing in Settings.
 */
const IMPORT_OPTS: {
  icon: IconName;
  label: string;
  hint: string;
  /** When set, clicking opens the matching modal / picker (or routes to Settings). */
  action?: "manual" | "url" | "capture" | "pdf" | "file";
}[] = [
  { icon: "link", label: "Paste URL", hint: "Fetch & clean the page", action: "url" },
  { icon: "paste", label: "Paste text", hint: "Plain text", action: "manual" },
  { icon: "source", label: "Import PDF", hint: "Read a PDF incrementally", action: "pdf" },
  {
    icon: "library",
    label: "Import file",
    hint: "EPUB, Markdown, HTML, highlights",
    action: "file",
  },
  { icon: "globe", label: "Browser capture", hint: "Pair the extension", action: "capture" },
  { icon: "text", label: "Manual note", hint: "Your own idea", action: "manual" },
];

/** Map a thrown PDF-import `code: message` error line to a friendly message. */
function pdfImportMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // The main handler throws `code: message`; strip a leading code we recognize.
  const codes: Record<string, string> = {
    not_pdf: "That file is not a PDF.",
    too_large: "That PDF is too large to import.",
    too_many_pages: "That PDF has too many pages to import.",
    encrypted: "That PDF is password-protected.",
    unreadable: "That PDF could not be read.",
  };
  const sep = raw.indexOf(":");
  const code = sep > 0 ? raw.slice(0, sep).trim() : "";
  return codes[code] ?? "Could not import that PDF.";
}

/** A single left-list row for one inbox source. */
function InboxRow({
  item,
  active,
  onSelect,
}: {
  item: InboxItemSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="inbox-row"
      data-element-id={item.id}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      className={
        active
          ? "flex w-full items-start gap-2.5 rounded-md border border-accent-soft-bd bg-accent-soft px-3.5 py-3 text-left"
          : "flex w-full items-start gap-2.5 rounded-md border border-transparent px-3.5 py-3 text-left hover:bg-surface-2"
      }
    >
      <TypeIcon type={item.type} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm text-text">{item.title}</span>
        <span className="mt-1 flex items-center gap-1.5 text-text-3 text-xs">
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs">{item.srcType}</span>
          {item.author ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{item.author}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span className="font-mono">{item.charCount.toLocaleString()} ch</span>
        </span>
      </span>
      <Prio priority={item.priority} />
    </button>
  );
}

/** A triage action button (block, with a keyboard hint). */
function TriageButton({
  icon,
  label,
  hint,
  danger,
  primary,
  onClick,
  testid,
}: {
  icon: IconName;
  label: string;
  hint: string;
  danger?: boolean;
  primary?: boolean;
  onClick: () => void;
  testid: string;
}) {
  const tone = danger
    ? "border-danger-soft bg-danger-soft text-danger hover:opacity-90"
    : primary
      ? "border-transparent bg-accent text-text-on-accent hover:opacity-90"
      : "border-border bg-surface text-text-2 hover:text-text";
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 font-medium text-sm ${tone}`}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
      <span className="flex-1" />
      <Kbd keys={hint} />
    </button>
  );
}

/** The right preview + metadata + triage rail for the selected item. */
function PreviewPane({
  detail,
  busy,
  onTriage,
  onSetPriority,
}: {
  detail: InboxItemDetail;
  busy: boolean;
  onTriage: (kind: "accept" | "keepForLater" | "delete") => void;
  onSetPriority: (label: PriorityLabelInput) => void;
}) {
  const { summary, provenance, bodyPreview } = detail;
  const current = priorityToLabel(summary.priority);
  return (
    <div className="flex min-w-0 flex-1" data-testid="inbox-preview">
      {/* body preview */}
      <div className="min-w-0 flex-1 overflow-y-auto px-7 py-5">
        <div className="mb-2.5 flex items-center gap-2 text-sm text-text-3">
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs">{summary.srcType}</span>
          {summary.accessedAt ? (
            <>
              <span aria-hidden>·</span>
              <span>imported {summary.accessedAt.slice(0, 10)}</span>
            </>
          ) : null}
        </div>
        <h2
          className="mb-1.5 font-semibold text-text text-xl tracking-tight"
          data-testid="inbox-preview-title"
        >
          {summary.title}
        </h2>
        {provenance.url ? (
          <div className="mb-4 flex items-center gap-1.5 text-accent-text text-sm">
            <Icon name="link" size={13} />
            <span className="break-all">{provenance.url}</span>
          </div>
        ) : null}
        {bodyPreview ? (
          <div className="font-read text-[17px] text-text leading-relaxed">
            {bodyPreview.split("\n\n").map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static preview paragraphs
              <p key={i} className="mb-4">
                {p}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-3" data-testid="inbox-preview-empty">
            No body yet. Add one from the New source modal.
          </p>
        )}
      </div>

      {/* metadata + triage rail */}
      <div className="flex w-72 flex-none flex-col gap-5 overflow-y-auto border-border border-l p-4">
        <section>
          <div className="mb-2 font-medium text-text-2 text-xs uppercase tracking-wide">
            Metadata
          </div>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-text-3">Author</dt>
              <dd className="truncate text-text">{provenance.author ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-text-3">Published</dt>
              <dd className="text-text">{provenance.publishedAt?.slice(0, 10) ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-text-3">Accessed</dt>
              <dd className="text-text" data-testid="inbox-preview-accessed">
                {provenance.accessedAt?.slice(0, 10) ?? "—"}
              </dd>
            </div>
            {provenance.canonicalUrl ? (
              <div className="flex justify-between gap-3">
                <dt className="text-text-3">Canonical</dt>
                <dd
                  className="min-w-0 break-all text-right text-text"
                  data-testid="inbox-preview-canonical"
                >
                  {provenance.canonicalUrl}
                </dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <dt className="text-text-3">Status</dt>
              <dd>
                <Status status={summary.status} />
              </dd>
            </div>
          </dl>
          {provenance.reasonAdded ? (
            <p className="mt-2 text-sm text-text-2">{provenance.reasonAdded}</p>
          ) : null}
        </section>

        <section data-testid="inbox-priority">
          <div className="mb-2 font-medium text-text-2 text-xs uppercase tracking-wide">
            Priority
          </div>
          <div className="flex gap-1.5">
            {PRIORITY_LABELS.map((p) => {
              const active = current === p;
              return (
                <button
                  key={p}
                  type="button"
                  data-testid={`inbox-priority-${p}`}
                  aria-pressed={active}
                  disabled={busy}
                  onClick={() => onSetPriority(p)}
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
          <p className="mt-1.5 text-text-3 text-xs">{PRIORITY_HINT[current]}</p>
        </section>

        <section>
          <div className="mb-2 font-medium text-text-2 text-xs uppercase tracking-wide">
            Triage <span className="font-normal text-text-3 normal-case">1 · 3 · 6</span>
          </div>
          <div className="space-y-2">
            <TriageButton
              testid="inbox-accept"
              icon="play"
              label="Activate"
              hint="1"
              primary
              onClick={() => onTriage("accept")}
            />
            <TriageButton
              testid="inbox-keep"
              icon="bookmark"
              label="Save for later"
              hint="3"
              onClick={() => onTriage("keepForLater")}
            />
            <TriageButton
              testid="inbox-delete"
              icon="trash"
              label="Delete"
              hint="6"
              danger
              onClick={() => onTriage("delete")}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

export function InboxScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const { selectedId, select } = useSelection();
  const [items, setItems] = useState<readonly InboxItemSummary[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InboxItemDetail | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [urlModalOpen, setUrlModalOpen] = useState(false);
  const [fileModalOpen, setFileModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after any list change (import / triage) so the balance banner re-reads
  // the week's counts without a full remount.
  const [balanceRefresh, setBalanceRefresh] = useState(0);

  /** Reload the list; keep/repair the current selection. */
  const refresh = useCallback(async (preferId?: string | null) => {
    if (!isDesktop()) return;
    try {
      const { items: next } = await appApi.listInbox();
      setItems(next);
      setBalanceRefresh((n) => n + 1);
      setError(null);
      setSelId((prev) => {
        const wanted = preferId ?? prev;
        if (wanted && next.some((i) => i.id === wanted)) return wanted;
        return next[0]?.id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Whenever the selected inbox id changes, fetch its detail + drive the shell
  // inspector selection so it shows the same element.
  useEffect(() => {
    if (!isDesktop() || !selId) {
      setDetail(null);
      return;
    }
    select(selId);
    let cancelled = false;
    void (async () => {
      try {
        const { detail: next } = await appApi.getInboxItem({ id: selId });
        if (!cancelled) setDetail(next);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selId, select]);

  const onSelect = useCallback((id: string) => setSelId(id), []);

  // Import a local PDF (T064) — the MAIN process opens the native file picker,
  // streams the original into the vault, parses per-page text, and creates an
  // `inbox` source. On success refresh + select it; on a typed PdfImportError
  // surface a friendly message; a cancelled picker is a no-op.
  const onImportPdf = useCallback(async () => {
    if (!isDesktop() || busy) return;
    setBusy(true);
    try {
      const result = await appApi.importPdfSource({});
      if (result.status === "imported") {
        await refresh(result.id);
        setError(null);
      }
    } catch (e) {
      setError(pdfImportMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  const onTriage = useCallback(
    async (kind: "accept" | "keepForLater" | "delete") => {
      if (!selId || busy) return;
      setBusy(true);
      try {
        await appApi.triageInboxItem({ id: selId, action: { kind } });
        // accept/keep/delete all remove the source from the inbox list.
        if (selectedId === selId) select(null);
        await refresh(null);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [selId, busy, refresh, select, selectedId],
  );

  const onSetPriority = useCallback(
    async (priority: PriorityLabelInput) => {
      if (!selId || busy) return;
      setBusy(true);
      try {
        await appApi.triageInboxItem({ id: selId, action: { kind: "setPriority", priority } });
        await refresh(selId);
        // Re-fetch the detail so the rail reflects the new priority.
        const { detail: next } = await appApi.getInboxItem({ id: selId });
        setDetail(next);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [selId, busy, refresh],
  );

  // Keyboard triage: 1 = activate, 3 = save for later, 6 = delete (ignore when a
  // field/modal is focused, matching the kit's 1–6 hints).
  useEffect(() => {
    if (!desktop || modalOpen || urlModalOpen || fileModalOpen || !selId) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1") void onTriage("accept");
      else if (e.key === "3") void onTriage("keepForLater");
      else if (e.key === "6") void onTriage("delete");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop, modalOpen, urlModalOpen, fileModalOpen, selId, onTriage]);

  // Open the New-source modal when the ⌘K command palette fires its event
  // ("Paste text as source…" / "New manual note…").
  useEffect(() => {
    const open = () => setModalOpen(true);
    window.addEventListener(NEW_SOURCE_EVENT, open);
    return () => window.removeEventListener(NEW_SOURCE_EVENT, open);
  }, []);

  if (!desktop) {
    return (
      <div
        className="flex h-full min-h-full flex-col items-center justify-center gap-3 px-7 py-8 text-center"
        data-testid="route-inbox"
      >
        <div className="grid size-12 place-items-center rounded-lg bg-accent-soft text-accent-text">
          <Icon name="inbox" size={26} />
        </div>
        <h1 className="font-semibold text-2xl text-text tracking-tight">Inbox</h1>
        <p className="max-w-sm text-base text-text-2">
          The inbox reads + writes sources through the desktop bridge — open the Electron app to
          triage captures.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-full flex-col" data-testid="route-inbox">
      {/* import strip */}
      <div className="border-border border-b px-6 py-4">
        <div className="mb-3 flex items-end justify-between">
          <h1 className="font-semibold text-text text-xl tracking-tight">Import &amp; Inbox</h1>
          <span className="text-sm text-text-3" data-testid="inbox-count">
            {items.length} item{items.length !== 1 ? "s" : ""} awaiting triage
          </span>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {IMPORT_OPTS.map((o) => {
            const enabled =
              o.action === "manual" ||
              o.action === "url" ||
              o.action === "capture" ||
              o.action === "pdf" ||
              o.action === "file";
            const onClick =
              o.action === "url"
                ? () => setUrlModalOpen(true)
                : o.action === "manual"
                  ? () => setModalOpen(true)
                  : o.action === "pdf"
                    ? () => void onImportPdf()
                    : o.action === "file"
                      ? () => setFileModalOpen(true)
                      : o.action === "capture"
                        ? // Route to the Settings "Browser capture" pairing card (T062).
                          () => void navigate({ to: "/settings", hash: "browser-capture" })
                        : undefined;
            return (
              <button
                key={o.label}
                type="button"
                data-testid={`inbox-import-${o.label === "Manual note" ? "manual" : o.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                disabled={!enabled}
                title={enabled ? undefined : "Coming soon"}
                onClick={onClick}
                className={
                  enabled
                    ? "flex items-center gap-2.5 rounded-md border border-border bg-surface px-3.5 py-2.5 text-left hover:border-border-strong"
                    : "flex cursor-not-allowed items-center gap-2.5 rounded-md border border-border bg-surface px-3.5 py-2.5 text-left opacity-50"
                }
              >
                <span className="grid size-7 place-items-center rounded-md bg-surface-2 text-text-2">
                  <Icon name={o.icon} size={14} />
                </span>
                <span className="flex flex-col">
                  <span className="font-semibold text-sm text-text">{o.label}</span>
                  <span className="text-2xs text-text-3">{o.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Import/process balance warning (T046) — advisory; hidden when balanced. */}
      <div className="px-6 pt-4 empty:hidden">
        <BalanceBanner refreshKey={balanceRefresh} />
      </div>

      {error ? (
        <p className="px-6 py-2 text-danger text-sm" data-testid="inbox-error">
          {error}
        </p>
      ) : null}

      {/* two-pane body */}
      <div className="flex min-h-0 flex-1">
        {items.length === 0 ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-3 px-7 text-center"
            data-testid="inbox-empty"
          >
            <div className="grid size-12 place-items-center rounded-lg bg-ok-soft text-ok">
              <Icon name="checkCircle" size={26} />
            </div>
            <h2 className="font-semibold text-text text-xl tracking-tight">Inbox zero</h2>
            <p className="max-w-sm text-base text-text-2">
              Every captured item has been triaged. New manual notes appear here.
            </p>
            <button
              type="button"
              data-testid="inbox-empty-new"
              onClick={() => setModalOpen(true)}
              className="mt-1 inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 font-medium text-sm text-text-on-accent"
            >
              <Icon name="plus" size={14} />
              New source
            </button>
          </div>
        ) : (
          <>
            <div
              className="w-[360px] flex-none space-y-1 overflow-y-auto border-border border-r p-2"
              data-testid="inbox-list"
            >
              {items.map((it) => (
                <InboxRow
                  key={it.id}
                  item={it}
                  active={it.id === selId}
                  onSelect={() => onSelect(it.id)}
                />
              ))}
            </div>
            {detail ? (
              <PreviewPane
                detail={detail}
                busy={busy}
                onTriage={onTriage}
                onSetPriority={onSetPriority}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-text-3">
                Loading…
              </div>
            )}
          </>
        )}
      </div>

      <NewSourceModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(id) => {
          setModalOpen(false);
          void refresh(id);
        }}
      />

      <ImportUrlModal
        open={urlModalOpen}
        onClose={() => setUrlModalOpen(false)}
        onImported={(id) => {
          setUrlModalOpen(false);
          void refresh(id);
        }}
      />

      <ImportFileModal
        open={fileModalOpen}
        initialKind="epub"
        onClose={() => setFileModalOpen(false)}
        onImported={(id) => {
          setFileModalOpen(false);
          void refresh(id);
        }}
        onHighlightsImported={(firstSourceId) => {
          // Highlights produce many sources + a count summary: refresh the inbox
          // underneath but leave the modal open so the user reads the counts.
          void refresh(firstSourceId.length > 0 ? firstSourceId : null);
        }}
      />
    </div>
  );
}
