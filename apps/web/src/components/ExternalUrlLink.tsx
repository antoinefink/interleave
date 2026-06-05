import { Icon, type IconName } from "./Icon";
import "./external-url-link.css";

function externalHref(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function ExternalUrlLink({
  url,
  testId,
  className,
  icon = null,
  iconSize = 12,
}: {
  url: string;
  testId?: string;
  className?: string;
  icon?: IconName | null;
  iconSize?: number;
}) {
  const href = externalHref(url);
  const classes = ["external-url-link", className].filter(Boolean).join(" ");

  if (!href) {
    return (
      <span
        className={["external-url-link__fallback", className].filter(Boolean).join(" ")}
        data-testid={testId}
      >
        {url}
      </span>
    );
  }

  return (
    <a
      className={classes}
      data-testid={testId}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      <span className="external-url-link__text">{url}</span>
    </a>
  );
}
