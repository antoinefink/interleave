import { Segmented } from "@interleave/web";

/**
 * Theme picker with icons — the welcome modal's primary use of Segmented.
 * sun / moon / system are all real Icon keys.
 */
export const ThemePicker = () => (
  <div className="welcome" style={{ padding: 16, width: "auto", maxHeight: "none", borderRadius: 0, boxShadow: "none", border: "none", background: "none", animation: "none" }}>
    <Segmented
      options={[
        { value: "light", label: "Light", icon: "sun" },
        { value: "dark", label: "Dark", icon: "moon" },
        { value: "system", label: "System", icon: "system" },
      ]}
      value="light"
      onChange={() => {}}
    />
  </div>
);
