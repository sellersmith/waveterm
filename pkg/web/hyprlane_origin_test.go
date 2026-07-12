// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/hyprlane/policy"
	"github.com/wavetermdev/waveterm/hyprlane/sessionpolicy"
	"github.com/wavetermdev/waveterm/pkg/authkey"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type webLifecycleClock struct{}

func (webLifecycleClock) Now() time.Time {
	return time.Now()
}

func (webLifecycleClock) AfterFunc(
	delay time.Duration,
	callback func(),
) sessionpolicy.Timer {
	return time.AfterFunc(delay, callback)
}

var (
	embeddedPolicyOnce sync.Once
	embeddedPolicyErr  error
)

func initializeEmbeddedPolicy(t *testing.T) {
	t.Helper()
	embeddedPolicyOnce.Do(func() {
		reader, writer, err := os.Pipe()
		if err != nil {
			embeddedPolicyErr = fmt.Errorf("os.Pipe: %w", err)
			return
		}
		bootstrap := fmt.Sprintf(
			`{"schemaVersion":1,"authKey":%q,"startupNonce":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789","parentPid":123,"allowedOrigin":"app://bundle","allowWaveCloud":false}`,
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		)
		if _, err := writer.WriteString(bootstrap); err != nil {
			embeddedPolicyErr = fmt.Errorf("write bootstrap: %w", err)
			return
		}
		if err := writer.Close(); err != nil {
			embeddedPolicyErr = fmt.Errorf("close bootstrap writer: %w", err)
			return
		}
		os.Setenv(policy.EnvEmbedded, "1")
		os.Setenv(policy.EnvBootstrapFD, strconv.FormatUint(uint64(reader.Fd()), 10))
		_, embeddedPolicyErr = policy.InitializeFromEnvironment()
		if embeddedPolicyErr == nil {
			embeddedPolicyErr = authkey.SetAuthKeyFromEnv()
		}
	})
	if embeddedPolicyErr != nil {
		t.Fatalf("initialize embedded policy: %v", embeddedPolicyErr)
	}
}

func TestEmbeddedWebSocketOriginIsExact(t *testing.T) {
	initializeEmbeddedPolicy(t)

	for _, test := range []struct {
		origin string
		want   bool
	}{
		{origin: "app://bundle", want: true},
		{origin: "", want: false},
		{origin: "null", want: false},
		{origin: "app://evil", want: false},
	} {
		req := httptest.NewRequest("GET", "http://127.0.0.1/ws", nil)
		if test.origin != "" {
			req.Header.Set("Origin", test.origin)
		}
		if got := WebSocketUpgrader.CheckOrigin(req); got != test.want {
			t.Fatalf("origin %q: got %v, want %v", test.origin, got, test.want)
		}
	}

	mainRequest := httptest.NewRequest("GET", "http://127.0.0.1/ws?stableid=electron", nil)
	mainRequest.Header.Set("X-AuthKey", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	if !WebSocketUpgrader.CheckOrigin(mainRequest) {
		t.Fatal("authenticated main-process route must support origin-less Node WebSocket")
	}
	mainRequest.Header.Set("X-AuthKey", "wrong")
	if WebSocketUpgrader.CheckOrigin(mainRequest) {
		t.Fatal("origin-less route accepted a wrong startup key")
	}
}

func TestEmbeddedUnixSocketUsesPrivateDirectoryAndMode(t *testing.T) {
	initializeEmbeddedPolicy(t)
	oldDataHome := wavebase.DataHome_VarCache
	runtimeRoot, err := os.MkdirTemp("/tmp", "hw-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	wavebase.DataHome_VarCache = filepath.Join(runtimeRoot, "runtime")
	t.Cleanup(func() { wavebase.DataHome_VarCache = oldDataHome })
	t.Cleanup(func() { os.RemoveAll(runtimeRoot) })

	listener, err := MakeUnixListener()
	if err != nil {
		t.Fatalf("MakeUnixListener: %v", err)
	}
	t.Cleanup(func() {
		listener.Close()
		os.Remove(wavebase.GetDomainSocketName())
	})
	dirStat, err := os.Lstat(wavebase.GetWaveDataDir())
	if err != nil {
		t.Fatalf("Lstat runtime dir: %v", err)
	}
	if dirStat.Mode().Perm() != 0700 || !dirStat.IsDir() || dirStat.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("runtime dir mode = %v", dirStat.Mode())
	}
	socketStat, err := os.Lstat(wavebase.GetDomainSocketName())
	if err != nil {
		t.Fatalf("Lstat socket: %v", err)
	}
	if socketStat.Mode().Perm() != 0600 || socketStat.Mode()&os.ModeSocket == 0 {
		t.Fatalf("socket mode = %v", socketStat.Mode())
	}
}

func TestEmbeddedStableRouteMustBeServerMintedAndExisting(t *testing.T) {
	initializeEmbeddedPolicy(t)
	const existingTab = "d759aed2-8437-48bf-bea5-f517d4a7d03c"
	exists := func(tabID string) bool { return tabID == existingTab }
	for _, test := range []struct {
		stableID string
		wantOK   bool
	}{
		{stableID: "electron", wantOK: true},
		{stableID: "tab:" + existingTab, wantOK: true},
		{stableID: "tab:00000000-0000-0000-0000-000000000000", wantOK: false},
		{stableID: "tab:not-a-uuid", wantOK: false},
		{stableID: "builder:" + existingTab, wantOK: false},
		{stableID: "attacker-selected", wantOK: false},
	} {
		err := validateEmbeddedStableRoute(test.stableID, exists)
		if (err == nil) != test.wantOK {
			t.Fatalf("stable route %q: error=%v, wantOK=%v", test.stableID, err, test.wantOK)
		}
	}
}

func TestEmbeddedTabLookupTreatsNilWithoutErrorAsMissing(t *testing.T) {
	lookup := func(context.Context, string) (*waveobj.Tab, error) {
		return nil, nil
	}
	if embeddedTabExists(
		context.Background(),
		"d759aed2-8437-48bf-bea5-f517d4a7d03c",
		lookup,
	) {
		t.Fatal("nil tab lookup was treated as an existing server-minted tab")
	}
}

func TestEmbeddedTabRouteAttachAndDetachControlPTYAdmission(t *testing.T) {
	initializeEmbeddedPolicy(t)
	var reaped []string
	coordinator, err := sessionpolicy.NewCoordinator(sessionpolicy.Options{
		Clock:       webLifecycleClock{},
		MaxLivePTYs: 1,
		DetachedTTL: time.Hour,
		ReapTab: func(tabID string) {
			reaped = append(reaped, tabID)
		},
	})
	if err != nil {
		t.Fatalf("NewCoordinator failed: %v", err)
	}
	oldCoordinator := webSessionCoordinator
	webSessionCoordinator = coordinator
	t.Cleanup(func() { webSessionCoordinator = oldCoordinator })

	const firstTab = "d759aed2-8437-48bf-bea5-f517d4a7d03c"
	const secondTab = "1e512f34-5bf8-4c53-84fe-c8f7bb5543a6"
	if err := attachEmbeddedSessionRoute("tab:" + firstTab); err != nil {
		t.Fatalf("attach first tab: %v", err)
	}
	if err := coordinator.Admit(firstTab, "pty-first"); err != nil {
		t.Fatalf("admit first PTY: %v", err)
	}
	if err := attachEmbeddedSessionRoute("tab:" + secondTab); err != nil {
		t.Fatalf("attach second tab: %v", err)
	}
	if err := coordinator.Admit(secondTab, "pty-second"); !errors.Is(err, sessionpolicy.ErrPTYLimit) {
		t.Fatalf("admit while first tab attached = %v, want ErrPTYLimit", err)
	}

	detachEmbeddedSessionRoute("tab:" + firstTab)
	if err := coordinator.Admit(secondTab, "pty-second"); err != nil {
		t.Fatalf("admit after first tab detached: %v", err)
	}
	if fmt.Sprint(reaped) != "["+firstTab+"]" {
		t.Fatalf("reaped tabs = %v, want [%s]", reaped, firstTab)
	}
}

func TestEmbeddedHTTPPolicyRequiresExactOriginAndAuth(t *testing.T) {
	initializeEmbeddedPolicy(t)
	const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	var calls atomic.Int32
	handler := embeddedPolicyHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))

	for _, test := range []struct {
		name       string
		method     string
		origin     string
		key        string
		wantStatus int
		wantCalls  int32
	}{
		{name: "valid", method: http.MethodGet, origin: "app://bundle", key: key, wantStatus: http.StatusNoContent, wantCalls: 1},
		{name: "preflight", method: http.MethodOptions, origin: "app://bundle", key: key, wantStatus: http.StatusNoContent, wantCalls: 0},
		{name: "missing origin", method: http.MethodGet, key: key, wantStatus: http.StatusForbidden, wantCalls: 0},
		{name: "evil origin", method: http.MethodGet, origin: "app://evil", key: key, wantStatus: http.StatusForbidden, wantCalls: 0},
		{name: "missing key", method: http.MethodGet, origin: "app://bundle", wantStatus: http.StatusUnauthorized, wantCalls: 0},
		{name: "disabled route", method: http.MethodPost, origin: "app://bundle", key: key, wantStatus: http.StatusForbidden, wantCalls: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls.Store(0)
			path := "/wave/service"
			if test.name == "disabled route" {
				path = "/api/post-chat-message"
			}
			req := httptest.NewRequest(test.method, "http://127.0.0.1"+path, nil)
			if test.origin != "" {
				req.Header.Set("Origin", test.origin)
			}
			if test.key != "" {
				req.Header.Set("X-AuthKey", test.key)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, test.wantStatus)
			}
			if got := calls.Load(); got != test.wantCalls {
				t.Fatalf("downstream calls = %d, want %d", got, test.wantCalls)
			}
			if test.origin == "app://bundle" && response.Header().Get("Access-Control-Allow-Origin") != "app://bundle" {
				t.Fatal("missing exact embedded CORS origin")
			}
		})
	}
}
