// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/hyprlane/sessionpolicy"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type lifecycleWallClock struct{}

func (lifecycleWallClock) Now() time.Time {
	return time.Now()
}

func (lifecycleWallClock) AfterFunc(
	delay time.Duration,
	callback func(),
) sessionpolicy.Timer {
	return time.AfterFunc(delay, callback)
}

type lifecycleTestController struct {
	mu          sync.Mutex
	status      string
	stopCount   int
	lastDestroy bool
}

func (controller *lifecycleTestController) Start(
	context.Context,
	waveobj.MetaMapType,
	*waveobj.RuntimeOpts,
	bool,
) error {
	return nil
}

func (controller *lifecycleTestController) Stop(_ bool, newStatus string, destroy bool) {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	controller.status = newStatus
	controller.stopCount++
	controller.lastDestroy = destroy
}

func (controller *lifecycleTestController) GetRuntimeStatus() *BlockControllerRuntimeStatus {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return &BlockControllerRuntimeStatus{ShellProcStatus: controller.status}
}

func (controller *lifecycleTestController) GetConnName() string {
	return ""
}

func (controller *lifecycleTestController) SendInput(*BlockInputUnion) error {
	return nil
}

func (controller *lifecycleTestController) stopResult() (int, bool) {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return controller.stopCount, controller.lastDestroy
}

func installLifecycleTestRegistry(
	t *testing.T,
	controllers map[string]Controller,
	tabIDs map[string]string,
) {
	t.Helper()
	registryLock.Lock()
	oldControllers := controllerRegistry
	oldTabIDs := controllerTabIDs
	controllerRegistry = controllers
	controllerTabIDs = tabIDs
	registryLock.Unlock()
	t.Cleanup(func() {
		registryLock.Lock()
		controllerRegistry = oldControllers
		controllerTabIDs = oldTabIDs
		registryLock.Unlock()
	})
}

func installLifecycleTestPolicy(
	t *testing.T,
	embedded bool,
	maxLivePTYs int,
	reapTab func(string),
) *sessionpolicy.Coordinator {
	t.Helper()
	coordinator, err := sessionpolicy.NewCoordinator(sessionpolicy.Options{
		Clock:       lifecycleWallClock{},
		MaxLivePTYs: maxLivePTYs,
		DetachedTTL: time.Hour,
		ReapTab:     reapTab,
	})
	if err != nil {
		t.Fatalf("NewCoordinator failed: %v", err)
	}
	oldCoordinator := localPTYCoordinator
	oldEmbedded := embeddedSessionPolicyEnabled
	localPTYCoordinator = coordinator
	embeddedSessionPolicyEnabled = func() bool { return embedded }
	t.Cleanup(func() {
		localPTYCoordinator = oldCoordinator
		embeddedSessionPolicyEnabled = oldEmbedded
	})
	return coordinator
}

func TestDestroyBlockControllersForTabStopsEveryController(t *testing.T) {
	first := &lifecycleTestController{status: Status_Running}
	second := &lifecycleTestController{status: Status_Running}
	other := &lifecycleTestController{status: Status_Running}
	installLifecycleTestRegistry(
		t,
		map[string]Controller{
			"block-a": first,
			"block-b": second,
			"block-c": other,
		},
		map[string]string{
			"block-a": "tab-expired",
			"block-b": "tab-expired",
			"block-c": "tab-live",
		},
	)
	installLifecycleTestPolicy(t, true, 16, func(string) {})

	destroyBlockControllersForTab("tab-expired")

	for name, controller := range map[string]*lifecycleTestController{
		"first":  first,
		"second": second,
	} {
		stopCount, destroyed := controller.stopResult()
		if stopCount != 1 || !destroyed {
			t.Fatalf("%s controller stop=(%d, %v), want (1, true)", name, stopCount, destroyed)
		}
	}
	if stopCount, _ := other.stopResult(); stopCount != 0 {
		t.Fatalf("controller in live tab stopped %d times", stopCount)
	}
	if getController("block-a") != nil || getController("block-b") != nil {
		t.Fatal("expired tab controllers remained registered")
	}
	if getController("block-c") != other {
		t.Fatal("controller in live tab was removed")
	}
}

func TestDestroyBlockControllersForTabStopsProcessGroupsConcurrently(t *testing.T) {
	first := &shutdownTestController{
		status:  BlockControllerRuntimeStatus{ShellProcStatus: Status_Running},
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	second := &shutdownTestController{
		status:  BlockControllerRuntimeStatus{ShellProcStatus: Status_Running},
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	installLifecycleTestRegistry(
		t,
		map[string]Controller{"block-a": first, "block-b": second},
		map[string]string{"block-a": "tab", "block-b": "tab"},
	)
	installLifecycleTestPolicy(t, true, 16, func(string) {})
	done := make(chan struct{})
	go func() {
		destroyBlockControllersForTab("tab")
		close(done)
	}()
	for name, started := range map[string]<-chan struct{}{
		"first":  first.started,
		"second": second.started,
	} {
		select {
		case <-started:
		case <-time.After(time.Second):
			close(first.release)
			close(second.release)
			t.Fatalf("%s controller did not begin stopping concurrently", name)
		}
	}
	close(first.release)
	close(second.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("concurrent tab destroy did not finish")
	}
}

func TestTabReapWaitsForInFlightControllerOperation(t *testing.T) {
	controller := &lifecycleTestController{status: Status_Running}
	installLifecycleTestRegistry(
		t,
		map[string]Controller{"block": controller},
		map[string]string{"block": "tab"},
	)
	installLifecycleTestPolicy(t, true, 16, func(string) {})
	tabLock := getTabControllerMutex("tab")
	tabLock.RLock()
	done := make(chan struct{})
	go func() {
		destroyBlockControllersForTab("tab")
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("tab reap passed an in-flight controller operation")
	case <-time.After(30 * time.Millisecond):
	}
	if stopCount, _ := controller.stopResult(); stopCount != 0 {
		t.Fatalf("controller stopped during in-flight operation %d times", stopCount)
	}
	tabLock.RUnlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("tab reap did not continue after operation completed")
	}
	if stopCount, _ := controller.stopResult(); stopCount != 1 {
		t.Fatalf("controller stop count = %d, want 1", stopCount)
	}
}

func TestEmbeddedDestroyWaitsForAsyncShellStartupAndStopsItAgain(t *testing.T) {
	runLock := &atomic.Bool{}
	runLock.Store(true)
	controller := &ShellController{
		Lock:       &sync.Mutex{},
		BlockId:    "block",
		TabId:      "tab",
		RunLock:    runLock,
		ProcStatus: Status_Init,
	}
	installLifecycleTestRegistry(
		t,
		map[string]Controller{"block": controller},
		map[string]string{"block": "tab"},
	)
	installLifecycleTestPolicy(t, true, 16, func(string) {})
	done := make(chan struct{})
	go func() {
		DestroyBlockController("block")
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("destroy returned while asynchronous shell startup was still active")
	case <-time.After(30 * time.Millisecond):
	}
	controller.Lock.Lock()
	controller.ProcStatus = Status_Running
	controller.Lock.Unlock()
	runLock.Store(false)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("destroy did not finish after shell startup quiesced")
	}
	if status := controller.GetRuntimeStatus(); status.ShellProcStatus != Status_Done {
		t.Fatalf("late shell status = %q, want done", status.ShellProcStatus)
	}
}

func TestStandaloneDestroyPreservesUpstreamRegistryOrdering(t *testing.T) {
	controller := &shutdownTestController{
		status: BlockControllerRuntimeStatus{
			ShellProcStatus: Status_Running,
		},
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	installLifecycleTestRegistry(
		t,
		map[string]Controller{"block": controller},
		map[string]string{"block": "tab"},
	)
	installLifecycleTestPolicy(t, false, 16, func(string) {})
	done := make(chan struct{})
	go func() {
		DestroyBlockController("block")
		close(done)
	}()
	select {
	case <-controller.started:
	case <-time.After(time.Second):
		t.Fatal("standalone controller was not stopped")
	}
	if getController("block") != controller {
		t.Fatal("standalone controller was removed before upstream Stop completed")
	}
	close(controller.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("standalone destroy did not finish")
	}
	if getController("block") != nil {
		t.Fatal("standalone controller remained after Stop completed")
	}
}

func TestEmbeddedLocalPTYAdmissionRejectsSeventeenthAttachedController(t *testing.T) {
	installLifecycleTestRegistry(t, map[string]Controller{}, map[string]string{})
	coordinator := installLifecycleTestPolicy(t, true, 16, func(string) {})
	for index := 0; index < 16; index++ {
		tabID := "tab-" + string(rune('a'+index))
		if err := coordinator.Attach(tabID); err != nil {
			t.Fatalf("Attach %s failed: %v", tabID, err)
		}
		if err := reserveLocalPTY(tabID, "block-"+tabID, BlockController_Shell, ""); err != nil {
			t.Fatalf("reserve %s failed: %v", tabID, err)
		}
	}
	if err := coordinator.Attach("tab-q"); err != nil {
		t.Fatalf("Attach tab-q failed: %v", err)
	}
	if err := reserveLocalPTY("tab-q", "block-q", BlockController_Cmd, "local"); !errors.Is(err, sessionpolicy.ErrPTYLimit) {
		t.Fatalf("17th reserve error = %v, want ErrPTYLimit", err)
	}
}

func TestRemoteAndStandaloneControllersKeepUpstreamAdmissionBehavior(t *testing.T) {
	installLifecycleTestRegistry(t, map[string]Controller{}, map[string]string{})
	coordinator := installLifecycleTestPolicy(t, false, 1, func(string) {})
	for index := 0; index < 20; index++ {
		if err := reserveLocalPTY("tab", "standalone", BlockController_Shell, ""); err != nil {
			t.Fatalf("standalone reserve failed: %v", err)
		}
	}
	if got := coordinator.LivePTYs(); got != 0 {
		t.Fatalf("standalone reservations = %d, want 0", got)
	}

	embeddedSessionPolicyEnabled = func() bool { return true }
	if err := reserveLocalPTY("tab", "remote", BlockController_Shell, "ssh://example"); err != nil {
		t.Fatalf("remote reserve failed: %v", err)
	}
	if err := reserveLocalPTY("tab", "tsunami", BlockController_Tsunami, ""); err != nil {
		t.Fatalf("non-terminal reserve failed: %v", err)
	}
	if got := coordinator.LivePTYs(); got != 0 {
		t.Fatalf("non-local reservations = %d, want 0", got)
	}
}

func TestFinishedPTYReservationIsReleasedBeforeAdmission(t *testing.T) {
	done := &lifecycleTestController{status: Status_Done}
	installLifecycleTestRegistry(
		t,
		map[string]Controller{"block-done": done},
		map[string]string{"block-done": "tab-done"},
	)
	coordinator := installLifecycleTestPolicy(t, true, 1, func(string) {})
	if err := coordinator.Admit("tab-done", "block-done"); err != nil {
		t.Fatalf("seeding done reservation failed: %v", err)
	}
	if err := coordinator.Attach("tab-new"); err != nil {
		t.Fatalf("Attach new tab failed: %v", err)
	}

	if err := reserveLocalPTY("tab-new", "block-new", BlockController_Shell, ""); err != nil {
		t.Fatalf("reserve after process exit failed: %v", err)
	}
	if coordinator.HasPTY("block-done") {
		t.Fatal("finished PTY reservation was not released")
	}
	if !coordinator.HasPTY("block-new") {
		t.Fatal("new PTY reservation is missing")
	}
}

func TestEmbeddedControllerTabOwnershipUsesServerRelationship(t *testing.T) {
	findTab := func(blockID string) (string, error) {
		if blockID != "block" {
			t.Fatalf("lookup block = %q, want block", blockID)
		}
		return "tab-server", nil
	}
	if err := validateControllerTabOwnership("tab-server", "block", findTab); err != nil {
		t.Fatalf("server-owned tab relationship rejected: %v", err)
	}
	if err := validateControllerTabOwnership("tab-client", "block", findTab); err == nil {
		t.Fatal("client-selected tab relationship was accepted")
	}
	lookupErr := errors.New("missing block relationship")
	if err := validateControllerTabOwnership(
		"tab-server",
		"block",
		func(string) (string, error) { return "", lookupErr },
	); !errors.Is(err, lookupErr) {
		t.Fatalf("lookup error = %v, want %v", err, lookupErr)
	}
}

func TestEmbeddedControllerPolicyAllowsOnlyLocalShell(t *testing.T) {
	allowsShell := func(controller string) bool { return controller == BlockController_Shell }
	for _, test := range []struct {
		name       string
		embedded   bool
		controller string
		connection string
		wantError  bool
	}{
		{name: "local shell", embedded: true, controller: BlockController_Shell},
		{name: "local alias", embedded: true, controller: BlockController_Shell, connection: "local"},
		{name: "command", embedded: true, controller: BlockController_Cmd, wantError: true},
		{name: "tsunami", embedded: true, controller: BlockController_Tsunami, wantError: true},
		{name: "remote shell", embedded: true, controller: BlockController_Shell, connection: "ssh://example", wantError: true},
		{name: "standalone upstream", controller: BlockController_Tsunami, connection: "ssh://example"},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateControllerPolicy(
				test.embedded,
				test.controller,
				test.connection,
				allowsShell,
			)
			if (err != nil) != test.wantError {
				t.Fatalf("validateControllerPolicy error = %v, wantError %v", err, test.wantError)
			}
		})
	}
}
