// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAnchorageStore } from "./useAnchorageStore";
import { createFixtureCapabilities } from "../data/commandFixtures";
import type { AnchorageContainer, HostAnchorageApi } from "../types";

const observedAt = "2026-08-02T12:00:00.000Z";

const listResult = (key: string, items: unknown[]) => ({
  context: "default",
  source: "engine-api",
  apiVersion: "1.55",
  [key]: items,
  observedAt,
  endpointHash: "endpoint",
  limitations: [],
});

/** The smallest host surface the store will boot against, with networks pluggable. */
const createHost = (
  listNetworks: () => Promise<unknown>,
): HostAnchorageApi =>
  ({
    system: {
      capabilities: async () => createFixtureCapabilities("default"),
      snapshot: vi.fn(async () => ({
        context: "default",
        source: "engine-api",
        apiVersion: "1.55",
        observedAt,
        info: {},
        version: {},
        diskUsage: null,
        limitations: [],
      })),
    },
    containers: {
      list: vi.fn(async () => listResult("containers", [])),
      action: vi.fn(),
      inspect: vi.fn(),
      stats: vi.fn(),
    },
    images: {
      list: vi.fn(async () => listResult("images", [])),
      action: vi.fn(),
    },
    volumes: {
      list: vi.fn(async () => listResult("volumes", [])),
      action: vi.fn(),
    },
    networks: {
      list: vi.fn(listNetworks),
      action: vi.fn(),
    },
    cli: {
      run: vi.fn(async () => ({
        stdout: { data: "", encoding: "utf-8" },
        stderr: { data: "", encoding: "utf-8" },
      })),
    },
    session: {
      start: vi.fn(async () => {
        throw new Error("PTY unavailable in test host");
      }),
      input: vi.fn(),
      resize: vi.fn(),
      signal: vi.fn(),
      cancel: vi.fn(),
      ack: vi.fn(),
    },
    subscribe: vi.fn(() => () => undefined),
  }) as unknown as HostAnchorageApi;

beforeEach(() => {
  delete window.anchorage;
});

afterEach(() => {
  cleanup();
  delete window.anchorage;
  vi.restoreAllMocks();
});

describe("refreshNetworks", () => {
  it("records a failed list as an error domain state instead of an empty list", async () => {
    window.anchorage = createHost(async () => {
      throw new Error("engine unreachable");
    });
    const { result } = renderHook(() => useAnchorageStore());

    await act(async () => {
      await expect(result.current.refreshNetworks()).rejects.toThrow(
        "engine unreachable",
      );
    });

    await waitFor(() => {
      expect(result.current.hostDomainState.networks).toEqual({
        status: "error",
        error: "engine unreachable",
      });
    });
    expect(result.current.networks).toEqual([]);
  });

  it("marks the domain ready when the list loads, even when it is empty", async () => {
    window.anchorage = createHost(async () => listResult("networks", []));
    const { result } = renderHook(() => useAnchorageStore());

    await act(async () => {
      await result.current.refreshNetworks();
    });

    await waitFor(() => {
      expect(result.current.hostDomainState.networks.status).toBe("ready");
    });
  });
});

/**
 * A slow inspect must not land under whichever image the panel has moved on to.
 *
 * The guard here was a ternary whose branches were identical — `current && current.imageId ===
 * image.imageId ? current : current` — so it discarded nothing, and the detail was applied
 * unconditionally. Clicking two images in quick succession on a busy daemon could therefore show
 * one image's name and identity above another's layers, size and platform, with nothing marking
 * the panel as mixed.
 */
const anImage = (imageId: string) =>
  ({
    repository: "registry.test/api",
    tag: imageId,
    id: imageId,
    imageId,
    reference: `registry.test/api:${imageId}`,
    identity: `registry.test/api:${imageId}`,
    created: observedAt,
    size: "10 MB",
    sizeMb: 10,
    usageKnown: true,
    inUse: false,
    reclaimable: true,
  }) as never;

const inspectShape = (imageId: string) => ({
  context: "default",
  image: { Id: imageId },
  history: [],
  observedAt,
});

describe("openImageDetail", () => {
  it("discards an inspect that lands after the panel moved to another image", async () => {
    const pending = new Map<string, (value: unknown) => void>();
    const host = createHost(async () => listResult("networks", []));
    (host as unknown as { images: Record<string, unknown> }).images.inspect = vi.fn(
      (request: { id: string }) =>
        new Promise((resolve) => pending.set(request.id, resolve)),
    );
    window.anchorage = host;
    const { result } = renderHook(() => useAnchorageStore());

    await act(async () => {
      void result.current.openImageDetail(anImage("first"));
    });
    await act(async () => {
      void result.current.openImageDetail(anImage("second"));
    });

    // The first inspect finally answers, long after the operator moved on.
    await act(async () => {
      pending.get("first")?.(inspectShape("first"));
      await Promise.resolve();
    });

    expect(result.current.selectedImage?.imageId).toBe("second");
    expect(result.current.imageDetail).toBeNull();

    // The one the panel is actually showing still lands.
    await act(async () => {
      pending.get("second")?.(inspectShape("second"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.imageDetail?.image).toEqual({ Id: "second" });
    });
  });
});

/**
 * A refused `docker top` has to become a reason the screen can show.
 *
 * The loader used to end `.catch(() => undefined)`, so a rejection left `processes` null with no
 * error beside it and the tab sat on "Reading container processes…" forever. The Engine answers
 * 409 for a container that is not running and the tab strip does not gate on state, so this is
 * an ordinary path.
 *
 * This asserts the store half specifically. The screen-level tests render a hand-written
 * `selectedDetailErrors`, so all three of them pass even when the store never writes one.
 */
const aContainer = (id: string) => ({
  Id: id,
  Names: [`/api-${id.slice(0, 4)}`],
  Image: "nginx:1.27",
  State: "exited",
  Status: "Exited (0) 2 minutes ago",
  Created: 1_760_000_000,
  Ports: [],
  Labels: {},
});

describe("read-only detail tabs", () => {
  for (const [tab, method, message] of [
    ["processes", "top", "Docker Engine rejected the process list request."],
    ["changes", "diff", "Docker Engine rejected the filesystem changes request."],
  ]) {
    it(`records why ${tab} could not be read`, async () => {
      const id = "b".repeat(64);
      const host = createHost(async () => listResult("networks", []));
      const containers = host as unknown as { containers: Record<string, unknown> };
      containers.containers.list = vi.fn(async () =>
        listResult("containers", [aContainer(id)]),
      );
      containers.containers[method] = vi.fn(async () => {
        throw new Error(message);
      });
      window.anchorage = host;
      const { result } = renderHook(() => useAnchorageStore());

      // The store loads containers itself on boot; there is no exposed refresh to drive.
      await waitFor(() => {
        expect(result.current.containers.length).toBe(1);
      });
      await act(async () => {
        result.current.setSelectedId(id);
        result.current.setDetailTab(tab as never);
      });

      await waitFor(() => {
        expect(result.current.selectedDetailErrors[tab as never]).toBe(message);
      });
    });
  }
});

/**
 * The same staleness applies to a failure, and the guard on that path was untested.
 *
 * The race test above resolves both inspects, so it never reaches the catch. A rejection landing
 * after the operator moved on would put one image's error message under another image's name —
 * the panel renders `imageDetailError` above the selected image's identity, so the reader is told
 * the wrong image failed.
 */
describe("openImageDetail failures", () => {
  it("discards a rejection that lands after the panel moved to another image", async () => {
    const pending = new Map<string, (reason: unknown) => void>();
    const host = createHost(async () => listResult("networks", []));
    (host as unknown as { images: Record<string, unknown> }).images.inspect = vi.fn(
      (request: { id: string }) =>
        new Promise((_resolve, reject) => pending.set(request.id, reject)),
    );
    window.anchorage = host;
    const { result } = renderHook(() => useAnchorageStore());

    await act(async () => {
      void result.current.openImageDetail(anImage("first"));
    });
    await act(async () => {
      void result.current.openImageDetail(anImage("second"));
    });

    await act(async () => {
      pending.get("first")?.(new Error("image inspect: no such image"));
      await Promise.resolve();
    });

    expect(result.current.selectedImage?.imageId).toBe("second");
    expect(result.current.imageDetailError).toBeNull();

    // The one on screen still reports its own failure.
    await act(async () => {
      pending.get("second")?.(new Error("second failed"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.imageDetailError).toBe("second failed");
    });
  });
});

/**
 * A bulk delete where some containers fail must say so.
 *
 * `deleteContainer` reports its own failure through `setError` and returns rather than throwing.
 * `runBulkContainerAction` collected failures from a `try/catch` around the call, so for deletes
 * the catch never fired and the "N of M failed" summary never appeared. Worse, every container
 * that removed cleanly afterwards called `setError(null)`, wiping the message left by one that
 * had not — delete five, two fail, and the UI reported nothing at all.
 */
describe("runBulkContainerAction delete", () => {
  const stopped = (id: string, name: string) =>
    ({
      id,
      name,
      image: "node:20",
      ports: "",
      state: "exited",
      rawState: "exited",
      status: "Exited (0) 1 hour ago",
      exitCode: 0,
      kind: "service",
      health: "none",
    }) as unknown as AnchorageContainer;

  const rows = [stopped("a1", "alpha"), stopped("b2", "bravo"), stopped("c3", "charlie")];

  it("reports the containers that failed even when a later one succeeds", async () => {
    const host = createHost(async () => listResult("networks", [])) as
      HostAnchorageApi & { containers: { list: unknown; action: unknown } };
    // The list is stateful: deleteContainer re-lists to confirm the row is gone, so a static
    // list would fail reconciliation for the successes too and prove nothing about the summary.
    const present = new Set(rows.map((row) => row.id));
    host.containers.list = vi.fn(async () =>
      listResult("containers", rows.filter((row) => present.has(row.id))),
    );
    // bravo fails; charlie is deleted afterwards and used to clear the banner.
    host.containers.action = vi.fn(async ({ id }: { id: string }) => {
      if (id === "b2") throw new Error("device or resource busy");
      present.delete(id);
      return { ok: true };
    });
    window.anchorage = host;

    const { result } = renderHook(() => useAnchorageStore());
    await waitFor(() => expect(result.current.containers).toHaveLength(3));

    act(() => result.current.setContainerSelection(["a1", "b2", "c3"]));
    await act(async () => {
      await result.current.runBulkContainerAction("delete");
    });

    await waitFor(() => {
      expect(result.current.error).toContain("1 of 3 failed");
    });
    expect(result.current.error).toContain("bravo");
    expect(result.current.error).toContain("device or resource busy");
  });

  it("leaves no error when every delete succeeds", async () => {
    const host = createHost(async () => listResult("networks", [])) as
      HostAnchorageApi & { containers: { list: unknown; action: unknown } };
    const present = new Set(rows.map((row) => row.id));
    host.containers.list = vi.fn(async () =>
      listResult("containers", rows.filter((row) => present.has(row.id))),
    );
    host.containers.action = vi.fn(async ({ id }: { id: string }) => {
      present.delete(id);
      return { ok: true };
    });
    window.anchorage = host;

    const { result } = renderHook(() => useAnchorageStore());
    await waitFor(() => expect(result.current.containers).toHaveLength(3));

    act(() => result.current.setContainerSelection(["a1", "b2", "c3"]));
    await act(async () => {
      await result.current.runBulkContainerAction("delete");
    });

    expect(result.current.error).toBeNull();
  });
});

/**
 * A prune must report the daemon's own reclaim figure.
 *
 * `cleanUpImages` awaited `images.action` and discarded the result, so a prune finished in
 * silence — the list just had fewer rows. The number cannot be recovered on this side either:
 * summing the sizes of the removed images counts every shared layer once per image that
 * referenced it, and Docker already computes the real total in `SpaceReclaimed`.
 */
describe("cleanUpImages", () => {
  /** The core's projection shape, not the store's — the store derives its rows from this. */
  const dangling = (id: string) => ({
    id,
    repoTags: [] as string[],
    created: "2026-08-01T00:00:00.000Z",
    sizeBytes: 200_000_000,
    containers: 0,
  });

  it("surfaces the reclaimed bytes the daemon reported", async () => {
    const host = createHost(async () => listResult("networks", [])) as
      HostAnchorageApi & { images: { list: unknown; action: unknown } };
    let pruned = false;
    host.images.list = vi.fn(async () =>
      listResult("images", pruned ? [] : [dangling("sha256:a")]),
    );
    host.images.action = vi.fn(async () => {
      pruned = true;
      return {
        action: "prune",
        receipt: {},
        prune: {
          // Two layers shared between the images: 400 MB listed, 220 MB actually freed.
          imagesDeleted: [{ deleted: "sha256:a" }, { untagged: "old:1" }],
          spaceReclaimedBytes: 220_000_000,
        },
      };
    });
    window.anchorage = host;

    const { result } = renderHook(() => useAnchorageStore());
    await waitFor(() => expect(result.current.images).toHaveLength(1));

    await act(async () => {
      await result.current.cleanUpImages("dangling");
    });

    await waitFor(() => {
      expect(result.current.imagePruneResult).toEqual({
        removed: 1,
        untagged: 1,
        spaceReclaimedBytes: 220_000_000,
      });
    });
  });
});

/**
 * A tag whose list refresh failed is not a clean tag.
 *
 * `tagImage` awaited one `Promise.allSettled` and then cleared the banner unconditionally, so a
 * rejected refresh was discarded: the daemon had the new reference, the table still showed the
 * old one, and the UI reported success. Every other mutation in the store surfaces that gap.
 */
describe("tagImage", () => {
  it("reports a reconciliation failure instead of clearing the banner", async () => {
    const host = createHost(async () => listResult("networks", [])) as
      HostAnchorageApi & { images: { list: unknown; action: unknown } };
    let tagged = false;
    host.images.list = vi.fn(async () => {
      if (tagged) throw new Error("engine went away");
      return listResult("images", [
        {
          id: "sha256:a",
          repoTags: ["app:1"],
          created: "2026-08-01T00:00:00.000Z",
          sizeBytes: 200_000_000,
          containers: 0,
        },
      ]);
    });
    host.images.action = vi.fn(async () => {
      tagged = true;
      return { action: "tag", receipt: {} };
    });
    window.anchorage = host;

    const { result } = renderHook(() => useAnchorageStore());
    await waitFor(() => expect(result.current.images).toHaveLength(1));
    const image = result.current.images[0]!;

    await act(async () => {
      await result.current.tagImage(image, "app:2");
    });

    await waitFor(() => {
      expect(result.current.error).toContain("engine went away");
    });
  });
});

/**
 * The network list's caveat has to reach a reader.
 *
 * The core reports when the Docker API version it is talking to cannot say how many containers
 * are attached, which is why the Attached column shows "Unknown" for those rows. The store read
 * that off the wire and dropped it, so the explanation existed in the protocol and nowhere on
 * screen. It also used to name a remedy — "open a network to inspect them" — for a
 * networks.inspect verb that does not exist.
 */
describe("refreshNetworks limitations", () => {
  it("keeps the caveat the core sent instead of discarding it", async () => {
    window.anchorage = createHost(async () => ({
      ...listResult("networks", []),
      limitations: ["The Attached count is unknown for some networks."],
    }));
    const { result } = renderHook(() => useAnchorageStore());

    await act(async () => {
      await result.current.refreshNetworks();
    });

    await waitFor(() => {
      expect(result.current.networkLimitations).toEqual([
        "The Attached count is unknown for some networks.",
      ]);
    });
  });

  it("clears the caveat when the list fails, so it cannot outlive its subject", async () => {
    let failing = false;
    window.anchorage = createHost(async () => {
      if (failing) throw new Error("engine unreachable");
      return {
        ...listResult("networks", []),
        limitations: ["The Attached count is unknown for some networks."],
      };
    });
    const { result } = renderHook(() => useAnchorageStore());
    await act(async () => {
      await result.current.refreshNetworks();
    });
    await waitFor(() => expect(result.current.networkLimitations).toHaveLength(1));

    failing = true;
    await act(async () => {
      await expect(result.current.refreshNetworks()).rejects.toThrow();
    });

    await waitFor(() => expect(result.current.networkLimitations).toEqual([]));
  });
});

/**
 * The tool loop: the model asks, the renderer reads, the model answers.
 *
 * `models.chat` is a proxy with no memory — the whole conversation is sent each turn — so the
 * loop lives here, and it is what makes the transcript on screen and the transcript the model
 * saw the same object. A second history kept in the core could drift from what the operator
 * can read, and a wrong answer would then be unaccountable.
 */
describe("sendChatMessage", () => {
  const chatHost = (chat: (request: unknown) => Promise<unknown>) => {
    const host = createHost(async () => listResult("networks", [])) as
      HostAnchorageApi & {
        containers: { list: unknown };
        models: { list: unknown; chat: unknown; search: unknown };
      };
    host.containers.list = vi.fn(async () =>
      listResult("containers", [
        {
          id: "a1b2c3d4e5f6",
          name: "api",
          image: "node:20",
          state: "running",
          status: "Up 2 hours",
          ports: [],
        },
      ]),
    );
    host.models = { list: vi.fn(), chat: vi.fn(chat), search: vi.fn() };
    return host;
  };

  it("runs the tool the model asked for and sends the result back", async () => {
    const turns: unknown[] = [];
    window.anchorage = chatHost(async (request) => {
      turns.push(request);
      if (turns.length === 1) {
        return {
          protocolVersion: "1",
          context: "default",
          model: "m",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "list_containers", arguments: "{}" },
              },
            ],
          },
          finishReason: "tool_calls",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          observedAt,
        };
      }
      return {
        protocolVersion: "1",
        context: "default",
        model: "m",
        message: { role: "assistant", content: "One container is running: api." },
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        observedAt,
      };
    });

    const { result } = renderHook(() => useAnchorageStore());
    act(() => result.current.setChatModel("m"));
    await act(async () => {
      await result.current.sendChatMessage("what is running?");
    });

    expect(turns).toHaveLength(2);
    const transcript = result.current.chatMessages;
    // system, user, assistant-asking, tool-result, assistant-answering.
    expect(transcript.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(transcript.at(-1)?.content).toContain("api");
    // The tool result the model saw is the one on screen, not a summary of it.
    expect(transcript[3]?.content).toContain("api");
    expect(transcript[3]?.tool_call_id).toBe("call-1");
  });

  it("stops a model that only ever calls tools, and says so", async () => {
    let calls = 0;
    window.anchorage = chatHost(async () => {
      calls += 1;
      return {
        protocolVersion: "1",
        context: "default",
        model: "m",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `call-${calls}`,
              type: "function",
              function: { name: "list_containers", arguments: "{}" },
            },
          ],
        },
        finishReason: "tool_calls",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        observedAt,
      };
    });

    const { result } = renderHook(() => useAnchorageStore());
    act(() => result.current.setChatModel("m"));
    await act(async () => {
      await result.current.sendChatMessage("loop forever");
    });

    expect(calls).toBe(6);
    expect(result.current.chatError).toContain("without answering");
    expect(result.current.chatPending).toBe(false);
  });

  it("offers no tools at all when the grant is switched off", async () => {
    let received: { tools?: unknown } = {};
    window.anchorage = chatHost(async (request) => {
      received = request as { tools?: unknown };
      return {
        protocolVersion: "1",
        context: "default",
        model: "m",
        message: { role: "assistant", content: "Nothing to read." },
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        observedAt,
      };
    });

    const { result } = renderHook(() => useAnchorageStore());
    act(() => {
      result.current.setChatModel("m");
      result.current.setChatToolsEnabled(false);
    });
    await act(async () => {
      await result.current.sendChatMessage("hello");
    });

    expect(received.tools).toBeUndefined();
  });

  it("reports a refusal from the runner instead of leaving the composer spinning", async () => {
    window.anchorage = chatHost(async () => {
      throw new Error("Docker Model Runner is not running");
    });

    const { result } = renderHook(() => useAnchorageStore());
    act(() => result.current.setChatModel("m"));
    await act(async () => {
      await result.current.sendChatMessage("hello");
    });

    expect(result.current.chatError).toContain("not running");
    expect(result.current.chatPending).toBe(false);
  });
});
