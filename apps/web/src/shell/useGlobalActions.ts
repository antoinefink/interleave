/**
 * Global element actions (T048) — the shared handlers behind the universal
 * shortcuts AND the `⌘K` palette ACTION entries.
 *
 * These act on the shell's CURRENT SELECTION (the `useSelection` id every screen
 * sets) and are the ONE place the keyboard, the palette, and the inspector buttons
 * converge: each handler dispatches the EXACT same typed `window.appApi` command
 * (or `navigateToLocation`) as the corresponding inspector button — no second
 * mutation path, no domain logic in the keyboard layer.
 *
 *   - open-source   → fetch the selected element's location via `inspector.get`,
 *                     then `navigateToLocation` (the T022 jump). Same path the
 *                     inspector "Jump to source" + review "Open source" use.
 *   - open-parent   → fetch the selected element's parent via `inspector.get`
 *                     (`data.parent`) and navigate to its page. Same data the
 *                     inspector lineage tree uses.
 *   - raise/lower   → `elements.setPriority` with `{ kind: "raise" | "lower" }` —
 *                     the universal priority write, identical to the inspector +
 *                     queue buttons. Re-reads + asks the inspector to refresh.
 *   - search        → navigate to `/search` (inline query lands with M8's
 *                     `searchQuery` surface — already present; the search SCREEN
 *                     owns the query box).
 *
 * Everything is gracefully inert outside the desktop shell or with no selection;
 * the renderer never touches SQLite/Node/fs.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";
import { requestInspectorRefresh } from "../components/inspector/Inspector";
import { appApi, isDesktop } from "../lib/appApi";
import { useNavigateToLocation } from "../reader/navigateToLocation";
import { hasActiveScope } from "./activeScope";
import { useSelection } from "./selection";

/** The element-targeted global actions, keyed by the registry's `PaletteActionId`. */
export interface GlobalActions {
  openSource(): void;
  openParent(): void;
  raisePriority(): void;
  lowerPriority(): void;
  search(): void;
}

export function useGlobalActions(): GlobalActions {
  const { selectedId } = useSelection();
  const navigate = useNavigate();
  const navigateToLocation = useNavigateToLocation();
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const openSource = useCallback(() => {
    if (!isDesktop() || !selectedId || hasActiveScope()) return;
    const requestedId = selectedId;
    void (async () => {
      try {
        const res = await appApi.getInspectorData({ id: requestedId });
        if (selectedIdRef.current !== requestedId || hasActiveScope()) return;
        if (!res.data) return;
        const loc = res.data.location;
        if (loc) {
          navigateToLocation(loc);
          return;
        }
        // No stored location: fall back to opening the originating source's reader,
        // or — when the selected element IS a source — its own reader.
        const sourceId = res.data.source?.id ?? null;
        if (sourceId) {
          void navigate({ to: "/source/$id", params: { id: sourceId } });
        } else if (res.data.element.type === "source") {
          void navigate({ to: "/source/$id", params: { id: requestedId } });
        }
      } catch {
        // Non-fatal: open-source is a convenience.
      }
    })();
  }, [selectedId, navigate, navigateToLocation]);

  const openParent = useCallback(() => {
    if (!isDesktop() || !selectedId || hasActiveScope()) return;
    const requestedId = selectedId;
    void (async () => {
      try {
        const res = await appApi.getInspectorData({ id: requestedId });
        if (selectedIdRef.current !== requestedId || hasActiveScope()) return;
        const parent = res.data?.parent;
        if (!parent) return;
        if (parent.type === "source" || parent.type === "topic") {
          void navigate({ to: "/source/$id", params: { id: parent.id } });
        } else if (parent.type === "extract") {
          void navigate({ to: "/extract/$id", params: { id: parent.id } });
        }
      } catch {
        // Non-fatal.
      }
    })();
  }, [selectedId, navigate]);

  const setPriority = useCallback(
    (kind: "raise" | "lower") => {
      if (!isDesktop() || !selectedId || hasActiveScope()) return;
      void appApi
        .setElementPriority({ id: selectedId, action: { kind } })
        .then(() => requestInspectorRefresh())
        .catch(() => {
          // Non-fatal: the inspector surfaces errors on its own re-read.
        });
    },
    [selectedId],
  );

  const raisePriority = useCallback(() => setPriority("raise"), [setPriority]);
  const lowerPriority = useCallback(() => setPriority("lower"), [setPriority]);

  const search = useCallback(() => {
    void navigate({ to: "/search" });
  }, [navigate]);

  return useMemo(
    () => ({ openSource, openParent, raisePriority, lowerPriority, search }),
    [openSource, openParent, raisePriority, lowerPriority, search],
  );
}
