/**
 * Standalone card detail route. Unlike `/review`, this route opens ONE card by
 * id, so queue/library clicks inspect and repair the clicked `active_card` instead
 * of starting the due-card session.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { Icon } from "../components/Icon";
import { isDesktop } from "../lib/appApi";
import { CardDetailPanel } from "./CardDetailPanel";
import "./review.css";

export function CardScreen() {
  const { id } = useParams({ from: "/card/$id" });
  const desktop = isDesktop();
  const navigate = useNavigate();

  if (!desktop) {
    return (
      <div className="rv-shell" data-testid="route-card">
        <div className="rv-blank">
          <div className="rv-empty">
            <div className="rv-empty__icon">
              <Icon name="brain" size={26} />
            </div>
            <h1 className="rv-empty__title">Card</h1>
            <p className="rv-empty__body">
              Card detail reads through the desktop bridge — open the Electron app to view it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const backToQueue = () => {
    void navigate({ to: "/queue" });
  };

  return (
    <div className="rv-shell" data-testid="route-card">
      <CardDetailPanel
        cardId={id}
        backLabel="Back to queue"
        backTestId="card-back-to-queue"
        emptyBackTestId="card-back"
        onBack={backToQueue}
        onCardRemoved={backToQueue}
      />
    </div>
  );
}
