import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LIMIT,
  appendActivity,
  summariseDockerEvent,
  updateActivity,
  type Activity,
} from "./activity";

/**
 * Docker already tells us everything that happens; nothing was listening.
 *
 * The store subscribes to `docker events` and uses it only to decide which domain to re-list,
 * throwing the event itself away. So a container dying, an image being removed, or a compose
 * project coming up produced a silent table refresh and no statement that anything had happened —
 * and a failed action reported itself, if at all, on whichever screen happened to own the inline
 * progress panel.
 *
 * These turn the raw stream into something a person can read, and are pure so the wording is
 * testable without a daemon.
 */
const event = (overrides: Record<string, unknown> = {}) => ({
  Type: "container",
  Action: "start",
  Actor: { ID: "abc123def456", Attributes: { name: "nginx-edge", image: "nginx:1.27" } },
  time: 1_767_225_600,
  ...overrides,
});

describe("summariseDockerEvent", () => {
  it("names the thing that changed, not its id", () => {
    const activity = summariseDockerEvent(event());
    expect(activity?.title).toBe("Container started");
    expect(activity?.subject).toBe("nginx-edge");
  });

  it("treats a non-zero exit as a failure worth keeping", () => {
    const activity = summariseDockerEvent(
      event({ Action: "die", Actor: { ID: "abc", Attributes: { name: "worker", exitCode: "137" } } }),
    );
    expect(activity?.state).toBe("failed");
    expect(activity?.detail).toContain("137");
  });

  it("does not call a clean exit a failure", () => {
    // `die` with exitCode 0 is a container finishing its work, which is not an error.
    const activity = summariseDockerEvent(
      event({ Action: "die", Actor: { ID: "abc", Attributes: { name: "migrate", exitCode: "0" } } }),
    );
    expect(activity?.state).toBe("info");
  });

  it("reports health transitions, which are the ones nobody watches for", () => {
    const activity = summariseDockerEvent(
      event({ Action: "health_status: unhealthy", Actor: { ID: "abc", Attributes: { name: "api" } } }),
    );
    expect(activity?.state).toBe("failed");
    expect(activity?.title).toContain("unhealthy");
  });

  it("attributes an event to its compose project when it has one", () => {
    const activity = summariseDockerEvent(
      event({
        Actor: {
          ID: "abc",
          Attributes: { name: "storefront-api-1", "com.docker.compose.project": "storefront" },
        },
      }),
    );
    expect(activity?.detail).toContain("storefront");
  });

  it("ignores the noise that would drown everything else", () => {
    // Every container emits a stream of exec and health events; surfacing them all would make
    // the inbox useless, which is worse than not having one.
    expect(summariseDockerEvent(event({ Action: "exec_start: ls" }))).toBeNull();
    expect(summariseDockerEvent(event({ Action: "exec_die" }))).toBeNull();
    expect(summariseDockerEvent(event({ Type: "network", Action: "connect" }))).toBeNull();
    expect(summariseDockerEvent(event({ Action: "health_status: healthy" }))).toBeNull();
  });

  it("returns nothing for a shape it does not recognise rather than inventing a sentence", () => {
    expect(summariseDockerEvent({})).toBeNull();
    expect(summariseDockerEvent({ Type: "container" })).toBeNull();
  });

  it("falls back to a short id when Docker reports no name", () => {
    const activity = summariseDockerEvent(
      event({ Actor: { ID: "abc123def456789", Attributes: {} } }),
    );
    expect(activity?.subject).toBe("abc123def456");
  });
});

const activity = (overrides: Partial<Activity> = {}): Activity => ({
  id: "a1",
  kind: "job",
  state: "running",
  title: "Compose down",
  subject: "storefront",
  startedAt: "2026-08-05T00:00:00.000Z",
  read: false,
  ...overrides,
});

describe("appendActivity", () => {
  it("puts the newest first, because that is the one being waited on", () => {
    const list = appendActivity([activity({ id: "old" })], activity({ id: "new" }));
    expect(list.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("bounds the history so a busy daemon cannot grow it without limit", () => {
    let list: Activity[] = [];
    for (let i = 0; i < ACTIVITY_LIMIT + 25; i += 1) {
      list = appendActivity(list, activity({ id: `a${i}`, kind: "event", state: "info" }));
    }
    expect(list).toHaveLength(ACTIVITY_LIMIT);
    expect(list[0].id).toBe(`a${ACTIVITY_LIMIT + 24}`);
  });

  it("still bounds itself when every entry is somehow still running", () => {
    // The running exemption below must not become an unbounded exemption; a stuck job that never
    // settles would otherwise grow this list for as long as the app is open.
    let list: Activity[] = [];
    for (let i = 0; i < ACTIVITY_LIMIT * 3; i += 1) {
      list = appendActivity(list, activity({ id: `r${i}`, state: "running" }));
    }
    expect(list.length).toBeLessThanOrEqual(ACTIVITY_LIMIT * 2);
  });

  it("never evicts a job that is still running", () => {
    // Dropping the entry for work still in flight would leave it invisible until it finished,
    // which is precisely the state this whole surface exists to remove.
    let list: Activity[] = [activity({ id: "in-flight", state: "running" })];
    for (let i = 0; i < ACTIVITY_LIMIT + 25; i += 1) {
      list = appendActivity(list, activity({ id: `e${i}`, kind: "event", state: "info" }));
    }
    expect(list.some((item) => item.id === "in-flight")).toBe(true);
  });
});

describe("updateActivity", () => {
  it("patches in place without disturbing order", () => {
    const list = [activity({ id: "a" }), activity({ id: "b" })];
    const next = updateActivity(list, "b", { state: "succeeded" });
    expect(next.map((item) => item.id)).toEqual(["a", "b"]);
    expect(next[1].state).toBe("succeeded");
  });

  it("returns the same array when the id is unknown, so React does not re-render", () => {
    const list = [activity({ id: "a" })];
    expect(updateActivity(list, "missing", { state: "failed" })).toBe(list);
  });
});

describe("where a notification takes you", () => {
  /*
    A notification that names a container and cannot show it is a dead end: the operator reads
    "Container health unhealthy — api" and then has to go and find `api` themselves, on a
    screen they have to guess. These pin the destinations, and pin the two cases where there
    deliberately is not one.
  */
  it("opens the container a container event is about", () => {
    const activity = summariseDockerEvent({
      Type: "container",
      Action: "die",
      Actor: { ID: "abc123def456", Attributes: { name: "api", exitCode: "1" } },
      time: 1_760_000_000,
    });
    expect(activity?.target).toEqual({
      view: "containers",
      containerId: "abc123def456",
    });
  });

  it("stops at the list for a container that no longer exists", () => {
    // Opening the detail screen for a destroyed container lands on an error. The list is
    // where its absence is the point.
    const activity = summariseDockerEvent({
      Type: "container",
      Action: "destroy",
      Actor: { ID: "abc123def456", Attributes: { name: "api" } },
      time: 1_760_000_000,
    });
    expect(activity?.target).toEqual({ view: "containers" });
  });

  it("sends each resource event to the list that holds it", () => {
    const cases: Array<[string, string, string]> = [
      ["image", "pull", "images"],
      ["volume", "create", "volumes"],
      ["network", "create", "networks"],
    ];
    for (const [type, action, view] of cases) {
      const activity = summariseDockerEvent({
        Type: type,
        Action: action,
        Actor: { ID: "x", Attributes: { name: "thing" } },
        time: 1_760_000_000,
      });
      expect(activity?.target, `${type} ${action}`).toEqual({ view });
    }
  });

  it("offers nowhere to go when there is nowhere", () => {
    // Daemon and plugin events have no list of their own, and a row that looks clickable and
    // does nothing is worse than one that never offered.
    const activity = summariseDockerEvent({
      Type: "daemon",
      Action: "reload",
      Actor: { ID: "d", Attributes: { name: "daemon" } },
      time: 1_760_000_000,
    });
    expect(activity?.target).toBeUndefined();
  });
});
