import { Kbd } from "@interleave/web";

/** A single key cap. */
export const SingleKey = () => <Kbd keys="?" />;

/** A modifier chord rendered as adjacent caps. */
export const Chord = () => <Kbd keys={["⌘", "K"]} />;

/** The shortcuts a keyboard-first workspace leans on, side by side. */
export const Shortcuts = () => (
  <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
    <Kbd keys={["⌘", "K"]} />
    <Kbd keys={["G", "I"]} />
    <Kbd keys="Esc" />
    <Kbd keys={["⌘", "⇧", "P"]} />
    <Kbd keys="Space" />
  </div>
);
