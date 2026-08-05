/**
 * What is happening, and what just happened.
 *
 * Two things were missing and they turn out to be the same thing. Long-running work Anchorage
 * starts — a compose down, an image pull, a scan — reported itself through an inline panel owned
 * by whichever screen happened to render it, so a `compose down` looked like a hang and a failure
 * announced itself on a screen the operator was not looking at. Separately, the store already
 * subscribes to `docker events` and uses it only to decide which list to re-fetch, discarding the
 * event itself: a container dying produced a silent table refresh.
 *
 * Both are entries in one activity log. A job has a lifecycle and is watched; an event is a fact
 * and is read afterwards. Sharing a model is what lets one surface answer "what is it doing" and
 * "what did it just do" without the operator having to know which is which.
 */

export type ActivityKind = "job" | "event";

/** `info` is a fact that is neither good nor bad — most Docker events are this. */
export type ActivityState = "running" | "succeeded" | "failed" | "info";

export interface Activity {
  id: string;
  kind: ActivityKind;
  state: ActivityState;
  /** What happened, in a form that reads on its own: "Compose down", "Container started". */
  title: string;
  /** What it happened to: a project, a container name, an image reference. */
  subject: string;
  /** Why it failed, or what qualifies it. Never a restatement of the title. */
  detail?: string;
  /** Streamed command output, for jobs that produce any. */
  output?: string;
  startedAt: string;
  endedAt?: string;
  read: boolean;
}

/**
 * How much history is kept.
 *
 * A daemon under load emits events continuously, so this is a ring rather than a log. Deep enough
 * to answer "what just happened" after stepping away, shallow enough that it cannot become a
 * memory leak on a machine running hundreds of containers.
 */
export const ACTIVITY_LIMIT = 200;

/**
 * Adds an entry, newest first, bounded.
 *
 * Running jobs are exempt from eviction: dropping the entry for work still in flight would make
 * it invisible until it completed, which is the exact failure this surface exists to remove.
 */
export function appendActivity(list: readonly Activity[], entry: Activity): Activity[] {
  const next = [entry, ...list];
  if (next.length <= ACTIVITY_LIMIT) return next;
  // The exemption is bounded too. A job that never settles — a wedged session, a stream that
  // never closes — would otherwise keep this list growing for as long as the app is open.
  const running = next.filter((item) => item.state === "running").slice(0, ACTIVITY_LIMIT);
  const settled = next.filter((item) => item.state !== "running");
  const room = Math.max(0, ACTIVITY_LIMIT - running.length);
  const kept = settled.slice(0, room);
  const keep = new Set([...running, ...kept]);
  // Filter rather than concatenate, so newest-first survives without re-sorting by timestamp —
  // entries recorded in the same millisecond have no reliable order to sort by.
  return next.filter((item) => keep.has(item));
}

/** Patches one entry in place, returning the original array when nothing matched. */
export function updateActivity(
  list: readonly Activity[],
  id: string,
  patch: Partial<Activity>,
): Activity[] {
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return list as Activity[];
  const next = [...list];
  next[index] = { ...next[index], ...patch };
  return next;
}

/**
 * Actions that are too frequent to be worth telling anyone about.
 *
 * Every `docker exec` emits a pair, health checks emit on every probe, and networks emit connect
 * and disconnect for every container start. Surfacing those would bury the events that matter,
 * which is worse than having no inbox at all. `health_status: healthy` is filtered here and its
 * unhealthy counterpart is not, deliberately: recovery is quiet, degradation is not.
 */
const IGNORED_ACTIONS = new Set(["exec_start", "exec_die", "exec_create", "health_status: healthy"]);
const IGNORED_NETWORK_ACTIONS = new Set(["connect", "disconnect"]);

const CONTAINER_TITLES: Record<string, string> = {
  create: "Container created",
  start: "Container started",
  stop: "Container stopped",
  kill: "Container killed",
  die: "Container exited",
  destroy: "Container removed",
  pause: "Container paused",
  unpause: "Container resumed",
  restart: "Container restarted",
  rename: "Container renamed",
  "oom": "Container ran out of memory",
};

const SIMPLE_TITLES: Record<string, Record<string, string>> = {
  image: { pull: "Image pulled", delete: "Image removed", tag: "Image tagged", untag: "Image untagged" },
  volume: { create: "Volume created", destroy: "Volume removed" },
  network: { create: "Network created", destroy: "Network removed" },
};

type RawDockerEvent = {
  Type?: unknown;
  Action?: unknown;
  Actor?: { ID?: unknown; Attributes?: Record<string, unknown> } | unknown;
  time?: unknown;
};

function attributes(raw: RawDockerEvent): Record<string, unknown> {
  const actor = raw.Actor;
  if (!actor || typeof actor !== "object") return {};
  const value = (actor as { Attributes?: unknown }).Attributes;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function actorId(raw: RawDockerEvent): string {
  const actor = raw.Actor;
  if (!actor || typeof actor !== "object") return "";
  const id = (actor as { ID?: unknown }).ID;
  return typeof id === "string" ? id : "";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Turns one raw `docker events` line into a readable entry, or null when it is not worth saying.
 *
 * Returning null rather than a generic sentence is deliberate: an event shape this does not
 * recognise would otherwise be reported as something vague and confident, and a log full of
 * "container changed" is indistinguishable from a log full of nothing.
 */
export function summariseDockerEvent(raw: RawDockerEvent): Activity | null {
  const type = text(raw.Type);
  const action = text(raw.Action);
  if (!type || !action) return null;

  const base = action.split(":")[0].trim();
  if (IGNORED_ACTIONS.has(action) || IGNORED_ACTIONS.has(base)) return null;
  if (type === "network" && IGNORED_NETWORK_ACTIONS.has(action)) return null;

  const attrs = attributes(raw);
  const id = actorId(raw);
  const subject =
    text(attrs.name) ?? text(attrs.image) ?? (id ? id.slice(0, 12) : undefined);
  if (!subject) return null;

  let title: string | undefined;
  let state: ActivityState = "info";
  let detail: string | undefined;

  if (type === "container" && action.startsWith("health_status")) {
    const status = action.split(":")[1]?.trim() ?? "changed";
    title = `Container health ${status}`;
    state = "failed";
  } else if (type === "container") {
    title = CONTAINER_TITLES[action];
    if (action === "die") {
      const exitCode = text(attrs.exitCode);
      // A zero exit is a container finishing its work. Calling that a failure would make every
      // completed one-shot job look like a problem.
      if (exitCode && exitCode !== "0") {
        state = "failed";
        detail = `Exit code ${exitCode}`;
      }
    }
    if (action === "oom") state = "failed";
  } else {
    title = SIMPLE_TITLES[type]?.[action];
  }
  if (!title) return null;

  const project = text(attrs["com.docker.compose.project"]);
  if (project) {
    detail = detail ? `${detail} · project ${project}` : `Compose project ${project}`;
  }

  const seconds = typeof raw.time === "number" ? raw.time : undefined;
  return {
    // Docker can emit the same action for the same actor twice in one second, so the id carries
    // the action too and a suffix is added by the caller if it still collides.
    id: `event:${type}:${action}:${id || subject}:${seconds ?? ""}`,
    kind: "event",
    state,
    title,
    subject,
    detail,
    startedAt: seconds ? new Date(seconds * 1000).toISOString() : new Date().toISOString(),
    read: false,
  };
}
