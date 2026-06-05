/**
 * First-run welcome modal (design handoff — "Incremental Reading.html").
 *
 * Step 0 of onboarding: names the loop, pre-empts the three misconceptions, lets
 * the user pick a theme, and offers four exits — start the guided tour, import
 * their own source, explore alone, or skip and turn off contextual tips. Shown
 * once on first launch; the Shell owns the `ui.seenOnboarding` flag persistence.
 *
 * Presentation-only.
 */
import { useEffect } from "react";
import { Icon } from "../components/Icon";
import { Btn, Pipeline, Segmented } from "../help/primitives";
import type { Theme } from "../theme";
import "./onboarding.css";

export function WelcomeModal({
  open,
  theme,
  onPickTheme,
  onStartTour,
  onImport,
  onExplore,
  onDisableTips,
}: {
  open: boolean;
  theme: Theme;
  onPickTheme: (theme: Theme) => void;
  onStartTour: () => void;
  onImport: () => void;
  onExplore: () => void;
  onDisableTips: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExplore();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onExplore]);

  if (!open) return null;

  return (
    <div className="welcome-overlay" data-testid="welcome-modal">
      <div className="welcome" role="dialog" aria-modal="true" aria-label="Welcome to Interleave">
        <span className="welcome__eyebrow">
          <Icon name="shield" size={13} /> Local vault · offline-first · no account
        </span>
        <h1 className="welcome__title">A refinery for what you read</h1>
        <p className="welcome__lede">
          This isn’t a read-it-later app, a note app, or just flashcards. Raw reading goes in;{" "}
          <b>most you throw away</b>; a little becomes extracts, less becomes cards you can actually
          recall, and the best becomes how you think.
        </p>

        <div className="welcome__pipeline">
          <Pipeline active="extract" />
          <div className="welcome__pipeline-cap">
            You’ll do this once right now — in about a minute.
          </div>
        </div>

        <div className="welcome__myths">
          <div className="myth">
            <span className="myth__x">
              <Icon name="x" size={11} />
            </span>
            <span>
              <b>You don’t finish what you import.</b> Reading 5% and keeping one durable idea is a
              win.
            </span>
          </div>
          <div className="myth">
            <span className="myth__x">
              <Icon name="x" size={11} />
            </span>
            <span>
              <b>A highlight is not an extract.</b> Only extracts come back to you on their own
              schedule.
            </span>
          </div>
          <div className="myth">
            <span className="myth__x">
              <Icon name="x" size={11} />
            </span>
            <span>
              <b>Don’t card everything.</b> Distill an idea down to one clean statement first.
            </span>
          </div>
        </div>

        <div className="welcome__theme">
          <span className="welcome__theme-label">Appearance</span>
          <Segmented<Theme>
            value={theme}
            onChange={onPickTheme}
            options={[
              { value: "system", label: "System", icon: "system" },
              { value: "light", label: "Light", icon: "sun" },
              { value: "dark", label: "Dark", icon: "moon" },
            ]}
          />
        </div>

        <div className="welcome__actions">
          <Btn variant="primary" size="lg" icon="play" block onClick={onStartTour}>
            Start the 60-second tour
          </Btn>
          <div className="welcome__row2">
            <Btn icon="upload" onClick={onImport}>
              Import my own source
            </Btn>
            <Btn variant="ghost" onClick={onExplore}>
              Explore on my own
            </Btn>
          </div>
        </div>
        <div className="welcome__skip">
          <button type="button" onClick={onDisableTips}>
            Skip &amp; turn off contextual tips
          </button>
        </div>
      </div>
    </div>
  );
}
