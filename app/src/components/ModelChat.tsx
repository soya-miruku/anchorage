import { useEffect, useRef, useState } from "react";

import { engineToolNames } from "../store/engineTools";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { ChatMessage } from "../types";

/*
Chatting with a model that is already on this machine.

The transcript on screen is the transcript the model sees. `models.chat` keeps no history —
the whole conversation is sent each turn — so there is no second copy anywhere that could
drift from what is rendered here, including the tool results. That is the reason a tool
result is shown rather than summarised: what the model was told is a thing the operator is
entitled to read, and hiding it would make a wrong answer impossible to account for.

The system turn is not rendered. It is not something the operator said, and showing it as the
first bubble of every conversation reads as a message from them.
*/

/** A row the transcript will actually draw. */
function isVisible(message: ChatMessage): boolean {
  if (message.role === "system") return false;
  // An assistant turn that only asks for tools has no prose in it. The tool rows below say
  // what happened; an empty bubble above them would say nothing.
  if (message.role === "assistant" && !message.content.trim()) return false;
  return true;
}

function ToolRow({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="model-chat__tool" data-testid="model-chat-tool">
      <button
        type="button"
        className="model-chat__tool-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="model-chat__tool-name">{message.name ?? "tool"}</span>
        <span className="model-chat__tool-hint">
          {open ? "Hide what it read" : "Show what it read"}
        </span>
      </button>
      {open && <pre className="model-chat__tool-body">{message.content}</pre>}
    </li>
  );
}

export function ModelChat({ store }: { store: AnchorageStore }) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const visible = store.chatMessages.filter(isVisible);

  // Follow the conversation as it grows. A tool round can add several rows at once, so this
  // keys on the count rather than on the last message.
  useEffect(() => {
    // Guarded because scrolling is a nicety and not every environment implements it — jsdom
    // does not, and a transcript that throws rather than fails to scroll is a worse trade.
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [visible.length, store.chatPending]);

  const models = store.models;
  const ready = store.chatModel !== null && !store.chatPending;

  if (models.length === 0) {
    return (
      <p className="models-empty" data-testid="model-chat-no-models">
        No model is pulled, so there is nothing here to talk to. Pull one on the
        Models screen — a small one answers on a CPU in about a second.
      </p>
    );
  }

  return (
    <div className="model-chat" data-testid="model-chat">
      <div className="model-chat__bar">
        <label className="model-chat__picker">
          <span>Model</span>
          <select
            data-testid="model-chat-model"
            value={store.chatModel ?? ""}
            onChange={(event) => store.setChatModel(event.currentTarget.value || null)}
          >
            <option value="">Choose a model…</option>
            {models.map((model) => (
              <option key={model.reference} value={model.reference}>
                {model.reference}
              </option>
            ))}
          </select>
        </label>
        <label className="model-chat__tools-toggle">
          <input
            type="checkbox"
            data-testid="model-chat-tools"
            checked={store.chatToolsEnabled}
            onChange={(event) => store.setChatToolsEnabled(event.currentTarget.checked)}
          />
          <span>
            Let it read this engine
            <em>
              {" "}
              — {engineToolNames().length} read-only tools: listing and inspecting
              containers, images, volumes and networks, and reading logs. Nothing here
              can change anything.
            </em>
          </span>
        </label>
        {store.chatMessages.length > 0 && (
          <button
            type="button"
            className="ghost-button"
            data-testid="model-chat-clear"
            onClick={store.clearChat}
          >
            Clear
          </button>
        )}
      </div>

      <ol className="model-chat__transcript" data-testid="model-chat-transcript">
        {visible.length === 0 && (
          <li className="model-chat__empty">
            Ask it something about this engine — &ldquo;what is running?&rdquo;,
            &ldquo;why did that container exit?&rdquo;, &ldquo;what is taking up
            space?&rdquo;
          </li>
        )}
        {visible.map((message, index) =>
          message.role === "tool" ? (
            <ToolRow key={`${message.tool_call_id ?? index}`} message={message} />
          ) : (
            <li
              key={`${message.role}-${index}`}
              className={`model-chat__turn model-chat__turn--${message.role}`}
              data-testid={`model-chat-${message.role}`}
            >
              {message.content}
            </li>
          ),
        )}
        {store.chatPending && (
          <li className="model-chat__pending" role="status" data-testid="model-chat-pending">
            {store.chatActivity.length > 0
              ? `Reading the engine: ${store.chatActivity.join(", ")}…`
              : "Thinking…"}
          </li>
        )}
        <div ref={endRef} />
      </ol>

      {store.chatError && (
        <p className="capability-error" role="alert" data-testid="model-chat-error">
          {store.chatError}
        </p>
      )}

      <form
        className="model-chat__composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          const text = draft;
          setDraft("");
          void store.sendChatMessage(text);
        }}
      >
        <textarea
          data-testid="model-chat-input"
          value={draft}
          rows={2}
          placeholder={
            store.chatModel
              ? "Ask about this engine…"
              : "Choose a model first"
          }
          disabled={store.chatModel === null}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line. A textarea rather than an input
            // because a question about a log line is often several lines long.
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            if (!ready || !draft.trim()) return;
            const text = draft;
            setDraft("");
            void store.sendChatMessage(text);
          }}
        />
        <button
          type="submit"
          className="primary-button"
          data-testid="model-chat-send"
          disabled={!ready || !draft.trim()}
        >
          {store.chatPending ? "Working…" : "Send"}
        </button>
      </form>
    </div>
  );
}
