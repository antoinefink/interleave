/**
 * ConceptGraph — the read-only concept Map shared by `/search` (LibraryScreen),
 * `/library` (BrowseScreen), and the dedicated `/concepts` knowledge-map screen.
 *
 * Lifted verbatim from `LibraryScreen.tsx` (T042) into this top-level shared
 * module so every surface renders the SAME map (kit `.graph`/`.gnode`): concepts
 * laid out on a deterministic radial ring around the most-connected root (no
 * persisted layout — the MVP map is read-only). Clicking/keying a node calls
 * `onPick(conceptId)`; the caller decides what selecting a concept does (filter
 * results, or drill into the concept's members). UI only — the concept list comes
 * from the typed `appApi.listConcepts()` bridge; no domain logic here.
 */

import { useMemo } from "react";
import type { ConceptNode } from "../lib/appApi";

export function ConceptGraph({
  concepts,
  onPick,
  selectedId = null,
  pickVerb = "Filter by",
}: {
  concepts: readonly ConceptNode[];
  onPick: (conceptId: string) => void;
  /** The currently-selected concept id — its node renders highlighted. Optional. */
  selectedId?: string | null;
  /** The verb in each node's aria-label ("Filter by" on search/library, "Explore" on /concepts). */
  pickVerb?: string;
}) {
  const W = 620;
  const H = 420;
  const cx = W / 2;
  const cy = H / 2;
  const roots = concepts.filter((c) => !c.parentConceptId);
  const placed = useMemo(() => {
    const positions = new Map<string, { x: number; y: number; r: number }>();
    // Roots on an inner ring; children on an outer ring around their parent.
    const rootRadius = roots.length > 1 ? 120 : 0;
    roots.forEach((root, i) => {
      const a = (i / Math.max(1, roots.length)) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * rootRadius;
      const y = cy + Math.sin(a) * rootRadius;
      positions.set(root.id, { x, y, r: 34 + Math.min(10, root.memberCount * 2) });
      const children = concepts.filter((c) => c.parentConceptId === root.id);
      children.forEach((child, j) => {
        const ca = a + ((j - (children.length - 1) / 2) * Math.PI) / 6;
        positions.set(child.id, {
          x: x + Math.cos(ca) * 110,
          y: y + Math.sin(ca) * 110,
          r: 24 + Math.min(8, child.memberCount * 2),
        });
      });
    });
    // Any concept not placed (orphan child) gets a fallback ring slot.
    let k = 0;
    for (const c of concepts) {
      if (positions.has(c.id)) continue;
      const a = (k / Math.max(1, concepts.length)) * Math.PI * 2;
      positions.set(c.id, { x: cx + Math.cos(a) * 160, y: cy + Math.sin(a) * 160, r: 22 });
      k += 1;
    }
    return positions;
  }, [concepts, roots, cx, cy]);

  return (
    <div className="graph" data-testid="concept-graph">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Concept map">
        {concepts.map((c) => {
          if (!c.parentConceptId) return null;
          const a = placed.get(c.id);
          const b = placed.get(c.parentConceptId);
          if (!a || !b) return null;
          return (
            <line
              key={`edge-${c.id}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="var(--border-strong)"
              strokeWidth="1.5"
            />
          );
        })}
        {concepts.map((c) => {
          const p = placed.get(c.id);
          if (!p) return null;
          const selected = selectedId === c.id;
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG <g> cannot be a <button>; it is keyboard-accessible via role/tabIndex, and the side panel offers a real-button equivalent
            <g
              key={c.id}
              className={`gnode${selected ? " gnode--on" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`${pickVerb} ${c.name}`}
              aria-pressed={selected}
              data-testid="concept-node"
              data-concept-id={c.id}
              data-selected={selected ? "true" : undefined}
              onClick={() => onPick(c.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPick(c.id);
                }
              }}
            >
              <circle
                cx={p.x}
                cy={p.y}
                r={p.r}
                fill={selected ? "var(--accent)" : "var(--accent-soft)"}
                stroke="var(--accent)"
                strokeWidth={selected ? 2.5 : 1.5}
              />
              <text
                x={p.x}
                y={p.y - 2}
                textAnchor="middle"
                fontWeight="600"
                fill={selected ? "var(--text-on-accent)" : "var(--text)"}
              >
                {c.name}
              </text>
              <text
                x={p.x}
                y={p.y + 12}
                textAnchor="middle"
                fontSize="9"
                fill={selected ? "var(--text-on-accent)" : "var(--text-3)"}
              >
                {c.memberCount} member{c.memberCount === 1 ? "" : "s"}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
