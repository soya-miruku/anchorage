//go:build linux

package core

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

type terminalWindowSize struct {
	Rows    uint16
	Cols    uint16
	XPixels uint16
	YPixels uint16
}

func openPTY(rows, cols int) (*os.File, *os.File, error) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, opError("pty_open_failed", "Linux PTY master could not be opened.", err, nil)
	}
	cleanup := func(cause error) (*os.File, *os.File, error) {
		_ = master.Close()
		return nil, nil, cause
	}

	var unlock int32
	if err := ioctlPointer(master.Fd(), syscall.TIOCSPTLCK, unsafe.Pointer(&unlock)); err != nil {
		return cleanup(opError("pty_unlock_failed", "Linux PTY master could not be unlocked.", err, nil))
	}
	var number uint32
	if err := ioctlPointer(master.Fd(), syscall.TIOCGPTN, unsafe.Pointer(&number)); err != nil {
		return cleanup(opError("pty_number_failed", "Linux PTY number could not be queried.", err, nil))
	}
	slavePath := fmt.Sprintf("/dev/pts/%d", number)
	slave, err := os.OpenFile(slavePath, os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return cleanup(opError("pty_slave_failed", "Linux PTY slave could not be opened.", err, map[string]any{
			"path": slavePath,
		}))
	}
	if err := resizePTY(master, rows, cols); err != nil {
		_ = slave.Close()
		return cleanup(err)
	}
	return master, slave, nil
}

func resizePTY(file *os.File, rows, cols int) error {
	if file == nil {
		return opError("pty_closed", "PTY is unavailable.", nil, nil)
	}
	size := terminalWindowSize{Rows: uint16(rows), Cols: uint16(cols)}
	if err := ioctlPointer(file.Fd(), syscall.TIOCSWINSZ, unsafe.Pointer(&size)); err != nil {
		return opError("pty_resize_failed", "Linux PTY could not be resized.", err, map[string]any{
			"rows": rows,
			"cols": cols,
		})
	}
	return nil
}

func ioctlPointer(fd uintptr, request uintptr, pointer unsafe.Pointer) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, request, uintptr(pointer))
	if errno != 0 {
		return errno
	}
	return nil
}

func sessionProcessAttributes(pty bool) *syscall.SysProcAttr {
	if pty {
		return &syscall.SysProcAttr{
			Setsid:    true,
			Setctty:   true,
			Ctty:      0,
			Pdeathsig: syscall.SIGKILL,
		}
	}
	return &syscall.SysProcAttr{
		Setpgid:   true,
		Pdeathsig: syscall.SIGKILL,
	}
}

func signalProcessGroup(pid int, signal syscall.Signal) error {
	if pid <= 0 {
		return errors.New("invalid process group")
	}
	return syscall.Kill(-pid, signal)
}

func processExitSignal(state *os.ProcessState) string {
	if state == nil {
		return ""
	}
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() {
		return ""
	}
	return status.Signal().String()
}

func expectedPTYReadError(err error) bool {
	return errors.Is(err, syscall.EIO)
}
