// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VolumesScreen } from "./VolumesScreen";
import type { AnchorageVolume } from "../types";
import type { AnchorageStore } from "../store/useAnchorageStore";

afterEach(cleanup);

const volume = (name: string): AnchorageVolume => ({
  name,
  driver: "local",
  size: "12 MB",
  usedBy: null,
  created: "2026-08-01",
  usageKnown: true,
  sizeBytes: 12_000_000,
  refCount: 0,
});

function renderVolumes(overrides: Partial<AnchorageStore>) {
  const store = {
    isHost: false,
    search: "",
    volumes: [],
    filteredVolumes: [],
    volumeSummary: "0 volumes",
    volumeMutationPending: false,
    browsedVolume: null,
    volumeTransfer: null,
    volumeInUseRestore: null,
    volumeBrowseError: null,
    hostDomainState: { volumes: { status: "ready" } },
    ...overrides,
  } as unknown as AnchorageStore;
  return render(<VolumesScreen store={store} />);
}

describe("VolumesScreen empty state", () => {
  it("names the search that matched nothing instead of blanking the table", () => {
    renderVolumes({ search: "nope", volumes: [volume("data")] });

    const empty = screen.getByTestId("volumes-empty-state");
    expect(empty).toHaveTextContent("No volumes match “nope”");
    expect(screen.queryByTestId("volume-data")).not.toBeInTheDocument();
  });

  it("distinguishes an empty host from an unmatched search", () => {
    renderVolumes({});

    expect(screen.getByTestId("volumes-empty-state")).toHaveTextContent(
      "No volumes yet",
    );
  });

  it("stays out of the way once a volume matches", () => {
    renderVolumes({
      search: "data",
      volumes: [volume("data")],
      filteredVolumes: [volume("data")],
    });

    expect(screen.getByTestId("volume-data")).toBeInTheDocument();
    expect(screen.queryByTestId("volumes-empty-state")).not.toBeInTheDocument();
  });
});

describe("VolumesScreen backup disclosure", () => {
  const openBackup = () => {
    renderVolumes({
      isHost: true,
      volumes: [volume("data")],
      filteredVolumes: [volume("data")],
    });
    fireEvent.click(screen.getByLabelText("Back up volume data"));
  };

  it("states what the archive discloses where the destination is chosen", () => {
    openBackup();

    const disclosure = screen.getByTestId("volume-backup-dialog-disclosure");
    expect(disclosure).toHaveTextContent(/plaintext copy of everything/);
    expect(disclosure).toHaveTextContent(
      /permissions of the directory you name here/,
    );
  });

  it("puts it in the dialog rather than behind it", () => {
    openBackup();

    expect(screen.getByTestId("volume-backup-dialog")).toContainElement(
      screen.getByTestId("volume-backup-dialog-disclosure"),
    );
  });

  it("leaves restore alone — reading it out is what discloses, not writing it in", () => {
    renderVolumes({
      isHost: true,
      volumes: [volume("data")],
      filteredVolumes: [volume("data")],
    });
    fireEvent.click(screen.getByLabelText("Restore volume data"));

    expect(
      screen.queryByTestId("volume-restore-dialog-disclosure"),
    ).not.toBeInTheDocument();
  });
});

const inUse = (name: string): AnchorageVolume => ({
  ...volume(name),
  usedBy: "2 containers",
  refCount: 2,
});

describe("VolumesScreen clone", () => {
  const openClone = (overrides: Partial<AnchorageStore> = {}) => {
    const cloneVolume = vi.fn();
    renderVolumes({
      isHost: true,
      volumes: [volume("data"), volume("pgdata")],
      filteredVolumes: [volume("data"), volume("pgdata")],
      cloneVolume,
      ...overrides,
    });
    fireEvent.click(screen.getByLabelText("Clone volume data"));
    return cloneVolume;
  };

  it("copies the source into the name the operator gives, and nowhere else", () => {
    const cloneVolume = openClone();

    fireEvent.change(screen.getByTestId("clone-volume-target"), {
      target: { value: "data_copy" },
    });
    fireEvent.click(screen.getByTestId("clone-volume-confirm"));

    expect(cloneVolume).toHaveBeenCalledWith("data", "data_copy");
  });

  it("will not clone until a target is named", () => {
    const cloneVolume = openClone();

    expect(screen.getByTestId("clone-volume-confirm")).toBeDisabled();
    fireEvent.submit(screen.getByTestId("clone-volume-dialog"));

    expect(cloneVolume).not.toHaveBeenCalled();
  });

  it("refuses a volume that is already on this screen rather than merging into it", () => {
    const cloneVolume = openClone();

    fireEvent.change(screen.getByTestId("clone-volume-target"), {
      target: { value: "pgdata" },
    });
    fireEvent.click(screen.getByTestId("clone-volume-confirm"));

    expect(screen.getByTestId("clone-volume-problem")).toHaveTextContent(
      /already exists/u,
    );
    expect(cloneVolume).not.toHaveBeenCalled();
  });

  it("tells the operator the copy carries no labels or driver options", () => {
    openClone();

    expect(screen.getByTestId("clone-volume-limitations")).toHaveTextContent(
      /labels or driver options/u,
    );
    expect(screen.getByTestId("clone-volume-limitations")).toHaveTextContent(
      /compose down --volumes/u,
    );
  });

  it("is a host verb only — the fixture screen cannot clone anything", () => {
    renderVolumes({
      volumes: [volume("data")],
      filteredVolumes: [volume("data")],
    });

    expect(screen.queryByLabelText("Clone volume data")).not.toBeInTheDocument();
  });
});

describe("VolumesScreen empty", () => {
  const openEmpty = (row: AnchorageVolume = volume("data")) => {
    const emptyVolume = vi.fn();
    renderVolumes({
      isHost: true,
      volumes: [row],
      filteredVolumes: [row],
      emptyVolume,
    });
    fireEvent.click(screen.getByLabelText(`Empty volume ${row.name}`));
    return emptyVolume;
  };

  it("destroys nothing until the confirmation is answered", () => {
    const emptyVolume = openEmpty();

    // Opening the dialog is not the decision: the bridge sets `confirmed` for every call, so
    // this confirmation is the only gate between the row control and the deletion.
    expect(emptyVolume).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("empty-volume-confirm"));
    expect(emptyVolume).toHaveBeenCalledWith("data");
  });

  it("names what is lost, and that it cannot be undone", () => {
    openEmpty();

    const dialog = screen.getByTestId("empty-volume-dialog");
    expect(dialog).toHaveTextContent("Empty data");
    expect(dialog).toHaveTextContent(/Every file in “data” is deleted/u);
    expect(dialog).toHaveTextContent(/cannot be undone/u);
  });

  it("says the volume is removed and recreated rather than wiped in place", () => {
    openEmpty();

    const limitations = screen.getByTestId("empty-volume-limitations");
    expect(limitations).toHaveTextContent(/removed and\s+recreated/u);
    expect(limitations).toHaveTextContent(/name, driver, labels\s+and options/u);
  });

  it("omits a size the daemon never measured instead of printing one", () => {
    openEmpty({
      ...volume("data"),
      size: "Unavailable",
      sizeBytes: undefined,
      usageKnown: false,
      refCount: undefined,
    });

    const dialog = screen.getByTestId("empty-volume-dialog");
    expect(dialog).toHaveTextContent(/Every file in “data” is deleted\./u);
    expect(dialog).not.toHaveTextContent(/Unavailable/u);
  });

  it("puts focus on the destructive control and hands it back", () => {
    renderVolumes({
      isHost: true,
      volumes: [volume("data")],
      filteredVolumes: [volume("data")],
      emptyVolume: vi.fn(),
    });
    const opener = screen.getByLabelText("Empty volume data");
    opener.focus();
    fireEvent.click(opener);

    expect(screen.getByTestId("empty-volume-confirm")).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(opener).toHaveFocus();
  });

  it("walks away when the operator cancels", () => {
    const emptyVolume = openEmpty();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("empty-volume-dialog")).not.toBeInTheDocument();
    expect(emptyVolume).not.toHaveBeenCalled();
  });

  it("offers no way past a volume Docker is holding open", () => {
    const emptyVolume = openEmpty(inUse("db"));

    expect(screen.getByTestId("empty-volume-in-use")).toHaveTextContent(
      /2 containers using this volume/u,
    );
    expect(screen.getByTestId("empty-volume-in-use")).toHaveTextContent(
      /no way to force it/u,
    );
    expect(screen.getByTestId("empty-volume-confirm")).toBeDisabled();

    fireEvent.click(screen.getByTestId("empty-volume-confirm"));
    expect(emptyVolume).not.toHaveBeenCalled();
  });
});

describe("VolumesScreen operation failures", () => {
  it("reports a refusal the row verbs would otherwise swallow", () => {
    // volume_in_use as the core words it: a stopped container still holds a reference the
    // running count never saw, so this reaches a volume the screen showed as free.
    renderVolumes({
      isHost: true,
      volumes: [volume("data")],
      filteredVolumes: [volume("data")],
      volumeBrowseError:
        "Docker will not release that volume: a container still references it.",
    });

    expect(screen.getByTestId("volume-operation-error")).toHaveTextContent(
      /a container still references it/u,
    );
  });

  it("reports the half-finished empty rather than treating it as done", () => {
    renderVolumes({
      isHost: true,
      volumes: [volume("data")],
      filteredVolumes: [volume("data")],
      volumeBrowseError:
        "The volume was removed but Docker Engine rejected recreating it.",
    });

    expect(screen.getByTestId("volume-operation-error")).toHaveTextContent(
      /removed but Docker Engine rejected recreating it/u,
    );
  });

  it("leaves the message to the file browser while that is open, so it reads once", () => {
    renderVolumes({
      isHost: true,
      volumes: [volume("data")],
      filteredVolumes: [volume("data")],
      browsedVolume: "data",
      volumePath: "/",
      volumeListing: null,
      volumePreview: null,
      volumeInUseUpload: null,
      browseVolume: vi.fn(),
      uploadVolumeFile: vi.fn(),
      previewVolumeFile: vi.fn(),
      closeVolumeBrowser: vi.fn(),
      closeVolumePreview: vi.fn(),
      volumeBrowseError: "Volume clone failed",
    });

    expect(screen.getByTestId("volume-browser")).toHaveTextContent(
      "Volume clone failed",
    );
    expect(
      screen.queryByTestId("volume-operation-error"),
    ).not.toBeInTheDocument();
  });
});

describe("VolumesScreen transfer in flight", () => {
  const running = (kind: "clone" | "empty") => ({
    isHost: true,
    volumes: [volume("data")],
    filteredVolumes: [volume("data")],
    volumeTransfer: { kind, volume: "data", status: "running" as const },
  });

  it("names the verb that is running instead of calling everything a restore", () => {
    renderVolumes(running("clone"));

    expect(screen.getByTestId("volume-transfer")).toHaveTextContent("Cloning data");

    cleanup();
    renderVolumes(running("empty"));

    expect(screen.getByTestId("volume-transfer")).toHaveTextContent("Emptying data");
  });

  it("stands the volume verbs down while the core's slot is taken", () => {
    renderVolumes(running("clone"));

    expect(screen.getByLabelText("Clone volume data")).toBeDisabled();
    expect(screen.getByLabelText("Empty volume data")).toBeDisabled();
    expect(screen.getByLabelText("Back up volume data")).toBeDisabled();
    expect(screen.getByLabelText("Restore volume data")).toBeDisabled();
  });

  it("opens the file browser from anywhere on the row", () => {
    /*
      Reported as having to "literally press the text of the list item". The name was the only
      target, so most of a 54px row looked identical and did nothing. The row is the control
      now — `role="button"` on the div rather than a real button, because the row contains five
      action buttons and a button cannot nest inside a button.
    */
    const browseVolume = vi.fn();
    renderVolumes({
      isHost: true,
      volumes: [volume("project_data")],
      filteredVolumes: [volume("project_data")],
      browseVolume,
    });

    const row = screen.getByTestId("volume-project_data");
    expect(row).toHaveAttribute("role", "button");
    fireEvent.click(row);
    expect(browseVolume).toHaveBeenCalledWith("project_data");
  });

  it("reaches the browser from the keyboard too", () => {
    // A div with role="button" gets no key handling for free, so Enter and Space are wired
    // explicitly — without them the row would be focusable and inert.
    const browseVolume = vi.fn();
    renderVolumes({
      isHost: true,
      volumes: [volume("project_data")],
      filteredVolumes: [volume("project_data")],
      browseVolume,
    });

    const row = screen.getByTestId("volume-project_data");
    expect(row).toHaveAttribute("tabIndex", "0");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(browseVolume).toHaveBeenCalledWith("project_data");
  });

  it("does not open the browser behind a row action", () => {
    // Back up, Restore, Clone, Empty and Delete all live inside the row. Without stopping
    // propagation each would open the file browser behind its own dialog.
    const browseVolume = vi.fn();
    renderVolumes({
      isHost: true,
      volumes: [volume("project_data")],
      filteredVolumes: [volume("project_data")],
      browseVolume,
    });

    fireEvent.click(screen.getByRole("button", { name: "Back up volume project_data" }));
    expect(browseVolume).not.toHaveBeenCalled();
  });

  it("no longer carries a Browse action, because the row is one", () => {
    renderVolumes({
      isHost: true,
      volumes: [volume("project_data")],
      filteredVolumes: [volume("project_data")],
    });
    // Queried by its visible text rather than its accessible name: the row itself is now
    // labelled "Browse volume project_data", which is correct and would match either way.
    expect(screen.queryByText("Browse")).toBeNull();
    // The other four row actions are untouched.
    for (const label of ["Back up", "Restore", "Clone", "Empty"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("leaves the row inert where there is nothing to browse", () => {
    // The browser preview reaches no daemon, so a clickable row would be a control that
    // cannot act — the same lie as an install button on a machine that cannot install.
    renderVolumes({
      isHost: false,
      volumes: [volume("project_data")],
      filteredVolumes: [volume("project_data")],
    });
    const row = screen.getByTestId("volume-project_data");
    expect(row).not.toHaveAttribute("role", "button");
  });
});
