import { ExpiryBanner } from "@interleave/web";

/** Expired fact — danger tone; shows the expired date and jurisdiction context. */
export const Expired = () => (
  <ExpiryBanner
    expiry={{
      status: "expired",
      validUntil: "Jan 2025",
      reviewBy: null,
      jurisdiction: "US tax law",
      softwareVersion: null,
    }}
  />
);

/** Due for review — softer warn tone; shows the review-by date and software version context. */
export const DueForReview = () => (
  <ExpiryBanner
    expiry={{
      status: "due_for_review",
      validUntil: null,
      reviewBy: "Jul 2026",
      jurisdiction: null,
      softwareVersion: "React 19",
    }}
  />
);

/** Expired with the "Create verify task" affordance (T092) — adds the banner__action button. */
export const ExpiredWithTaskButton = () => (
  <ExpiryBanner
    expiry={{
      status: "expired",
      validUntil: "Mar 2024",
      reviewBy: null,
      jurisdiction: null,
      softwareVersion: "Node.js 18 LTS",
    }}
    onCreateTask={async () => {}}
  />
);
