// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

// Package sessionpolicy coordinates the lifecycle and admission policy for
// local terminal processes owned by the Wave-derived Hyprlane core.
package sessionpolicy

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

const (
	MaxLivePTYs = 16
	DetachedTTL = 60 * time.Second
)

var (
	ErrPTYLimit           = errors.New("local PTY limit reached")
	ErrPTYAlreadyReserved = errors.New("PTY is already reserved by another tab")
	ErrTabReaping         = errors.New("tab controllers are being reaped")
)

type Timer interface {
	Stop() bool
}

type Clock interface {
	Now() time.Time
	AfterFunc(time.Duration, func()) Timer
}

type wallClock struct{}

func (wallClock) Now() time.Time {
	return time.Now()
}

func (wallClock) AfterFunc(delay time.Duration, callback func()) Timer {
	return time.AfterFunc(delay, callback)
}

type Options struct {
	Clock       Clock
	MaxLivePTYs int
	DetachedTTL time.Duration
	ReapTab     func(string)
}

type tabState struct {
	attached   bool
	detachedAt time.Time
	generation uint64
	reaped     bool
	reaping    bool
	timer      Timer
	ptys       map[string]struct{}
}

type Coordinator struct {
	mu          sync.Mutex
	reapCond    *sync.Cond
	reapsActive int
	clock       Clock
	maxLivePTYs int
	detachedTTL time.Duration
	reapTab     func(string)
	tabs        map[string]*tabState
	ptyOwners   map[string]string
}

func NewCoordinator(options Options) (*Coordinator, error) {
	if options.Clock == nil {
		return nil, fmt.Errorf("session policy clock is required")
	}
	if options.MaxLivePTYs <= 0 {
		return nil, fmt.Errorf("session policy PTY limit must be positive")
	}
	if options.DetachedTTL <= 0 {
		return nil, fmt.Errorf("session policy detached TTL must be positive")
	}
	if options.ReapTab == nil {
		return nil, fmt.Errorf("session policy tab reaper is required")
	}
	coordinator := &Coordinator{
		clock:       options.Clock,
		maxLivePTYs: options.MaxLivePTYs,
		detachedTTL: options.DetachedTTL,
		reapTab:     options.ReapTab,
		tabs:        make(map[string]*tabState),
		ptyOwners:   make(map[string]string),
	}
	coordinator.reapCond = sync.NewCond(&coordinator.mu)
	return coordinator, nil
}

func mustDefaultCoordinator() *Coordinator {
	coordinator, err := NewCoordinator(Options{
		Clock:       wallClock{},
		MaxLivePTYs: MaxLivePTYs,
		DetachedTTL: DetachedTTL,
		ReapTab:     func(string) {},
	})
	if err != nil {
		panic(err)
	}
	return coordinator
}

var DefaultCoordinator = mustDefaultCoordinator()

func (coordinator *Coordinator) SetReapTab(reapTab func(string)) error {
	if reapTab == nil {
		return fmt.Errorf("session policy tab reaper is required")
	}
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	coordinator.reapTab = reapTab
	return nil
}

func (coordinator *Coordinator) stateForTabLocked(tabID string) *tabState {
	state := coordinator.tabs[tabID]
	if state == nil {
		state = &tabState{ptys: make(map[string]struct{})}
		coordinator.tabs[tabID] = state
	}
	return state
}

func (coordinator *Coordinator) Attach(tabID string) error {
	if tabID == "" {
		return fmt.Errorf("tab id is required")
	}
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	state := coordinator.stateForTabLocked(tabID)
	if state.reaping {
		return ErrTabReaping
	}
	state.attached = true
	state.reaped = false
	state.generation++
	if state.timer != nil {
		state.timer.Stop()
		state.timer = nil
	}
	return nil
}

func (coordinator *Coordinator) Detach(tabID string) {
	if tabID == "" {
		return
	}
	coordinator.mu.Lock()
	state := coordinator.tabs[tabID]
	if state == nil || !state.attached || state.reaping {
		coordinator.mu.Unlock()
		return
	}
	state.attached = false
	state.detachedAt = coordinator.clock.Now()
	state.generation++
	generation := state.generation
	state.timer = coordinator.clock.AfterFunc(coordinator.detachedTTL, func() {
		coordinator.expire(tabID, generation)
	})
	coordinator.mu.Unlock()
}

func (coordinator *Coordinator) oldestDetachedTabLocked(excludeTabID string) (string, *tabState) {
	var oldestID string
	var oldest *tabState
	for tabID, state := range coordinator.tabs {
		if tabID == excludeTabID || state.attached || state.reaping || len(state.ptys) == 0 {
			continue
		}
		if oldest == nil || state.detachedAt.Before(oldest.detachedAt) ||
			(state.detachedAt.Equal(oldest.detachedAt) && tabID < oldestID) {
			oldestID = tabID
			oldest = state
		}
	}
	return oldestID, oldest
}

func (coordinator *Coordinator) claimTabLocked(tabID string, state *tabState) func(string) {
	coordinator.reapsActive++
	state.reaping = true
	state.generation++
	if state.timer != nil {
		state.timer.Stop()
		state.timer = nil
	}
	for ptyID := range state.ptys {
		delete(coordinator.ptyOwners, ptyID)
	}
	clear(state.ptys)
	return coordinator.reapTab
}

func (coordinator *Coordinator) finishReap(tabID string, state *tabState) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if coordinator.tabs[tabID] == state && state.reaping {
		state.reaping = false
		state.reaped = true
	}
	coordinator.reapsActive--
	coordinator.reapCond.Broadcast()
}

func (coordinator *Coordinator) expire(tabID string, generation uint64) {
	coordinator.mu.Lock()
	state := coordinator.tabs[tabID]
	if state == nil || state.attached || state.reaping || state.generation != generation {
		coordinator.mu.Unlock()
		return
	}
	reapTab := coordinator.claimTabLocked(tabID, state)
	coordinator.mu.Unlock()

	defer coordinator.finishReap(tabID, state)
	reapTab(tabID)
}

func (coordinator *Coordinator) Admit(tabID string, ptyID string) error {
	if tabID == "" || ptyID == "" {
		return fmt.Errorf("tab id and PTY id are required")
	}
	coordinator.mu.Lock()
	for coordinator.reapsActive > 0 {
		coordinator.reapCond.Wait()
	}
	if ownerTabID, found := coordinator.ptyOwners[ptyID]; found {
		coordinator.mu.Unlock()
		if ownerTabID == tabID {
			return nil
		}
		return ErrPTYAlreadyReserved
	}

	requestState := coordinator.stateForTabLocked(tabID)
	if requestState.reaping || requestState.reaped {
		coordinator.mu.Unlock()
		return ErrTabReaping
	}

	var victimID string
	var victimState *tabState
	var reapTab func(string)
	if len(coordinator.ptyOwners) >= coordinator.maxLivePTYs {
		victimID, victimState = coordinator.oldestDetachedTabLocked(tabID)
		if victimState == nil {
			coordinator.mu.Unlock()
			return ErrPTYLimit
		}
		reapTab = coordinator.claimTabLocked(victimID, victimState)
	}

	coordinator.ptyOwners[ptyID] = tabID
	requestState.ptys[ptyID] = struct{}{}
	coordinator.mu.Unlock()

	if victimState != nil {
		defer coordinator.finishReap(victimID, victimState)
		reapTab(victimID)
	}
	return nil
}

func (coordinator *Coordinator) AuthorizeControllerOperation(tabID string) error {
	if tabID == "" {
		return fmt.Errorf("tab id is required")
	}
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	state := coordinator.tabs[tabID]
	if state != nil && (state.reaping || state.reaped) {
		return ErrTabReaping
	}
	return nil
}

func (coordinator *Coordinator) Release(ptyID string) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	tabID, found := coordinator.ptyOwners[ptyID]
	if !found {
		return
	}
	delete(coordinator.ptyOwners, ptyID)
	if state := coordinator.tabs[tabID]; state != nil {
		delete(state.ptys, ptyID)
	}
}

func (coordinator *Coordinator) LivePTYs() int {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	return len(coordinator.ptyOwners)
}

func (coordinator *Coordinator) HasPTY(ptyID string) bool {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	_, found := coordinator.ptyOwners[ptyID]
	return found
}
