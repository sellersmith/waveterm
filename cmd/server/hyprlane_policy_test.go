// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"os"
	"strconv"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/hyprlane/policy"
)

var (
	embeddedServerPolicyOnce sync.Once
	embeddedServerPolicyErr  error
)

func initializeEmbeddedServerPolicy(t *testing.T) {
	t.Helper()
	embeddedServerPolicyOnce.Do(func() {
		reader, writer, err := os.Pipe()
		if err != nil {
			embeddedServerPolicyErr = fmt.Errorf("os.Pipe: %w", err)
			return
		}
		bootstrap := fmt.Sprintf(
			`{"schemaVersion":1,"authKey":%q,"startupNonce":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789","parentPid":123,"allowedOrigin":"app://bundle","allowWaveCloud":false}`,
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		)
		if _, err := writer.WriteString(bootstrap); err != nil {
			embeddedServerPolicyErr = fmt.Errorf("write bootstrap: %w", err)
			return
		}
		if err := writer.Close(); err != nil {
			embeddedServerPolicyErr = fmt.Errorf("close bootstrap writer: %w", err)
			return
		}
		os.Setenv(policy.EnvEmbedded, "1")
		os.Setenv(policy.EnvBootstrapFD, strconv.FormatUint(uint64(reader.Fd()), 10))
		_, embeddedServerPolicyErr = policy.InitializeFromEnvironment()
	})
	if embeddedServerPolicyErr != nil {
		t.Fatalf("InitializeFromEnvironment: %v", embeddedServerPolicyErr)
	}
}

func TestEmbeddedRuntimeDoesNotStartTelemetryBackgroundWork(t *testing.T) {
	initializeEmbeddedServerPolicy(t)
	if telemetryBackgroundEnabled() {
		t.Fatal("embedded runtime must not start telemetry or diagnostic loops")
	}
	for _, backgroundLoop := range []string{"jobs", "wave.ai.config"} {
		if optionalBackgroundLoopEnabled(backgroundLoop) {
			t.Fatalf("embedded runtime must not start %q", backgroundLoop)
		}
	}
}
