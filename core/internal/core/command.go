package core

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	discoveryOutputLimit = 256 * 1024
	cliOutputLimit       = 1024 * 1024
)

type DockerCLI struct {
	binary BinaryFingerprint
	env    []string
}

type commandResult struct {
	stdout          []byte
	stderr          []byte
	stdoutBytes     int64
	stderrBytes     int64
	stdoutTruncated bool
	stderrTruncated bool
	exitCode        int
	timedOut        bool
	duration        time.Duration
}

type prefixWriter struct {
	mu        sync.Mutex
	buffer    bytes.Buffer
	limit     int
	total     int64
	truncated bool
}

func (w *prefixWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.total += int64(len(p))
	remaining := w.limit - w.buffer.Len()
	if remaining > 0 {
		if remaining > len(p) {
			remaining = len(p)
		}
		_, _ = w.buffer.Write(p[:remaining])
	}
	if w.total > int64(w.limit) {
		w.truncated = true
	}
	return len(p), nil
}

func (w *prefixWriter) snapshot() ([]byte, int64, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return bytes.Clone(w.buffer.Bytes()), w.total, w.truncated
}

func resolveDockerBinary(requested string) (*DockerCLI, error) {
	if strings.TrimSpace(requested) == "" {
		requested = "docker"
	}

	path, err := exec.LookPath(requested)
	if err != nil {
		return nil, opError("docker_not_found", "Docker CLI executable was not found.", err, map[string]any{
			"requestedPath": requested,
		})
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return nil, opError("docker_resolution_failed", "Docker CLI path could not be resolved.", err, nil)
	}
	realPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, opError("docker_resolution_failed", "Docker CLI symlink target could not be resolved.", err, map[string]any{
			"path": path,
		})
	}
	info, err := os.Stat(realPath)
	if err != nil {
		return nil, opError("docker_resolution_failed", "Docker CLI executable could not be inspected.", err, map[string]any{
			"path": realPath,
		})
	}
	if !info.Mode().IsRegular() {
		return nil, opError("docker_invalid_executable", "Docker CLI path is not a regular file.", nil, map[string]any{
			"path": realPath,
		})
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return nil, opError("docker_invalid_executable", "Docker CLI file is not executable.", nil, map[string]any{
			"path": realPath,
		})
	}

	file, err := os.Open(realPath)
	if err != nil {
		return nil, opError("docker_resolution_failed", "Docker CLI executable could not be opened for fingerprinting.", err, nil)
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, file)
	closeErr := file.Close()
	if copyErr != nil {
		return nil, opError("docker_fingerprint_failed", "Docker CLI executable could not be fingerprinted.", copyErr, nil)
	}
	if closeErr != nil {
		return nil, opError("docker_fingerprint_failed", "Docker CLI executable could not be closed after fingerprinting.", closeErr, nil)
	}

	return &DockerCLI{
		binary: BinaryFingerprint{
			RequestedPath: requested,
			Path:          path,
			RealPath:      realPath,
			SHA256:        hex.EncodeToString(hash.Sum(nil)),
			Size:          info.Size(),
			ModifiedAt:    info.ModTime().UTC().Format(time.RFC3339Nano),
			Mode:          info.Mode().String(),
		},
		env: os.Environ(),
	}, nil
}

func (c *DockerCLI) run(ctx context.Context, args []string, cwd string, env map[string]string, outputLimit int) (commandResult, error) {
	if c == nil {
		return commandResult{}, opError("docker_not_found", "Docker CLI is unavailable.", nil, nil)
	}
	if outputLimit <= 0 {
		outputLimit = discoveryOutputLimit
	}

	command := exec.CommandContext(ctx, c.binary.RealPath, args...)
	command.Dir = cwd
	command.Env = mergeEnvironment(c.env, env)
	command.Stdin = nil

	stdout := &prefixWriter{limit: outputLimit}
	stderr := &prefixWriter{limit: outputLimit}
	command.Stdout = stdout
	command.Stderr = stderr

	started := time.Now()
	err := command.Run()
	duration := time.Since(started)
	stdoutData, stdoutBytes, stdoutTruncated := stdout.snapshot()
	stderrData, stderrBytes, stderrTruncated := stderr.snapshot()
	result := commandResult{
		stdout:          stdoutData,
		stderr:          stderrData,
		stdoutBytes:     stdoutBytes,
		stderrBytes:     stderrBytes,
		stdoutTruncated: stdoutTruncated,
		stderrTruncated: stderrTruncated,
		exitCode:        0,
		timedOut:        errors.Is(ctx.Err(), context.DeadlineExceeded),
		duration:        duration,
	}

	if err == nil {
		return result, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		result.exitCode = exitErr.ExitCode()
		return result, nil
	}
	if result.timedOut || errors.Is(ctx.Err(), context.Canceled) {
		result.exitCode = signalExitCode(command.ProcessState)
		return result, nil
	}
	return result, opError("process_start_failed", "Docker CLI process could not be started.", err, map[string]any{
		"executable": c.binary.RealPath,
	})
}

func signalExitCode(state *os.ProcessState) int {
	if state == nil {
		return -1
	}
	return state.ExitCode()
}

func mergeEnvironment(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return base
	}
	merged := make(map[string]string, len(base)+len(overrides))
	order := make([]string, 0, len(base)+len(overrides))
	for _, item := range base {
		key, value, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		if _, exists := merged[key]; !exists {
			order = append(order, key)
		}
		merged[key] = value
	}
	for key, value := range overrides {
		if _, exists := merged[key]; !exists {
			order = append(order, key)
		}
		merged[key] = value
	}
	result := make([]string, 0, len(merged))
	for _, key := range order {
		result = append(result, key+"="+merged[key])
	}
	return result
}

func commandEvidence(binary string, args []string, result commandResult) CommandEvidence {
	argv := make([]string, 0, len(args)+1)
	argv = append(argv, binary)
	argv = append(argv, args...)
	return CommandEvidence{
		Argv:            argv,
		ExitCode:        result.exitCode,
		Stdout:          string(result.stdout),
		Stderr:          string(result.stderr),
		StdoutTruncated: result.stdoutTruncated,
		StderrTruncated: result.stderrTruncated,
		TimedOut:        result.timedOut,
		DurationMs:      result.duration.Milliseconds(),
	}
}

func capturedOutput(data []byte, total int64, truncated bool) CapturedOutput {
	if utf8.Valid(data) {
		return CapturedOutput{
			Data:      string(data),
			Encoding:  "utf-8",
			Bytes:     total,
			Truncated: truncated,
		}
	}
	return CapturedOutput{
		Data:      base64.StdEncoding.EncodeToString(data),
		Encoding:  "base64",
		Bytes:     total,
		Truncated: truncated,
	}
}

func operationID() (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", fmt.Errorf("generate operation id: %w", err)
	}
	// Set RFC 4122 version/variant bits. The identifier is correlation-only.
	random[6] = (random[6] & 0x0f) | 0x40
	random[8] = (random[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(random[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}
