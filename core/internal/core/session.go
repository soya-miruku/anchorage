package core

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	defaultOutputWindow = 256 * 1024
	minOutputWindow     = 1024
	maxOutputWindow     = 8 * 1024 * 1024
	maxSessionInput     = 256 * 1024
	maxSessionOutput    = int64(1 << 40) // 1 TiB when an explicit cap is requested.
	outputChunkSize     = 16 * 1024
	sessionTombstoneTTL = 5 * time.Minute
	defaultCancelGrace  = 2 * time.Second
)

// postExitDrainTimeout bounds how long a session may stay open after its process exits while
// waiting for the client to acknowledge buffered output. Past this the tail is dropped so the
// session can finalize instead of leaking its readers, fds and OS threads. It is a var only so
// tests can shorten it.
var postExitDrainTimeout = 30 * time.Second

type sessionManager struct {
	owner *Service

	mu       sync.RWMutex
	sessions map[string]*cliSession
}

type pendingOutput struct {
	sequence uint64
	bytes    int64
}

type sessionReader struct {
	stream string
	reader io.Reader
	closer io.Closer
}

type cliSession struct {
	manager *sessionManager
	emitter EventEmitter

	id         string
	mode       string
	context    string
	targetMode string
	executable string
	argv       []string
	cwd        string
	startedAt  time.Time
	rows       int
	cols       int

	command   *exec.Cmd
	pid       int
	input     io.WriteCloser
	pty       *os.File
	readers   []sessionReader
	childEnds []*os.File

	outputWindow int64
	maxOutput    int64

	mu                 sync.Mutex
	cond               *sync.Cond
	inputMu            sync.Mutex
	emitMu             sync.Mutex
	pending            []pendingOutput
	outstandingBytes   int64
	lastSequence       uint64
	lastAck            uint64
	budgetUsed         int64
	emittedBytes       int64
	droppedBytes       int64
	stdoutBytes        int64
	stderrBytes        int64
	ptyBytes           int64
	truncated          bool
	truncationNotified bool
	discardOutput      bool
	inputClosed        bool
	processExited      bool
	finalized          bool
	timedOut           bool
	canceled           bool
	cancelOnce         sync.Once
	done               chan struct{}
}

func newSessionManager(owner *Service) *sessionManager {
	return &sessionManager{owner: owner, sessions: make(map[string]*cliSession)}
}

func (m *sessionManager) start(parent context.Context, params SessionStartParams, emit EventEmitter) (SessionStartResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return SessionStartResult{}, err
	}
	params.Context = contextName
	targetMode, err := normalizeTargetMode(params.TargetMode)
	if err != nil {
		return SessionStartResult{}, err
	}
	params.TargetMode = targetMode
	if err := validateCLIArgv(params.Argv, m.owner.docker.binary, targetMode); err != nil {
		return SessionStartResult{}, err
	}
	if err := validateCLIEnvironment(params.Env, targetMode); err != nil {
		return SessionStartResult{}, err
	}
	if params.Mode != "pipes" && params.Mode != "pty" {
		return SessionStartResult{}, opError("invalid_session_mode", "Session mode must be \"pipes\" or \"pty\".", nil, map[string]any{
			"mode": params.Mode,
		})
	}
	if params.TimeoutSeconds < 0 || params.TimeoutSeconds > 86400 {
		return SessionStartResult{}, opError("invalid_timeout", "Session timeout must be between 0 and 86400 seconds.", nil, nil)
	}
	if params.OutputWindowBytes == 0 {
		params.OutputWindowBytes = defaultOutputWindow
	}
	if params.OutputWindowBytes < minOutputWindow || params.OutputWindowBytes > maxOutputWindow {
		return SessionStartResult{}, opError("invalid_output_window", "Session output window is outside the supported range.", nil, map[string]any{
			"minimum": minOutputWindow,
			"maximum": maxOutputWindow,
		})
	}
	if params.MaxOutputBytes < 0 || params.MaxOutputBytes > maxSessionOutput {
		return SessionStartResult{}, opError("invalid_output_limit", "Session output limit is outside the supported range.", nil, map[string]any{
			"maximum": maxSessionOutput,
		})
	}
	if params.Mode == "pty" {
		if params.Rows == 0 {
			params.Rows = 24
		}
		if params.Cols == 0 {
			params.Cols = 80
		}
		if err := validateTerminalSize(params.Rows, params.Cols); err != nil {
			return SessionStartResult{}, err
		}
	} else if params.Rows != 0 || params.Cols != 0 {
		return SessionStartResult{}, opError("not_a_tty", "Rows and columns are only valid for PTY sessions.", nil, nil)
	}
	cwd, err := m.owner.resolveAllowedCWD(params.Cwd)
	if err != nil {
		return SessionStartResult{}, err
	}
	sessionID, err := operationID()
	if err != nil {
		return SessionStartResult{}, opError("session_id_failed", "Session identifier could not be generated.", err, nil)
	}
	args := commandArgs(contextName, targetMode, params.Argv...)
	command := exec.Command(m.owner.docker.binary.RealPath, args...)
	command.Dir = cwd
	command.Env = mergeEnvironment(m.owner.docker.env, params.Env)

	session := &cliSession{
		manager:      m,
		emitter:      emit,
		id:           sessionID,
		mode:         params.Mode,
		context:      contextName,
		targetMode:   targetMode,
		executable:   m.owner.docker.binary.RealPath,
		argv:         args,
		cwd:          cwd,
		startedAt:    time.Now().UTC(),
		rows:         params.Rows,
		cols:         params.Cols,
		command:      command,
		outputWindow: int64(params.OutputWindowBytes),
		maxOutput:    params.MaxOutputBytes,
		done:         make(chan struct{}),
	}
	session.cond = sync.NewCond(&session.mu)

	if err := session.prepareIO(); err != nil {
		session.closePreparedIO()
		return SessionStartResult{}, err
	}
	if err := command.Start(); err != nil {
		session.closePreparedIO()
		return SessionStartResult{}, opError("process_start_failed", "Docker CLI session could not be started.", err, map[string]any{
			"executable": session.executable,
			"mode":       session.mode,
		})
	}
	session.pid = command.Process.Pid
	session.closeChildEndsAfterStart()

	m.mu.Lock()
	m.sessions[session.id] = session
	m.mu.Unlock()

	started := session.startResult()
	if emit != nil {
		emit("session.started", SessionStartedEvent{SessionStartResult: started, State: "running"})
	}
	session.startReadersAndWaiter()
	session.watchLifetime(parent, params.TimeoutSeconds)
	return started, nil
}

func (s *cliSession) prepareIO() error {
	if s.mode == "pty" {
		master, slave, err := openPTY(s.rows, s.cols)
		if err != nil {
			return err
		}
		s.pty = master
		s.input = master
		s.command.Stdin = slave
		s.command.Stdout = slave
		s.command.Stderr = slave
		s.command.SysProcAttr = sessionProcessAttributes(true)
		s.readers = []sessionReader{{stream: "pty", reader: master}}
		// The parent closes this slave copy immediately after Start.
		s.childEnds = []*os.File{slave}
		return nil
	}

	stdinReader, stdinWriter, err := os.Pipe()
	if err != nil {
		return opError("session_pipe_failed", "Session stdin pipe could not be created.", err, nil)
	}
	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		_ = stdinReader.Close()
		_ = stdinWriter.Close()
		return opError("session_pipe_failed", "Session stdout pipe could not be created.", err, nil)
	}
	stderrReader, stderrWriter, err := os.Pipe()
	if err != nil {
		_ = stdinReader.Close()
		_ = stdinWriter.Close()
		_ = stdoutReader.Close()
		_ = stdoutWriter.Close()
		return opError("session_pipe_failed", "Session stderr pipe could not be created.", err, nil)
	}
	s.input = stdinWriter
	s.command.Stdin = stdinReader
	s.command.Stdout = stdoutWriter
	s.command.Stderr = stderrWriter
	s.command.SysProcAttr = sessionProcessAttributes(false)
	s.childEnds = []*os.File{stdinReader, stdoutWriter, stderrWriter}
	s.readers = []sessionReader{
		{stream: "stdout", reader: stdoutReader, closer: stdoutReader},
		{stream: "stderr", reader: stderrReader, closer: stderrReader},
	}
	return nil
}

func (s *cliSession) closeChildEndsAfterStart() {
	for _, file := range s.childEnds {
		_ = file.Close()
	}
	s.childEnds = nil
}

func (s *cliSession) closePreparedIO() {
	if s.input != nil {
		_ = s.input.Close()
	}
	for _, reader := range s.readers {
		if reader.closer != nil {
			_ = reader.closer.Close()
		}
	}
	for _, file := range s.childEnds {
		_ = file.Close()
	}
	if s.pty != nil {
		_ = s.pty.Close()
	}
}

func (s *cliSession) startResult() SessionStartResult {
	return SessionStartResult{
		SessionID:         s.id,
		Mode:              s.mode,
		PID:               s.pid,
		Context:           s.context,
		TargetMode:        s.targetMode,
		Executable:        s.executable,
		Argv:              append([]string{}, s.argv...),
		Cwd:               s.cwd,
		Rows:              s.rows,
		Cols:              s.cols,
		OutputWindowBytes: int(s.outputWindow),
		MaxOutputBytes:    s.maxOutput,
		StartedAt:         s.startedAt.Format(time.RFC3339Nano),
	}
}

func (s *cliSession) startReadersAndWaiter() {
	var readers sync.WaitGroup
	readers.Add(len(s.readers))
	for _, reader := range s.readers {
		reader := reader
		go func() {
			defer readers.Done()
			s.readOutput(reader)
		}()
	}
	go func() {
		waitErr := s.command.Wait()
		s.mu.Lock()
		s.processExited = true
		s.cond.Broadcast()
		s.mu.Unlock()
		s.closeInput()
		_ = signalProcessGroup(s.pid, syscall.SIGKILL)

		// A reader parked on an exhausted ack window would otherwise keep readers.Wait() blocked
		// forever when the client stops acknowledging, so the PTY would never close, finish()
		// would never run, session.exited would never be emitted, and the fds, goroutines and OS
		// threads would leak for the lifetime of the core. Bound the post-exit drain: if the
		// client has not made room within the deadline, discard the tail (which the existing
		// discardOutput path already reports as dropped/truncated) and tear the session down.
		drained := make(chan struct{})
		go func() {
			readers.Wait()
			close(drained)
		}()
		timer := time.NewTimer(postExitDrainTimeout)
		defer timer.Stop()
		select {
		case <-drained:
		case <-timer.C:
			s.mu.Lock()
			s.discardOutput = true
			s.cond.Broadcast()
			s.mu.Unlock()
			<-drained
		}

		if s.pty != nil {
			_ = s.pty.Close()
		}
		s.finish(waitErr)
	}()
}

func (s *cliSession) watchLifetime(parent context.Context, timeoutSeconds int) {
	go func() {
		var timeout <-chan time.Time
		var timer *time.Timer
		if timeoutSeconds > 0 {
			timer = time.NewTimer(time.Duration(timeoutSeconds) * time.Second)
			timeout = timer.C
			defer timer.Stop()
		}
		select {
		case <-parent.Done():
			s.requestCancellation(false, 0)
		case <-timeout:
			s.requestCancellation(true, defaultCancelGrace)
		case <-s.done:
		}
	}()
}

func (s *cliSession) readOutput(reader sessionReader) {
	if reader.closer != nil {
		defer reader.closer.Close()
	}
	chunkSize := outputChunkSize
	if int64(chunkSize) > s.outputWindow {
		chunkSize = int(s.outputWindow)
	}
	buffer := make([]byte, chunkSize)
	for {
		count, err := reader.reader.Read(buffer)
		if count > 0 {
			data := append([]byte(nil), buffer[:count]...)
			s.handleOutput(reader.stream, data)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && !expectedPTYReadError(err) && !errors.Is(err, os.ErrClosed) {
				s.emitEvent("session.error", map[string]any{
					"sessionId": s.id,
					"code":      "session_output_failed",
					"message":   err.Error(),
					"stream":    reader.stream,
				})
			}
			return
		}
	}
}

func (s *cliSession) handleOutput(stream string, data []byte) {
	// Serialize budget allocation and emission across stdout/stderr so output
	// sequence numbers and truncation notifications have one stable order.
	s.emitMu.Lock()
	defer s.emitMu.Unlock()

	s.mu.Lock()
	switch stream {
	case "stdout":
		s.stdoutBytes += int64(len(data))
	case "stderr":
		s.stderrBytes += int64(len(data))
	case "pty":
		s.ptyBytes += int64(len(data))
	}
	allowed := len(data)
	if s.discardOutput {
		allowed = 0
	} else if s.maxOutput > 0 {
		remaining := s.maxOutput - s.budgetUsed
		if remaining <= 0 {
			allowed = 0
		} else if int64(allowed) > remaining {
			allowed = int(remaining)
		}
	}
	s.budgetUsed += int64(allowed)
	dropped := int64(len(data) - allowed)
	if dropped > 0 {
		s.droppedBytes += dropped
		s.truncated = true
	}
	s.mu.Unlock()

	if allowed > 0 && !s.emitOutput(stream, data[:allowed]) {
		s.noteDropped(int64(allowed))
	}
	if dropped > 0 {
		s.notifyTruncation()
	}
}

func (s *cliSession) emitOutput(stream string, data []byte) bool {
	s.mu.Lock()
	// The window is deliberately still enforced after process exit: a short-lived command that
	// writes its whole output and exits immediately must not be allowed to bypass backpressure
	// and flood the renderer. The guarantee that this cannot block forever comes from the drain
	// deadline in startReadersAndWaiter, which sets discardOutput and broadcasts.
	for !s.discardOutput && s.outstandingBytes+int64(len(data)) > s.outputWindow {
		s.cond.Wait()
	}
	if s.discardOutput {
		s.mu.Unlock()
		return false
	}
	s.lastSequence++
	sequence := s.lastSequence
	s.pending = append(s.pending, pendingOutput{sequence: sequence, bytes: int64(len(data))})
	s.outstandingBytes += int64(len(data))
	s.emittedBytes += int64(len(data))
	s.mu.Unlock()

	encoding := "utf-8"
	encoded := string(data)
	if !utf8.Valid(data) {
		encoding = "base64"
		encoded = base64.StdEncoding.EncodeToString(data)
	}
	s.emitEvent("session.output", SessionOutputEvent{
		SessionID: s.id,
		Sequence:  sequence,
		Stream:    stream,
		Data:      encoded,
		Encoding:  encoding,
		Bytes:     len(data),
	})
	return true
}

func (s *cliSession) noteDropped(bytes int64) {
	if bytes <= 0 {
		return
	}
	s.mu.Lock()
	s.droppedBytes += bytes
	s.truncated = true
	s.mu.Unlock()
	s.notifyTruncation()
}

func (s *cliSession) notifyTruncation() {
	s.mu.Lock()
	if s.truncationNotified {
		s.mu.Unlock()
		return
	}
	s.truncationNotified = true
	event := SessionTruncatedEvent{
		SessionID: s.id, MaxOutputBytes: s.maxOutput, DroppedBytes: s.droppedBytes,
	}
	s.mu.Unlock()
	s.emitEvent("session.output.truncated", event)
}

func (s *cliSession) emitEvent(name string, payload any) {
	if s.emitter != nil {
		s.emitter(name, payload)
	}
}

func (s *cliSession) finish(waitErr error) {
	exitedAt := time.Now().UTC()
	exitCode := 0
	signal := ""
	if s.command.ProcessState != nil {
		exitCode = s.command.ProcessState.ExitCode()
		signal = processExitSignal(s.command.ProcessState)
	} else if waitErr != nil {
		exitCode = -1
	}

	s.mu.Lock()
	if s.finalized {
		s.mu.Unlock()
		return
	}
	s.finalized = true
	event := SessionExitedEvent{
		SessionID:  s.id,
		State:      "exited",
		ExitCode:   exitCode,
		Signal:     signal,
		TimedOut:   s.timedOut,
		Canceled:   s.canceled,
		StartedAt:  s.startedAt.Format(time.RFC3339Nano),
		ExitedAt:   exitedAt.Format(time.RFC3339Nano),
		DurationMs: exitedAt.Sub(s.startedAt).Milliseconds(),
		Output: SessionExitOutput{
			StdoutBytes: s.stdoutBytes, StderrBytes: s.stderrBytes, PTYBytes: s.ptyBytes,
			EmittedBytes: s.emittedBytes, DroppedBytes: s.droppedBytes, Truncated: s.truncated,
			LastSequence: s.lastSequence,
		},
	}
	close(s.done)
	s.cond.Broadcast()
	s.mu.Unlock()
	s.emitEvent("session.exited", event)

	time.AfterFunc(sessionTombstoneTTL, func() {
		s.manager.mu.Lock()
		if s.manager.sessions[s.id] == s {
			delete(s.manager.sessions, s.id)
		}
		s.manager.mu.Unlock()
	})
}

func (m *sessionManager) input(params SessionInputParams) (SessionInputResult, error) {
	session, err := m.lookup(params.SessionID)
	if err != nil {
		return SessionInputResult{}, err
	}
	if params.Encoding == "" {
		params.Encoding = "utf-8"
	}
	var data []byte
	switch params.Encoding {
	case "utf-8":
		data = []byte(params.Data)
	case "base64":
		decoded, err := base64.StdEncoding.Strict().DecodeString(params.Data)
		if err != nil {
			return SessionInputResult{}, opError("invalid_input_encoding", "Session input is not valid base64.", err, nil)
		}
		data = decoded
	default:
		return SessionInputResult{}, opError("invalid_input_encoding", "Session input encoding must be \"utf-8\" or \"base64\".", nil, nil)
	}
	if len(data) > maxSessionInput {
		return SessionInputResult{}, opError("session_input_too_large", "Session input exceeds the per-request limit.", nil, map[string]any{
			"limit": maxSessionInput,
		})
	}
	if len(data) == 0 && !params.EOF {
		return SessionInputResult{}, opError("session_input_empty", "Session input must include data or request EOF.", nil, nil)
	}
	accepted, err := session.writeInput(data, params.EOF)
	if err != nil {
		return SessionInputResult{}, err
	}
	return SessionInputResult{SessionID: session.id, AcceptedBytes: accepted, EOF: params.EOF}, nil
}

func (s *cliSession) writeInput(data []byte, eof bool) (int, error) {
	s.inputMu.Lock()
	defer s.inputMu.Unlock()
	s.mu.Lock()
	if s.processExited || s.finalized {
		s.mu.Unlock()
		return 0, opError("session_closed", "Session process has exited.", nil, map[string]any{"sessionId": s.id})
	}
	if s.inputClosed {
		s.mu.Unlock()
		return 0, opError("session_input_closed", "Session input is already closed.", nil, map[string]any{"sessionId": s.id})
	}
	input := s.input
	mode := s.mode
	s.mu.Unlock()

	written := 0
	for written < len(data) {
		count, err := input.Write(data[written:])
		written += count
		if err != nil {
			return written, opError("session_input_failed", "Session input could not be written.", err, map[string]any{
				"sessionId": s.id,
			})
		}
		if count == 0 {
			return written, opError("session_input_failed", "Session input writer made no progress.", io.ErrNoProgress, nil)
		}
	}
	if eof {
		if mode == "pty" {
			count, err := input.Write([]byte{0x04})
			if err != nil {
				return written, opError("session_input_failed", "PTY end-of-input marker could not be written.", err, nil)
			}
			if count != 1 {
				return written, opError("session_input_failed", "PTY end-of-input marker was not fully written.", io.ErrShortWrite, nil)
			}
		} else {
			s.mu.Lock()
			s.inputClosed = true
			s.mu.Unlock()
			if err := input.Close(); err != nil {
				return written, opError("session_input_failed", "Session input could not be closed.", err, nil)
			}
		}
	}
	return written, nil
}

func (s *cliSession) closeInput() {
	s.inputMu.Lock()
	defer s.inputMu.Unlock()
	s.mu.Lock()
	if s.inputClosed || s.mode == "pty" {
		s.mu.Unlock()
		return
	}
	s.inputClosed = true
	input := s.input
	s.mu.Unlock()
	if input != nil {
		_ = input.Close()
	}
}

func (m *sessionManager) resize(params SessionResizeParams) (SessionResizeResult, error) {
	session, err := m.lookup(params.SessionID)
	if err != nil {
		return SessionResizeResult{}, err
	}
	if session.mode != "pty" {
		return SessionResizeResult{}, opError("not_a_tty", "Only PTY sessions can be resized.", nil, map[string]any{
			"sessionId": session.id,
		})
	}
	if err := validateTerminalSize(params.Rows, params.Cols); err != nil {
		return SessionResizeResult{}, err
	}
	session.mu.Lock()
	if session.processExited || session.finalized {
		session.mu.Unlock()
		return SessionResizeResult{}, opError("session_closed", "Session process has exited.", nil, map[string]any{"sessionId": session.id})
	}
	pty := session.pty
	session.mu.Unlock()
	if err := resizePTY(pty, params.Rows, params.Cols); err != nil {
		return SessionResizeResult{}, err
	}
	session.mu.Lock()
	session.rows = params.Rows
	session.cols = params.Cols
	session.mu.Unlock()
	// TIOCSWINSZ normally delivers SIGWINCH to the foreground group. Send it
	// explicitly as well so CLI plugins with unusual terminal setup observe it.
	if err := signalProcessGroup(session.pid, syscall.SIGWINCH); err != nil && !errors.Is(err, syscall.ESRCH) {
		return SessionResizeResult{}, opError("session_signal_failed", "PTY resize succeeded, but SIGWINCH could not be delivered.", err, map[string]any{
			"sessionId": session.id,
		})
	}
	return SessionResizeResult{SessionID: session.id, Rows: params.Rows, Cols: params.Cols}, nil
}

func (m *sessionManager) signal(params SessionSignalParams) (SessionSignalResult, error) {
	session, err := m.lookup(params.SessionID)
	if err != nil {
		return SessionSignalResult{}, err
	}
	signal, err := parseSessionSignal(params.Signal)
	if err != nil {
		return SessionSignalResult{}, err
	}
	session.mu.Lock()
	exited := session.processExited || session.finalized
	pid := session.pid
	session.mu.Unlock()
	if exited {
		return SessionSignalResult{}, opError("session_closed", "Session process has exited.", nil, map[string]any{"sessionId": session.id})
	}
	if err := signalProcessGroup(pid, signal); err != nil {
		return SessionSignalResult{}, opError("session_signal_failed", "Signal could not be delivered to the session process group.", err, map[string]any{
			"sessionId": session.id,
			"signal":    params.Signal,
		})
	}
	return SessionSignalResult{SessionID: session.id, Signal: params.Signal, Accepted: true}, nil
}

func (m *sessionManager) cancel(params SessionCancelParams) (SessionCancelResult, error) {
	session, err := m.lookup(params.SessionID)
	if err != nil {
		return SessionCancelResult{}, err
	}
	grace := defaultCancelGrace
	if params.GracePeriodMs != nil {
		if *params.GracePeriodMs < 0 || *params.GracePeriodMs > 30000 {
			return SessionCancelResult{}, opError("invalid_grace_period", "Cancellation grace period must be between 0 and 30000 milliseconds.", nil, nil)
		}
		grace = time.Duration(*params.GracePeriodMs) * time.Millisecond
	}
	session.mu.Lock()
	finalized := session.finalized
	session.mu.Unlock()
	// Only a finalized session is genuinely done. A session whose process has exited but which
	// has not finalized is still draining (or wedged behind an ack window), and cancelling it
	// must still force teardown -- otherwise cancel is a no-op on exactly the sessions that
	// most need it.
	if finalized {
		return SessionCancelResult{SessionID: session.id, Accepted: false, State: "exited"}, nil
	}
	session.requestCancellation(false, grace)
	return SessionCancelResult{SessionID: session.id, Accepted: true, State: "canceling"}, nil
}

func (s *cliSession) requestCancellation(timedOut bool, grace time.Duration) {
	s.cancelOnce.Do(func() {
		s.mu.Lock()
		s.timedOut = timedOut
		s.canceled = !timedOut
		s.discardOutput = true
		s.cond.Broadcast()
		exited := s.processExited
		pid := s.pid
		s.mu.Unlock()
		if exited {
			return
		}
		if grace <= 0 {
			_ = signalProcessGroup(pid, syscall.SIGKILL)
			return
		}
		_ = signalProcessGroup(pid, syscall.SIGTERM)
		go func() {
			timer := time.NewTimer(grace)
			defer timer.Stop()
			select {
			case <-timer.C:
				s.mu.Lock()
				stillRunning := !s.processExited
				s.mu.Unlock()
				if stillRunning {
					_ = signalProcessGroup(pid, syscall.SIGKILL)
				}
			case <-s.done:
			}
		}()
	})
}

func (m *sessionManager) ack(params SessionAckParams) (SessionAckResult, error) {
	session, err := m.lookup(params.SessionID)
	if err != nil {
		return SessionAckResult{}, err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if params.ThroughSequence > session.lastSequence {
		return SessionAckResult{}, opError("invalid_ack", "Acknowledgement is ahead of the last emitted output sequence.", nil, map[string]any{
			"lastSequence": session.lastSequence,
		})
	}
	if params.ThroughSequence > session.lastAck {
		session.lastAck = params.ThroughSequence
		remove := 0
		for remove < len(session.pending) && session.pending[remove].sequence <= params.ThroughSequence {
			session.outstandingBytes -= session.pending[remove].bytes
			remove++
		}
		if remove > 0 {
			copy(session.pending, session.pending[remove:])
			session.pending = session.pending[:len(session.pending)-remove]
		}
		session.cond.Broadcast()
	}
	return SessionAckResult{
		SessionID: session.id, ThroughSequence: session.lastAck, OutstandingBytes: session.outstandingBytes,
	}, nil
}

func (m *sessionManager) lookup(id string) (*cliSession, error) {
	if err := validateSessionID(id); err != nil {
		return nil, err
	}
	m.mu.RLock()
	session := m.sessions[id]
	m.mu.RUnlock()
	if session == nil {
		return nil, opError("session_not_found", "Session does not exist or its tombstone expired.", nil, map[string]any{
			"sessionId": id,
		})
	}
	return session, nil
}

func validateSessionID(id string) error {
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
		return opError("invalid_session_id", "Session ID must be a canonical UUID.", nil, nil)
	}
	for index, char := range id {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f') {
			return opError("invalid_session_id", "Session ID must be a lowercase canonical UUID.", nil, nil)
		}
	}
	return nil
}

func validateTerminalSize(rows, cols int) error {
	if rows < 1 || rows > 1000 || cols < 1 || cols > 1000 {
		return opError("invalid_terminal_size", "Terminal rows and columns must each be between 1 and 1000.", nil, map[string]any{
			"rows": rows,
			"cols": cols,
		})
	}
	return nil
}

func parseSessionSignal(name string) (syscall.Signal, error) {
	switch name {
	case "interrupt":
		return syscall.SIGINT, nil
	case "terminate":
		return syscall.SIGTERM, nil
	case "kill":
		return syscall.SIGKILL, nil
	case "hangup":
		return syscall.SIGHUP, nil
	case "quit":
		return syscall.SIGQUIT, nil
	default:
		return 0, opError("invalid_signal", "Session signal is not in the allowlist.", nil, map[string]any{
			"signal": name,
		})
	}
}

func (s *cliSession) String() string {
	return fmt.Sprintf("session %s pid=%d mode=%s", s.id, s.pid, s.mode)
}
