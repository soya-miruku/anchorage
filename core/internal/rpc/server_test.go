package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	coreapi "anchorage/core/internal/core"
)

// handlerFunc adapts a function to the Handler interface.
type handlerFunc func(context.Context, string, json.RawMessage, coreapi.EventEmitter) (any, error)

func (f handlerFunc) Handle(ctx context.Context, method string, params json.RawMessage, emit coreapi.EventEmitter) (any, error) {
	return f(ctx, method, params, emit)
}

// syncBuffer is a bytes.Buffer safe for the server's concurrent writes.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

type testHandler struct{}

func (testHandler) Handle(_ context.Context, method string, _ json.RawMessage, emit coreapi.EventEmitter) (any, error) {
	if method == "emit" {
		emit("fixture.event", map[string]any{"ok": true})
		return map[string]any{"done": true}, nil
	}
	if method == "fail" {
		return nil, &coreapi.OpError{Code: "fixture_error", Message: "fixture failed"}
	}
	return map[string]any{"method": method}, nil
}

func TestServerWritesResponsesErrorsAndEventsAsJSONLines(t *testing.T) {
	input := strings.NewReader(
		"{\"id\":\"one\",\"method\":\"emit\",\"params\":{}}\n" +
			"{\"id\":2,\"method\":\"fail\",\"params\":{}}\n",
	)
	var output bytes.Buffer
	server := NewServer(testHandler{}, input, &output)
	if err := server.Serve(context.Background()); err != nil {
		t.Fatalf("serve: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected event and two responses, got %d: %s", len(lines), output.String())
	}
	var sawEvent, sawResult, sawError bool
	for _, line := range lines {
		var message map[string]any
		if err := json.Unmarshal([]byte(line), &message); err != nil {
			t.Fatalf("invalid JSON line %q: %v", line, err)
		}
		if message["event"] == "fixture.event" {
			sawEvent = true
		}
		if message["id"] == "one" && message["result"] != nil {
			sawResult = true
		}
		if message["id"] == float64(2) && message["error"] != nil {
			sawError = true
		}
	}
	if !sawEvent || !sawResult || !sawError {
		t.Fatalf("missing envelope: event=%v result=%v error=%v output=%s", sawEvent, sawResult, sawError, output.String())
	}
}

func TestServerRejectsMalformedUnknownAndInvalidIDs(t *testing.T) {
	input := strings.NewReader(
		"{not-json}\n" +
			"{\"id\":null,\"method\":\"health\"}\n" +
			"{\"id\":\"ok\",\"method\":\"health\",\"extra\":true}\n",
	)
	var output bytes.Buffer
	server := NewServer(testHandler{}, input, &output)
	if err := server.Serve(context.Background()); err != nil {
		t.Fatalf("serve: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected three errors, got %d: %s", len(lines), output.String())
	}
	for _, line := range lines {
		if !strings.Contains(line, `"code":"invalid_request"`) {
			t.Fatalf("expected invalid_request: %s", line)
		}
	}
}

// A request the client has abandoned used to run to completion in the core, holding a
// goroutine, an Engine connection and any docker subprocess it had started. request.cancel
// gives the client a way to reclaim that.
func TestRequestCancelStopsAnInFlightRequest(t *testing.T) {
	started := make(chan struct{})
	observed := make(chan error, 1)
	handler := handlerFunc(func(ctx context.Context, method string, _ json.RawMessage, _ coreapi.EventEmitter) (any, error) {
		if method != "slow" {
			return map[string]any{"ok": true}, nil
		}
		close(started)
		<-ctx.Done()
		observed <- ctx.Err()
		return nil, ctx.Err()
	})

	input, inputWriter := io.Pipe()
	var output syncBuffer
	server := NewServer(handler, input, &output)
	done := make(chan error, 1)
	go func() { done <- server.Serve(context.Background()) }()

	if _, err := inputWriter.Write([]byte(`{"id":"1","method":"slow"}` + "\n")); err != nil {
		t.Fatalf("write slow request: %v", err)
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("handler never started")
	}

	// targetId carries the same JSON value as the original request id, which is exactly what
	// the Electron client sends when its own IPC timeout fires.
	if _, err := inputWriter.Write([]byte(`{"id":"2","method":"request.cancel","params":{"targetId":"1"}}` + "\n")); err != nil {
		t.Fatalf("write cancel: %v", err)
	}

	select {
	case err := <-observed:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected the in-flight request context to be canceled, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("request.cancel did not reach the in-flight request")
	}

	_ = inputWriter.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop")
	}
}

// A session must outlive the request that created it. Once requests became individually
// cancellable, session.start inheriting the request context tore every session down the
// instant the start call returned — logs, exec, image pull, Command Center and the docker
// events stream all died immediately. Only a 30-minute soak caught it, so it is pinned here.
func TestSessionContextSurvivesTheStartRequest(t *testing.T) {
	observed := make(chan context.Context, 1)
	handler := handlerFunc(func(ctx context.Context, method string, _ json.RawMessage, _ coreapi.EventEmitter) (any, error) {
		if method == "session.start" {
			// Mirror the service: sessions detach from the request context.
			observed <- context.WithoutCancel(ctx)
		}
		return map[string]any{"ok": true}, nil
	})

	input, inputWriter := io.Pipe()
	var output syncBuffer
	server := NewServer(handler, input, &output)
	done := make(chan error, 1)
	go func() { done <- server.Serve(context.Background()) }()

	if _, err := inputWriter.Write([]byte(`{"id":"1","method":"session.start"}` + "\n")); err != nil {
		t.Fatalf("write session.start: %v", err)
	}

	var sessionCtx context.Context
	select {
	case sessionCtx = <-observed:
	case <-time.After(5 * time.Second):
		t.Fatal("handler never ran")
	}

	// The request has completed and its context is cancelled; the session's must not be.
	select {
	case <-sessionCtx.Done():
		t.Fatal("session context was cancelled when its start request completed")
	case <-time.After(250 * time.Millisecond):
	}

	_ = inputWriter.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop")
	}
}
