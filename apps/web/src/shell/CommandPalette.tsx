/**
 * ⌘K command palette (T004).
 *
 * A filterable, keyboard-driven launcher rebuilt from the kit's CommandPalette:
 * type to filter, ↑/↓ to move, Enter to run, Esc to close. Choosing an item
 * navigates to its route. Pure UI — the catalogue is static config from
 * `nav.ts`; navigation is delegated to the caller.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Kbd } from "./Kbd";
import { COMMAND_ITEMS, type CommandItem } from "./nav";

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  /** Navigate to a route path (a registered TanStack Router path). */
  onNavigate: (to: string) => void;
};

export function CommandPalette({ open, onClose, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => COMMAND_ITEMS.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  /**
   * Run a chosen command: navigate to its route, then (after navigation, so the
   * target screen is mounted to receive it) dispatch its optional CustomEvent —
   * e.g. "New manual note…" navigates to `/inbox` and opens its modal.
   */
  const runItem = useCallback(
    (item: CommandItem) => {
      onNavigate(item.to);
      onClose();
      if (item.event) {
        const eventName = item.event;
        window.setTimeout(() => window.dispatchEvent(new CustomEvent(eventName)), 0);
      }
    },
    [onNavigate, onClose],
  );

  // Reset + focus when opened.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  // Keyboard handling while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = filtered[selected];
        if (item) runItem(item);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, selected, onClose, runItem]);

  if (!open) return null;

  let lastGroup: string | null = null;

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
        </div>
      </div>
    </div>
  );
}
