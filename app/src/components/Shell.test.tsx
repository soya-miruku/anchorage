// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { AnchorageBridge } from "../types";
import { isCaptureSurface, Shell } from "./Shell";

function createStore(
  bridgeOverrides: Partial<AnchorageBridge> = {},
): AnchorageStore {
  return {
    bannerVisible: false,
    bridge: {
      windowAction: vi.fn(async () => undefined),
      windowIsMaximized: vi.fn(async () => false),
      subscribeWindowMaximized: vi.fn(() => () => undefined),
      setWindowBackgroundColor: vi.fn(async () => undefined),
      ...bridgeOverrides,
    },
    clock: "12:00",
    colorMode: "dark",
    commandCenterOpen: false,
    engineCpu: 0,
    engineMemory: 0,
    engineStatus: "ready",
    isHost: false,
    navigate: vi.fn(),
    openCommandCenter: vi.fn(),
    resources: { cpus: 8, memoryGb: 16, swapGb: 1, diskGb: 64 },
    setColorMode: vi.fn(),
    runningCount: 1,
    search: "",
    setSearch: vi.fn(),
    stoppedCount: 0,
    systemSnapshot: null,
    view: "containers",
  } as unknown as AnchorageStore;
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  document.documentElement.style.removeProperty("--anc-app");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-color-mode");
});

describe("Shell surface geometry mode", () => {
  it("uses viewport geometry for ordinary browser and Electron URLs", () => {
    render(
      <Shell store={createStore()}>
        <div>Content</div>
      </Shell>,
    );

    const desk = screen.getByTestId("shell").parentElement;
    expect(desk).toHaveAttribute("data-surface-mode", "viewport");
    expect(desk).not.toHaveClass("anchorage-desk--capture");
  });

  it("restores the canonical desk for any capture query value", () => {
    window.history.replaceState({}, "", "/?capture=containers");

    render(
      <Shell store={createStore()}>
        <div>Content</div>
      </Shell>,
    );

    const desk = screen.getByTestId("shell").parentElement;
    expect(desk).toHaveAttribute("data-surface-mode", "capture");
    expect(desk).toHaveClass("anchorage-desk--capture");
    expect(isCaptureSurface("?theme=dark&capture=")).toBe(true);
    expect(isCaptureSurface("?captureState=containers")).toBe(false);
  });

  it("marks titlebar control regions as non-draggable", () => {
    render(
      <Shell store={createStore()}>
        <div>Content</div>
      </Shell>,
    );

    expect(screen.getByTestId("titlebar")).not.toHaveClass(
      "titlebar__no-drag",
    );
    expect(screen.getByTestId("global-search").closest("label")).toHaveClass(
      "titlebar__no-drag",
    );
    expect(
      screen.getByRole("button", { name: "Open settings" }).parentElement,
    ).toHaveClass("titlebar__no-drag");
  });

  it("queries initial maximize state and follows native maximize events", async () => {
    let emitMaximized: ((value: boolean) => void) | undefined;
    let resolveInitial: ((value: boolean) => void) | undefined;
    const initialState = new Promise<boolean>((resolve) => {
      resolveInitial = resolve;
    });
    const unsubscribe = vi.fn();
    const windowAction = vi.fn(async () => false);
    const store = createStore({
      windowAction,
      windowIsMaximized: vi.fn(() => initialState),
      subscribeWindowMaximized: vi.fn((listener) => {
        emitMaximized = listener;
        return unsubscribe;
      }),
    });

    render(
      <Shell store={store}>
        <div>Content</div>
      </Shell>,
    );

    expect(
      screen.getByRole("button", { name: "Maximize window" }),
    ).toHaveAttribute("data-window-state", "restored");

    act(() => emitMaximized?.(true));
    const restore = await screen.findByRole("button", {
      name: "Restore window",
    });
    expect(restore).toHaveAttribute("data-window-state", "maximized");

    await act(async () => {
      resolveInitial?.(false);
      await initialState;
    });
    expect(
      screen.getByRole("button", { name: "Restore window" }),
    ).toBeInTheDocument();

    fireEvent.click(restore);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Maximize window" }),
      ).toBeInTheDocument();
    });
    expect(windowAction).toHaveBeenCalledWith("maximize");

    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("synchronizes the native clear color from the applied app token", async () => {
    const setWindowBackgroundColor = vi.fn(async () => undefined);
    document.documentElement.style.setProperty("--anc-app", "#00153C");

    render(
      <Shell store={createStore({ setWindowBackgroundColor })}>
        <div>Content</div>
      </Shell>,
    );

    await waitFor(() => {
      expect(setWindowBackgroundColor).toHaveBeenLastCalledWith("#00153c");
    });

    document.documentElement.style.setProperty("--anc-app", "#ffffff");
    document.documentElement.setAttribute("data-color-mode", "light");
    await waitFor(() => {
      expect(setWindowBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    });
    expect(setWindowBackgroundColor).toHaveBeenCalledTimes(2);
  });

  it("does not forward a non-opaque CSS value to native window chrome", async () => {
    const setWindowBackgroundColor = vi.fn(async () => undefined);
    document.documentElement.style.setProperty(
      "--anc-app",
      "rgb(0 21 60 / 80%)",
    );

    render(
      <Shell store={createStore({ setWindowBackgroundColor })}>
        <div>Content</div>
      </Shell>,
    );

    await Promise.resolve();
    expect(setWindowBackgroundColor).not.toHaveBeenCalled();
  });
});

describe("Titlebar appearance and version", () => {
  it("states the version that was actually built", () => {
    render(
      <Shell store={createStore()}>
        <div>Content</div>
      </Shell>,
    );

    expect(screen.getByText(__ANCHORAGE_VERSION__)).toBeInTheDocument();
  });

  it("offers the opposite colour mode from the titlebar", () => {
    const store = createStore();
    render(
      <Shell store={store}>
        <div>Content</div>
      </Shell>,
    );

    const toggle = screen.getByTestId("mode-toggle");
    expect(toggle).toHaveAccessibleName("Switch to light mode");

    fireEvent.click(toggle);
    expect(store.setColorMode).toHaveBeenCalledWith("light");
  });

  it("withholds the mode toggle from capture URLs, which force their own appearance", () => {
    window.history.replaceState({}, "", "/?capture=containers");

    render(
      <Shell store={createStore()}>
        <div>Content</div>
      </Shell>,
    );

    expect(screen.queryByTestId("mode-toggle")).toBeNull();
  });

  it("keeps chrome added after the handoff out of the canonical capture canvas", () => {
    render(
      <Shell store={createStore()}>
        <div>Content</div>
      </Shell>,
    );
    expect(screen.getByTestId("maturity-chip")).toBeInTheDocument();

    cleanup();
    window.history.replaceState({}, "", "/?capture=containers");
    render(
      <Shell store={createStore()}>
        <div>Content</div>
      </Shell>,
    );

    // Capture URLs exist so the original handoff states stay comparable; new titlebar
    // furniture would change all 24 of them.
    expect(screen.queryByTestId("maturity-chip")).toBeNull();
  });
});

describe("Sidebar navigation grouping", () => {
  function navOrder(groupLabel: string) {
    return Array.from(
      screen
        .getByRole("navigation", { name: `${groupLabel} navigation` })
        .querySelectorAll("[data-testid^='nav-']"),
    ).map((item) => item.getAttribute("data-testid"));
  }

  it("groups the workspace destinations in the handoff's order", () => {
    render(
      <Shell store={createStore()}>
        <div>Content</div>
      </Shell>,
    );

    expect(navOrder("workspace")).toEqual([
      "nav-dashboard",
      "nav-containers",
      "nav-compose",
      "nav-images",
      "nav-volumes",
      "nav-networks",
      "nav-builds",
      "nav-logs",
      "nav-kubernetes",
    ]);
  });

  it("files the remaining destinations under Platform rather than Develop", () => {
    render(
      <Shell store={createStore()}>
        <div>Content</div>
      </Shell>,
    );

    expect(navOrder("platform")).toEqual([
      "nav-cloud",
      "nav-devenv",
      "nav-extensions",
      "nav-settings",
    ]);
    expect(
      screen.queryByRole("navigation", { name: "develop navigation" }),
    ).toBeNull();
  });

  it("announces the active destination while the engine is ready", () => {
    render(
      <Shell store={createStore()}>
        <div>Content</div>
      </Shell>,
    );

    expect(screen.getByTestId("nav-containers")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("announces no current page when the engine is not ready", () => {
    const store = createStore();
    render(
      <Shell store={{ ...store, engineStatus: "disconnected" }}>
        <div>Content</div>
      </Shell>,
    );

    expect(screen.getByTestId("nav-containers")).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByTestId("nav-containers")).toHaveClass(
      "nav-item--active",
    );
  });

  it("scrolls the active destination into view when it sits below the fold", () => {
    // Twenty-two destinations do not fit the shortest supported window, so the PLATFORM
    // group is off-screen at rest. Without this the primary nav shows no active row at all
    // on Settings, which reads as "nothing selected" rather than "scroll down".
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    // jsdom performs no layout, so every offset is 0 and the guard would correctly decline.
    // These give the nav a viewport shorter than the row's position within it.
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() {
        return this.classList?.contains("nav-item--active") ? 900 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return 35;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return 600;
      },
    });

    render(
      <Shell store={{ ...createStore(), view: "settings" }}>
        <div>Content</div>
      </Shell>,
    );

    const active = screen.getByTestId("nav-settings");
    expect(active).toHaveClass("nav-item--active");
    expect(scrollIntoView).toHaveBeenCalled();

    Reflect.deleteProperty(HTMLElement.prototype, "offsetTop");
    Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  it("marks the destination list when it continues past its own bottom edge", () => {
    // The cut lands on a row boundary, so a clipped list is indistinguishable from a complete
    // one. Two independent reviews of the design captures read the sidebar as ending at
    // Governance rather than scrolling.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList?.contains("sidebar__nav") ? 1100 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList?.contains("sidebar__nav") ? 600 : 0;
      },
    });

    render(
      <Shell store={{ ...createStore(), view: "settings" }}>
        <div>Content</div>
      </Shell>,
    );

    expect(document.querySelector(".sidebar__nav")).toHaveAttribute(
      "data-more",
      "true",
    );

    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });
});
