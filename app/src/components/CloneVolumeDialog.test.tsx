// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloneVolumeDialog } from "./CloneVolumeDialog";

afterEach(cleanup);

function renderDialog(
  overrides: Partial<Parameters<typeof CloneVolumeDialog>[0]> = {},
) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <CloneVolumeDialog
      volume="project_data"
      existingNames={["project_data", "pgdata"]}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return {
    onConfirm,
    onCancel,
    target: screen.getByTestId("clone-volume-target"),
    confirm: screen.getByTestId("clone-volume-confirm"),
  };
}

describe("CloneVolumeDialog target name", () => {
  it("will not clone without a name for the copy", () => {
    const { confirm, target, onConfirm } = renderDialog();

    expect(confirm).toBeDisabled();
    fireEvent.change(target, { target: { value: "   " } });
    expect(confirm).toBeDisabled();

    fireEvent.submit(screen.getByTestId("clone-volume-dialog"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("passes the trimmed name once one is given", () => {
    const { confirm, target, onConfirm } = renderDialog();

    fireEvent.change(target, { target: { value: "  project_data_copy  " } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledWith("project_data_copy");
  });

  it("refuses a target that already exists, and offers no way to overwrite it", () => {
    const { confirm, target, onConfirm } = renderDialog();

    fireEvent.change(target, { target: { value: "pgdata" } });

    expect(screen.getByTestId("clone-volume-problem")).toHaveTextContent(
      /already exists/u,
    );
    expect(screen.getByTestId("clone-volume-problem")).toHaveTextContent(
      /nothing to overwrite/u,
    );
    expect(confirm).toBeDisabled();
    // The core pre-checks because Docker's create would merge into the existing volume, and
    // there is no overwrite for the dialog to offer: no checkbox, no "replace" affordance.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    fireEvent.submit(screen.getByTestId("clone-volume-dialog"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("refuses the source's own name", () => {
    const { confirm, target } = renderDialog();

    fireEvent.change(target, { target: { value: "project_data" } });

    expect(screen.getByTestId("clone-volume-problem")).toHaveTextContent(
      /cannot be cloned onto itself/u,
    );
    expect(confirm).toBeDisabled();
  });

  it("catches a name Docker would reject before the copy runs", () => {
    const { confirm, target } = renderDialog();

    fireEvent.change(target, { target: { value: "-copy" } });

    expect(screen.getByTestId("clone-volume-problem")).toHaveTextContent(
      /letters, digits, dot, dash and underscore/u,
    );
    expect(confirm).toBeDisabled();
  });
});

describe("CloneVolumeDialog limitations", () => {
  it("says the copy carries neither labels nor driver options, before it is taken", () => {
    renderDialog();

    const limitations = screen.getByTestId("clone-volume-limitations");
    expect(limitations).toHaveTextContent(/labels or driver options/u);
    // Naming the consequence, not just the omission: a Compose label on the copy is what
    // makes `down --volumes` destroy it.
    expect(limitations).toHaveTextContent(/compose down --volumes/u);
    expect(screen.getByTestId("clone-volume-dialog")).toContainElement(limitations);
  });
});

describe("CloneVolumeDialog dialog semantics", () => {
  it("is a labelled, described modal that names itself and takes focus", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "clone-volume-title");
    expect(dialog).toHaveAttribute("aria-describedby", "clone-volume-description");
    expect(screen.getByTestId("clone-volume-target")).toHaveFocus();
  });

  it("closes on Escape and on Cancel without cloning anything", () => {
    const { onCancel, onConfirm } = renderDialog();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("gives focus back to whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const view = render(
      <CloneVolumeDialog
        volume="project_data"
        existingNames={[]}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    view.unmount();

    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("stands down while another volume transfer is running", () => {
    const { confirm, target } = renderDialog({ busy: true });

    fireEvent.change(target, { target: { value: "project_data_copy" } });

    expect(confirm).toBeDisabled();
  });
});
