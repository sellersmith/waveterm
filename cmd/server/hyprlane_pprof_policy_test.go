// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const standalonePprofPolicyHelper = "HYPRLANE_TEST_STANDALONE_PPROF_POLICY"

func reservePprofPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		t.Fatalf("reserve pprof port: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func configurePprofSettings(t *testing.T, pprofPort *int, memProfileRate int) {
	t.Helper()
	dataHome := t.TempDir()
	wavebase.DataHome_VarCache = dataHome
	wavebase.ConfigHome_VarCache = filepath.Join(dataHome, "config")
	configDir := wavebase.GetWaveConfigDir()
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatalf("create config directory: %v", err)
	}
	portSetting := ""
	if pprofPort != nil {
		portSetting = fmt.Sprintf(`,"debug:pprofport":%d`, *pprofPort)
	}
	settings := fmt.Sprintf(
		`{"debug:pprofmemprofilerate":%d%s}`,
		memProfileRate,
		portSetting,
	)
	if err := os.WriteFile(filepath.Join(configDir, wconfig.SettingsFile), []byte(settings), 0600); err != nil {
		t.Fatalf("write pprof settings: %v", err)
	}
	watcher := wconfig.GetWatcher()
	if watcher == nil {
		t.Fatal("config watcher is unavailable")
	}
	watcher.Start()
}

func TestEmbeddedRuntimeDisablesPersistedPprofConfiguration(t *testing.T) {
	initializeEmbeddedServerPolicy(t)
	port := reservePprofPort(t)
	const baselineMemProfileRate = 123457
	const persistedMemProfileRate = 76543
	configurePprofSettings(t, &port, persistedMemProfileRate)

	originalMemProfileRate := runtime.MemProfileRate
	runtime.MemProfileRate = baselineMemProfileRate
	t.Cleanup(func() { runtime.MemProfileRate = originalMemProfileRate })

	maybeStartPprofServer()
	if runtime.MemProfileRate != baselineMemProfileRate {
		t.Fatalf(
			"embedded runtime applied persisted mem profile rate: got %d, want %d",
			runtime.MemProfileRate,
			baselineMemProfileRate,
		)
	}

	address := net.JoinHostPort("localhost", strconv.Itoa(port))
	deadline := time.Now().Add(250 * time.Millisecond)
	for time.Now().Before(deadline) {
		connection, err := net.DialTimeout("tcp", address, 25*time.Millisecond)
		if err == nil {
			connection.Close()
			t.Fatalf("embedded runtime exposed unauthenticated pprof on %s", address)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestStandaloneRuntimePreservesPprofConfiguration(t *testing.T) {
	if os.Getenv(standalonePprofPolicyHelper) == "1" {
		const persistedMemProfileRate = 76543
		configurePprofSettings(t, nil, persistedMemProfileRate)
		maybeStartPprofServer()
		if runtime.MemProfileRate != persistedMemProfileRate {
			t.Fatalf(
				"standalone mem profile rate = %d, want %d",
				runtime.MemProfileRate,
				persistedMemProfileRate,
			)
		}
		return
	}

	command := exec.Command(os.Args[0], "-test.run=^TestStandaloneRuntimePreservesPprofConfiguration$")
	command.Env = []string{standalonePprofPolicyHelper + "=1"}
	for _, variable := range os.Environ() {
		if strings.HasPrefix(variable, "HYPRLANE_WAVE_") ||
			strings.HasPrefix(variable, standalonePprofPolicyHelper+"=") {
			continue
		}
		command.Env = append(command.Env, variable)
	}
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		t.Fatalf("standalone pprof helper failed: %v\n%s", err, output.String())
	}
}
