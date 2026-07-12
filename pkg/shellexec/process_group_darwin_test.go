// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

//go:build darwin

package shellexec

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func waitForChildPid(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		contents, err := os.ReadFile(path)
		if err == nil && strings.TrimSpace(string(contents)) != "" {
			pid, err := strconv.Atoi(strings.TrimSpace(string(contents)))
			if err != nil {
				t.Fatalf("parsing child pid: %v", err)
			}
			return pid
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for child pid file %s", path)
	return 0
}

func waitForProcessGroupExit(t *testing.T, pgid int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		err := syscall.Kill(-pgid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("process group %d survived shutdown", pgid)
}

func waitForFileContents(
	t *testing.T,
	path string,
	want string,
	timeout time.Duration,
) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		contents, err := os.ReadFile(path)
		if err == nil && string(contents) == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s to contain %q", path, want)
}

func TestCmdWrapKillGracefulKillsDescendantsThatIgnoreHup(t *testing.T) {
	childPidPath := t.TempDir() + "/child.pid"
	cmd := exec.Command(
		"/bin/sh",
		"-c",
		`trap '' HUP TERM; sleep 30 & child=$!; printf '%s' "$child" > "$1"; wait`,
		"hyprlane-process-group-test",
		childPidPath,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting shell process group: %v", err)
	}
	pgid := cmd.Process.Pid
	defer func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}()

	childPid := waitForChildPid(t, childPidPath)
	if err := syscall.Kill(childPid, 0); err != nil {
		t.Fatalf("child process %d was not running before shutdown: %v", childPid, err)
	}

	cmdWrap := MakeCmdWrap(cmd, nil, true)
	cmdWrap.KillGraceful(100 * time.Millisecond)
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- cmdWrap.Wait()
	}()
	waitForProcessGroupExit(t, pgid)
	select {
	case <-waitDone:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out reaping shell process")
	}
}

func TestCmdWrapKillGracefulUsesCapturedGroupAfterLeaderExited(t *testing.T) {
	childPidPath := t.TempDir() + "/child.pid"
	cmd := exec.Command(
		"/bin/sh",
		"-c",
		`trap '' HUP TERM; sleep 30 & child=$!; printf '%s' "$child" > "$1"`,
		"hyprlane-exited-leader-test",
		childPidPath,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting shell process group: %v", err)
	}
	pgid := cmd.Process.Pid
	defer func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}()

	cmdWrap := MakeCmdWrap(cmd, nil, true)
	childPid := waitForChildPid(t, childPidPath)
	if err := cmdWrap.Wait(); err != nil {
		t.Fatalf("waiting for shell leader: %v", err)
	}
	if err := syscall.Kill(childPid, 0); err != nil {
		t.Fatalf("child process %d did not outlive its shell leader: %v", childPid, err)
	}

	cmdWrap.KillGraceful(100 * time.Millisecond)
	waitForProcessGroupExit(t, pgid)
}

func TestCmdWrapKillGracefulSendsTermToNonShellProcessGroup(t *testing.T) {
	tempDir := t.TempDir()
	childScript := tempDir + "/term-child.sh"
	markerPath := tempDir + "/term.marker"
	readyPath := tempDir + "/ready.marker"
	childPidPath := tempDir + "/child.pid"
	if err := os.WriteFile(
		childScript,
		[]byte("#!/bin/sh\ntrap 'printf TERM > \"$MARKER\"; exit 0' TERM\nprintf ready > \"$READY\"\nwhile :; do sleep 1; done\n"),
		0o700,
	); err != nil {
		t.Fatalf("writing child script: %v", err)
	}
	cmd := exec.Command(
		"/bin/sh",
		"-c",
		`trap ':' HUP TERM; "$1" & child=$!; printf '%s' "$child" > "$2"; wait`,
		"hyprlane-term-group-test",
		childScript,
		childPidPath,
	)
	cmd.Env = append(os.Environ(), "MARKER="+markerPath, "READY="+readyPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting non-shell process group: %v", err)
	}
	pgid := cmd.Process.Pid
	defer func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}()

	cmdWrap := MakeCmdWrap(cmd, nil, false)
	_ = waitForChildPid(t, childPidPath)
	// A real child process must pass through macOS exec scheduling before it can
	// write this marker. Keep the fixture reliable while package tests and native
	// linking run concurrently; the production shutdown grace remains unchanged.
	waitForFileContents(t, readyPath, "ready", 10*time.Second)
	cmdWrap.KillGraceful(100 * time.Millisecond)
	waitForFileContents(t, markerPath, "TERM", 3*time.Second)
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- cmdWrap.Wait()
	}()
	waitForProcessGroupExit(t, pgid)
	select {
	case <-waitDone:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out reaping non-shell process")
	}
}
