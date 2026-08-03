package rpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"

	coreapi "anchorage/core/internal/core"
)

const maxRequestLineBytes = 8 * 1024 * 1024

// maxResponseLineBytes must stay at or below the client's own line budget
// (MAX_RPC_LINE_BYTES in app/electron/jsonl-rpc.mjs). The client SIGTERMs the core when it
// reads a longer line, so an oversized payload has to be degraded here into a structured
// error rather than emitted and allowed to kill the process.
const maxResponseLineBytes = 8 * 1024 * 1024

type Handler interface {
	Handle(ctx context.Context, method string, params json.RawMessage, emit coreapi.EventEmitter) (any, error)
}

type Server struct {
	handler Handler
	input   io.Reader
	output  io.Writer

	writeMu sync.Mutex
	active  sync.Map
}

type request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type response struct {
	ID     json.RawMessage  `json:"id"`
	Result any              `json:"result,omitempty"`
	Error  *coreapi.OpError `json:"error,omitempty"`
}

type eventEnvelope struct {
	Event   string `json:"event"`
	Payload any    `json:"payload"`
}

func NewServer(handler Handler, input io.Reader, output io.Writer) *Server {
	return &Server{handler: handler, input: input, output: output}
}

func (s *Server) Serve(ctx context.Context) error {
	if s.handler == nil || s.input == nil || s.output == nil {
		return errors.New("rpc server requires a handler, input, and output")
	}
	scanner := bufio.NewScanner(s.input)
	scanner.Buffer(make([]byte, 64*1024), maxRequestLineBytes)
	var requests sync.WaitGroup
	for scanner.Scan() {
		line := bytes.TrimSpace(bytes.Clone(scanner.Bytes()))
		if len(line) == 0 {
			continue
		}
		parsed, err := decodeRequest(line)
		if err != nil {
			if writeErr := s.write(response{
				ID: json.RawMessage("null"),
				Error: &coreapi.OpError{
					Code: "invalid_request", Message: "RPC request is invalid.",
					Details: map[string]any{"reason": err.Error()},
				},
			}); writeErr != nil {
				return writeErr
			}
			continue
		}
		key := string(parsed.ID)
		// request.cancel is handled by the server itself: it must reach the in-flight
		// request's context, which the handler has no access to.
		if parsed.Method == cancelMethod {
			s.handleCancel(parsed)
			continue
		}
		requestCtx, cancelRequest := context.WithCancel(ctx)
		if _, loaded := s.active.LoadOrStore(key, cancelRequest); loaded {
			cancelRequest()
			if writeErr := s.write(response{
				ID: parsed.ID,
				Error: &coreapi.OpError{
					Code: "duplicate_request_id", Message: "RPC request ID is already in flight.",
				},
			}); writeErr != nil {
				return writeErr
			}
			continue
		}
		requests.Add(1)
		go func(parsed request, key string, requestCtx context.Context, cancelRequest context.CancelFunc) {
			defer requests.Done()
			defer s.active.Delete(key)
			defer cancelRequest()
			s.handleRequest(requestCtx, parsed)
		}(parsed, key, requestCtx, cancelRequest)
	}
	scanErr := scanner.Err()
	requests.Wait()
	if scanErr != nil {
		if errors.Is(scanErr, bufio.ErrTooLong) || strings.Contains(scanErr.Error(), "token too long") {
			return fmt.Errorf("rpc request exceeds %d bytes: %w", maxRequestLineBytes, scanErr)
		}
		return fmt.Errorf("read rpc request: %w", scanErr)
	}
	return nil
}

// cancelMethod lets a client abandon an in-flight request. Without it, an RPC the client has
// already given up on (its own IPC timeout fired, or the user navigated away) kept running to
// completion in the core, holding a goroutine, an Engine connection and any docker subprocess
// it had started.
const cancelMethod = "request.cancel"

func (s *Server) handleCancel(parsed request) {
	var params struct {
		TargetID json.RawMessage `json:"targetId"`
	}
	if len(parsed.Params) > 0 {
		if err := json.Unmarshal(parsed.Params, &params); err != nil {
			_ = s.write(response{
				ID: parsed.ID,
				Error: &coreapi.OpError{
					Code: "invalid_request", Message: "request.cancel params are invalid.",
				},
			})
			return
		}
	}
	target := string(bytes.TrimSpace(params.TargetID))
	if target == "" {
		_ = s.write(response{
			ID: parsed.ID,
			Error: &coreapi.OpError{
				Code: "invalid_request", Message: "request.cancel requires targetId.",
			},
		})
		return
	}
	value, ok := s.active.Load(target)
	if ok {
		if cancel, isCancel := value.(context.CancelFunc); isCancel {
			cancel()
		}
	}
	_ = s.write(response{ID: parsed.ID, Result: map[string]any{"canceled": ok}})
}

func (s *Server) handleRequest(ctx context.Context, request request) {
	defer func() {
		if recovered := recover(); recovered != nil {
			_ = s.write(response{
				ID: request.ID,
				Error: &coreapi.OpError{
					Code: "internal_error", Message: "The core panicked while handling the request.",
					Details: map[string]any{"panicType": fmt.Sprintf("%T", recovered)},
				},
			})
		}
	}()
	emit := func(event string, payload any) {
		if strings.TrimSpace(event) == "" {
			return
		}
		_ = s.write(eventEnvelope{Event: event, Payload: payload})
	}
	result, err := s.handler.Handle(ctx, request.Method, request.Params, emit)
	if err != nil {
		_ = s.write(response{ID: request.ID, Error: coreapi.AsOpError(err)})
		return
	}
	if writeErr := s.write(response{ID: request.ID, Result: result}); errors.Is(writeErr, errResponseTooLarge) {
		_ = s.write(response{
			ID: request.ID,
			Error: &coreapi.OpError{
				Code:    "response_too_large",
				Message: "The result exceeded the protocol line limit and was not transmitted.",
				Details: map[string]any{"method": request.Method, "limitBytes": maxResponseLineBytes},
			},
		})
	}
}

var errResponseTooLarge = errors.New("rpc response exceeds the protocol line limit")

func (s *Server) write(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode rpc message: %w", err)
	}
	// +1 for the newline the framing appends below.
	if len(data)+1 > maxResponseLineBytes {
		return errResponseTooLarge
	}
	data = append(data, '\n')
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.output.Write(data); err != nil {
		return fmt.Errorf("write rpc message: %w", err)
	}
	return nil
}

func decodeRequest(line []byte) (request, error) {
	var parsed request
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&parsed); err != nil {
		return request{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return request{}, errors.New("unexpected trailing JSON value")
		}
		return request{}, err
	}
	if len(parsed.ID) == 0 || bytes.Equal(bytes.TrimSpace(parsed.ID), []byte("null")) {
		return request{}, errors.New("id is required and cannot be null")
	}
	if err := validateID(parsed.ID); err != nil {
		return request{}, err
	}
	if strings.TrimSpace(parsed.Method) == "" {
		return request{}, errors.New("method is required")
	}
	return parsed, nil
}

func validateID(raw json.RawMessage) error {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("invalid id: %w", err)
	}
	switch typed := value.(type) {
	case string:
		if typed == "" || len(typed) > 256 {
			return errors.New("string id must contain between 1 and 256 bytes")
		}
	case json.Number:
		if _, err := strconv.ParseInt(typed.String(), 10, 64); err != nil {
			return errors.New("numeric id must be a signed 64-bit integer")
		}
	default:
		return errors.New("id must be a string or integer")
	}
	return nil
}
