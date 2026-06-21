import { ExternalUrlLink } from "@interleave/web";

/** A clean https URL with the link icon — the standard external reference treatment. */
export const WithIcon = () => (
  <ExternalUrlLink url="https://arxiv.org/abs/1911.01547" icon="link" iconSize={12} />
);

/** A long URL typical of a paper or documentation permalink — truncation and wrapping behaviour. */
export const LongUrl = () => (
  <div style={{ width: 320 }}>
    <ExternalUrlLink url="https://www.supermemo.com/en/blog/twenty-rules-of-formulating-knowledge-in-learning" />
  </div>
);

/** A non-URL string (bare title, no protocol) — renders as the plain-text fallback span. */
export const PlainTextFallback = () => (
  <ExternalUrlLink url="On the Measure of Intelligence — François Chollet" />
);
