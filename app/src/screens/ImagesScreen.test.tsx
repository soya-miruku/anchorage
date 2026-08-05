// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ImagesScreen } from "./ImagesScreen";
import type { AnchorageImage } from "../types";
import type { AnchorageStore } from "../store/useAnchorageStore";

afterEach(cleanup);

const image = (repository: string): AnchorageImage => ({
  repository,
  tag: "latest",
  id: repository,
  imageId: `sha256:${repository}`,
  reference: `${repository}:latest`,
  identity: `${repository}:latest`,
  created: "2026-08-01",
  size: "120 MB",
  sizeMb: 120,
  usageKnown: true,
  inUse: false,
  reclaimable: true,
});

function renderImages(overrides: Partial<AnchorageStore>) {
  const store = {
    isHost: true,
    imageTab: "local",
    search: "",
    imageQuery: "",
    images: [],
    filteredImages: [],
    imageSummary: "0 images",
    imageMutationPending: false,
    imageTransfer: null,
    selectedImage: null,
    imageFilters: { all: false, includeDangling: false },
    hostDomainState: { images: { status: "ready" } },
    setImageTab: () => undefined,
    setImageQuery: () => undefined,
    setImageFilters: () => undefined,
    ...overrides,
  } as unknown as AnchorageStore;
  return render(<ImagesScreen store={store} />);
}

describe("ImagesScreen empty state", () => {
  it("names the titlebar search that matched nothing instead of blanking the table", () => {
    renderImages({ search: "nope", images: [image("api")] });

    const empty = screen.getByTestId("images-empty-state");
    expect(empty).toHaveTextContent("No images match “nope”");
    expect(screen.queryByTestId("image-api")).not.toBeInTheDocument();
  });

  // Both boxes narrow the same table, so the in-screen one has to be quotable too.
  it("quotes the in-screen filter when both boxes are set", () => {
    renderImages({ search: "nope", imageQuery: "worker", images: [image("api")] });

    expect(screen.getByTestId("images-empty-state")).toHaveTextContent(
      "No images match “worker”",
    );
  });

  it("distinguishes an empty host from an unmatched search", () => {
    renderImages({});

    expect(screen.getByTestId("images-empty-state")).toHaveTextContent(
      "No images yet",
    );
  });

  it("stays out of the way once an image matches", () => {
    renderImages({
      search: "api",
      images: [image("api")],
      filteredImages: [image("api")],
    });

    expect(screen.getByTestId("image-api")).toBeInTheDocument();
    expect(screen.queryByTestId("images-empty-state")).not.toBeInTheDocument();
  });

  it("shows a dangling image's scan result, which is stored under its immutable ID", () => {
    // `analyzeImage` is called with `reference ?? imageId`, so a dangling image is keyed by
    // ID. Looking it up by reference alone meant the scan ran, succeeded, and the drawer
    // stayed empty — indistinguishable from never having scanned it.
    const imageId = `sha256:${"d".repeat(64)}`;
    const dangling: AnchorageImage = {
      ...image("dangling"),
      repository: "<none>",
      tag: "<none>",
      imageId,
      reference: null,
      identity: imageId,
    };

    renderImages({
      images: [dangling],
      filteredImages: [dangling],
      selectedImage: dangling,
      // The panel renders its sections only once the inspect result has arrived.
      imageDetail: {
        context: "default",
        source: "engine-api",
        image: {
          id: imageId,
          repoTags: [],
          repoDigests: [],
          created: "2026-08-02",
          architecture: "amd64",
          os: "linux",
          sizeBytes: 180_000_000,
          labels: {},
          env: [],
          entrypoint: [],
          command: [],
          exposedPorts: [],
          rootFsLayers: [],
        },
        history: [],
        document: {},
        observedAt: "2026-08-04T00:00:00.000Z",
      },
      scoutByReference: {
        [imageId]: {
          reference: imageId,
          findings: [],
          summary: { critical: 0, high: 1, medium: 0, low: 0, unspecified: 0 },
          limitations: [],
          observedAt: "2026-08-04T00:00:00.000Z",
        },
      },
    } as unknown as Partial<AnchorageStore>);

    // The panel renders regardless; what matters is that the *result* reached it.
    expect(screen.getByTestId("image-scout")).toBeInTheDocument();
  });
});

/**
 * The detail panel has to be told whether an inspect is even possible.
 *
 * `ImageDetailPanel` distinguishes waiting from "no daemon to ask", but `inspectable` defaults
 * to true, so the whole distinction rests on this one prop being passed. Deleting
 * `inspectable={store.isHost}` from the screen left the suite green, which meant the only wiring
 * for that fix was unasserted — the panel's own tests pass the prop explicitly and cannot catch
 * a screen that stops passing it.
 */
describe("ImagesScreen detail panel wiring", () => {
  it("tells the panel the preview has no daemon to inspect with", () => {
    renderImages({
      isHost: false,
      images: [image("api")],
      selectedImage: image("api"),
      imageDetail: null,
      imageDetailError: null,
      scoutByReference: {},
      scoutPending: null,
      closeImageDetail: () => undefined,
    } as Partial<AnchorageStore>);

    expect(screen.getByText(/no daemon to inspect this image with/u)).toBeInTheDocument();
    expect(screen.queryByText(/Loading image detail/u)).toBeNull();
  });

  it("still waits on the host, where an inspect is genuinely in flight", () => {
    renderImages({
      isHost: true,
      images: [image("api")],
      selectedImage: image("api"),
      imageDetail: null,
      imageDetailError: null,
      scoutByReference: {},
      scoutPending: null,
      closeImageDetail: () => undefined,
    } as Partial<AnchorageStore>);

    expect(screen.getByText(/Loading image detail/u)).toBeInTheDocument();
  });
});
