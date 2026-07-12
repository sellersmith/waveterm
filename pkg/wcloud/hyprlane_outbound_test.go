// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package wcloud

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/wavetermdev/waveterm/hyprlane/policy"
)

func TestEmbeddedPolicyBlocksWaveCloudBeforeNetwork(t *testing.T) {
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

	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, server.URL, nil)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	req.Header.Set("X-PromptAPIUrl", "/telemetry")
	if _, err := doRequest(req, nil, false); err == nil {
		t.Fatal("expected embedded outbound policy rejection")
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("network trap received %d requests", got)
	}
}
