// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package authkey

import (
	"fmt"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"

	"github.com/wavetermdev/waveterm/hyprlane/policy"
)

func TestEmbeddedAuthKeyComesFromInheritedBootstrap(t *testing.T) {
	const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	bootstrap := fmt.Sprintf(
		`{"schemaVersion":1,"authKey":%q,"startupNonce":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789","parentPid":123,"allowedOrigin":"app://bundle","allowWaveCloud":false}`,
		key,
	)
	if _, err := writer.WriteString(bootstrap); err != nil {
		t.Fatalf("write bootstrap: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close bootstrap writer: %v", err)
	}
	t.Setenv(policy.EnvEmbedded, "1")
	t.Setenv(policy.EnvBootstrapFD, strconv.FormatUint(uint64(reader.Fd()), 10))
	t.Setenv(WaveAuthKeyEnv, "must-not-be-used")
	if _, err := policy.InitializeFromEnvironment(); err != nil {
		t.Fatalf("InitializeFromEnvironment: %v", err)
	}
	if err := SetAuthKeyFromEnv(); err != nil {
		t.Fatalf("SetAuthKeyFromEnv: %v", err)
	}
	if value, ok := os.LookupEnv(WaveAuthKeyEnv); ok {
		t.Fatalf("auth environment leaked with value %q", value)
	}

	request := httptest.NewRequest("GET", "http://127.0.0.1/wave/service", nil)
	request.Header.Set(AuthKeyHeader, key)
	if err := ValidateIncomingRequest(request); err != nil {
		t.Fatalf("valid key rejected: %v", err)
	}
	request.Header.Set(AuthKeyHeader, key[:63]+"0")
	if err := ValidateIncomingRequest(request); err == nil {
		t.Fatal("wrong key accepted")
	}
}
