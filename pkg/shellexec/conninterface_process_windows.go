// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package shellexec

import "os"

func makeCmdSignalTarget(process *os.Process) cmdSignalTarget {
	return cmdSignalTarget{process: process}
}

func hupCmdSignalTarget(target cmdSignalTarget) error {
	return nil
}

func termCmdSignalTarget(target cmdSignalTarget) error {
	return killCmdSignalTarget(target)
}

func killCmdSignalTarget(target cmdSignalTarget) error {
	if target.process == nil {
		return nil
	}
	return target.process.Kill()
}
