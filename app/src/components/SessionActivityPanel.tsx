import type { ReactNode } from "react";

/**
 * What a long-running Docker session is doing, in Docker's own words.
 *
 * One panel rather than one per screen. The store runs image transfers and Compose actions
 * through the same session machinery, and for a while only Images rendered the result: a
 * `compose down` streamed its `Stopping …` and `Removing network …` lines into the store and
 * displayed none of them, so the only visible effect of pressing the button was that the buttons
 * greyed out. A failed action reported itself solely on a screen the operator was not looking at.
 *
 * Extracted rather than copied because the two uses must not drift — the error branch in
 * particular is the one nobody exercises by hand.
 */
export type SessionActivity = {
  /** What the panel is reporting on — "Pull", "Save", "Compose Down". */
  title: string;
  reference: string;
  status: "starting" | "running" | "exited" | "error";
  output: string;
  error?: string | null;
};

export function SessionActivityPanel({
  session,
  testId,
  idleMessage,
  runningMessage,
  children,
}: {
  session: SessionActivity;
  testId: string;
  /** Shown before Docker has written anything at all. */
  idleMessage: string;
  /**
   * Shown while running with no output yet. Some commands genuinely say nothing until they
   * finish, and an empty pane is their normal state rather than a stall — say so where that
   * is true, so silence is not read as a hang.
   */
  runningMessage: string;
  /** Screen-specific guidance, e.g. the registry sign-in hint on Images. */
  children?: ReactNode;
}) {
  return (
    <section className="host-pull-output" aria-live="polite" data-testid={testId}>
      <header>
        <strong>
          <span className="host-pull-output__kind">{session.title}</span>
          {session.reference}
        </strong>
        <span>{session.status}</span>
      </header>
      {session.error && <p className="capability-error">{session.error}</p>}
      {children}
      <pre>
        {session.output ||
          (session.status === "running" ? runningMessage : idleMessage)}
      </pre>
    </section>
  );
}
