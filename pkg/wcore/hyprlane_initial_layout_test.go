// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"fmt"
	"os"
	"strconv"
	"testing"

	"github.com/wavetermdev/waveterm/hyprlane/policy"
)

func TestEmbeddedFirstLaunchCreatesTerminalLayout(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	bootstrap := fmt.Sprintf(
		`{"schemaVersion":1,"authKey":%q,"startupNonce":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789","parentPid":123,"allowedOrigin":"app://bundle","allowWaveCloud":false}`,
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	)
	if _, err := writer.WriteString(bootstrap); err != nil {
		t.Fatalf("write bootstrap: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close bootstrap writer: %v", err)
	}
	t.Setenv(policy.EnvEmbedded, "1")
	t.Setenv(policy.EnvBootstrapFD, strconv.FormatUint(uint64(reader.Fd()), 10))
	if _, err := policy.InitializeFromEnvironment(); err != nil {
		t.Fatalf("InitializeFromEnvironment: %v", err)
	}
	if !shouldApplyInitialTabLayout(true) {
		t.Fatal("embedded first launch must create a real terminal without Wave onboarding")
	}
}
