// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { createFixtureCapabilities } from "./data/commandFixtures";
import { useAnchorageStore } from "./store/useAnchorageStore";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  THEME_OPTIONS,
} from "./theme/appearance";

function installMemoryStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

function installFailingStorage() {
  const storage: Storage = {
    get length() {
      return 0;
    },
    clear: () => undefined,
    getItem: () => null,
    key: () => null,
    removeItem: () => undefined,
    setItem: () => {
      throw new Error("storage unavailable");
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

beforeEach(() => {
  delete window.anchorage;
  installMemoryStorage();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-color-mode");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderReady() {
  render(<App />);
  await screen.findByTestId("container-row-a91f2c4d");
}

function useHostContainerList(list: () => Promise<unknown>) {
  window.anchorage = {
    system: {
      capabilities: async () => createFixtureCapabilities("default"),
    },
    containers: {
      list: async () => list(),
      action: async () => ({ accepted: true }),
    },
  };
}


/** The label of whichever family ships as the default, so tests track it rather than name it. */
const defaultThemeLabel = () =>
  THEME_OPTIONS.find((option) => option.id === DEFAULT_APPEARANCE.family)!.label;

describe("Anchorage containers workspace", () => {
  it("composes global search with the only-running filter", async () => {
    await renderReady();

    expect(screen.getAllByTestId(/container-row-/)).toHaveLength(8);
    expect(
      screen.getByText("5 running · 2 stopped · 8 total"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("only-running-filter"));
    expect(screen.getAllByTestId(/container-row-/)).toHaveLength(5);
    expect(screen.queryByText("minio-storage")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("global-search"), {
      target: { value: "postgres" },
    });
    expect(screen.getAllByTestId(/container-row-/)).toHaveLength(1);
    expect(screen.getByText("postgres-main")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("global-search"), {
      target: { value: "minio" },
    });
    const emptyState = screen.getByTestId("containers-empty-state");
    expect(emptyState).toBeInTheDocument();
    expect(
      emptyState.querySelector('[data-anchorage-icon="empty"]'),
    ).toHaveAttribute("width", "19");
  });

  it("keeps row actions in the list and reconciles fixture mutations", async () => {
    await renderReady();
    const row = screen.getByTestId("container-row-f6210d98");

    fireEvent.click(screen.getByTestId("container-toggle-f6210d98"));
    expect(screen.queryByTestId("container-detail-screen")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(within(row).getByText("Running")).toBeInTheDocument();
    });
    expect(
      screen.getByText("6 running · 1 stopped · 8 total"),
    ).toBeInTheDocument();
  });

  it("requires confirmation before deleting a fixture container", async () => {
    await renderReady();

    fireEvent.click(screen.getByTestId("container-delete-3ac74e5b"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("delete-container-dialog")).toBeNull();
    expect(screen.getByTestId("container-row-3ac74e5b")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("container-delete-3ac74e5b"));
    fireEvent.click(screen.getByTestId("delete-container-confirm"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("container-row-3ac74e5b"),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByText("5 running · 1 stopped · 7 total"),
    ).toBeInTheDocument();
  });

  it("sorts the containers table by a column and reports the order accessibly", async () => {
    await renderReady();

    const rowNames = () =>
      screen
        .getAllByTestId(/^container-row-/u)
        .map((row) => row.querySelector("strong")?.textContent ?? "");

    const original = rowNames();
    const header = screen.getByTestId("sort-name");
    expect(header.closest("[aria-sort]")).toHaveAttribute("aria-sort", "none");

    fireEvent.click(header);
    const ascending = rowNames();
    expect(ascending).toEqual([...original].sort((a, b) => a.localeCompare(b)));
    expect(header.closest("[aria-sort]")).toHaveAttribute("aria-sort", "ascending");

    fireEvent.click(header);
    expect(rowNames()).toEqual([...ascending].reverse());
    expect(header.closest("[aria-sort]")).toHaveAttribute("aria-sort", "descending");

    // A third activation clears the sort and restores the daemon's own ordering.
    fireEvent.click(header);
    expect(rowNames()).toEqual(original);
    expect(header.closest("[aria-sort]")).toHaveAttribute("aria-sort", "none");
  });

  it("keeps sorting independent of filtering", async () => {
    await renderReady();

    fireEvent.click(screen.getByTestId("sort-name"));
    fireEvent.click(screen.getByTestId("only-running-filter"));

    const names = screen
      .getAllByTestId(/^container-row-/u)
      .map((row) => row.querySelector("strong")?.textContent ?? "");
    // Still sorted, and now only running rows are present.
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(screen.queryByTestId("container-row-3ac74e5b")).toBeNull();
  });

  it("selects containers in bulk and deletes the whole batch behind one confirmation", async () => {
    await renderReady();

    // Selecting all must cover exactly the filtered rows.
    fireEvent.click(screen.getByTestId("container-select-all"));
    const bar = await screen.findByTestId("container-bulk-bar");
    expect(bar).toHaveTextContent("8 selected");

    fireEvent.click(screen.getByTestId("bulk-delete"));
    const dialog = await screen.findByTestId("bulk-delete-dialog");
    // Running containers need --force, and the batch dialog must say so up front.
    expect(dialog).toHaveTextContent(/still running and will be killed first/u);
    fireEvent.click(within(dialog).getByTestId("bulk-delete-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("container-bulk-bar")).toBeNull();
    });
  });

  it("clears a partial selection without acting on anything", async () => {
    await renderReady();

    fireEvent.click(screen.getByTestId("container-select-3ac74e5b"));
    expect(await screen.findByTestId("container-bulk-bar")).toHaveTextContent(
      "1 selected",
    );
    fireEvent.click(screen.getByTestId("bulk-clear"));

    await waitFor(() => {
      expect(screen.queryByTestId("container-bulk-bar")).toBeNull();
    });
    // Nothing was removed.
    expect(screen.getByTestId("container-row-3ac74e5b")).toBeInTheDocument();
  });

  it("offers force delete for a running container and never escalates silently", async () => {
    await renderReady();

    // A running container is removable only with --force. The control must be enabled and
    // must say so, rather than being disabled with no explanation.
    const running = screen.getByTestId("container-delete-a91f2c4d");
    expect(running).not.toBeDisabled();
    expect(running).toHaveAttribute("title", "Force delete");

    fireEvent.click(running);
    const dialog = screen.getByTestId("delete-container-dialog");
    expect(dialog).toHaveAttribute("role", "alertdialog");
    expect(
      within(dialog).getByTestId("delete-container-confirm"),
    ).toHaveTextContent("Force delete");
  });

  it("navigates from the sidebar and opens the detail logs shell", async () => {
    await renderReady();

    fireEvent.click(screen.getByTestId("nav-images"));
    expect(screen.getByTestId("images-screen")).toBeInTheDocument();
    expect(screen.getByTestId("nav-images")).toHaveAttribute(
      "aria-current",
      "page",
    );

    // Searching filters the view you are on; it must not yank you to Containers mid-keystroke.
    fireEvent.change(screen.getByTestId("global-search"), {
      target: { value: "redis" },
    });
    expect(screen.getByTestId("images-screen")).toBeInTheDocument();
    expect(screen.getByTestId("image-sha256:11d8ac")).toBeInTheDocument();
    expect(screen.queryByTestId("image-sha256:4f1a92")).toBeNull();

    fireEvent.click(screen.getByTestId("nav-containers"));
    fireEvent.click(screen.getByTestId("container-row-c02a5f77"));
    expect(
      await screen.findByTestId("container-detail-screen"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "redis-cache" })).toBeInTheDocument();
    expect(await screen.findByTestId("container-logs")).toBeInTheDocument();
  });

  it("dismisses the update banner without disturbing the shell", async () => {
    await renderReady();
    expect(screen.getByTestId("update-banner")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("shell")).toBeInTheDocument();
  });

  it("renders the live-derived overview in the exact dashboard composition", async () => {
    await renderReady();

    fireEvent.click(screen.getByTestId("nav-dashboard"));

    expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Overview" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Containers running")).toBeInTheDocument();
    expect(screen.getByText("Aggregate CPU")).toBeInTheDocument();
    expect(screen.getByText("Recent activity")).toBeInTheDocument();
    expect(screen.getByText("Disk usage")).toBeInTheDocument();
  });

  it("switches image tabs, filters registry fixtures, and exposes pull state", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("nav-images"));

    expect(screen.getByText("8 images · 2.55 GB total · 890 MB reclaimable"))
      .toBeInTheDocument();
    expect(screen.getByTestId("image-sha256:0f4b8c")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Registry search" }));
    expect(
      screen.getByRole("heading", { name: "postgres" }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("registry-search"), {
      target: { value: "does-not-exist" },
    });
    expect(screen.getByTestId("registry-empty")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("registry-search"), {
      target: { value: "postgres" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(screen.getByRole("button", { name: "Pulled" })).toBeDisabled();

    fireEvent.click(screen.getByRole("tab", { name: "Local" }));
    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));
    fireEvent.click(screen.getByTestId("clean-up-confirm"));
    expect(screen.queryByTestId("image-sha256:0f4b8c")).not.toBeInTheDocument();
    expect(screen.getByText("7 images · 1.66 GB total · 0 MB reclaimable"))
      .toBeInTheDocument();
  });

  it("creates a deterministic local volume from the visible control", async () => {
    await renderReady();

    fireEvent.click(screen.getByTestId("nav-volumes"));
    fireEvent.click(screen.getByRole("button", { name: "Create volume" }));

    // The dialog is in-app on purpose: Electron short-circuits window.prompt in the renderer,
    // so a prompt-backed control is dead in the packaged application.
    const dialog = screen.getByTestId("create-volume-dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    fireEvent.change(screen.getByTestId("create-volume-name"), {
      target: { value: "worker cache" },
    });
    fireEvent.submit(dialog);

    expect(screen.getByTestId("volume-worker_cache")).toBeInTheDocument();
    expect(screen.getByText("6 volumes · 18.5 GB · 2 unused"))
      .toBeInTheDocument();
  });

  it("does not create a volume when the create dialog is dismissed", async () => {
    await renderReady();

    fireEvent.click(screen.getByTestId("nav-volumes"));
    fireEvent.click(screen.getByRole("button", { name: "Create volume" }));
    fireEvent.change(screen.getByTestId("create-volume-name"), {
      target: { value: "discarded" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("create-volume-dialog")).toBeNull();
    expect(screen.queryByTestId("volume-discarded")).toBeNull();
  });

  it("selects a build and updates the complete master-detail projection", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("nav-builds"));

    fireEvent.click(screen.getByTestId("build-worker-2.3-71ba55d"));

    expect(
      screen.getByRole("heading", { name: "acme/worker:2.3" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/main · 71ba55d · linux\/amd64 · 38s · cache 42%/),
    ).toBeInTheDocument();
    expect(screen.getByText("RUN npm run build")).toBeInTheDocument();
  });

  it("operates populated and empty Dev Environment creation flows", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("nav-devenv"));

    expect(screen.getByTestId("devenv-acme-platform")).toBeInTheDocument();
    expect(screen.getByTestId("devenv-ml-pipeline")).toBeInTheDocument();
    expect(screen.getByTestId("devenv-docs-site")).toBeInTheDocument();

    const acme = screen.getByTestId("devenv-acme-platform");
    fireEvent.click(
      within(acme).getByRole("button", {
        name: "More actions for acme-platform",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(within(acme).getByText("Stopped")).toBeInTheDocument();

    fireEvent.click(within(acme).getByRole("button", { name: "Open in editor" }));
    expect(within(acme).getByRole("button", { name: "Opened" }))
      .toBeInTheDocument();

    const ml = screen.getByTestId("devenv-ml-pipeline");
    fireEvent.click(
      within(ml).getByRole("button", {
        name: "More actions for ml-pipeline",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(within(ml).getByText("Running")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Create environment" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close create environment" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Create environment" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    for (const id of ["acme-platform", "ml-pipeline", "docs-site"]) {
      const card = screen.getByTestId(`devenv-${id}`);
      fireEvent.click(
        within(card).getByRole("button", {
          name: `More actions for ${
            id === "ml-pipeline" ? "ml-pipeline" : id === "docs-site" ? "docs-site" : "acme-platform"
          }`,
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    }

    expect(screen.getByTestId("devenv-empty")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Create from repository" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Create environment" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "payments-dev" },
    });
    fireEvent.change(screen.getByLabelText("Repository"), {
      target: { value: "https://github.com/acme/payments" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByTestId("devenv-payments-dev")).toBeInTheDocument();
    expect(screen.getByText("github.com/acme/payments")).toBeInTheDocument();
  });

  it("installs and uninstalls Extensions while keeping the summary exact", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("nav-extensions"));

    expect(
      screen.getByText("2 installed · 6 available in the marketplace"),
    ).toBeInTheDocument();

    const diskUsage = screen
      .getByRole("heading", { name: "Disk Usage" })
      .closest("article");
    expect(diskUsage).not.toBeNull();
    fireEvent.click(
      within(diskUsage as HTMLElement).getByRole("button", {
        name: "Installed",
      }),
    );
    expect(
      screen.getByText("1 installed · 6 available in the marketplace"),
    ).toBeInTheDocument();

    const trivy = screen
      .getByRole("heading", { name: "Trivy Scanner" })
      .closest("article");
    expect(trivy).not.toBeNull();
    fireEvent.click(
      within(trivy as HTMLElement).getByRole("button", { name: "Install" }),
    );
    expect(
      screen.getByText("2 installed · 6 available in the marketplace"),
    ).toBeInTheDocument();
    expect(
      within(trivy as HTMLElement).getByRole("button", { name: "Installed" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("supports every Resources control and the Docker Engine projection", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("nav-settings"));

    expect(
      screen.getByRole("button", { name: "Resources" }),
    ).toHaveAttribute("aria-current", "page");
    const cpu = screen.getByRole("slider", { name: "CPU limit" });
    const memory = screen.getByRole("slider", { name: "Memory limit" });
    const swap = screen.getByRole("slider", { name: "Swap" });
    const disk = screen.getByRole("slider", { name: "Virtual disk limit" });
    expect(cpu).toHaveValue("8");
    expect(memory).toHaveValue("16");
    expect(swap).toHaveValue("2");
    expect(disk).toHaveValue("96");

    fireEvent.change(cpu, { target: { value: "12" } });
    fireEvent.change(memory, { target: { value: "24" } });
    fireEvent.change(swap, { target: { value: "6" } });
    fireEvent.change(disk, { target: { value: "160" } });
    expect(screen.getByText("12 cores")).toBeInTheDocument();
    expect(screen.getByText("24 GB")).toBeInTheDocument();
    expect(screen.getByText("6 GB")).toBeInTheDocument();
    expect(screen.getByText("160 GB")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Apply & restart" }),
    );
    expect(
      screen.getByText("Resources applied · engine restart queued"),
    ).toHaveAttribute("role", "status");

    fireEvent.click(
      screen.getByRole("button", { name: "Reset to defaults" }),
    );
    expect(cpu).toHaveValue("8");
    expect(memory).toHaveValue("16");
    expect(swap).toHaveValue("2");
    expect(disk).toHaveValue("96");

    fireEvent.click(screen.getByRole("button", { name: "Docker Engine" }));
    expect(screen.getByTestId("daemon-json")).toHaveTextContent(
      '"containerd-snapshotter": true',
    );
    expect(
      screen.getByRole("button", { name: "Docker Engine" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("controls Kubernetes, update, and Advanced switches independently", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("nav-settings"));

    // Scoped: the sidebar now carries a Kubernetes destination of its own, so the bare
    // name matches both it and the Settings pane tab.
    fireEvent.click(
      within(screen.getByTestId("settings-navigation")).getByRole("button", {
        name: "Kubernetes",
      }),
    );
    const kubernetes = screen.getByRole("switch", {
      name: "Enable Kubernetes",
    });
    expect(kubernetes).toHaveAttribute("aria-checked", "false");
    fireEvent.click(kubernetes);
    expect(kubernetes).toHaveAttribute("aria-checked", "true");

    fireEvent.click(
      screen.getByRole("button", { name: "Software updates" }),
    );
    const automaticUpdates = screen.getByRole("switch", {
      name: "Automatic updates",
    });
    const betaChannel = screen.getByRole("switch", { name: "Beta channel" });
    expect(automaticUpdates).toHaveAttribute("aria-checked", "true");
    expect(betaChannel).toHaveAttribute("aria-checked", "false");
    fireEvent.click(automaticUpdates);
    fireEvent.click(betaChannel);
    expect(automaticUpdates).toHaveAttribute("aria-checked", "false");
    expect(betaChannel).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    const buildkit = screen.getByRole("switch", { name: "Use BuildKit" });
    const emulation = screen.getByRole("switch", {
      name: "Binary emulation",
    });
    const telemetry = screen.getByRole("switch", {
      name: "Send usage statistics",
    });
    expect(buildkit).toHaveAttribute("aria-checked", "true");
    expect(emulation).toHaveAttribute("aria-checked", "true");
    expect(telemetry).toHaveAttribute("aria-checked", "false");
    fireEvent.click(buildkit);
    fireEvent.click(emulation);
    fireEvent.click(telemetry);
    expect(buildkit).toHaveAttribute("aria-checked", "false");
    expect(emulation).toHaveAttribute("aria-checked", "false");
    expect(telemetry).toHaveAttribute("aria-checked", "true");
  });

  it("applies and persists theme family and color mode independently", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("nav-settings"));
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));

    // Whichever family ships as the default, not a literal: v2.5 moved it from Nous to Y2K and
    // a hard-coded name here would have to be chased every time that happens.
    expect(
      screen.getByRole("radio", { name: new RegExp(defaultThemeLabel(), "u") }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radio", { name: /Dark/u }),
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: /Docker/u }));
    fireEvent.click(screen.getByRole("radio", { name: /^Light/u }));

    expect(document.documentElement).toHaveAttribute("data-theme", "docker");
    expect(document.documentElement).toHaveAttribute(
      "data-color-mode",
      "light",
    );
    expect(
      JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}"),
    ).toEqual({
      family: "docker",
      mode: "light",
      corners: "rounded",
      cornersChosen: false,
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Using Docker · Light · Rounded corners · Saved on this device",
    );
  });

  it("uses roving focus and ARIA radio keyboard navigation for appearance", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("nav-settings"));
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));

    // Addressed by position rather than by name. Which family is selected, and where it sits in
    // the list, are both product decisions that have already moved once — naming them here meant
    // chasing this test every time. What must hold is the roving-focus contract itself: exactly
    // one row is tabbable, Home and End reach the ends, and arrowing wraps.
    const themeRadios = within(
      screen.getByRole("radiogroup", { name: /theme/iu }),
    ).getAllByRole("radio");
    const firstTheme = themeRadios[0];
    const lastTheme = themeRadios[themeRadios.length - 1];
    const selectedTheme = screen.getByRole("radio", {
      name: new RegExp(defaultThemeLabel(), "u"),
    });

    expect(themeRadios.filter((r) => r.getAttribute("tabindex") === "0")).toEqual([
      selectedTheme,
    ]);

    // Backwards from the first family wraps onto the last one.
    firstTheme.focus();
    fireEvent.keyDown(firstTheme, { key: "ArrowLeft" });
    expect(lastTheme).toHaveFocus();
    expect(lastTheme).toHaveAttribute("aria-checked", "true");
    expect(lastTheme).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(lastTheme, { key: "Home" });
    expect(firstTheme).toHaveFocus();
    expect(firstTheme).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(firstTheme, { key: "ArrowDown" });
    expect(themeRadios[1]).toHaveFocus();
    expect(themeRadios[1]).toHaveAttribute("aria-checked", "true");

    const darkMode = screen.getByRole("radio", { name: /^Dark/u });
    const lightMode = screen.getByRole("radio", { name: /^Light/u });
    darkMode.focus();
    fireEvent.keyDown(darkMode, { key: "End" });
    expect(lightMode).toHaveFocus();
    expect(lightMode).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(lightMode, { key: "Home" });
    expect(darkMode).toHaveFocus();
    expect(darkMode).toHaveAttribute("aria-checked", "true");
  });

  it("reports session-only appearance when persistence is unavailable", async () => {
    installFailingStorage();
    await renderReady();
    fireEvent.click(screen.getByTestId("nav-settings"));
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));

    expect(
      screen.getByText(/Changes apply for this session only/u),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Session only");

    fireEvent.click(screen.getByRole("radio", { name: /GitHub/u }));
    expect(document.documentElement).toHaveAttribute("data-theme", "github");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Using GitHub · Dark · Rounded corners · Session only",
    );
  });

  it("keeps capture appearance immutable through store mutation calls", () => {
    window.history.replaceState({}, "", "/?capture=canonical");
    const storedPreference = JSON.stringify({
      family: "github",
      mode: "light",
    });
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, storedPreference);
    const { result } = renderHook(() => useAnchorageStore());

    expect(result.current.themeFamily).toBe(DEFAULT_APPEARANCE.family);
    expect(result.current.colorMode).toBe(DEFAULT_APPEARANCE.mode);

    act(() => {
      result.current.setThemeFamily("github");
      result.current.setColorMode("light");
    });

    expect(result.current.themeFamily).toBe(DEFAULT_APPEARANCE.family);
    expect(result.current.colorMode).toBe(DEFAULT_APPEARANCE.mode);
    expect(document.documentElement).toHaveAttribute(
      "data-theme",
      DEFAULT_APPEARANCE.family,
    );
    expect(document.documentElement).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe(
      storedPreference,
    );
    expect(result.current.appearancePersistenceSucceeded).toBeNull();
  });

  it("keeps the canonical capture settings navigation unchanged", async () => {
    window.history.replaceState({}, "", "/?capture=settings-resources");
    await renderReady();
    fireEvent.click(screen.getByTestId("nav-settings"));

    const navigation = screen.getByRole("navigation", {
      name: "Settings sections",
    });
    expect(
      within(navigation).queryByRole("button", { name: "Appearance" }),
    ).not.toBeInTheDocument();
    expect(
      within(navigation).getByRole("button", { name: "Resources" }),
    ).toHaveAttribute("aria-current", "page");
  });
});

describe("Anchorage engine connection states", () => {
  it("shows loading without changing the healthy renderer after resolution", async () => {
    let resolveList: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolveList = resolve;
    });
    useHostContainerList(() => pending);

    render(<App />);
    expect(screen.getByTestId("engine-state-loading")).toBeInTheDocument();

    resolveList([]);
    expect(await screen.findByTestId("containers-screen")).toBeInTheDocument();
    expect(screen.queryByTestId("engine-state-loading")).not.toBeInTheDocument();
  });

  it("classifies a disconnected engine and retries into the healthy state", async () => {
    let attempt = 0;
    useHostContainerList(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("connect ECONNREFUSED /var/run/docker.sock");
      }
      return [];
    });

    render(<App />);
    expect(
      await screen.findByTestId("engine-state-disconnected"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));

    expect(await screen.findByTestId("containers-screen")).toBeInTheDocument();
    expect(screen.getByText("0 running · 0 stopped · 0 total"))
      .toBeInTheDocument();
  });

  it("shows the permission-specific recovery state", async () => {
    useHostContainerList(async () => {
      throw new Error("permission denied while opening /var/run/docker.sock");
    });

    render(<App />);
    expect(
      await screen.findByTestId("engine-state-permission"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Permission required" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry connection" }),
    ).toBeInTheDocument();
  });

  it("shows unexpected engine errors without misclassifying them", async () => {
    useHostContainerList(async () => {
      throw new Error("Malformed engine response");
    });

    render(<App />);
    expect(await screen.findByTestId("engine-state-error")).toBeInTheDocument();
    expect(screen.getByText("Could not load the engine")).toBeInTheDocument();
    expect(screen.getByText("Malformed engine response")).toBeInTheDocument();
  });
});
