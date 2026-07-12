// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type shutdownTestController struct {
	status  BlockControllerRuntimeStatus
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (controller *shutdownTestController) Start(
	context.Context,
	waveobj.MetaMapType,
	*waveobj.RuntimeOpts,
	bool,
) error {
	return nil
}

func (controller *shutdownTestController) Stop(bool, string, bool) {
	controller.once.Do(func() { close(controller.started) })
	<-controller.release
}

func (controller *shutdownTestController) GetRuntimeStatus() *BlockControllerRuntimeStatus {
	status := controller.status
	return &status
}

func (controller *shutdownTestController) GetConnName() string {
	return ""
}

func (controller *shutdownTestController) SendInput(*BlockInputUnion) error {
	return nil
}

func TestStopBlockControllersForShutdownAndWaitAwaitsRunningControllers(t *testing.T) {
	running := &shutdownTestController{
		status: BlockControllerRuntimeStatus{
			ShellProcStatus: Status_Running,
		},
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	done := &shutdownTestController{
		status: BlockControllerRuntimeStatus{
			ShellProcStatus: Status_Done,
		},
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	cleaned := make(chan string, 1)
	result := make(chan error, 1)

	go func() {
		result <- stopBlockControllersForShutdownAndWait(
			context.Background(),
			map[string]Controller{
				"running": running,
				"done":    done,
			},
			func(blockID string) { cleaned <- blockID },
			0,
		)
	}()

	select {
	case <-running.started:
	case <-time.After(time.Second):
		t.Fatal("running controller was not stopped")
	}
	select {
	case err := <-result:
		t.Fatalf("shutdown returned before controller stopped: %v", err)
	default:
	}
	select {
	case <-done.started:
		t.Fatal("done controller must not be stopped again")
	default:
	}

	close(running.release)
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("shutdown failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown did not finish")
	}
	select {
	case blockID := <-cleaned:
		if blockID != "running" {
			t.Fatalf("cleaned block %q, want running", blockID)
		}
	case <-time.After(time.Second):
		t.Fatal("running controller runtime info was not cleaned")
	}
}

func TestStopBlockControllersForShutdownAndWaitHonorsContext(t *testing.T) {
	controller := &shutdownTestController{
		status: BlockControllerRuntimeStatus{
			ShellProcStatus: Status_Running,
		},
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	defer close(controller.release)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	err := stopBlockControllersForShutdownAndWait(
		ctx,
		map[string]Controller{"running": controller},
		func(string) {},
		0,
	)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown error = %v, want context deadline exceeded", err)
	}
}
