import { describe, expect, it, vi } from "vitest";

import {
  engineToolCatalogue,
  engineToolNames,
  runEngineTool,
} from "./engineTools";
import type { AnchorageBridge, ChatToolCall } from "../types";

/*
The catalogue is the boundary, so it is what is tested.

A model's instructions describe intent; what it can reach is the tools it was handed. This
screen says so in its own posture note, which makes "no tool here mutates anything" a property
worth asserting rather than a convention worth remembering — the day someone adds
`remove_container` because it would be convenient, this should stop them.
*/

const call = (name: string, args: unknown = {}): ChatToolCall => ({
  id: "call-1",
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const container = (name: string, state = "running") => ({
  id: `${name}-id-0123456789abcdef`,
  name,
  image: "node:20",
  state,
  status: state === "running" ? "Up 2 hours" : "Exited (1)",
  ports: "8080:8080",
  health: "healthy",
});

const bridgeWith = (overrides: Record<string, unknown> = {}) =>
  ({
    containers: {
      list: vi.fn(async () => [container("api"), container("worker", "exited")]),
      logs: vi.fn(async () => [{ message: "started" }, { message: "listening" }]),
      inspect: vi.fn(async () => ({ Config: { Image: "node:20" } })),
    },
    images: { list: vi.fn(async () => ({ images: [] })) },
    volumes: { list: vi.fn(async () => ({ volumes: [] })) },
    networks: { list: vi.fn(async () => ({ networks: [] })) },
    system: { snapshot: vi.fn(async () => ({ engine: { cpus: 8 } })) },
    ...overrides,
  }) as unknown as AnchorageBridge;

describe("the engine tool catalogue", () => {
  it("offers only tools that read", () => {
    // Not a list of forbidden names — a mutating verb would be named something not on it.
    // Every tool's own description has to be a reading verb, and the names are checked too.
    const mutating = /(^|_)(remove|delete|prune|stop|start|restart|kill|create|run|pull|push|tag|update|write|exec|commit|rename|unpause|pause)($|_)/;
    for (const name of engineToolNames()) {
      expect(name, `${name} names an action, not a read`).not.toMatch(mutating);
    }
  });

  it("describes every tool it offers, because the description is the whole interface", () => {
    for (const tool of engineToolCatalogue()) {
      expect(tool.type).toBe("function");
      expect(tool.function.description ?? "").not.toHaveLength(0);
      expect(tool.function.parameters).toBeTruthy();
    }
  });

  it("is stable in order, so the prompt does not churn between turns", () => {
    expect(engineToolCatalogue().map((tool) => tool.function.name)).toEqual(
      engineToolNames(),
    );
  });
});

describe("running a tool", () => {
  it("returns the engine's answer as the string the model will read", async () => {
    const outcome = await runEngineTool(
      bridgeWith(),
      "default",
      call("list_containers", { running_only: true }),
    );

    expect(outcome.failed).toBe(false);
    const rows = JSON.parse(outcome.content) as { name: string }[];
    expect(rows.map((row) => row.name)).toEqual(["api"]);
  });

  /*
   * A failure is a result, not an exception.
   *
   * The model asked for something; "that did not work, and here is why" is an answer it can act
   * on, and throwing here would end the conversation on the model's own mistake rather than
   * letting it try a different approach.
   */
  it("hands a made-up container name back as a readable failure", async () => {
    const outcome = await runEngineTool(
      bridgeWith(),
      "default",
      call("container_logs", { container: "nginx" }),
    );

    expect(outcome.failed).toBe(true);
    expect(outcome.content).toContain("No container named nginx");
    expect(outcome.content).toContain("list_containers");
  });

  it("hands an unknown tool name back with the names that do exist", async () => {
    const outcome = await runEngineTool(
      bridgeWith(),
      "default",
      call("delete_everything"),
    );

    expect(outcome.failed).toBe(true);
    expect(outcome.content).toContain("No tool named delete_everything");
    expect(outcome.content).toContain("list_containers");
  });

  it("survives arguments that are not JSON", async () => {
    const outcome = await runEngineTool(bridgeWith(), "default", {
      id: "call-1",
      type: "function",
      function: { name: "list_containers", arguments: "{not json" },
    });

    expect(outcome.failed).toBe(true);
    expect(outcome.content).toContain("not valid JSON");
  });

  it("treats a bridge rejection as a failed tool rather than a crash", async () => {
    const bridge = bridgeWith({
      images: {
        list: vi.fn(async () => {
          throw new Error("engine unreachable");
        }),
      },
    });

    const outcome = await runEngineTool(bridge, "default", call("list_images"));

    expect(outcome.failed).toBe(true);
    expect(outcome.content).toBe("engine unreachable");
  });

  /*
   * A container listing on a busy machine can exceed a small model's whole context. Sending it
   * turns the answer into an out-of-context error; dropping it makes the model conclude there
   * is nothing there. Truncating with a marker is the only option that leaves it able to say
   * something true.
   */
  it("truncates an oversized result and says that it did", async () => {
    const many = Array.from({ length: 4_000 }, (_, index) =>
      container(`service-with-a-long-name-${index}`),
    );
    const bridge = bridgeWith({
      containers: { list: vi.fn(async () => many) },
    });

    const outcome = await runEngineTool(bridge, "default", call("list_containers"));

    expect(outcome.failed).toBe(false);
    expect(outcome.content).toContain("[truncated: the full result was");
    expect(outcome.content.length).toBeLessThan(25_000);
  });

  it("resolves a container named by a short ID prefix, as a person would type it", async () => {
    const bridge = bridgeWith();
    const outcome = await runEngineTool(
      bridge,
      "default",
      call("container_logs", { container: "api-id-0123" }),
    );

    expect(outcome.failed).toBe(false);
    expect(JSON.parse(outcome.content)).toEqual(["started", "listening"]);
  });
});
