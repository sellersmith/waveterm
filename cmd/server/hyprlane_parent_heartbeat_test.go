// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"io"
	"strings"
	"testing"
	"time"
)

const parentHeartbeatTestNonce = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

func TestParentHeartbeatRejectsWrongNonce(t *testing.T) {
	err := watchParentHeartbeats(
		strings.NewReader(parentHeartbeatPrefix+strings.Repeat("0", 64)+"\n"),
		parentHeartbeatTestNonce,
		100*time.Millisecond,
	)
	if err == nil || !strings.Contains(err.Error(), "invalid parent heartbeat") {
		t.Fatalf("error = %v, want invalid parent heartbeat", err)
	}
}

func TestParentHeartbeatLeaseExpires(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	startedAt := time.Now()
	err := watchParentHeartbeats(reader, parentHeartbeatTestNonce, 25*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "lease expired") {
		t.Fatalf("error = %v, want lease expired", err)
	}
	if elapsed := time.Since(startedAt); elapsed < 20*time.Millisecond || elapsed > time.Second {
		t.Fatalf("heartbeat lease elapsed = %v", elapsed)
	}
}

func TestParentHeartbeatRefreshesLeaseUntilPipeCloses(t *testing.T) {
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- watchParentHeartbeats(reader, parentHeartbeatTestNonce, 60*time.Millisecond)
	}()

	frame := parentHeartbeatPrefix + parentHeartbeatTestNonce + "\n"
	for range 3 {
		if _, err := writer.Write([]byte(frame)); err != nil {
			t.Fatalf("write heartbeat: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close heartbeat pipe: %v", err)
	}
	err := <-done
	if err == nil || !strings.Contains(err.Error(), "stdin closed") {
		t.Fatalf("error = %v, want stdin closed", err)
	}
}
