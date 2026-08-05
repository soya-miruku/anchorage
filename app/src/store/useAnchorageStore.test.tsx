// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAnchorageStore } from "./useAnchorageStore";
import { createFixtureCapabilities } from "../data/commandFixtures";
import type { HostAnchorageApi } from "../types";

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
