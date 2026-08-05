// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RebindPortsDialog } from "./RebindPortsDialog";
import type { AnchorageContainer } from "../types";

afterEach(cleanup);

/**
 * Republishing ports is not an edit, and the dialog must not read like one.
 *
 * Docker fixes bindings when a container is created; `docker update` cannot change them. The only
 * route is to create a replacement, which means the container ID changes, the writable layer is
 * discarded, and the log history goes with it. A dialog that says "Edit ports" and shows a text
 * field would be describing an operation Docker does not have.
 */
const container = (overrides: Partial<AnchorageContainer> = {}): AnchorageContainer =>
  ({
    id: "abc123def456",
    name: "api",
    image: "nginx:1.27",
    ports: "8080:80/tcp",
    state: "stopped",
    rawState: "exited",
    status: "Exited (0)",
    exitCode: 0,
    kind: "http",
    health: "—",
    cpu: 0,
    memory: 0,
    memoryLimit: 0,
    cpuHistory: [],
    memoryHistory: [],
    labels: {},
    composeProject: null,
    ...overrides,
  }) as unknown as AnchorageContainer;

const renderDialog = (overrides: Partial<AnchorageContainer> = {}) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <RebindPortsDialog
      container={container(overrides)}
      pending={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onCancel };
};

describe("RebindPortsDialog", () => {
  it("says the container will be replaced, not edited", () => {
    renderDialog();
    const dialog = screen.getByTestId("rebind-ports-dialog");
    expect(dialog.textContent ?? "").toMatch(/replac/i);
  });

  it("states each thing recreating loses", () => {
    renderDialog();
    const dialog = screen.getByTestId("rebind-ports-dialog");
    expect(dialog).toHaveTextContent(/writable layer/i);
    expect(dialog).toHaveTextContent(/log/i);
    expect(dialog).toHaveTextContent(/identifier|ID changes|new ID/i);
  });

  it("starts from the bindings the container already has", () => {
    renderDialog();
    expect(screen.getByTestId("rebind-host-0")).toHaveValue("8080");
    expect(screen.getByTestId("rebind-container-0")).toHaveValue("80/tcp");
  });

  it("submits the edited bindings in the shape the core expects", () => {
    const { onConfirm } = renderDialog();
    fireEvent.change(screen.getByTestId("rebind-host-0"), { target: { value: "9090" } });
    fireEvent.click(screen.getByTestId("rebind-confirm"));
    expect(onConfirm).toHaveBeenCalledWith({ "9090": "80/tcp" });
  });

  it("can remove a binding, which is the case merging would make impossible", () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(screen.getByTestId("rebind-remove-0"));
    fireEvent.click(screen.getByTestId("rebind-confirm"));
    expect(onConfirm).toHaveBeenCalledWith({});
  });

  it("refuses a host port that is not a number rather than sending it", () => {
    const { onConfirm } = renderDialog();
    fireEvent.change(screen.getByTestId("rebind-host-0"), { target: { value: "http" } });
    fireEvent.click(screen.getByTestId("rebind-confirm"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("rebind-error")).toHaveTextContent(/number/i);
  });

  it("refuses two bindings that claim the same host port", () => {
    // Docker would reject this at create time, after the original had already been parked.
    const { onConfirm } = renderDialog();
    fireEvent.click(screen.getByTestId("rebind-add"));
    fireEvent.change(screen.getByTestId("rebind-host-1"), { target: { value: "8080" } });
    fireEvent.change(screen.getByTestId("rebind-container-1"), { target: { value: "443/tcp" } });
    fireEvent.click(screen.getByTestId("rebind-confirm"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("rebind-error")).toHaveTextContent(/8080/);
  });
});
