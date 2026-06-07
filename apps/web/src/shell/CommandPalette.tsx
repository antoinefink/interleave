/**
 * ⌘K command palette (T004).
 *
 * A filterable, keyboard-driven launcher rebuilt from the kit's CommandPalette:
 * type to filter, ↑/↓ to move, Enter to run, Esc to close. Command rows come
 * from the static catalogue in `nav.ts`; live source rows are fetched through
 * the typed `appApi.searchQuery` bridge, with navigation delegated to the caller.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { appApi, isDesktop, type SearchResult } from "../lib/appApi";
import { Kbd } from "./Kbd";
import { COMMAND_ITEMS, type CommandContext, type CommandItem } from "./nav";
import type { PaletteActionId } from "./shortcuts";

const SOURCE_SEARCH_LIMIT = 8;
const SOURCE_SEARCH_DEBOUNCE_MS = 150;
const SOURCE_SEARCH_MIN_LENGTH = 2;

type NavigateOptions = {
  readonly params?: Readonly<Record<string, string>>;
};

type SourcePaletteResult = SearchResult & { readonly type: "source" };

type PaletteRow =
  | { readonly kind: "command"; readonly item: CommandItem }
  | { readonly kind: "source"; readonly source: SourcePaletteResult };

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  /** Navigate to a route path (a registered TanStack Router path). */
  onNavigate: (to: string, options?: NavigateOptions) => void;
  /**
   * Run a registry-backed ACTION command (T048). The shell supplies a handler that
   * dispatches the SAME typed `window.appApi` command as the matching on-screen
   * button (no second mutation path).
   */
  onAction: (actionId: PaletteActionId) => void;
  /** Whether an element is selected — gates context-scoped action commands (T048). */
  hasSelection: boolean;
};

function matchesCommand(item: CommandItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return true;
  return [item.label, item.to, ...(item.keywords ?? [])]
    .filter((part): part is string => Boolean(part))
    .some((part) => part.toLowerCase().includes(normalized));
}

function isSourceResult(result: SearchResult): result is SourcePaletteResult {
  return result.type === "source";
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onAction,
  hasSelection,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [sourceResults, setSourceResults] = useState<readonly SourcePaletteResult[]>([]);
  const [sourceStatus, setSourceStatus] = useState<
    "idle" | "too-short" | "loading" | "ready" | "error" | "unavailable"
  >("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceRequestRef = useRef(0);

  const ctx = useMemo<CommandContext>(() => ({ hasSelection }), [hasSelection]);
  const trimmedQuery = query.trim();

  const filtered = useMemo(
    () => COMMAND_ITEMS.filter((i) => (i.when ? i.when(ctx) : true) && matchesCommand(i, query)),
    [query, ctx],
  );

  const paletteRows = useMemo<readonly PaletteRow[]>(
    () => [
      ...filtered.map((item) => ({ kind: "command" as const, item })),
      ...sourceResults.map((source) => ({ kind: "source" as const, source })),
    ],
    [filtered, sourceResults],
  );

  /**
   * Run a chosen command (T048): navigate to its route (if any), run its
   * registry-backed action (if any), then dispatch its optional CustomEvent — e.g.
   * "New manual note…" navigates to `/inbox` and opens its modal; "Open source"
   * runs the open-source action; "Start review" navigates AND (no-op action). The
   * action runs after navigation so the target screen is mounted to receive it.
   */
  const runItem = useCallback(
    (item: CommandItem) => {
      const navigated = Boolean(item.to);
      if (item.to) onNavigate(item.to);
      onClose();
      if (item.actionId) {
        const id = item.actionId;
        // When the command also navigated, defer the action one tick so the route
        // has applied before the action reads the (possibly new) screen state;
        // action-only commands run synchronously.
        if (navigated) window.setTimeout(() => onAction(id), 0);
        else onAction(id);
      }
      if (item.event) {
        const eventName = item.event;
        window.setTimeout(() => window.dispatchEvent(new CustomEvent(eventName)), 0);
      }
    },
    [onNavigate, onClose, onAction],
  );

  const runSource = useCallback(
    (source: SourcePaletteResult) => {
      onNavigate("/source/$id", { params: { id: source.id } });
      onClose();
    },
    [onNavigate, onClose],
  );

  const runRow = useCallback(
    (row: PaletteRow) => {
      if (row.kind === "command") runItem(row.item);
      else runSource(row.source);
    },
    [runItem, runSource],
  );

  // Reset + focus when opened.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
      setSelected(0);
      setSourceResults([]);
      setSourceStatus("idle");
      sourceRequestRef.current += 1;
      return;
    }
    setQuery("");
    setDebouncedQuery("");
    setSelected(0);
    setSourceResults([]);
    setSourceStatus("idle");
    sourceRequestRef.current += 1;
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  // Debounce the typed text before it crosses the renderer bridge.
  useEffect(() => {
    if (!open) return;
    if (trimmedQuery.length < SOURCE_SEARCH_MIN_LENGTH) {
      setDebouncedQuery("");
      return;
    }
    const id = window.setTimeout(() => setDebouncedQuery(trimmedQuery), SOURCE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [open, trimmedQuery]);

  // Source-only live search. Command rows are rendered independently from this state.
  useEffect(() => {
    if (!open || trimmedQuery.length === 0) {
      sourceRequestRef.current += 1;
      setSourceResults([]);
      setSourceStatus("idle");
      return;
    }

    if (trimmedQuery.length < SOURCE_SEARCH_MIN_LENGTH) {
      sourceRequestRef.current += 1;
      setSourceResults([]);
      setSourceStatus("too-short");
      return;
    }

    if (!isDesktop()) {
      sourceRequestRef.current += 1;
      setSourceResults([]);
      setSourceStatus("unavailable");
      return;
    }

    if (debouncedQuery !== trimmedQuery) {
      sourceRequestRef.current += 1;
      setSourceResults([]);
      setSourceStatus("loading");
      return;
    }

    let cancelled = false;
    const requestId = sourceRequestRef.current + 1;
    sourceRequestRef.current = requestId;
    setSourceResults([]);
    setSourceStatus("loading");

    void appApi
      .searchQuery({
        q: debouncedQuery,
        type: "source",
        limit: SOURCE_SEARCH_LIMIT,
        includeCounts: false,
      })
      .then((res) => {
        if (cancelled || sourceRequestRef.current !== requestId) return;
        setSourceResults(res.results.filter(isSourceResult).slice(0, SOURCE_SEARCH_LIMIT));
        setSourceStatus("ready");
      })
      .catch(() => {
        if (cancelled || sourceRequestRef.current !== requestId) return;
        setSourceResults([]);
        setSourceStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [open, trimmedQuery, debouncedQuery]);

  // Keep the active keyboard index inside the combined command + source row set.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(paletteRows.length - 1, 0)));
  }, [paletteRows.length]);

  // Keyboard handling while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, Math.max(paletteRows.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const row = paletteRows[selected];
        if (row) runRow(row);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, paletteRows, selected, onClose, runRow]);

  if (!open) return null;

  let lastGroup: string | null = null;
  const showSourceSection = trimmedQuery.length > 0;

  return (
    <div className="shell-cmdk-overlay" data-testid="command-palette">
      {/* Backdrop is a real button so click-to-dismiss is keyboard-accessible
          (Esc also closes via the global handler above). */}
      <button
        type="button"
        className="shell-overlay-backdrop"
        aria-label="Close command palette"
        tabIndex={-1}
        onClick={onClose}
      />
      <div className="shell-cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="shell-cmdk__input">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            placeholder="Search, import, or run command…"
            aria-label="Command palette search"
          />
          <Kbd keys="Esc" />
        </div>
        <div className="shell-cmdk__list">
          {filtered.length === 0 && (
            <div className="shell-cmdk__group">No commands match “{query}”</div>
          )}
          {filtered.map((item, i) => {
            const showHead = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.label}>
                {showHead && <div className="shell-cmdk__group">{item.group}</div>}
                <button
                  type="button"
                  className={
                    selected === i ? "shell-cmdk__item shell-cmdk__item--on" : "shell-cmdk__item"
                  }
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => runItem(item)}
                >
                  <Icon name={item.icon} size={16} />
                  <span className="shell-grow">{item.label}</span>
                  {item.kbd && <Kbd keys={item.kbd} />}
                </button>
              </div>
            );
          })}
          {showSourceSection && (
            <div>
              <div className="shell-cmdk__group">Sources</div>
              {sourceStatus === "too-short" && (
                <div className="shell-cmdk__state" role="status">
                  <Icon name="source" size={15} />
                  <span>Type at least 2 characters to search sources.</span>
                </div>
              )}
              {sourceStatus === "loading" && (
                <div className="shell-cmdk__state" role="status">
                  <Icon name="source" size={15} />
                  <span>Searching sources...</span>
                </div>
              )}
              {sourceStatus === "unavailable" && (
                <div className="shell-cmdk__state" role="status">
                  <Icon name="source" size={15} />
                  <span>Source search is available in the desktop app.</span>
                </div>
              )}
              {sourceStatus === "error" && (
                <div className="shell-cmdk__state" role="alert">
                  <Icon name="warning" size={15} />
                  <span>Could not search sources.</span>
                </div>
              )}
              {sourceStatus === "ready" && sourceResults.length === 0 && (
                <div className="shell-cmdk__state" role="status">
                  <Icon name="source" size={15} />
                  <span>No sources match “{trimmedQuery}”.</span>
                </div>
              )}
              {sourceResults.map((source, i) => {
                const sourceIndex = filtered.length + i;
                const snippet = source.snippet.trim();
                return (
                  <button
                    type="button"
                    key={source.id}
                    className={
                      selected === sourceIndex
                        ? "shell-cmdk__item shell-cmdk__item--source shell-cmdk__item--on"
                        : "shell-cmdk__item shell-cmdk__item--source"
                    }
                    data-testid="command-palette-source"
                    data-source-id={source.id}
                    onMouseEnter={() => setSelected(sourceIndex)}
                    onClick={() => runSource(source)}
                  >
                    <Icon name="source" size={16} />
                    <span className="shell-cmdk__source">
                      <span className="shell-cmdk__source-title">{source.title}</span>
                      {snippet.length > 0 && (
                        <span className="shell-cmdk__source-snippet">{snippet}</span>
                      )}
                    </span>
                    <Icon
                      name="return"
                      size={14}
                      className="shell-cmdk__return"
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
