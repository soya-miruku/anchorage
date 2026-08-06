// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelsScreen } from "./ModelsScreen";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { DockerModel } from "../types";

afterEach(cleanup);

const SMOLLM: DockerModel = {
  id: "sha256:354bf30d0aa3af413d2aa5ae4f23c66d78980072d1e07a5b0d776e9606a2f0b9",
  tags: ["ai/smollm2:latest", "ai/smollm2:360M"],
  reference: "ai/smollm2:latest",
  created: "2025-03-24T11:49:41Z",
  format: "gguf",
  quantization: "IQ2_XXS/Q4_K_M",
  parameters: "361.82 M",
  architecture: "llama",
  size: "256.35 MiB",
  contextSize: 4096,
};

function createStore(overrides: Partial<AnchorageStore> = {}): AnchorageStore {
  return {
    isHost: true,
    models: [],
    modelRunner: { running: true, reported: "Docker Model Runner is running", backends: [] },
    modelDisk: [],
    modelsStatus: "ready",
    modelsError: null,
    modelsBusy: null,
    imageTransfer: null,
    modelSearchResults: null,
    modelSearchStatus: "idle",
    modelSearchError: null,
    refreshModels: vi.fn(async () => undefined),
    searchModels: vi.fn(async () => undefined),
    clearModelSearch: vi.fn(),
    modelAction: vi.fn(async () => true),
    openCommandCenter: vi.fn(),
    ...overrides,
  } as unknown as AnchorageStore;
}

describe("ModelsScreen", () => {
  it("reads the installation on arrival rather than waiting to be asked", () => {
    const store = createStore();
    render(<ModelsScreen store={store} />);

    expect(store.refreshModels).toHaveBeenCalled();
    // Search is the one thing here that leaves the machine, so it must not fire on mount:
    // opening a screen is not consent to reach a registry.
    expect(store.searchModels).not.toHaveBeenCalled();
  });

  it("shows the runner's own sentence rather than a paraphrase of a boolean", () => {
    render(
      <ModelsScreen
        store={createStore({
          modelRunner: {
            running: true,
            reported: "Docker Model Runner is running",
            backends: [
              { name: "llama.cpp", status: "Running", detail: "llama.cpp 72874f559" },
              { name: "mlx", status: "Not Installed", detail: "only supported on Apple Silicon" },
            ],
          },
        })}
      />,
    );

    const runner = screen.getByTestId("model-runner");
    expect(runner).toHaveTextContent("Docker Model Runner is running");
    // A backend that is not installed is reported rather than hidden — an absent row would
    // read as a missing feature instead of an inapplicable one.
    expect(screen.getByTestId("model-backend-mlx")).toHaveTextContent(
      "only supported on Apple Silicon",
    );
  });

  it("distinguishes no models from no runner", () => {
    // The whole reason the runner strip and the list share a screen. "Nothing pulled yet" and
    // "nothing here is going to work" look identical if only one of them is on screen.
    const { rerender } = render(<ModelsScreen store={createStore()} />);
    expect(screen.getByTestId("models-empty")).toBeInTheDocument();
    expect(screen.getByTestId("model-runner")).toHaveTextContent("is running");

    rerender(
      <ModelsScreen
        store={createStore({
          modelRunner: {
            running: false,
            reported: "Docker Model Runner is not running",
            backends: [],
          },
        })}
      />,
    );
    expect(screen.getByTestId("models-empty")).toBeInTheDocument();
    expect(screen.getByTestId("model-runner")).toHaveTextContent("is not running");
  });

  it("lists a model once however many tags point at it", () => {
    render(<ModelsScreen store={createStore({ models: [SMOLLM] })} />);

    const row = screen.getByTestId("model-row-ai/smollm2:latest");
    expect(row).toHaveTextContent("361.82 M");
    expect(row).toHaveTextContent("IQ2_XXS/Q4_K_M");
    expect(row).toHaveTextContent("256.35 MiB");
    // One row, with the second tag named on it. A row per tag would make the disk figures read
    // as though the weights were stored twice.
    expect(screen.getAllByTestId(/^model-row-/u)).toHaveLength(1);
    expect(screen.getByTestId("model-extra-tags")).toHaveTextContent(
      "Also tagged ai/smollm2:360M",
    );
  });

  it("makes deleting weights take a second press", async () => {
    const store = createStore({ models: [SMOLLM] });
    render(<ModelsScreen store={store} />);
    const row = screen.getByTestId("model-row-ai/smollm2:latest");

    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    // Nothing has happened yet — the first press only asks.
    expect(store.modelAction).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole("button", { name: "Delete weights" }));
    expect(store.modelAction).toHaveBeenCalledWith({
      action: "remove",
      reference: "ai/smollm2:latest",
    });
  });

  it("unloads without confirmation, because unloading destroys nothing", () => {
    // Unload evicts the model from memory and leaves the weights on disk. Gating it behind the
    // same confirmation as a delete would teach the operator to click through both.
    const store = createStore({ models: [SMOLLM] });
    render(<ModelsScreen store={store} />);

    fireEvent.click(
      within(screen.getByTestId("model-row-ai/smollm2:latest")).getByRole("button", {
        name: "Unload",
      }),
    );
    expect(store.modelAction).toHaveBeenCalledWith({
      action: "unload",
      reference: "ai/smollm2:latest",
    });
  });

  it("greys only the row it is working on", () => {
    const second: DockerModel = { ...SMOLLM, id: "sha256:other", tags: ["ai/qwen3:latest"], reference: "ai/qwen3:latest" };
    render(
      <ModelsScreen
        store={createStore({
          models: [SMOLLM, second],
          modelsBusy: "ai/smollm2:latest",
        })}
      />,
    );

    expect(screen.getByTestId("model-row-ai/smollm2:latest")).toHaveAttribute(
      "data-busy",
      "true",
    );
    expect(screen.getByTestId("model-row-ai/qwen3:latest")).not.toHaveAttribute(
      "data-busy",
    );
  });

  it("searches only when asked, and says the search leaves the machine", () => {
    const store = createStore();
    render(<ModelsScreen store={store} />);

    expect(screen.getByText(/Reaches Docker Hub/u)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search Docker Hub for a model"), {
      target: { value: "smollm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(store.searchModels).toHaveBeenCalledWith("smollm");
  });

  it("pulls a Hugging Face hit from Hugging Face, not from Docker Hub", async () => {
    /*
     * `docker model search --source=huggingface` returns Hugging Face repositories under their
     * own names, and `docker model pull` resolves an unqualified name against Docker Hub. Sending
     * the displayed name therefore failed on every Hugging Face result, and failed in a way that
     * reads like the model is not real:
     *
     *   failed to pull model "huggingfacetb/smollm2-135m-instruct:latest":
     *   resolving docker.io/huggingfacetb/smollm2-135m-instruct:latest:
     *   pull access denied, repository does not exist
     *
     * Verified against the CLI both ways: the bare name fails, `hf.co/` + the same name pulls.
     * The core derives the pullable reference; this is the screen's half of it, and the two
     * strings differing is the entire point — a test that used the same value for both would
     * pass with the bug back in.
     */
    const store = createStore({
      modelSearchStatus: "ready",
      modelSearchResults: [
        {
          name: "HuggingFaceTB/SmolLM2-135M-Instruct",
          reference: "hf.co/HuggingFaceTB/SmolLM2-135M-Instruct",
          source: "HuggingFace",
          sizeBytes: 272_500_000,
        },
      ],
    });
    render(<ModelsScreen store={store} />);

    // Shown under its own name, so it is recognisable as the thing that was searched for.
    expect(
      screen.getByTestId("model-hit-HuggingFaceTB/SmolLM2-135M-Instruct"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(store.modelAction).toHaveBeenCalledWith({
      action: "pull",
      reference: "hf.co/HuggingFaceTB/SmolLM2-135M-Instruct",
    });
  });

  it("offers a pull for a search hit and formats what it will cost", () => {
    const store = createStore({
      modelSearchStatus: "ready",
      modelSearchResults: [
        {
          name: "ai/smollm2",
          reference: "ai/smollm2",
          description: "Tiny LLM built for speed",
          downloads: 606_099,
          official: true,
          backend: "llama.cpp",
          source: "Docker Hub",
          sizeBytes: 270_601_982,
        },
      ],
    });
    render(<ModelsScreen store={store} />);

    const hit = screen.getByTestId("model-hit-ai/smollm2");
    // 270,601,982 bytes is 258MB, and a download worth that much deserves a figure before
    // the button rather than after it.
    expect(hit).toHaveTextContent("258MB");
    expect(hit).toHaveTextContent("606K pulls");

    fireEvent.click(within(hit).getByRole("button", { name: "Pull" }));
    expect(store.modelAction).toHaveBeenCalledWith({
      action: "pull",
      reference: "ai/smollm2",
    });
  });

  it("falls back to the install surface when the plugin is not there", () => {
    // There is nothing to list until `docker model` exists, so the screen becomes the one
    // thing that helps: what state the plugin is in and how to get it.
    render(
      <ModelsScreen
        store={createStore({ modelsStatus: "unavailable", pluginReport: null })}
      />,
    );

    expect(screen.getByTestId("models-screen")).toHaveTextContent(/Models/u);
    expect(screen.queryByTestId("model-runner")).toBeNull();
  });

  it("states what the runner does not protect, whether or not it is installed", () => {
    render(<ModelsScreen store={createStore()} />);
    expect(screen.getByTestId("models-screen-posture")).toHaveTextContent(
      /no authentication by default/u,
    );
  });

  it("shows a pull in flight, and stops a second one starting", () => {
    /*
      The defect this covers: a pull returns as soon as the download *starts*, so the screen
      used to re-read the list immediately, find nothing new, and report that nothing had
      happened — while the download was still running with nobody following it. The transfer
      slot holds one session, so a second pull would cancel the first; both Pull buttons are
      disabled while one is in flight rather than only the row that was pressed.
    */
    const store = createStore({
      modelSearchStatus: "ready",
      modelSearchResults: [
        { name: "ai/smollm2", reference: "ai/smollm2", sizeBytes: 270_601_982 },
        { name: "ai/qwen3", reference: "ai/qwen3", sizeBytes: 1_000_000 },
      ],
      imageTransfer: {
        kind: "model",
        title: "Pull",
        reference: "ai/smollm2",
        status: "running",
        output: "Downloading 42%",
      },
    });
    render(<ModelsScreen store={store} />);

    expect(screen.getByTestId("model-pull-output")).toHaveTextContent("Downloading 42%");
    for (const button of screen.getAllByRole("button", { name: /Pull|Pulling/u })) {
      expect(button).toBeDisabled();
    }
  });

  it("does not show another screen's transfer", () => {
    // Image transfers and Compose actions share this slot. Before it was filtered by kind, an
    // image pull rendered its progress on Compose and vice versa.
    render(
      <ModelsScreen
        store={createStore({
          imageTransfer: {
            kind: "image",
            title: "Pull",
            reference: "nginx:latest",
            status: "running",
            output: "Downloading",
          },
        })}
      />,
    );
    expect(screen.queryByTestId("model-pull-output")).toBeNull();
  });
});
