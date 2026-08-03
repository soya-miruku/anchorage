//go:build !linux

package core

import (
	"errors"
	"os"
	"syscall"
)

func openPTY(_, _ int) (*os.File, *os.File, error) {
	return nil, nil, opError("unsupported_platform", "PTY sessions are currently supported only on Linux.", nil, nil)
}

func resizePTY(_ *os.File, _, _ int) error {
	return opError("unsupported_platform", "PTY sessions are currently supported only on Linux.", nil, nil)
}

func sessionProcessAttributes(_ bool) *syscall.SysProcAttr {
	return &syscall.SysProcAttr{}
}

func signalProcessGroup(pid int, signal syscall.Signal) error {
	if pid <= 0 {
		return errors.New("invalid process")
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Signal(signal)
}

func processExitSignal(_ *os.ProcessState) string {
	return ""
}

func expectedPTYReadError(_ error) bool {
	return false
}
