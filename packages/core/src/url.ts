/**
 * URL canonicalization (T014) — a small, pure, framework-agnostic normalizer.
 *
 * Manual imports capture provenance with NO remote fetching (M2): the user
 * enters a URL by hand, the app preserves it verbatim as `originalUrl`, and
 * derives a normalized `canonicalUrl` from it. This module owns that derivation.
 *
 * The normalization is deliberately CONSERVATIVE — it only:
 *  - lowercases the host (hosts are case-insensitive; paths/queries are not),
 *  - strips common tracking params (`utm_*`, `fbclid`, `gclid`, …),
 *  - drops the URL fragment (`#…`),
 *  - trims a redundant trailing slash on the path.
 *
 * Aggressive normalization risks collapsing genuinely distinct URLs, so anything
 * heavier (sorting query params, stripping `www.`, default-port removal beyond
 * what `URL` already does, content hashing) is intentionally left to the M12
 * duplicate-detection work (T061), which will REUSE this function as its
 * foundation. M2 only *captures* the canonical URL; it never dedupes against it.
 *
 * `null`/empty/garbage input returns `null` (there is no canonical form of a
 * non-URL). It performs no network I/O and imports nothing — safe everywhere.
 */

/**
 * Query-parameter names stripped during canonicalization. Tracking/analytics
 * params that never change which document a URL points at. Matched
 * case-insensitively; the `utm_` family is matched by prefix.
 */
const TRACKING_PARAMS: readonly string[] = [
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "yclid",
  "_hsenc",
  "_hsmi",
  "ref",
  "ref_src",
];

/** Whether a query-param name is a tracking param (drop it from the canonical URL). */
function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("utm_")) return true;
  return TRACKING_PARAMS.includes(lower);
}

/**
 * Derive a conservative canonical form of an entered URL, or `null` when the
 * input is empty / not a parseable absolute URL.
 *
 * Idempotent: feeding an already-canonical URL back in returns the same string.
 * Only `http`/`https` URLs are canonicalized; other schemes (and unparseable
 * input) return `null` so non-web "sources" never get a bogus canonical URL.
 *
 * @param raw the as-entered URL string (or `null`/`undefined`).
 */
export function canonicalizeUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // Only canonicalize web URLs; leave exotic schemes uncanonicalized.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // Host is case-insensitive; the WHATWG URL parser already lowercases it, but be
  // explicit so the intent survives any future parser change.
  url.hostname = url.hostname.toLowerCase();

  // Drop the fragment — it never identifies a distinct document for provenance.
  url.hash = "";

  // Strip tracking params, preserving the order of the rest. `URLSearchParams`
  // does not expose deletion-while-iterating safely, so collect the keys first.
  const drop = [...url.searchParams.keys()].filter(isTrackingParam);
  for (const key of drop) url.searchParams.delete(key);

  // Trim a redundant trailing slash on the path (but never on the bare root "/",
  // which `URL` always keeps) — "/a/" and "/a" are usually the same document.
  // `pathname` excludes the query string, so a query-bearing URL is unaffected.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}
