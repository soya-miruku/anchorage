package core

import (
	"strings"
	"testing"
)

/*
The one destination in this core that comes from a subprocess rather than from the protocol.

`docker model status --json` reports two addresses — `endpoint`, reachable from inside a
container, and `endpointHost`, reachable from this machine — and they differ by design. A
conversation forwarded to the wrong one carries the operator's question and every tool result
with it, which is not a mistake that can be taken back, so the address is checked rather than
trusted.
*/
func TestRunnerEndpointAcceptsOnlyALocalAddress(t *testing.T) {
	for _, accepted := range []struct{ in, want string }{
		{"http://127.0.0.1:12434/v1/", "http://127.0.0.1:12434/v1"},
		{"http://localhost:12434/v1", "http://localhost:12434/v1"},
		{"https://127.0.0.1:12434/v1/", "https://127.0.0.1:12434/v1"},
	} {
		got, err := validateRunnerEndpoint(accepted.in)
		if err != nil {
			t.Fatalf("%q should be accepted, got %v", accepted.in, err)
		}
		if got != accepted.want {
			t.Fatalf("%q should normalise to %q, got %q", accepted.in, accepted.want, got)
		}
	}

	for _, refused := range []string{
		"",
		// The in-container address on a Linux engine. Reachable, and not this machine.
		"http://172.17.0.1:12434/v1/",
		"http://model-runner.example.com/v1/",
		"http://169.254.169.254/v1/",
		"file:///etc/passwd",
		"ftp://127.0.0.1/v1",
		"://not a url",
	} {
		if _, err := validateRunnerEndpoint(refused); err == nil {
			t.Fatalf("%q should be refused", refused)
		}
	}
}

func TestChatRefusesAConversationWithNoMessages(t *testing.T) {
	service := &Service{}
	_, err := service.modelsChat(t.Context(), ModelsChatParams{
		Context: "default", Model: "ai/smollm2:latest",
	})
	if err == nil || !strings.Contains(err.Error(), "at least one message") {
		t.Fatalf("an empty conversation should be refused before any network call, got %v", err)
	}
}

func TestChatRefusesAConversationLongerThanTheBound(t *testing.T) {
	messages := make([]ChatMessage, maxChatMessages+1)
	for index := range messages {
		messages[index] = ChatMessage{Role: "user", Content: "hello"}
	}
	service := &Service{}
	_, err := service.modelsChat(t.Context(), ModelsChatParams{
		Context: "default", Model: "ai/smollm2:latest", Messages: messages,
	})
	if err == nil || !strings.Contains(err.Error(), "at most") {
		t.Fatalf("an over-long conversation should be refused, got %v", err)
	}
}
