import { Status } from "@interleave/web";

/** All nine lifecycle statuses in a single row — sweeps every badge variant. */
export const AllStatuses = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <Status status="inbox" />
    <Status status="pending" />
    <Status status="active" />
    <Status status="scheduled" />
    <Status status="done" />
    <Status status="parked" />
    <Status status="dismissed" />
    <Status status="suspended" />
    <Status status="deleted" />
  </div>
);
