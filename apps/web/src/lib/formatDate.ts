/**
 * Shared short-date formatter for renderer UI (e.g. the "Parked {date}" labels in
 * the Library result rows and the relocated inspector context line). One canonical
 * helper so the library list and the inspector render the same string.
 */
export function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}
