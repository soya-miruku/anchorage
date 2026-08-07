// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelChat } from "./ModelChat";
import type { AnchorageStore } from "../store/useAnchorageStore";

afterEach(cleanup);

const createStore = (overrides: Partial<AnchorageStore> = {}): AnchorageStore =>
  ({
    models: [{ reference: "ai/llama3.2:latest" }],
    chatModel: "ai/llama3.2:latest",
    setChatModel: vi.fn(),
    chatMessages: [],
    chatPending: false,
    chatError: null,
    chatToolsEnabled: true,
    setChatToolsEnabled: vi.fn(),
    chatActivity: [],
    sendChatMessage: vi.fn(async () => undefined),
    clearChat: vi.fn(),
    ...overrides,
  }) as unknown as AnchorageStore;

describe("ModelChat", () => {
  it("says there is nothing to talk to when no model is pulled", () => {
    render(<ModelChat store={createStore({ models: [] })} />);
    expect(screen.getByTestId("model-chat-no-models")).toHaveTextContent(
      "No model is pulled",
    );
  });

  it("will not send until a model is chosen", () => {
    render(<ModelChat store={createStore({ chatModel: null })} />);
    expect(screen.getByTestId("model-chat-input")).toBeDisabled();
    expect(screen.getByTestId("model-chat-send")).toBeDisabled();
  });

  it("sends the draft and clears the composer", () => {
    const store = createStore();
    render(<ModelChat store={store} />);

    fireEvent.change(screen.getByTestId("model-chat-input"), {
      target: { value: "what is running?" },
    });
    fireEvent.click(screen.getByTestId("model-chat-send"));

    expect(store.sendChatMessage).toHaveBeenCalledWith("what is running?");
    expect(screen.getByTestId("model-chat-input")).toHaveValue("");
  });

  /*
   * The system turn is not something the operator said. Rendering it as the first bubble of
   * every conversation would attribute this application's own instructions to them.
   */
  it("does not render the system turn", () => {
    render(
      <ModelChat
        store={createStore({
          chatMessages: [
            { role: "system", content: "You are answering questions about Docker." },
            { role: "user", content: "hello" },
          ],
        })}
      />,
    );

    expect(screen.getByTestId("model-chat-user")).toHaveTextContent("hello");
    expect(screen.queryByText(/You are answering questions/)).toBeNull();
  });

  /*
   * An assistant turn that only asks for tools carries no prose. The tool rows below it say
   * what happened; an empty bubble above them says nothing and reads as a failed reply.
   */
  it("draws no empty bubble for a turn that only asked for tools", () => {
    render(
      <ModelChat
        store={createStore({
          chatMessages: [
            { role: "user", content: "what is running?" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "list_containers", arguments: "{}" },
                },
              ],
            },
            { role: "tool", content: '[{"name":"api"}]', tool_call_id: "c1", name: "list_containers" },
            { role: "assistant", content: "One container: api." },
          ],
        })}
      />,
    );

    expect(screen.getAllByTestId("model-chat-assistant")).toHaveLength(1);
    expect(screen.getByTestId("model-chat-tool")).toHaveTextContent("list_containers");
  });

  /*
   * What the model was told is a thing the operator is entitled to read. Summarising the tool
   * result instead would make a wrong answer impossible to account for.
   */
  it("shows exactly what a tool returned, on request", () => {
    render(
      <ModelChat
        store={createStore({
          chatMessages: [
            {
              role: "tool",
              content: '[{"name":"api","state":"running"}]',
              tool_call_id: "c1",
              name: "list_containers",
            },
          ],
        })}
      />,
    );

    expect(screen.queryByText(/"state":"running"/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /list_containers/ }));
    expect(screen.getByText(/"state":"running"/)).toBeInTheDocument();
  });

  it("names the tools it is running rather than only saying it is busy", () => {
    render(
      <ModelChat
        store={createStore({
          chatPending: true,
          chatActivity: ["list_containers", "container_logs"],
        })}
      />,
    );

    expect(screen.getByTestId("model-chat-pending")).toHaveTextContent(
      "list_containers, container_logs",
    );
  });

  it("states the grant next to the switch that makes it", () => {
    render(<ModelChat store={createStore()} />);
    expect(screen.getByTestId("model-chat-tools").closest("label")).toHaveTextContent(
      "read-only",
    );
  });

  it("surfaces a failure instead of leaving the composer looking idle", () => {
    render(
      <ModelChat store={createStore({ chatError: "Docker Model Runner is not running" })} />,
    );
    expect(screen.getByTestId("model-chat-error")).toHaveTextContent("not running");
  });
});
