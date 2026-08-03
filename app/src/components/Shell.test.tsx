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
    commandCenterOpen: false,
    engineCpu: 0,
    engineMemory: 0,
    engineStatus: "ready",
    isHost: false,
    navigate: vi.fn(),
    openCommandCenter: vi.fn(),
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
