// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package shellexec

import (
	"os"
	"syscall"
)

func makeCmdSignalTarget(process *os.Process) cmdSignalTarget {
	target := cmdSignalTarget{process: process}
	if process == nil || process.Pid <= 0 {
		return target
	}
	processGroupID, err := syscall.Getpgid(process.Pid)
	if err == nil && processGroupID == process.Pid {
		target.processGroupID = processGroupID
	}
	return target
}

func signalCmdTarget(target cmdSignalTarget, signal syscall.Signal) error {
	if target.processGroupID > 0 {
		return syscall.Kill(-target.processGroupID, signal)
	}
	if target.process == nil {
		return nil
	}
	return target.process.Signal(signal)
}

func hupCmdSignalTarget(target cmdSignalTarget) error {
	return signalCmdTarget(target, syscall.SIGHUP)
}

func termCmdSignalTarget(target cmdSignalTarget) error {
	return signalCmdTarget(target, syscall.SIGTERM)
}

func killCmdSignalTarget(target cmdSignalTarget) error {
	return signalCmdTarget(target, syscall.SIGKILL)
}
