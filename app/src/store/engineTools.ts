import type {
  AnchorageBridge,
  ChatTool,
  ChatToolCall,
} from "../types";

/*
What a model is allowed to ask this application to do.

Every tool here reads. None of them start, stop, remove, prune, pull, or write anything, and
that is a property of the catalogue rather than of the prompt. The Agents screen's own posture
note says an agent's instructions describe intent and not a boundary — what it can reach is the
tools granted to it — and a screen that says so while handing a model `docker rm` would be
arguing against itself. Adding a mutating tool here is a decision about what an unattended model
may do to this machine, not a feature.

The loop runs in the renderer. Every call goes through the same validated IPC the buttons use,
so a tool cannot reach anything a screen could not, and the core stays a proxy with no agent in
it. Running the loop in the core would mean a second path to the daemon that no screen is
watching and no receipt distinguishes from a human.
*/

/** A tool result, as the string the model will read. */
export interface ToolOutcome {
  callId: string;
  name: string;
  /** What the model sees. Errors are results too: "that failed, and here is why". */
  content: string;
  failed: boolean;
}

interface EngineTool {
  tool: ChatTool;
  run: (
    bridge: AnchorageBridge,
    context: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * How much of one tool's output a model may be given.
 *
 * A container listing on a busy machine is easily larger than a small model's whole context.
 * Truncating with a marker is better than either sending it (the answer becomes an out-of-
 * context error) or dropping it (the model concludes there is nothing there).
 */
const MAX_TOOL_OUTPUT = 24_000;

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asBoolean = (value: unknown): boolean => value === true;

const ENGINE_TOOLS: Record<string, EngineTool> = {
  list_containers: {
    tool: {
      type: "function",
      function: {
        name: "list_containers",
        description:
          "List containers on this Docker engine with their state, image, ports and health.",
        parameters: {
          type: "object",
          properties: {
            running_only: {
              type: "boolean",
              description: "Only containers that are currently running.",
            },
          },
          required: [],
        },
      },
    },
    run: async (bridge, context, args) => {
      const containers = await bridge.containers.list(context);
      const rows = asBoolean(args.running_only)
        ? containers.filter((container) => container.state === "running")
        : containers;
      return rows.map((container) => ({
        name: container.name,
        image: container.image,
        state: container.state,
        status: container.status,
        ports: container.ports,
        health: container.health,
      }));
    },
  },
  list_images: {
    tool: {
      type: "function",
      function: {
        name: "list_images",
        description: "List images held locally, with their size and whether anything uses them.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    run: async (bridge, context) => {
      const result = await bridge.images.list(context);
      return result.images.map((image) => ({
        reference: image.repoTags?.[0] ?? "<none>",
        id: image.id,
        size: image.sizeDisplay,
        usedByContainers: image.containers,
      }));
    },
  },
  list_volumes: {
    tool: {
      type: "function",
      function: {
        name: "list_volumes",
        description: "List volumes, with their driver and how many containers reference them.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    run: async (bridge, context) => {
      const result = await bridge.volumes.list(context);
      return result.volumes.map((volume) => ({
        name: volume.name,
        driver: volume.driver,
        refCount: volume.usage?.refCount,
        sizeBytes: volume.usage?.sizeBytes,
      }));
    },
  },
  list_networks: {
    tool: {
      type: "function",
      function: {
        name: "list_networks",
        description: "List networks, with their driver, scope and subnets.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    run: async (bridge, context) => {
      const result = await bridge.networks.list(context);
      return result.networks.map((network) => ({
        name: network.name,
        driver: network.driver,
        scope: network.scope,
        subnets: network.subnets,
        attached: network.containerCount < 0 ? "unknown" : network.containerCount,
      }));
    },
  },
  engine_info: {
    tool: {
      type: "function",
      function: {
        name: "engine_info",
        description:
          "Read the engine's own report: version, operating system, CPU and memory, and how many containers and images it holds.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    run: async (bridge, context) => {
      const snapshot = await bridge.system.snapshot(context, false);
      return {
        serverVersion: snapshot.engine?.serverVersion,
        apiVersion: snapshot.engine?.apiVersion,
        operatingSystem: snapshot.engine?.operatingSystem,
        architecture: snapshot.engine?.architecture,
        kernelVersion: snapshot.engine?.kernelVersion,
        cpus: snapshot.engine?.cpus,
        memoryBytes: snapshot.engine?.memoryBytes,
        containers: snapshot.engine?.containers,
        containersRunning: snapshot.engine?.containersRunning,
        images: snapshot.engine?.images,
        warnings: snapshot.engine?.warnings,
      };
    },
  },
  container_logs: {
    tool: {
      type: "function",
      function: {
        name: "container_logs",
        description:
          "Read the recent log output of one container. Use list_containers first to find its name.",
        parameters: {
          type: "object",
          properties: {
            container: {
              type: "string",
              description: "The container's name or ID.",
            },
          },
          required: ["container"],
        },
      },
    },
    run: async (bridge, context, args) => {
      const wanted = asString(args.container).trim();
      if (!wanted) throw new Error("container is required");
      // The model names a container the way a person would. Resolving here rather than passing
      // the string through means an invented name fails as "no such container" instead of as
      // an engine error the model then tries to reason about.
      const containers = await bridge.containers.list(context);
      const match = containers.find(
        (container) => container.name === wanted || container.id.startsWith(wanted),
      );
      if (!match) {
        throw new Error(
          `No container named ${wanted}. Call list_containers to see what is here.`,
        );
      }
      const lines = await bridge.containers.logs(match.id, context);
      return lines.slice(-200).map((line) => line.message);
    },
  },
  inspect_container: {
    tool: {
      type: "function",
      function: {
        name: "inspect_container",
        description:
          "Read one container's full configuration: mounts, environment keys, restart policy, network settings.",
        parameters: {
          type: "object",
          properties: {
            container: {
              type: "string",
              description: "The container's name or ID.",
            },
          },
          required: ["container"],
        },
      },
    },
    run: async (bridge, context, args) => {
      const wanted = asString(args.container).trim();
      if (!wanted) throw new Error("container is required");
      const containers = await bridge.containers.list(context);
      const match = containers.find(
        (container) => container.name === wanted || container.id.startsWith(wanted),
      );
      if (!match) {
        throw new Error(
          `No container named ${wanted}. Call list_containers to see what is here.`,
        );
      }
      return bridge.containers.inspect(match.id, context);
    },
  },
};

/** The tools offered to the model, in a stable order so the prompt does not churn. */
export const engineToolCatalogue = (): ChatTool[] =>
  Object.keys(ENGINE_TOOLS)
    .sort()
    .map((name) => ENGINE_TOOLS[name]!.tool);

/** Every tool name, for the UI to name what it granted. */
export const engineToolNames = (): string[] => Object.keys(ENGINE_TOOLS).sort();

/**
 * Run one tool call and produce the string the model will read next.
 *
 * A failure is returned rather than thrown. The model asked for something; "that did not work,
 * and here is why" is a usable answer and lets it try a different approach, whereas an
 * exception here would end the conversation on the model's mistake.
 */
export async function runEngineTool(
  bridge: AnchorageBridge,
  context: string,
  call: ChatToolCall,
): Promise<ToolOutcome> {
  const name = call.function.name;
  const entry = ENGINE_TOOLS[name];
  if (!entry) {
    return {
      callId: call.id,
      name,
      content: `No tool named ${name} is available. Available tools: ${engineToolNames().join(", ")}.`,
      failed: true,
    };
  }

  let args: Record<string, unknown> = {};
  const raw = call.function.arguments?.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      // A model can emit a bare array or string here. Anything that is not an object has no
      // named arguments in it, so it is treated as none rather than as a failure.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      return {
        callId: call.id,
        name,
        content: `The arguments were not valid JSON: ${raw.slice(0, 200)}`,
        failed: true,
      };
    }
  }

  try {
    const result = await entry.run(bridge, context, args);
    const encoded = JSON.stringify(result ?? null);
    return {
      callId: call.id,
      name,
      content:
        encoded.length > MAX_TOOL_OUTPUT
          ? `${encoded.slice(0, MAX_TOOL_OUTPUT)}\n[truncated: the full result was ${encoded.length} characters]`
          : encoded,
      failed: false,
    };
  } catch (reason) {
    return {
      callId: call.id,
      name,
      content: reason instanceof Error ? reason.message : "The tool failed.",
      failed: true,
    };
  }
}
