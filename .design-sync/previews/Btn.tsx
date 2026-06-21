import { Btn } from "@interleave/web";

/** All four variants side by side — .welcome scopes .btn without imposing flex-column layout. */
export const Variants = () => (
  <div
    className="welcome"
    style={{
      display: "flex",
      gap: 10,
      alignItems: "center",
      padding: 16,
      width: "auto",
      maxHeight: "none",
      borderRadius: 0,
      boxShadow: "none",
      border: "none",
      background: "none",
      animation: "none",
    }}
  >
    <Btn variant="primary">Save extract</Btn>
    <Btn variant="soft">Distill</Btn>
    <Btn variant="ghost">Dismiss</Btn>
    <Btn variant="danger">Delete source</Btn>
  </div>
);

/** Three sizes: sm, default (no size prop), lg. */
export const Sizes = () => (
  <div
    className="welcome"
    style={{
      display: "flex",
      gap: 10,
      alignItems: "center",
      padding: 16,
      width: "auto",
      maxHeight: "none",
      borderRadius: 0,
      boxShadow: "none",
      border: "none",
      background: "none",
      animation: "none",
    }}
  >
    <Btn size="sm">Quick add</Btn>
    <Btn>Add to queue</Btn>
    <Btn size="lg">Start review</Btn>
  </div>
);

/** Buttons with a leading icon and a trailing icon. */
export const WithIcons = () => (
  <div
    className="welcome"
    style={{
      display: "flex",
      gap: 10,
      alignItems: "center",
      padding: 16,
      width: "auto",
      maxHeight: "none",
      borderRadius: 0,
      boxShadow: "none",
      border: "none",
      background: "none",
      animation: "none",
    }}
  >
    <Btn variant="primary" icon="plus">
      Add source
    </Btn>
    <Btn variant="soft" icon="brain">
      Distill
    </Btn>
    <Btn variant="ghost" iconRight="chevronRight">
      See all cards
    </Btn>
    <Btn variant="ghost" icon="postpone" iconRight="chevronDown">
      Postpone
    </Btn>
  </div>
);

/** Icon-only button (no children text, just the icon prop). */
export const IconOnly = () => (
  <div
    className="welcome"
    style={{
      display: "flex",
      gap: 10,
      alignItems: "center",
      padding: 16,
      width: "auto",
      maxHeight: "none",
      borderRadius: 0,
      boxShadow: "none",
      border: "none",
      background: "none",
      animation: "none",
    }}
  >
    <Btn icon="edit" aria-label="Edit extract" />
    <Btn variant="soft" icon="bookmark" aria-label="Bookmark source" />
    <Btn variant="ghost" icon="trash" aria-label="Delete card" />
    <Btn variant="danger" icon="ban" aria-label="Suspend card" />
  </div>
);
