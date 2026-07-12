// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package sessionpolicy

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	clock    *fakeClock
	deadline time.Time
	callback func()
	stopped  bool
	fired    bool
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Unix(1_000, 0)}
}

func (clock *fakeClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *fakeClock) AfterFunc(delay time.Duration, callback func()) Timer {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	timer := &fakeTimer{
		clock:    clock,
		deadline: clock.now.Add(delay),
		callback: callback,
	}
	clock.timers = append(clock.timers, timer)
	return timer
}

func (timer *fakeTimer) Stop() bool {
	timer.clock.mu.Lock()
	defer timer.clock.mu.Unlock()
	if timer.stopped || timer.fired {
		return false
	}
	timer.stopped = true
	return true
}

func (clock *fakeClock) Advance(by time.Duration) {
	clock.mu.Lock()
	clock.now = clock.now.Add(by)
	var due []*fakeTimer
	for _, timer := range clock.timers {
		if timer.stopped || timer.fired || timer.deadline.After(clock.now) {
			continue
		}
		timer.fired = true
		due = append(due, timer)
	}
	clock.mu.Unlock()

	sort.Slice(due, func(i int, j int) bool {
		return due[i].deadline.Before(due[j].deadline)
	})
	for _, timer := range due {
		timer.callback()
	}
}

func newTestCoordinator(
	t *testing.T,
	clock Clock,
	maxLivePTYs int,
	ttl time.Duration,
	reapTab func(string),
) *Coordinator {
	t.Helper()
	coordinator, err := NewCoordinator(Options{
		Clock:       clock,
		MaxLivePTYs: maxLivePTYs,
		DetachedTTL: ttl,
		ReapTab:     reapTab,
	})
	if err != nil {
		t.Fatalf("NewCoordinator failed: %v", err)
	}
	return coordinator
}

func TestDetachedLeaseExpiresAtExactlySixtySeconds(t *testing.T) {
	clock := newFakeClock()
	var reaped []string
	coordinator := newTestCoordinator(t, clock, 16, 60*time.Second, func(tabID string) {
		reaped = append(reaped, tabID)
	})

	if err := coordinator.Attach("tab-a"); err != nil {
		t.Fatalf("Attach failed: %v", err)
	}
	if err := coordinator.Admit("tab-a", "pty-a"); err != nil {
		t.Fatalf("Admit failed: %v", err)
	}
	coordinator.Detach("tab-a")

	clock.Advance(60*time.Second - time.Nanosecond)
	if len(reaped) != 0 {
		t.Fatalf("reaped before TTL: %v", reaped)
	}
	if got := coordinator.LivePTYs(); got != 1 {
		t.Fatalf("live PTYs before TTL = %d, want 1", got)
	}

	clock.Advance(time.Nanosecond)
	if fmt.Sprint(reaped) != "[tab-a]" {
		t.Fatalf("reaped tabs = %v, want [tab-a]", reaped)
	}
	if got := coordinator.LivePTYs(); got != 0 {
		t.Fatalf("live PTYs after TTL = %d, want 0", got)
	}
}

func TestReapedTabRejectsStaleWorkUntilAuthenticatedReattach(t *testing.T) {
	clock := newFakeClock()
	coordinator := newTestCoordinator(t, clock, 16, 60*time.Second, func(string) {})
	if err := coordinator.Attach("tab-a"); err != nil {
		t.Fatalf("Attach failed: %v", err)
	}
	if err := coordinator.Admit("tab-a", "pty-a"); err != nil {
		t.Fatalf("Admit failed: %v", err)
	}
	coordinator.Detach("tab-a")
	clock.Advance(60 * time.Second)

	if err := coordinator.AuthorizeControllerOperation("tab-a"); !errors.Is(err, ErrTabReaping) {
		t.Fatalf("stale operation error = %v, want ErrTabReaping", err)
	}
	if err := coordinator.Admit("tab-a", "pty-stale"); !errors.Is(err, ErrTabReaping) {
		t.Fatalf("stale admission error = %v, want ErrTabReaping", err)
	}
	if err := coordinator.Attach("tab-a"); err != nil {
		t.Fatalf("authenticated reattach failed: %v", err)
	}
	if err := coordinator.AuthorizeControllerOperation("tab-a"); err != nil {
		t.Fatalf("operation after reattach failed: %v", err)
	}
	if err := coordinator.Admit("tab-a", "pty-new"); err != nil {
		t.Fatalf("admission after reattach failed: %v", err)
	}
}

func TestReconnectCancelsPendingReapAndPreservesReservation(t *testing.T) {
	clock := newFakeClock()
	var reaped []string
	coordinator := newTestCoordinator(t, clock, 16, 60*time.Second, func(tabID string) {
		reaped = append(reaped, tabID)
	})

	if err := coordinator.Attach("tab-a"); err != nil {
		t.Fatalf("initial Attach failed: %v", err)
	}
	if err := coordinator.Admit("tab-a", "pty-a"); err != nil {
		t.Fatalf("Admit failed: %v", err)
	}
	coordinator.Detach("tab-a")
	clock.Advance(59 * time.Second)
	if err := coordinator.Attach("tab-a"); err != nil {
		t.Fatalf("reconnect Attach failed: %v", err)
	}
	clock.Advance(2 * time.Minute)

	if len(reaped) != 0 {
		t.Fatalf("reaped after successful reconnect: %v", reaped)
	}
	if got := coordinator.LivePTYs(); got != 1 {
		t.Fatalf("live PTYs after reconnect = %d, want 1", got)
	}
}

func TestExpiryClaimBeatsReconnectAtomically(t *testing.T) {
	clock := newFakeClock()
	reapStarted := make(chan struct{})
	allowReap := make(chan struct{})
	coordinator := newTestCoordinator(t, clock, 16, 60*time.Second, func(string) {
		close(reapStarted)
		<-allowReap
	})

	if err := coordinator.Attach("tab-a"); err != nil {
		t.Fatalf("Attach failed: %v", err)
	}
	if err := coordinator.Admit("tab-a", "pty-a"); err != nil {
		t.Fatalf("Admit failed: %v", err)
	}
	coordinator.Detach("tab-a")

	advanceDone := make(chan struct{})
	go func() {
		clock.Advance(60 * time.Second)
		close(advanceDone)
	}()
	<-reapStarted

	if err := coordinator.Attach("tab-a"); !errors.Is(err, ErrTabReaping) {
		t.Fatalf("Attach during reap error = %v, want ErrTabReaping", err)
	}
	close(allowReap)
	<-advanceDone
	if got := coordinator.LivePTYs(); got != 0 {
		t.Fatalf("live PTYs after winning reap = %d, want 0", got)
	}
}

func TestReconnectClaimBeatsExpiryAtomically(t *testing.T) {
	clock := newFakeClock()
	var reapCount int
	coordinator := newTestCoordinator(t, clock, 16, 60*time.Second, func(string) {
		reapCount++
	})

	if err := coordinator.Attach("tab-a"); err != nil {
		t.Fatalf("Attach failed: %v", err)
	}
	if err := coordinator.Admit("tab-a", "pty-a"); err != nil {
		t.Fatalf("Admit failed: %v", err)
	}
	coordinator.Detach("tab-a")
	if err := coordinator.Attach("tab-a"); err != nil {
		t.Fatalf("reconnect Attach failed: %v", err)
	}

	clock.Advance(60 * time.Second)
	if reapCount != 0 {
		t.Fatalf("reap count = %d, want 0", reapCount)
	}
	if got := coordinator.LivePTYs(); got != 1 {
		t.Fatalf("live PTYs = %d, want 1", got)
	}
}

func TestSeventeenthAttachedPTYIsRejected(t *testing.T) {
	coordinator := newTestCoordinator(t, newFakeClock(), 16, 60*time.Second, func(string) {})
	for index := 0; index < 16; index++ {
		tabID := fmt.Sprintf("tab-%02d", index)
		if err := coordinator.Attach(tabID); err != nil {
			t.Fatalf("Attach %s failed: %v", tabID, err)
		}
		if err := coordinator.Admit(tabID, fmt.Sprintf("pty-%02d", index)); err != nil {
			t.Fatalf("Admit %s failed: %v", tabID, err)
		}
	}

	if err := coordinator.Attach("tab-17"); err != nil {
		t.Fatalf("Attach tab-17 failed: %v", err)
	}
	if err := coordinator.Admit("tab-17", "pty-17"); !errors.Is(err, ErrPTYLimit) {
		t.Fatalf("17th Admit error = %v, want ErrPTYLimit", err)
	}
	if got := coordinator.LivePTYs(); got != 16 {
		t.Fatalf("live PTYs = %d, want 16", got)
	}
}

func TestConcurrentAdmissionNeverExceedsHardCap(t *testing.T) {
	coordinator := newTestCoordinator(t, newFakeClock(), 16, 60*time.Second, func(string) {})
	const attempts = 64
	for index := 0; index < attempts; index++ {
		if err := coordinator.Attach(fmt.Sprintf("tab-%02d", index)); err != nil {
			t.Fatalf("Attach %d failed: %v", index, err)
		}
	}

	start := make(chan struct{})
	results := make(chan error, attempts)
	var waitGroup sync.WaitGroup
	for index := 0; index < attempts; index++ {
		waitGroup.Add(1)
		go func(number int) {
			defer waitGroup.Done()
			<-start
			results <- coordinator.Admit(
				fmt.Sprintf("tab-%02d", number),
				fmt.Sprintf("pty-%02d", number),
			)
		}(index)
	}
	close(start)
	waitGroup.Wait()
	close(results)

	var admitted int
	var rejected int
	for err := range results {
		switch {
		case err == nil:
			admitted++
		case errors.Is(err, ErrPTYLimit):
			rejected++
		default:
			t.Fatalf("unexpected admission error: %v", err)
		}
	}
	if admitted != 16 || rejected != attempts-16 {
		t.Fatalf("admitted=%d rejected=%d, want 16/%d", admitted, rejected, attempts-16)
	}
	if got := coordinator.LivePTYs(); got != 16 {
		t.Fatalf("live PTYs = %d, want 16", got)
	}
}

func TestAdmissionReapsOldestDetachedTabBeforeReservingSlot(t *testing.T) {
	clock := newFakeClock()
	var reaped []string
	var coordinator *Coordinator
	coordinator = newTestCoordinator(t, clock, 16, 60*time.Second, func(tabID string) {
		reaped = append(reaped, tabID)
		coordinator.Release("pty-00")
	})
	for index := 0; index < 16; index++ {
		tabID := fmt.Sprintf("tab-%02d", index)
		if err := coordinator.Attach(tabID); err != nil {
			t.Fatalf("Attach %s failed: %v", tabID, err)
		}
		if err := coordinator.Admit(tabID, fmt.Sprintf("pty-%02d", index)); err != nil {
			t.Fatalf("Admit %s failed: %v", tabID, err)
		}
	}
	coordinator.Detach("tab-00")
	clock.Advance(time.Second)
	coordinator.Detach("tab-01")

	if err := coordinator.Attach("tab-new"); err != nil {
		t.Fatalf("Attach tab-new failed: %v", err)
	}
	if err := coordinator.Admit("tab-new", "pty-new"); err != nil {
		t.Fatalf("Admit with detached victim failed: %v", err)
	}

	if fmt.Sprint(reaped) != "[tab-00]" {
		t.Fatalf("reaped tabs = %v, want oldest [tab-00]", reaped)
	}
	if got := coordinator.LivePTYs(); got != 16 {
		t.Fatalf("live PTYs after replacement = %d, want 16", got)
	}
	if !coordinator.HasPTY("pty-new") {
		t.Fatal("new PTY reservation is missing")
	}
}

func TestAdmissionReapsEveryPTYInOldestDetachedTab(t *testing.T) {
	clock := newFakeClock()
	var reaped []string
	coordinator := newTestCoordinator(t, clock, 3, 60*time.Second, func(tabID string) {
		reaped = append(reaped, tabID)
	})
	if err := coordinator.Attach("tab-old"); err != nil {
		t.Fatalf("Attach old tab failed: %v", err)
	}
	if err := coordinator.Admit("tab-old", "pty-old-a"); err != nil {
		t.Fatalf("Admit old a failed: %v", err)
	}
	if err := coordinator.Admit("tab-old", "pty-old-b"); err != nil {
		t.Fatalf("Admit old b failed: %v", err)
	}
	if err := coordinator.Attach("tab-live"); err != nil {
		t.Fatalf("Attach live tab failed: %v", err)
	}
	if err := coordinator.Admit("tab-live", "pty-live"); err != nil {
		t.Fatalf("Admit live failed: %v", err)
	}
	coordinator.Detach("tab-old")

	if err := coordinator.Attach("tab-new"); err != nil {
		t.Fatalf("Attach new tab failed: %v", err)
	}
	if err := coordinator.Admit("tab-new", "pty-new"); err != nil {
		t.Fatalf("Admit new failed: %v", err)
	}

	if fmt.Sprint(reaped) != "[tab-old]" {
		t.Fatalf("reaped tabs = %v, want [tab-old]", reaped)
	}
	if coordinator.HasPTY("pty-old-a") || coordinator.HasPTY("pty-old-b") {
		t.Fatal("old tab PTY reservations survived tab reap")
	}
	if got := coordinator.LivePTYs(); got != 2 {
		t.Fatalf("live PTYs = %d, want 2", got)
	}
}

func TestConcurrentAdmissionWaitsForClaimedTabProcessesToBeReaped(t *testing.T) {
	clock := newFakeClock()
	reapStarted := make(chan struct{})
	allowReap := make(chan struct{})
	coordinator := newTestCoordinator(t, clock, 3, 60*time.Second, func(string) {
		close(reapStarted)
		<-allowReap
	})
	if err := coordinator.Attach("tab-old"); err != nil {
		t.Fatalf("Attach old tab failed: %v", err)
	}
	for _, ptyID := range []string{"pty-old-a", "pty-old-b"} {
		if err := coordinator.Admit("tab-old", ptyID); err != nil {
			t.Fatalf("Admit %s failed: %v", ptyID, err)
		}
	}
	if err := coordinator.Attach("tab-live"); err != nil {
		t.Fatalf("Attach live tab failed: %v", err)
	}
	if err := coordinator.Admit("tab-live", "pty-live"); err != nil {
		t.Fatalf("Admit live failed: %v", err)
	}
	coordinator.Detach("tab-old")
	if err := coordinator.Attach("tab-new-a"); err != nil {
		t.Fatalf("Attach first new tab failed: %v", err)
	}
	if err := coordinator.Attach("tab-new-b"); err != nil {
		t.Fatalf("Attach second new tab failed: %v", err)
	}

	firstResult := make(chan error, 1)
	go func() {
		firstResult <- coordinator.Admit("tab-new-a", "pty-new-a")
	}()
	<-reapStarted

	secondResult := make(chan error, 1)
	go func() {
		secondResult <- coordinator.Admit("tab-new-b", "pty-new-b")
	}()
	select {
	case err := <-secondResult:
		t.Fatalf("second admission returned before old processes were reaped: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	close(allowReap)
	for name, result := range map[string]<-chan error{
		"first":  firstResult,
		"second": secondResult,
	} {
		select {
		case err := <-result:
			if err != nil {
				t.Fatalf("%s admission failed: %v", name, err)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s admission stayed blocked after reap", name)
		}
	}
	if got := coordinator.LivePTYs(); got != 3 {
		t.Fatalf("live PTYs = %d, want 3", got)
	}
}

func TestReservationIsIdempotentAndCannotMoveTabs(t *testing.T) {
	coordinator := newTestCoordinator(t, newFakeClock(), 1, 60*time.Second, func(string) {})
	if err := coordinator.Admit("tab-a", "pty-a"); err != nil {
		t.Fatalf("initial Admit failed: %v", err)
	}
	if err := coordinator.Admit("tab-a", "pty-a"); err != nil {
		t.Fatalf("idempotent Admit failed: %v", err)
	}
	if err := coordinator.Admit("tab-b", "pty-a"); !errors.Is(err, ErrPTYAlreadyReserved) {
		t.Fatalf("moving reservation error = %v, want ErrPTYAlreadyReserved", err)
	}
	if got := coordinator.LivePTYs(); got != 1 {
		t.Fatalf("live PTYs = %d, want 1", got)
	}
}
