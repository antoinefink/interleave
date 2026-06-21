import { Icon } from "@interleave/web";

const GRID_ICONS: Array<{ name: string; label: string }> = [
  { name: "source", label: "source" },
  { name: "topic", label: "topic" },
  { name: "extract", label: "extract" },
  { name: "card", label: "card" },
  { name: "task", label: "task" },
  { name: "concept", label: "concept" },
  { name: "brain", label: "brain" },
  { name: "gauge", label: "gauge" },
  { name: "search", label: "search" },
  { name: "edit", label: "edit" },
  { name: "postpone", label: "postpone" },
  { name: "sparkle", label: "sparkle" },
];

/** Labeled grid of 12 representative icons covering element types + key actions. */
export const Grid = () => (
  <div
    style={{
      display: "grid",
      gridTemplateColumns: "repeat(6, 1fr)",
      gap: 16,
      padding: 20,
    }}
  >
    {GRID_ICONS.map(({ name, label }) => (
      <div
        key={name}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          color: "var(--text)",
        }}
      >
        <Icon name={name as Parameters<typeof Icon>[0]["name"]} size={22} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--text-3)",
            textAlign: "center",
          }}
        >
          {label}
        </span>
      </div>
    ))}
  </div>
);
