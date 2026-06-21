import { LibrarySearchField } from "@interleave/web";

/** Pre-filled with a query — shows the search text inside the styled input. */
export const WithQuery = () => (
  <div style={{ width: 360, padding: 12 }}>
    <LibrarySearchField syncQuery="spaced repetition" syncToken={0} onDebouncedChange={() => {}} />
  </div>
);

/** Empty state — shows the placeholder text. */
export const Empty = () => (
  <div style={{ width: 360, padding: 12 }}>
    <LibrarySearchField syncQuery="" syncToken={0} onDebouncedChange={() => {}} />
  </div>
);
