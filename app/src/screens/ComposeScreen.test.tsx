// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeScreen } from "./ComposeScreen";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type {
  ComposeConfigResult,
  ComposeConfigService,
  ComposeProject,
  ComposeService,
} from "../types";

afterEach(cleanup);

const observedAt = "2026-08-04T09:00:00.000Z";

const project = (overrides: Partial<ComposeProject> = {}): ComposeProject => ({
  name: "storefront",
  status: "running(2)",
  states: [{ state: "running", count: 2 }],
  configFiles: ["/srv/storefront/compose.yaml"],
  runningCount: 2,
  totalCount: 2,
  ...overrides,
});

const service = (
  name: string,
  overrides: Partial<ComposeConfigService> = {},
): ComposeConfigService => ({
  name,
  image: `team/${name}:latest`,
  startOrder: 0,
  dependsOn: [],
  watch: [],
  hooks: [],
  ...overrides,
});

const live = (name: string, overrides: Partial<ComposeService> = {}): ComposeService => ({
  name: `storefront-${name}-1`,
  service: name,
  containerId: `container-${name}`,
  image: `team/${name}:latest`,
  state: "running",
  status: "Up 2 hours",
  exitCode: 0,
  ...overrides,
});

const configResult = (
  overrides: Partial<ComposeConfigResult> = {},
): ComposeConfigResult => ({
  context: "default",
  project: "storefront",
  source: "cli-json",
  configFiles: ["/srv/storefront/compose.yaml"],
  services: [],
  dependencies: [],
  observedAt,
  // Every real result carries at least this one: Compose merges includes before it renders.
  limitations: [
    "Compose merges included files before rendering, so services from an include appear inline and the include entries themselves are not reported.",
  ],
  ...overrides,
});

function renderScreen(overrides: Partial<AnchorageStore> = {}) {
  const store = {
    isHost: true,
    composeStatus: "ready",
    composeProjectList: [project()],
    composeError: null,
    composeServices: {},
    composeConfigs: {},
    composeConfigPending: null,
    composeConfigError: null,
    expandedComposeProject: null,
    containers: [],
    imageTransfer: null,
    refreshCompose: vi.fn(async () => undefined),
    toggleComposeProject: vi.fn(async () => undefined),
    loadComposeConfig: vi.fn(async () => undefined),
    runComposeAction: vi.fn(async () => undefined),
    selectContainer: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AnchorageStore;
  render(<ComposeScreen store={store} />);
  return store;
}

const serviceRowNames = () =>
  Array.from(
    screen
      .getByTestId("compose-services-storefront")
      .querySelectorAll(".compose-service-row__name"),
  ).map((node) => node.textContent);

describe("ComposeScreen resolved configuration", () => {
  it("renders the start order Compose resolved, not the order the file happens to list", () => {
    // The core ranks each service by the depth of what it waits for and hands the list back
    // in that order; the screen must show that ranking rather than re-sort by name.
    renderScreen({
      expandedComposeProject: "storefront",
      composeServices: { storefront: [live("db"), live("api")] },
      composeConfigs: {
        storefront: configResult({
          services: [
            service("db"),
            service("api", {
              startOrder: 1,
              dependsOn: [
                { service: "db", condition: "service_healthy", required: true },
              ],
            }),
            service("worker", {
              startOrder: 2,
              dependsOn: [
                {
                  service: "api",
                  condition: "service_started",
                  required: false,
                  restart: true,
                },
              ],
            }),
          ],
        }),
      },
    });

    expect(serviceRowNames()).toEqual(["db", "api", "worker"]);

    const api = screen.getByTestId("compose-service-storefront-api");
    expect(api).toHaveTextContent("1");
    expect(api).toHaveTextContent("db · healthy");
    // running now, from `compose ps`, joined onto what the file declares.
    expect(api).toHaveTextContent("running");

    const worker = screen.getByTestId("compose-service-storefront-worker");
    // required:false changes what the condition guarantees, and restart:true means Compose
    // restarts this service when its dependency restarts. Both are stated.
    expect(worker).toHaveTextContent("api · started · optional · restarts");
    // Declared but never brought up: no container is not the same claim as "exited".
    expect(worker).toHaveTextContent("no container");
  });

  it("flags a lifecycle hook that resolves to root", () => {
    renderScreen({
      expandedComposeProject: "storefront",
      composeConfigs: {
        storefront: configResult({
          services: [
            service("api", {
              hooks: [
                {
                  phase: "post_start",
                  command: ["chown", "-R", "app:app", "/data"],
                  user: "root",
                  runsAsRoot: true,
                },
              ],
            }),
            service("web", {
              hooks: [
                {
                  phase: "pre_stop",
                  command: ["nginx", "-s", "quit"],
                  user: "nginx",
                  runsAsRoot: false,
                },
              ],
            }),
          ],
        }),
      },
    });

    const rootHook = screen.getByTestId("compose-hook-api-post_start-0");
    expect(rootHook).toHaveTextContent("runs as root");
    expect(rootHook).toHaveTextContent("chown -R app:app /data");
    // The flag is a labelled chip, not a colour: the greyscale theme has no hue to read.
    expect(
      within(rootHook).getByText("runs as root").className,
    ).toContain("compose-tag--warning");

    expect(
      screen.getByTestId("compose-hook-web-pre_stop-0"),
    ).not.toHaveTextContent("runs as root");
  });

  it("shows watch rules where they exist and says so where they do not", () => {
    renderScreen({
      expandedComposeProject: "storefront",
      composeConfigs: {
        storefront: configResult({
          services: [
            service("api", {
              watch: [
                {
                  path: "./api/src",
                  action: "sync+restart",
                  target: "/app/src",
                  ignore: ["node_modules"],
                },
              ],
            }),
          ],
        }),
      },
    });

    const watch = screen.getByTestId("compose-watch");
    expect(watch).toHaveTextContent("sync+restart");
    expect(watch).toHaveTextContent("./api/src");
    expect(watch).toHaveTextContent("api → /app/src");
    expect(watch).toHaveTextContent("ignore node_modules");

    cleanup();
    renderScreen({
      expandedComposeProject: "storefront",
      composeConfigs: {
        storefront: configResult({ services: [service("api")] }),
      },
    });
    // An empty panel would read as "watch is off"; the file simply declares none.
    expect(screen.getByTestId("compose-watch")).toHaveTextContent(
      "No service in this project declares a develop.watch rule.",
    );
  });

  it("carries every limitation the core reports through to the screen", () => {
    // These are the difference between "this is the project" and "this is what the rendering
    // carried". Dropping them would let the panels read as the whole file.
    const limitations = [
      "Compose merges included files before rendering, so services from an include appear inline and the include entries themselves are not reported.",
      "Compose omits the top-level models section from its JSON rendering, so only the services that declare a model are reported, not the model's own configuration.",
      'WARN[0000] The "REGISTRY" variable is not set. Defaulting to a blank string.',
    ];
    renderScreen({
      expandedComposeProject: "storefront",
      composeConfigs: {
        storefront: configResult({
          services: [service("api")],
          limitations,
        }),
      },
    });

    const panel = screen.getByTestId("compose-limitations");
    for (const limitation of limitations) {
      expect(panel).toHaveTextContent(limitation);
    }
  });

  it("lists declared dependencies with what Compose resolves them to", () => {
    renderScreen({
      expandedComposeProject: "storefront",
      composeConfigs: {
        storefront: configResult({
          services: [service("api")],
          dependencies: [
            {
              kind: "volume",
              name: "data",
              resource: "storefront_data",
              external: false,
              services: ["api"],
            },
            {
              kind: "model",
              name: "llama",
              external: false,
              services: ["api"],
            },
          ],
        }),
      },
    });

    const panel = screen.getByTestId("compose-dependencies");
    expect(panel).toHaveTextContent("storefront_data");
    expect(panel).toHaveTextContent("used by api");
    expect(panel).toHaveTextContent("llama");
  });
});

describe("ComposeScreen resolution boundaries", () => {
  it("explains why a project discovered by label cannot be resolved, and does not ask", () => {
    const store = renderScreen({
      composeProjectList: [project({ name: "adhoc", configFiles: [] })],
      expandedComposeProject: "adhoc",
    });

    expect(screen.getByTestId("compose-unresolvable")).toHaveTextContent(
      "discovered by label and reports no compose file",
    );
    // `config` renders files by path; asking without one resolves whatever sits in the
    // working directory, so the screen states the refusal instead of spinning on a call the
    // store would reject anyway.
    expect(store.loadComposeConfig).not.toHaveBeenCalled();
    expect(screen.queryByText("Resolving the Compose file…")).toBeNull();
    // `up` cannot run without the files either, and says so rather than failing later.
    expect(screen.getByTestId("compose-up-adhoc")).toBeDisabled();
  });

  it("resolves only the selected project, and only once", () => {
    const store = renderScreen({
      composeProjectList: [project(), project({ name: "billing" })],
      expandedComposeProject: "storefront",
    });

    // `compose config` renders and resolves the whole file, so it runs for what is on screen
    // rather than for the list.
    expect(store.loadComposeConfig).toHaveBeenCalledTimes(1);
    expect(store.loadComposeConfig).toHaveBeenCalledWith("storefront", [
      "/srv/storefront/compose.yaml",
    ]);
  });

  it("offers the failure and a retry rather than an open-ended wait", () => {
    const store = renderScreen({
      expandedComposeProject: "storefront",
      composeConfigError: "Docker Compose could not resolve the project configuration.",
    });

    const failure = screen.getByTestId("compose-config-error");
    expect(failure).toHaveTextContent(
      "Docker Compose could not resolve the project configuration.",
    );
    expect(store.loadComposeConfig).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("compose-config-retry"));
    expect(store.loadComposeConfig).toHaveBeenCalledTimes(2);
  });

  it("keeps the live service list when the configuration cannot be read", () => {
    // `compose ps` and `compose config` are separate reads; losing one must not blank the
    // other, which is what the operator uses to see the project at all.
    renderScreen({
      expandedComposeProject: "storefront",
      composeServices: { storefront: [live("api")] },
      composeConfigError: "Compose capability is unavailable",
    });

    expect(serviceRowNames()).toEqual(["api"]);
    expect(screen.getByTestId("compose-services-storefront")).toHaveTextContent(
      "running",
    );
  });
});

describe("ComposeScreen project rail", () => {
  it("loads a project's services on selection, and does not unselect it on a second click", () => {
    // The rail's selection is the store's expanded project, so selecting still drives the
    // one `compose ps` the expandable row used to. Re-clicking the open project would
    // collapse it and blank the column being read.
    const store = renderScreen();

    fireEvent.click(screen.getByTestId("compose-expand-storefront"));
    expect(store.toggleComposeProject).toHaveBeenCalledWith("storefront");

    cleanup();
    const selectedStore = renderScreen({ expandedComposeProject: "storefront" });
    fireEvent.click(screen.getByTestId("compose-expand-storefront"));
    expect(selectedStore.toggleComposeProject).not.toHaveBeenCalled();
  });

  it("links a service through to the container it maps to, and only when there is one", () => {
    const store = renderScreen({
      expandedComposeProject: "storefront",
      // The screen matches a service's container by id and reads nothing else off it.
      containers: [{ id: "container-api" }] as AnchorageStore["containers"],
      composeServices: {
        storefront: [live("api"), live("gone", { containerId: "", state: "exited" })],
      },
    });

    // The row opens the service in place; the jump to the container's own screen is an
    // explicit control inside what it opened.
    fireEvent.click(screen.getByTestId("compose-service-expand-api"));
    fireEvent.click(screen.getByTestId("compose-service-open-full-api"));
    expect(store.selectContainer).toHaveBeenCalledWith("container-api");

    // A service whose container is gone still opens, but offers no jump to nothing.
    fireEvent.click(screen.getByTestId("compose-service-expand-gone"));
    expect(screen.queryByTestId("compose-service-open-full-gone")).toBeNull();
  });

  it("joins the short id compose ps reports onto the full id the container list carries", () => {
    // `docker compose ps` truncates its ID field to 12 characters; the container list is
    // read with --no-trunc. Exact equality never held, so every service in every project
    // claimed "no container" while its container sat running in the list.
    const fullId = `0244b7d89d10${"f".repeat(52)}`;
    const store = renderScreen({
      expandedComposeProject: "storefront",
      containers: [{ id: fullId }] as AnchorageStore["containers"],
      composeServices: {
        storefront: [live("api", { containerId: "0244b7d89d10" })],
      },
    });

    fireEvent.click(screen.getByTestId("compose-service-expand-api"));
    fireEvent.click(screen.getByTestId("compose-service-open-full-api"));
    // The full id is the one the container screen can act on.
    expect(store.selectContainer).toHaveBeenCalledWith(fullId);
  });

  it("does not present the browser preview as a project inventory", () => {
    renderScreen({ isHost: false, composeStatus: "idle", composeProjectList: [] });

    expect(screen.getByTestId("compose-screen")).toHaveTextContent(
      "Browser preview",
    );
    // "0 projects" would be a claim that Anchorage looked; in preview there is no CLI to ask.
    expect(screen.getByTestId("compose-screen")).not.toHaveTextContent("0 projects");
  });
});

/**
 * A Compose action reports nothing, and the screen looked hung.
 *
 * `runComposeAction` drives the same session machinery as an image transfer, so the project's
 * `Stopping …` / `Removing network …` lines, the status, and any failure were all being captured
 * into the store — and then rendered nowhere, because the panel that displays a session lived in
 * `ImagesScreen`. Compose read the same state only to derive a `busy` boolean that greys out its
 * buttons. `compose down` on a real project takes tens of seconds, so the whole visible result of
 * pressing the button was that the buttons stopped responding.
 *
 * The failure worth guarding hardest is the last one: an action that errored said so only on a
 * screen the operator was not looking at.
 */
describe("ComposeScreen action progress", () => {
  const runningTransfer = {
    kind: "compose" as const,
    title: "Compose Down",
    reference: "storefront",
    status: "running" as const,
    output: "Stopping storefront-api-1  ...\nRemoving network storefront_default\n",
  };

  it("shows the action, its target and its status while it runs", () => {
    renderScreen({ imageTransfer: runningTransfer });
    const panel = screen.getByTestId("compose-action-output");
    expect(panel).toHaveTextContent("Compose Down");
    expect(panel).toHaveTextContent("storefront");
    expect(panel).toHaveTextContent("running");
  });

  it("streams Compose's own words rather than a spinner that claims nothing", () => {
    renderScreen({ imageTransfer: runningTransfer });
    const panel = screen.getByTestId("compose-action-output");
    expect(panel).toHaveTextContent("Removing network storefront_default");
  });

  it("reports a failed action on the screen the operator is looking at", () => {
    renderScreen({
      imageTransfer: {
        ...runningTransfer,
        status: "error" as const,
        error: "compose down failed: network storefront_default has active endpoints",
      },
    });
    expect(screen.getByTestId("compose-action-output")).toHaveTextContent(
      "network storefront_default has active endpoints",
    );
  });

  it("announces progress to assistive technology as it changes", () => {
    renderScreen({ imageTransfer: runningTransfer });
    // The panel appears and updates without focus moving, so a screen reader is told nothing
    // unless the region is live.
    expect(screen.getByTestId("compose-action-output")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("stays absent when no action is running, rather than showing an empty shell", () => {
    renderScreen({ imageTransfer: null });
    expect(screen.queryByTestId("compose-action-output")).toBeNull();
  });

  it("ignores an image transfer, which shares the same slot", () => {
    // One session slot serves both screens. Without the discriminator a background `docker pull`
    // painted a progress panel over Compose reading "Pull nginx:1.27", which belongs to Images.
    renderScreen({
      imageTransfer: {
        kind: "image" as const,
        title: "Pull",
        reference: "nginx:1.27",
        status: "running" as const,
        output: "Pulling from library/nginx\n",
      },
    });
    expect(screen.queryByTestId("compose-action-output")).toBeNull();
  });

  it("keeps reporting while the operator moves through the rail", () => {
    // The panel sits above the selection branch: taking a project down deselects nothing, but
    // clicking away mid-action must not silently drop the only progress the operator has.
    renderScreen({ imageTransfer: runningTransfer, expandedComposeProject: null });
    expect(screen.getByTestId("compose-action-output")).toHaveTextContent("Compose Down");
  });
});

/**
 * A service row could only be left, not opened.
 *
 * Clicking a service name switched the whole view to Containers and opened that container's
 * logs, which is a reasonable destination and a poor default: checking which port a service is
 * bound to, or why it exited, meant leaving the project view and navigating back. The row now
 * expands in place, and the jump to the full screen stays as an explicit choice.
 *
 * Ports matter most here. Compose reports a service's state but not its bindings, so the row
 * reads them from the container the project actually produced.
 */
describe("ComposeScreen service detail", () => {
  const withService = (overrides: Partial<AnchorageStore> = {}) =>
    renderScreen({
      expandedComposeProject: "storefront",
      composeServices: { storefront: [live("api")] },
      composeConfigs: {
        storefront: configResult({ services: [service("api")] }),
      },
      containers: [
        {
          cpu: 0,
          memory: 0,
          memoryLimit: 0,
          cpuHistory: [],
          memoryHistory: [],
          labels: {},
          composeProject: "storefront",
          id: "container-api",
          name: "storefront-api-1",
          image: "team/api:latest",
          ports: "8080:8080, 9229:9229",
          state: "running",
          rawState: "running",
          status: "Up 2 hours",
          exitCode: 0,
          kind: "http",
          health: "healthy",
        },
      ],
      ...overrides,
    });

  it("keeps the detail closed until asked", () => {
    withService();
    expect(screen.queryByTestId("compose-service-detail-api")).toBeNull();
  });

  it("shows the bindings Compose does not report, read from the container", () => {
    withService();
    fireEvent.click(screen.getByTestId("compose-service-expand-api"));
    const detail = screen.getByTestId("compose-service-detail-api");
    expect(detail).toHaveTextContent("8080:8080");
    expect(detail).toHaveTextContent("9229:9229");
  });

  it("states plainly when a service publishes nothing, rather than showing an empty field", () => {
    withService({
      containers: [
        {
          cpu: 0,
          memory: 0,
          memoryLimit: 0,
          cpuHistory: [],
          memoryHistory: [],
          labels: {},
          composeProject: "storefront",
          id: "container-api",
          name: "storefront-api-1",
          image: "team/api:latest",
          ports: "",
          state: "running",
          rawState: "running",
          status: "Up 2 hours",
          exitCode: 0,
          kind: "http",
          health: "healthy",
        },
      ],
    } as unknown as Partial<AnchorageStore>);
    fireEvent.click(screen.getByTestId("compose-service-expand-api"));
    expect(screen.getByTestId("compose-service-detail-api")).toHaveTextContent(
      "No published ports",
    );
  });

  it("still offers the jump to the full container screen", () => {
    const store = withService();
    fireEvent.click(screen.getByTestId("compose-service-expand-api"));
    fireEvent.click(screen.getByTestId("compose-service-open-full-api"));
    expect(store.selectContainer).toHaveBeenCalledWith("container-api");
  });

  it("expands a service whose container is gone, and says that is why there is nothing", () => {
    // Compose reports services whose containers have been removed. Refusing to expand them
    // leaves the operator with no explanation at all.
    renderScreen({
      expandedComposeProject: "storefront",
      composeServices: { storefront: [live("api", { containerId: "" })] },
      composeConfigs: {
        storefront: configResult({ services: [service("api")] }),
      },
      containers: [],
    });
    fireEvent.click(screen.getByTestId("compose-service-expand-api"));
    expect(screen.getByTestId("compose-service-detail-api")).toHaveTextContent(
      "no container",
    );
  });
});
