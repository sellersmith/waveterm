// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

//go:build darwin

package blockcontroller

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/hyprlane/sessionpolicy"
	"github.com/wavetermdev/waveterm/pkg/shellexec"
)

type noPTYCommand struct {
	shellexec.CmdWrap
}

func (noPTYCommand) Close() error {
	return nil
}

func TestDetachedTabExpiryKillsTerminalProcessGroup(t *testing.T) {
	command := exec.Command(
		"/bin/sh",
		"-c",
		`trap '' HUP TERM; sleep 30 & wait`,
	)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		t.Fatalf("starting terminal process group: %v", err)
	}
	processGroupID := command.Process.Pid
	t.Cleanup(func() {
		_ = syscall.Kill(-processGroupID, syscall.SIGKILL)
	})

	commandWrap := shellexec.MakeCmdWrap(command, nil, true)
	controller := &ShellController{
		Lock:           &sync.Mutex{},
		ControllerType: BlockController_Shell,
		TabId:          "tab-expiring",
		BlockId:        "block-expiring",
		RunLock:        &atomic.Bool{},
		ProcStatus:     Status_Running,
		ShellProc: &shellexec.ShellProc{
			Cmd:       noPTYCommand{CmdWrap: commandWrap},
			CloseOnce: &sync.Once{},
			DoneCh:    make(chan any),
		},
	}
	installLifecycleTestRegistry(
		t,
		map[string]Controller{"block-expiring": controller},
		map[string]string{"block-expiring": "tab-expiring"},
	)

	coordinator, err := sessionpolicy.NewCoordinator(sessionpolicy.Options{
		Clock:       lifecycleWallClock{},
		MaxLivePTYs: 16,
		DetachedTTL: 10 * time.Millisecond,
		ReapTab:     destroyBlockControllersForTab,
	})
	if err != nil {
		t.Fatalf("NewCoordinator failed: %v", err)
	}
	oldCoordinator := localPTYCoordinator
	oldEmbedded := embeddedSessionPolicyEnabled
	localPTYCoordinator = coordinator
	embeddedSessionPolicyEnabled = func() bool { return true }
	t.Cleanup(func() {
		localPTYCoordinator = oldCoordinator
		embeddedSessionPolicyEnabled = oldEmbedded
	})

	if err := coordinator.Attach("tab-expiring"); err != nil {
		t.Fatalf("Attach failed: %v", err)
	}
	if err := coordinator.Admit("tab-expiring", "block-expiring"); err != nil {
		t.Fatalf("Admit failed: %v", err)
	}
	coordinator.Detach("tab-expiring")

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		processErr := syscall.Kill(-processGroupID, 0)
		if errors.Is(processErr, syscall.ESRCH) &&
			getController("block-expiring") == nil &&
			coordinator.LivePTYs() == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf(
		"expired terminal leaked process group %d (registered=%t, livePTYs=%d)",
		processGroupID,
		getController("block-expiring") != nil,
		coordinator.LivePTYs(),
	)
}

func waitForLifecycleChildPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		contents, err := os.ReadFile(path)
		if err == nil && strings.TrimSpace(string(contents)) != "" {
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(contents)))
			if parseErr != nil {
				t.Fatalf("parsing child PID: %v", parseErr)
			}
			return pid
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for child PID at %s", path)
	return 0
}

func TestCapEvictionWaitsForExitedLeaderProcessGroupEscalation(t *testing.T) {
	childPIDPath := t.TempDir() + "/child.pid"
	command := exec.Command(
		"/bin/sh",
		"-c",
		`trap '' HUP TERM; sleep 30 & child=$!; printf '%s' "$child" > "$1"`,
		"hyprlane-session-escalation-test",
		childPIDPath,
	)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		t.Fatalf("starting terminal process group: %v", err)
	}
	processGroupID := command.Process.Pid
	t.Cleanup(func() {
		_ = syscall.Kill(-processGroupID, syscall.SIGKILL)
	})
	commandWrap := shellexec.MakeCmdWrap(command, nil, true)
	childPID := waitForLifecycleChildPID(t, childPIDPath)
	if err := syscall.Kill(childPID, 0); err != nil {
		t.Fatalf("terminal child was not alive before eviction: %v", err)
	}

	controller := &ShellController{
		Lock:           &sync.Mutex{},
		ControllerType: BlockController_Shell,
		TabId:          "tab-old",
		BlockId:        "block-old",
		RunLock:        &atomic.Bool{},
		ProcStatus:     Status_Running,
		ShellProc: &shellexec.ShellProc{
			Cmd:       noPTYCommand{CmdWrap: commandWrap},
			CloseOnce: &sync.Once{},
			DoneCh:    make(chan any),
		},
	}
	installLifecycleTestRegistry(
		t,
		map[string]Controller{"block-old": controller},
		map[string]string{"block-old": "tab-old"},
	)
	coordinator, err := sessionpolicy.NewCoordinator(sessionpolicy.Options{
		Clock:       lifecycleWallClock{},
		MaxLivePTYs: 1,
		DetachedTTL: time.Minute,
		ReapTab:     destroyBlockControllersForTab,
	})
	if err != nil {
		t.Fatalf("NewCoordinator failed: %v", err)
	}
	oldCoordinator := localPTYCoordinator
	oldEmbedded := embeddedSessionPolicyEnabled
	localPTYCoordinator = coordinator
	embeddedSessionPolicyEnabled = func() bool { return true }
	t.Cleanup(func() {
		localPTYCoordinator = oldCoordinator
		embeddedSessionPolicyEnabled = oldEmbedded
	})
	if err := coordinator.Attach("tab-old"); err != nil {
		t.Fatalf("Attach old tab failed: %v", err)
	}
	if err := coordinator.Admit("tab-old", "block-old"); err != nil {
		t.Fatalf("Admit old PTY failed: %v", err)
	}
	coordinator.Detach("tab-old")
	if err := coordinator.Attach("tab-new"); err != nil {
		t.Fatalf("Attach new tab failed: %v", err)
	}

	if err := coordinator.Admit("tab-new", "block-new"); err != nil {
		t.Fatalf("replacement admission failed: %v", err)
	}
	if err := syscall.Kill(-processGroupID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("replacement admitted before old process group exited: %v", err)
	}
}
