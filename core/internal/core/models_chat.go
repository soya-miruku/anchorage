package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

/*
Talking to a model that is already on this machine.

Docker Model Runner serves an OpenAI-compatible API. The renderer cannot reach it: the CSP is
`connect-src 'self'`, deliberately, so the only network this application performs is the
network the core performs. This is that proxy and nothing more — it forwards one completion
request and returns one answer. It runs no loop, keeps no history, and decides nothing about
tools; the caller owns the conversation, because the caller is the only party that knows what
the operator has actually seen and approved.

The endpoint is asked for rather than assumed. `docker model status --json` reports both an
`endpoint` (reachable from inside a container) and an `endpointHost` (reachable from this
machine), and which of the two is correct depends on where the runner is installed. Guessing
127.0.0.1:12434 is right on the common setup and silently wrong on the others.
*/

const (
	// A completion is a model thinking, not a request waiting on a socket. Small local models
	// answer in under a second; a large one on CPU can take minutes, and cutting it off at a
	// socket-shaped timeout would make the feature look broken rather than slow.
	modelsChatTimeout = 10 * time.Minute
	// Discovering the endpoint is a CLI call that either answers immediately or is not going to.
	modelsEndpointTimeout = 20 * time.Second
	// One answer. Bounded because an unbounded read from a local socket is still an unbounded
	// allocation, and no legitimate completion approaches this.
	modelsChatResponseLimit = 8 * 1024 * 1024
	// The whole conversation the caller is sending. Enough for a long session with tool output
	// in it; small enough that a runaway loop fails here rather than in the model's context.
	modelsChatRequestLimit = 4 * 1024 * 1024
	maxChatMessages        = 200
	maxChatTools           = 32
)

// modelRunnerEndpoint asks the plugin where its OpenAI-compatible API is listening.
//
// endpointHost is the one reachable from this machine. `endpoint` is the in-container address
// and is returned as well so a failure can say which was tried.
func (s *Service) modelRunnerEndpoint(parent context.Context, contextName string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, modelsEndpointTimeout)
	defer cancel()

	result, err := s.runDockerValidated(ctx, contextName,
		[]string{"model", "status", "--json"}, modelsOutputLimit)
	if err != nil {
		return "", err
	}
	if result.exitCode != 0 {
		stderr := strings.TrimSpace(string(result.stderr))
		if modelsUnavailable(stderr) {
			return "", modelsPluginError(stderr)
		}
		return "", opError("model_runner_unavailable",
			"Docker Model Runner did not report its status.", nil,
			map[string]any{"exitCode": result.exitCode, "stderr": stderr})
	}

	payload := strings.TrimSpace(string(result.stdout))
	if index := strings.IndexByte(payload, '{'); index > 0 {
		payload = payload[index:]
	}
	var status struct {
		Running      bool   `json:"running"`
		Endpoint     string `json:"endpoint"`
		EndpointHost string `json:"endpointHost"`
	}
	if err := json.Unmarshal([]byte(payload), &status); err != nil {
		return "", opError("model_runner_unreadable",
			"Docker Model Runner returned a status this build could not parse.", err,
			map[string]any{"bytes": len(payload)})
	}
	if !status.Running {
		return "", opError("model_runner_stopped",
			"Docker Model Runner is not running, so no model can answer.", nil, nil)
	}
	endpoint := strings.TrimSpace(status.EndpointHost)
	if endpoint == "" {
		endpoint = strings.TrimSpace(status.Endpoint)
	}
	return validateRunnerEndpoint(endpoint)
}

/*
validateRunnerEndpoint decides whether an address the plugin reported may be called.

Loopback only. The runner is a local service and this is the one place in the core where a
destination comes from a subprocess's output rather than from the protocol — `endpoint` is the
in-container address and is reported alongside `endpointHost` precisely because they differ, so
a value pointing off this machine means something upstream is wrong. Forwarding a conversation
there, tool results and all, is not a mistake that can be taken back.
*/
func validateRunnerEndpoint(endpoint string) (string, error) {
	if endpoint == "" {
		return "", opError("model_runner_unaddressable",
			"Docker Model Runner is running but reported no endpoint to reach it on.", nil, nil)
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", opError("model_runner_unaddressable",
			"Docker Model Runner reported an endpoint this build will not call.", err,
			map[string]any{"endpoint": endpoint})
	}
	if host := parsed.Hostname(); host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return "", opError("model_runner_unaddressable",
			"Docker Model Runner reported a non-local endpoint; this build only calls the runner on this machine.", nil,
			map[string]any{"endpoint": endpoint})
	}
	return strings.TrimSuffix(endpoint, "/"), nil
}

func (s *Service) modelsChat(parent context.Context, params ModelsChatParams) (ModelsChatResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ModelsChatResult{}, err
	}
	model := strings.TrimSpace(params.Model)
	if model == "" {
		return ModelsChatResult{}, opError("invalid_model",
			"A model reference is required to start a completion.", nil, nil)
	}
	if len(model) > 512 {
		return ModelsChatResult{}, opError("invalid_model",
			"A model reference must be 512 characters or fewer.", nil, nil)
	}
	if len(params.Messages) == 0 {
		return ModelsChatResult{}, opError("invalid_messages",
			"A completion needs at least one message.", nil, nil)
	}
	if len(params.Messages) > maxChatMessages {
		return ModelsChatResult{}, opError("invalid_messages",
			fmt.Sprintf("A conversation may carry at most %d messages.", maxChatMessages), nil,
			map[string]any{"messages": len(params.Messages), "maximum": maxChatMessages})
	}
	if len(params.Tools) > maxChatTools {
		return ModelsChatResult{}, opError("invalid_tools",
			fmt.Sprintf("At most %d tools may be offered.", maxChatTools), nil,
			map[string]any{"tools": len(params.Tools), "maximum": maxChatTools})
	}

	endpoint, err := s.modelRunnerEndpoint(parent, contextName)
	if err != nil {
		return ModelsChatResult{}, err
	}

	body := map[string]any{"model": model, "messages": params.Messages, "stream": false}
	if len(params.Tools) > 0 {
		body["tools"] = params.Tools
		body["tool_choice"] = "auto"
	}
	if params.Temperature != nil {
		body["temperature"] = *params.Temperature
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return ModelsChatResult{}, opError("invalid_messages",
			"The conversation could not be encoded for the model runner.", err, nil)
	}
	if len(encoded) > modelsChatRequestLimit {
		return ModelsChatResult{}, opError("invalid_messages",
			"The conversation is too large to send.", nil,
			map[string]any{"bytes": len(encoded), "maximum": modelsChatRequestLimit})
	}

	ctx, cancel := context.WithTimeout(parent, modelsChatTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		endpoint+"/chat/completions", bytes.NewReader(encoded))
	if err != nil {
		return ModelsChatResult{}, opError("model_chat_failed",
			"The completion request could not be built.", err, nil)
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := (&http.Client{Timeout: modelsChatTimeout}).Do(request)
	if err != nil {
		return ModelsChatResult{}, opError("model_chat_failed",
			"Docker Model Runner did not answer.", err, map[string]any{"endpoint": endpoint})
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, modelsChatResponseLimit))
	if err != nil {
		return ModelsChatResult{}, opError("model_chat_failed",
			"The model's answer could not be read.", err, nil)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ModelsChatResult{}, engineHTTPError("model_chat_rejected",
			"Docker Model Runner rejected the completion.", response.StatusCode, payload)
	}

	var completion struct {
		Choices []struct {
			FinishReason string          `json:"finish_reason"`
			Message      ChatMessage     `json:"message"`
			Index        int             `json:"index"`
			Raw          json.RawMessage `json:"-"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(payload, &completion); err != nil {
		return ModelsChatResult{}, opError("model_chat_unreadable",
			"Docker Model Runner returned a completion this build could not parse.", err,
			map[string]any{"bytes": len(payload)})
	}
	if len(completion.Choices) == 0 {
		return ModelsChatResult{}, opError("model_chat_empty",
			"Docker Model Runner returned no completion.", nil, nil)
	}

	choice := completion.Choices[0]
	// The role is not always echoed, and a message with no role is not a message the caller can
	// append to its own history.
	if strings.TrimSpace(choice.Message.Role) == "" {
		choice.Message.Role = "assistant"
	}
	if choice.Message.ToolCalls == nil {
		choice.Message.ToolCalls = []ChatToolCall{}
	}
	return ModelsChatResult{
		ProtocolVersion: ProtocolVersion,
		Context:         contextName,
		Model:           model,
		Message:         choice.Message,
		FinishReason:    choice.FinishReason,
		Usage: ChatUsage{
			PromptTokens:     completion.Usage.PromptTokens,
			CompletionTokens: completion.Usage.CompletionTokens,
			TotalTokens:      completion.Usage.TotalTokens,
		},
		ObservedAt: nowUTC(),
	}, nil
}
