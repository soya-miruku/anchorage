// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BuildsScreen } from "./BuildsScreen";
import type { BuildRecord, BuildsInspectResult } from "../types";
import type { AnchorageStore } from "../store/useAnchorageStore";

afterEach(cleanup);

const observedAt = "2026-08-04T09:00:00.000Z";

const record = (id: string, status: BuildRecord["status"]): BuildRecord => ({
  id,
  ref: `default/default/${id}`,
  name: `registry.test/${id}:latest`,
  status,
  createdAt: observedAt,
  durationMs: 42_000,
  totalSteps: 8,
  completedSteps: 8,
  cachedSteps: 4,
});

const detail = (status: BuildRecord["status"]): BuildsInspectResult => ({
  context: "default",
  id: "detail",
  name: "registry.test/detail:latest",
  status,
  totalSteps: 8,
  cachedSteps: 4,
  completedSteps: 8,
  materials: [],
  observedAt,
});

function renderHost(overrides: Partial<AnchorageStore>) {
  const store = {
    isHost: true,
    buildsStatus: "ready",
    buildRecords: [],
    buildBuilders: [],
    buildDetail: null,
    selectedBuildRef: null,
    refreshBuilds: async () => undefined,
    selectBuildRecord: async () => undefined,
    ...overrides,
  } as unknown as AnchorageStore;
  return render(<BuildsScreen store={store} />);
}

const dot = (id: string) =>
  screen.getByTestId(`build-${id}`).querySelector(".build-status-dot")!;

describe("BuildsScreen host status colours", () => {
  it("does not report a running or cancelled build as failed", () => {
    renderHost({
      buildRecords: [
        record("running", "running"),
        record("cancelled", "cancelled"),
        record("unknown", "unknown"),
      ],
    });

    for (const id of ["running", "cancelled", "unknown"]) {
      expect(dot(id)).not.toHaveClass("build-status-dot--failed");
      expect(dot(id)).toHaveClass(`build-status-dot--${id}`);
    }
  });

  it("still separates a success from a failure", () => {
    renderHost({
      buildRecords: [record("ok", "success"), record("bad", "failed")],
    });

    expect(dot("ok")).toHaveClass("build-status-dot--success");
    expect(dot("bad")).toHaveClass("build-status-dot--failed");
  });

  // A status the engine grows later must not arrive as a red dot, and must not arrive as a
  // modifier with no CSS rule behind it either — that would render the dot invisible.
  it("falls back to the neutral style for a status it does not know", () => {
    renderHost({
      buildRecords: [record("odd", "provisioning" as BuildRecord["status"])],
    });

    expect(dot("odd")).toHaveClass("build-status-dot--unknown");
  });

  it("does not paint the detail pill red for a build that is still running", () => {
    renderHost({
      buildRecords: [record("running", "running")],
      selectedBuildRef: "default/default/running",
      buildDetail: detail("running"),
    });

    const pill = screen.getByText("running", { selector: ".build-status-pill" });
    expect(pill).not.toHaveClass("build-status-pill--failed");
    expect(pill).toHaveClass("build-status-pill--running");
  });
});

/**
 * A build whose record cannot be read has to say so on the screen the operator clicked from.
 *
 * `selectBuildRecord` used to route a failed `buildx history inspect` into `buildsError`, which
 * only Settings → Builders renders — so the detail pane sat on "Reading build record…" and the
 * reason appeared somewhere nobody was looking. `buildsError` also carries buildx's own
 * limitations, which are caveats rather than failures, so the two could not share a slot.
 */
describe("BuildsScreen detail failures", () => {
  it("reports why the selected record could not be read", () => {
    renderHost({
      buildRecords: [record("one", "success")],
      selectedBuildRef: "default/default/one",
      buildDetail: null,
      buildDetailError: "buildx history inspect: no such record",
    } as Partial<AnchorageStore>);
    expect(
      screen.getByText("buildx history inspect: no such record"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Reading build record/u)).toBeNull();
  });

  it("does not mistake a list-level buildx limitation for a failed record", () => {
    renderHost({
      buildRecords: [record("one", "success")],
      selectedBuildRef: "default/default/one",
      buildDetail: null,
      buildsError: "History is limited to the default builder on this transport.",
    } as Partial<AnchorageStore>);
    expect(screen.getByText(/Reading build record/u)).toBeInTheDocument();
    expect(screen.queryByText(/Could not read this build/u)).toBeNull();
  });
});
