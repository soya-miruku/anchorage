package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type recordedSessionEvent struct {
	name    string
	payload any
}

type sessionEventRecorder struct {
	channel chan recordedSessionEvent
	mu      sync.Mutex
	all     []recordedSessionEvent
}

func newSessionEventRecorder() *sessionEventRecorder {
	return &sessionEventRecorder{channel: make(chan recordedSessionEvent, 256)}
}

func (r *sessionEventRecorder) emit(name string, payload any) {
	event := recordedSessionEvent{name: name, payload: payload}
	r.mu.Lock()
	r.all = append(r.all, event)
	r.mu.Unlock()
	r.channel <- event
}

func (r *sessionEventRecorder) wait(t *testing.T, name string) any {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-r.channel:
			if event.name == "session.error" {
				t.Fatalf("unexpected session error: %#v", event.payload)
			}
			if event.name == name {
				return event.payload
			}
		case <-timer.C:
			r.mu.Lock()
			all := append([]recordedSessionEvent{}, r.all...)
			r.mu.Unlock()
			t.Fatalf("timed out waiting for %s; events=%#v", name, all)
		}
	}
}

func (r *sessionEventRecorder) next(t *testing.T) recordedSessionEvent {
	t.Helper()
	select {
	case event := <-r.channel:
		if event.name == "session.error" {
			t.Fatalf("unexpected session error: %#v", event.payload)
		}
		return event
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for session event")
		return recordedSessionEvent{}
	}
}

func (r *sessionEventRecorder) assertNoOutput(t *testing.T, duration time.Duration) {
	t.Helper()
	timer := time.NewTimer(duration)
	defer timer.Stop()
	for {
		select {
		case event := <-r.channel:
			if event.name == "session.output" {
				t.Fatalf("received output without an acknowledgement: %#v", event.payload)
			}
			if event.name == "session.error" {
				t.Fatalf("unexpected session error: %#v", event.payload)
			}
		case <-timer.C:
			return
		}
	}
}

func TestPipeSessionSeparatesStreamsSequencesOutputAndReportsExit(t *testing.T) {
	service := newSessionTestService(t)
	recorder := newSessionEventRecorder()
	started, err := service.sessions.start(context.Background(), SessionStartParams{
		Context: "default", Argv: []string{"session-separate"}, Mode: "pipes",
		Cwd: filepath.Dir(service.docker.binary.RealPath),
	}, recorder.emit)
	if err != nil {
		t.Fatalf("start pipe session: %v", err)
	}
	cleanupSession(t, service, started.SessionID)
	startedEvent := recorder.wait(t, "session.started").(SessionStartedEvent)
	if startedEvent.SessionID != started.SessionID || startedEvent.State != "running" {
		t.Fatalf("unexpected started event: %#v", startedEvent)
	}

	outputs := make([]SessionOutputEvent, 0, 2)
	for len(outputs) < 2 {
		outputs = append(outputs, recorder.wait(t, "session.output").(SessionOutputEvent))
	}
	if outputs[0].Sequence != 1 || outputs[1].Sequence != 2 {
		t.Fatalf("output sequence is not ordered: %#v", outputs)
	}
	streamData := map[string]string{}
	for _, output := range outputs {
		streamData[output.Stream] += output.Data
		if _, err := service.sessions.ack(SessionAckParams{
			SessionID: started.SessionID, ThroughSequence: output.Sequence,
		}); err != nil {
			t.Fatalf("ack output: %v", err)
		}
	}
	if streamData["stdout"] != "stdout-data" || streamData["stderr"] != "stderr-data" {
		t.Fatalf("stdout/stderr separation failed: %#v", streamData)
	}
	exited := recorder.wait(t, "session.exited").(SessionExitedEvent)
	if exited.ExitCode != 7 || exited.Signal != "" || exited.Canceled || exited.TimedOut {
		t.Fatalf("unexpected exit event: %#v", exited)
	}
	if exited.Output.LastSequence != 2 || exited.Output.StdoutBytes != 11 || exited.Output.StderrBytes != 11 {
		t.Fatalf("unexpected exit output summary: %#v", exited.Output)
	}
}

func TestLiteralTargetSessionDoesNotInjectContextAndAllowsDockerTargetEnvironment(t *testing.T) {
	service := newSessionTestService(t)
	recorder := newSessionEventRecorder()
	started, err := service.sessions.start(context.Background(), SessionStartParams{
		Context:    "default",
		TargetMode: "literal",
		Argv:       []string{"session-separate"},
		Mode:       "pipes",
		Cwd:        filepath.Dir(service.docker.binary.RealPath),
		Env:        map[string]string{"DOCKER_HOST": "unix:///tmp/literal.sock"},
	}, recorder.emit)
	if err != nil {
		t.Fatalf("start literal target session: %v", err)
	}
	cleanupSession(t, service, started.SessionID)
	if got := strings.Join(started.Argv, " "); got != "session-separate" {
		t.Fatalf("literal target session injected a context: %q", got)
	}
	if started.TargetMode != "literal" {
		t.Fatalf("literal target mode was not explicit in the start result: %#v", started)
	}
	_ = recorder.wait(t, "session.started")
	for {
		event := recorder.wait(t, "session.output").(SessionOutputEvent)
		_, _ = service.sessions.ack(SessionAckParams{
			SessionID: started.SessionID, ThroughSequence: event.Sequence,
		})
		if event.Stream == "stderr" {
			continue
		}
		break
	}
	exited := recorder.wait(t, "session.exited").(SessionExitedEvent)
	if exited.ExitCode != 7 {
		t.Fatalf("literal target session did not execute exact argv: %#v", exited)
	}
}

func TestPipeSessionInputAndEOF(t *testing.T) {
	service := newSessionTestService(t)
	recorder := newSessionEventRecorder()
	started, err := service.sessions.start(context.Background(), SessionStartParams{
		Context: "default", Argv: []string{"session-input"}, Mode: "pipes",
		Cwd: filepath.Dir(service.docker.binary.RealPath),
	}, recorder.emit)
	if err != nil {
		t.Fatalf("start input session: %v", err)
	}
	cleanupSession(t, service, started.SessionID)
	_ = recorder.wait(t, "session.started")
	input, err := service.sessions.input(SessionInputParams{
		SessionID: started.SessionID, Data: "hello\n", Encoding: "utf-8", EOF: true,
	})
	if err != nil {
		t.Fatalf("write session input: %v", err)
	}
	if input.AcceptedBytes != 6 || !input.EOF {
		t.Fatalf("unexpected input receipt: %#v", input)
	}
	output := recorder.wait(t, "session.output").(SessionOutputEvent)
	if output.Stream != "stdout" || output.Data != "input:hello" {
		t.Fatalf("unexpected input response: %#v", output)
	}
	_, _ = service.sessions.ack(SessionAckParams{SessionID: started.SessionID, ThroughSequence: output.Sequence})
	exited := recorder.wait(t, "session.exited").(SessionExitedEvent)
	if exited.ExitCode != 0 {
		t.Fatalf("input session failed: %#v", exited)
	}
}

func TestSessionOutputWindowAppliesAckBackpressure(t *testing.T) {
	service := newSessionTestService(t)
	recorder := newSessionEventRecorder()
	started, err := service.sessions.start(context.Background(), SessionStartParams{
		Context: "default", Argv: []string{"session-stream"}, Mode: "pipes",
		Cwd: filepath.Dir(service.docker.binary.RealPath), OutputWindowBytes: 1024,
	}, recorder.emit)
	if err != nil {
		t.Fatalf("start stream session: %v", err)
	}
	cleanupSession(t, service, started.SessionID)
	_ = recorder.wait(t, "session.started")
	windowBytes := 0
	var firstWindowLast uint64
	idle := time.NewTimer(150 * time.Millisecond)
collectFirstWindow:
	for {
		select {
		case event := <-recorder.channel:
			if event.name != "session.output" {
				t.Fatalf("unexpected event before first acknowledgement: %#v", event)
			}
			output := event.payload.(SessionOutputEvent)
			windowBytes += output.Bytes
			firstWindowLast = output.Sequence
			if !idle.Stop() {
				<-idle.C
			}
			idle.Reset(150 * time.Millisecond)
		case <-idle.C:
			break collectFirstWindow
		}
	}
	if windowBytes <= 0 || windowBytes > 1024 {
		t.Fatalf("first output window violated its bound: %d", windowBytes)
	}
	if _, err := service.sessions.ack(SessionAckParams{
		SessionID: started.SessionID, ThroughSequence: firstWindowLast + 1,
	}); err == nil || AsOpError(err).Code != "invalid_ack" {
		t.Fatalf("expected ahead-of-stream acknowledgement rejection, got %v", err)
	}
	ack, err := service.sessions.ack(SessionAckParams{SessionID: started.SessionID, ThroughSequence: firstWindowLast})
	if err != nil {
		t.Fatalf("ack first window: %v", err)
	}
	if ack.OutstandingBytes != 0 {
		t.Fatalf("ack did not release output window: %#v", ack)
	}
	totalBytes := windowBytes
	lastSequence := firstWindowLast
	for {
		event := recorder.next(t)
		if event.name == "session.exited" {
			exited := event.payload.(SessionExitedEvent)
			if totalBytes != 2048 || exited.Output.EmittedBytes != 2048 || exited.Output.Truncated {
				t.Fatalf("unexpected backpressure summary: total=%d output=%#v", totalBytes, exited.Output)
			}
			break
		}
		if event.name != "session.output" {
			t.Fatalf("unexpected stream event: %#v", event)
		}
		output := event.payload.(SessionOutputEvent)
		if output.Sequence <= lastSequence {
			t.Fatalf("output sequence did not advance: %#v", output)
		}
		totalBytes += output.Bytes
		lastSequence = output.Sequence
		if _, err := service.sessions.ack(SessionAckParams{
			SessionID: started.SessionID, ThroughSequence: output.Sequence,
		}); err != nil {
			t.Fatalf("ack streamed output: %v", err)
		}
	}
}

func TestSessionOutputLimitEmitsExplicitTruncation(t *testing.T) {
	service := newSessionTestService(t)
	recorder := newSessionEventRecorder()
	started, err := service.sessions.start(context.Background(), SessionStartParams{
		Context: "default", Argv: []string{"session-stream"}, Mode: "pipes",
		Cwd: filepath.Dir(service.docker.binary.RealPath), MaxOutputBytes: 100,
	}, recorder.emit)
	if err != nil {
		t.Fatalf("start truncated session: %v", err)
	}
	cleanupSession(t, service, started.SessionID)
	_ = recorder.wait(t, "session.started")
	emitted := 0
	var truncated SessionTruncatedEvent
	for {
		event := recorder.next(t)
		switch event.name {
		case "session.output":
			output := event.payload.(SessionOutputEvent)
			emitted += output.Bytes
			_, _ = service.sessions.ack(SessionAckParams{SessionID: started.SessionID, ThroughSequence: output.Sequence})
		case "session.output.truncated":
			truncated = event.payload.(SessionTruncatedEvent)
			goto observedTruncation
		}
	}
observedTruncation:
	if emitted != 100 {
		t.Fatalf("output limit not enforced: emitted=%d", emitted)
	}
	if truncated.MaxOutputBytes != 100 || truncated.DroppedBytes <= 0 {
		t.Fatalf("unexpected truncation event: %#v", truncated)
	}
	exited := recorder.wait(t, "session.exited").(SessionExitedEvent)
	if !exited.Output.Truncated || exited.Output.EmittedBytes != 100 || exited.Output.DroppedBytes != 1948 {
		t.Fatalf("unexpected truncation summary: %#v", exited.Output)
	}
}

func TestPTYSessionIsRealAndResizeIsObserved(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("real PTY integration is Linux-specific")
	}
	service := newSessionTestService(t)
	recorder := newSessionEventRecorder()
	started, err := service.sessions.start(context.Background(), SessionStartParams{
		Context: "default", Argv: []string{"session-pty-resize"}, Mode: "pty",
		Cwd: filepath.Dir(service.docker.binary.RealPath), Rows: 24, Cols: 80,
	}, recorder.emit)
	if err != nil {
		t.Fatalf("start PTY session: %v", err)
	}
	cleanupSession(t, service, started.SessionID)
	_ = recorder.wait(t, "session.started")
	initialText := ""
	var initialSequence uint64
	for !strings.Contains(initialText, "PTY-READY") {
		initial := recorder.wait(t, "session.output").(SessionOutputEvent)
		if initial.Stream != "pty" {
			t.Fatalf("unexpected PTY stream: %#v", initial)
		}
		initialText += initial.Data
		initialSequence = initial.Sequence
		_, _ = service.sessions.ack(SessionAckParams{SessionID: started.SessionID, ThroughSequence: initial.Sequence})
	}
	if !strings.Contains(initialText, "24 80") || initialSequence == 0 {
		t.Fatalf("initial PTY size was not observed: %q", initialText)
	}
	resized, err := service.sessions.resize(SessionResizeParams{
		SessionID: started.SessionID, Rows: 40, Cols: 120,
	})
	if err != nil {
		t.Fatalf("resize PTY: %v", err)
	}
	if resized.Rows != 40 || resized.Cols != 120 {
		t.Fatalf("unexpected resize receipt: %#v", resized)
	}
	observed := recorder.wait(t, "session.output").(SessionOutputEvent)
	if !strings.Contains(observed.Data, "40 120") {
		t.Fatalf("resized PTY dimensions were not observed: %#v", observed)
	}
	_, _ = service.sessions.ack(SessionAckParams{SessionID: started.SessionID, ThroughSequence: observed.Sequence})
	exited := recorder.wait(t, "session.exited").(SessionExitedEvent)
	if exited.ExitCode != 0 || exited.Output.PTYBytes == 0 {
		t.Fatalf("unexpected PTY exit: %#v", exited)
	}
}

func TestCancellationKillsSessionProcessGroupAndChild(t *testing.T) {
	service := newSessionTestService(t)
	recorder := newSessionEventRecorder()
	started, err := service.sessions.start(context.Background(), SessionStartParams{
		Context: "default", Argv: []string{"session-child"}, Mode: "pipes",
		Cwd: filepath.Dir(service.docker.binary.RealPath),
	}, recorder.emit)
	if err != nil {
		t.Fatalf("start child session: %v", err)
	}
	cleanupSession(t, service, started.SessionID)
	_ = recorder.wait(t, "session.started")
	output := recorder.wait(t, "session.output").(SessionOutputEvent)
	childPID, err := strconv.Atoi(strings.TrimSpace(output.Data))
	if err != nil || childPID <= 0 {
		t.Fatalf("invalid child pid output %q: %v", output.Data, err)
	}
	_, _ = service.sessions.ack(SessionAckParams{SessionID: started.SessionID, ThroughSequence: output.Sequence})
	zero := 0
	receipt, err := service.sessions.cancel(SessionCancelParams{
		SessionID: started.SessionID, GracePeriodMs: &zero,
	})
	if err != nil {
		t.Fatalf("cancel session: %v", err)
	}
	if !receipt.Accepted || receipt.State != "canceling" {
		t.Fatalf("unexpected cancellation receipt: %#v", receipt)
	}
	exited := recorder.wait(t, "session.exited").(SessionExitedEvent)
	if !exited.Canceled || exited.TimedOut || exited.Signal == "" {
		t.Fatalf("unexpected canceled exit: %#v", exited)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		err := syscall.Kill(childPID, 0)
		if errors.Is(err, syscall.ESRCH) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("child process %d survived session cancellation (kill probe=%v)", childPID, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestSessionSignalIsDeliveredToProcessGroup(t *testing.T) {
	service := newSessionTestService(t)
	recorder := newSessionEventRecorder()
	started, err := service.sessions.start(context.Background(), SessionStartParams{
		Context: "default", Argv: []string{"session-signal"}, Mode: "pipes",
		Cwd: filepath.Dir(service.docker.binary.RealPath),
	}, recorder.emit)
	if err != nil {
		t.Fatalf("start signal session: %v", err)
	}
	cleanupSession(t, service, started.SessionID)
	_ = recorder.wait(t, "session.started")
	output := recorder.wait(t, "session.output").(SessionOutputEvent)
	if output.Data != "SIGNAL-READY" {
		t.Fatalf("signal fixture was not ready: %#v", output)
	}
	_, _ = service.sessions.ack(SessionAckParams{SessionID: started.SessionID, ThroughSequence: output.Sequence})
	receipt, err := service.sessions.signal(SessionSignalParams{
		SessionID: started.SessionID, Signal: "interrupt",
	})
	if err != nil {
		t.Fatalf("signal session: %v", err)
	}
	if !receipt.Accepted || receipt.Signal != "interrupt" {
		t.Fatalf("unexpected signal receipt: %#v", receipt)
	}
	exited := recorder.wait(t, "session.exited").(SessionExitedEvent)
	if exited.ExitCode != 23 || exited.Canceled || exited.TimedOut {
		t.Fatalf("signal trap did not determine exit: %#v", exited)
	}
}

func TestSessionRejectsInvalidIDsModesAndOperations(t *testing.T) {
	service := newSessionTestService(t)
	_, err := service.sessions.input(SessionInputParams{SessionID: "bad", Data: "x"})
	if got := AsOpError(err).Code; got != "invalid_session_id" {
		t.Fatalf("expected invalid session id, got %q", got)
	}
	unknown, _ := operationID()
	_, err = service.sessions.ack(SessionAckParams{SessionID: unknown, ThroughSequence: 1})
	if got := AsOpError(err).Code; got != "session_not_found" {
		t.Fatalf("expected session not found, got %q", got)
	}
	_, err = service.sessions.start(context.Background(), SessionStartParams{
		Context: "default", Argv: []string{"session-stream"}, Mode: "unknown",
		Cwd: filepath.Dir(service.docker.binary.RealPath),
	}, nil)
	if got := AsOpError(err).Code; got != "invalid_session_mode" {
		t.Fatalf("expected invalid mode, got %q", got)
	}
}

func newSessionTestService(t *testing.T) *Service {
	t.Helper()
	directory := t.TempDir()
	executable := filepath.Join(directory, "docker")
	script := `#!/bin/sh
case "$*" in
  "session-separate")
    printf 'stdout-data'
    printf 'stderr-data' >&2
    exit 7
    ;;
  "--context default session-separate")
    printf 'stdout-data'
    printf 'stderr-data' >&2
    exit 7
    ;;
  "--context default session-input")
    IFS= read -r value
    printf 'input:%s' "$value"
    ;;
  "--context default session-stream")
    index=0
    while [ "$index" -lt 128 ]; do
      printf '0123456789abcdef'
      index=$((index + 1))
    done
    ;;
  "--context default session-pty-resize")
    stty size
    trap 'stty size; exit 0' WINCH
    printf 'PTY-READY\n'
    while :; do :; done
    ;;
  "--context default session-child")
    sleep 30 &
    child=$!
    printf '%s\n' "$child"
    wait "$child"
    ;;
  "--context default session-signal")
    trap 'exit 23' INT
    printf 'SIGNAL-READY'
    while :; do :; done
    ;;
  *)
    printf 'unexpected argv: %s\n' "$*" >&2
    exit 64
    ;;
esac
`
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatalf("write session fake docker: %v", err)
	}
	service, err := NewService(Config{
		DockerExecutable: executable,
		AllowedCWDRoots:  []string{directory},
	})
	if err != nil {
		t.Fatalf("new session service: %v", err)
	}
	return service
}

func cleanupSession(t *testing.T, service *Service, sessionID string) {
	t.Helper()
	t.Cleanup(func() {
		zero := 0
		_, _ = service.sessions.cancel(SessionCancelParams{
			SessionID: sessionID, GracePeriodMs: &zero,
		})
	})
}

// Regression: a session whose ack window is exhausted and never acknowledged used to wedge
// permanently once its child exited. The waiter broadcast processExited and then blocked on
// readers.Wait(), but a reader parked on the window never woke, so the PTY was never closed,
// finish() never ran, session.exited was never emitted, and the fds, goroutines and OS threads
// leaked for the lifetime of the core. The post-exit drain deadline now bounds this.
func TestUnacknowledgedSessionStillExitsAfterProcessExit(t *testing.T) {
	restore := postExitDrainTimeout
	postExitDrainTimeout = 250 * time.Millisecond
	t.Cleanup(func() { postExitDrainTimeout = restore })

	service := newSessionTestService(t)
	recorder := newSessionEventRecorder()
	started, err := service.sessions.start(context.Background(), SessionStartParams{
		Context: "default", Argv: []string{"session-stream"}, Mode: "pipes",
		Cwd: filepath.Dir(service.docker.binary.RealPath), OutputWindowBytes: 1024,
	}, recorder.emit)
	if err != nil {
		t.Fatalf("start stream session: %v", err)
	}
	cleanupSession(t, service, started.SessionID)
	_ = recorder.wait(t, "session.started")

	// Deliberately never acknowledge anything. The first window fills, the child exits, and the
	// drain deadline must still bring the session to a reported exit.
	deadline := time.After(10 * time.Second)
	for {
		select {
		case event := <-recorder.channel:
			if event.name == "session.exited" {
				exited := event.payload.(SessionExitedEvent)
				if exited.Output.EmittedBytes > 1024 {
					t.Fatalf("ack window was bypassed after process exit: %#v", exited.Output)
				}
				return
			}
			if event.name == "session.error" {
				t.Fatalf("unexpected session error: %#v", event.payload)
			}
		case <-deadline:
			t.Fatal("session wedged: session.exited was never emitted without acknowledgements")
		}
	}
}

// Regression: cancel() short-circuited on processExited, so a session that had exited but not
// finalized -- exactly the wedged case above -- reported accepted:false and did nothing.
func TestCancelIsAcceptedWhileSessionIsStillDraining(t *testing.T) {
	service := newSessionTestService(t)
	recorder := newSessionEventRecorder()
	started, err := service.sessions.start(context.Background(), SessionStartParams{
		Context: "default", Argv: []string{"session-stream"}, Mode: "pipes",
		Cwd: filepath.Dir(service.docker.binary.RealPath), OutputWindowBytes: 1024,
	}, recorder.emit)
	if err != nil {
		t.Fatalf("start stream session: %v", err)
	}
	cleanupSession(t, service, started.SessionID)
	_ = recorder.wait(t, "session.started")

	session, err := service.sessions.lookup(started.SessionID)
	if err != nil {
		t.Fatalf("lookup session: %v", err)
	}
	// Force the exited-but-not-finalized state the wedge produced.
	session.mu.Lock()
	session.processExited = true
	session.finalized = false
	session.mu.Unlock()

	zero := 0
	result, err := service.sessions.cancel(SessionCancelParams{
		SessionID: started.SessionID, GracePeriodMs: &zero,
	})
	if err != nil {
		t.Fatalf("cancel draining session: %v", err)
	}
	if !result.Accepted || result.State != "canceling" {
		t.Fatalf("cancel refused to act on a draining session: %#v", result)
	}
}
