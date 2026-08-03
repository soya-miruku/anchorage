import { PlugsIcon } from "@phosphor-icons/react";

export function UnsupportedSurface({
  testId,
  title,
  description,
  commandQuery,
  onOpenCommand,
}: {
  testId: string;
  title: string;
  description: string;
  commandQuery: string;
  onOpenCommand: (query: string) => void;
}) {
  return (
    <section className="screen unsupported-surface" data-testid={testId}>
      <header className="screen-header">
        <div>
          <h1>{title}</h1>
          <p>Live Docker capability unavailable</p>
        </div>
      </header>
      <div className="unsupported-surface__content" role="status">
        <span className="unsupported-surface__icon">
          <PlugsIcon aria-hidden="true" size={24} weight="light" />
        </span>
        <strong>{title} is unavailable in this build</strong>
        <p>{description}</p>
        <p>No fixture or simulated data is shown in packaged host mode.</p>
        <button
          className="primary-button unsupported-surface__action"
          type="button"
          onClick={() => onOpenCommand(commandQuery)}
        >
          Open Command Center
        </button>
      </div>
    </section>
  );
}
