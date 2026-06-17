import { Icon } from "../components/Icon";
import { Tooltip } from "../components/Tooltip";
import "./AtomicExtractPrompt.css";

export interface AtomicExtractPromptState {
  readonly extractId: string;
  readonly title: string;
}

export function AtomicExtractPrompt({
  prompt,
  onConvert,
  onDismiss,
}: {
  readonly prompt: AtomicExtractPromptState | null;
  readonly onConvert: () => void;
  readonly onDismiss: () => void;
}) {
  if (!prompt) return null;
  return (
    <div className="atomic-extract-prompt" data-testid="atomic-extract-prompt" role="status">
      <span className="atomic-extract-prompt__icon">
        <Icon name="card" size={14} />
      </span>
      <span className="atomic-extract-prompt__text">{prompt.title}</span>
      <Tooltip label="Turn this statement into a review card">
        <button
          type="button"
          className="atomic-extract-prompt__button atomic-extract-prompt__button--primary"
          data-testid="atomic-extract-convert-now"
          onClick={onConvert}
        >
          <Icon name="card" size={14} /> Convert now
        </button>
      </Tooltip>
      <button
        type="button"
        className="atomic-extract-prompt__button atomic-extract-prompt__button--icon"
        aria-label="Dismiss convert-now prompt"
        onClick={onDismiss}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
