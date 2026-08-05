import { useEffect, useMemo, useRef, useState } from "react";

import type { Activity } from "../store/activity";

/**
 * Floating progress, and an inbox for what has already happened.
 *
 * Long-running work used to report itself through a panel owned by whichever screen started it,
 * so a `compose down` that takes tens of seconds looked like a hang, and a failure announced
 * itself on a screen the operator had already navigated away from. Docker's own event stream was
 * read only to decide which list to re-fetch and then discarded, so nothing said a container had
 * died.
 *
 * Toasts carry what is happening now; the inbox carries what happened. Failures never
 * auto-dismiss — an error that disappears on a timer is an error nobody read.
 */

const TOAST_DISMISS_MS = 6_000;

function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function ActivityRow({ item, now }: { item: Activity; now: number }) {
  return (
    <div className={`activity-row activity-row--${item.state}`}>
      <span className="activity-row__dot" aria-hidden="true" />
      <div className="activity-row__body">
        <div className="activity-row__head">
          <strong>{item.title}</strong>
          <span className="activity-row__when">{relativeTime(item.startedAt, now)}</span>
        </div>
        <div className="activity-row__subject">{item.subject}</div>
        {item.detail && <div className="activity-row__detail">{item.detail}</div>}
      </div>
    </div>
  );
}

/**
 * The toast stack: work in flight, plus anything that failed and has not been acknowledged.
 */
export function ActivityToasts({
  activities,
  onDismiss,
}: {
  activities: readonly Activity[];
  onDismiss: (id: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  // Only ticks while something is on screen, so an idle app schedules nothing.
  const visible = useMemo(
    () =>
      activities
        .filter(
          (item) =>
            item.state === "running" || (item.state === "failed" && !item.read),
        )
        .slice(0, 4),
    [activities],
  );

  useEffect(() => {
    if (visible.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [visible.length]);

  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const succeeded = useMemo(
    () => activities.filter((item) => item.state === "succeeded" && !item.read).slice(0, 2),
    [activities],
  );

  useEffect(() => {
    if (succeeded.length === 0) return;
    // Success is self-evident from the list updating, so it clears itself. Failures are left
    // for the operator to dismiss.
    const timers = succeeded.map((item) =>
      window.setTimeout(() => dismissRef.current(item.id), TOAST_DISMISS_MS),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [succeeded]);

  const shown = [...visible, ...succeeded];
  if (shown.length === 0) return null;

  return (
    <div className="activity-toasts" role="status" aria-live="polite" data-testid="activity-toasts">
      {shown.map((item) => (
        <div className={`activity-toast activity-toast--${item.state}`} key={item.id}>
          <ActivityRow item={item} now={now} />
          <button
            type="button"
            className="activity-toast__close"
            aria-label={`Dismiss ${item.title} ${item.subject}`}
            onClick={() => onDismiss(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The inbox: everything, newest first, behind a button that carries the unread count.
 */
export function ActivityInbox({
  activities,
  unreadCount,
  onMarkRead,
}: {
  activities: readonly Activity[];
  unreadCount: number;
  onMarkRead: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="activity-inbox" ref={panelRef}>
      <button
        type="button"
        className="activity-inbox__trigger"
        aria-expanded={open}
        aria-label={
          unreadCount > 0 ? `Activity, ${unreadCount} unread` : "Activity"
        }
        data-testid="activity-inbox-trigger"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onMarkRead();
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 2a4 4 0 0 0-4 4v2.5L2.8 10.4a.5.5 0 0 0 .43.76h9.54a.5.5 0 0 0 .43-.76L12 8.5V6a4 4 0 0 0-4-4Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M6.5 13a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        {unreadCount > 0 && (
          <span className="activity-inbox__badge" data-testid="activity-unread-count">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="activity-inbox__panel" data-testid="activity-inbox-panel">
          <header>
            <strong>Activity</strong>
            <span className="resource-dim">
              {activities.length === 0 ? "nothing yet" : `${activities.length} recent`}
            </span>
          </header>
          {activities.length === 0 ? (
            <p className="activity-inbox__empty">
              Jobs you start and changes Docker reports will appear here. Nothing has happened
              since Anchorage connected.
            </p>
          ) : (
            <div className="activity-inbox__list">
              {activities.map((item) => (
                <ActivityRow item={item} key={item.id} now={now} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
