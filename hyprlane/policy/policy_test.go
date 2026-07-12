// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package policy

import (
	"fmt"
	"os"
	"strconv"
	"testing"
)

const testAuthKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const testStartupNonce = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

func bootstrapJSON(origin string, development bool, projectRoot string) []byte {
	return []byte(fmt.Sprintf(
		`{"schemaVersion":1,"authKey":%q,"startupNonce":%q,"parentPid":123,"allowedOrigin":%q,"development":%t,"allowWaveCloud":false,"projectRoot":%q}`,
		testAuthKey,
		testStartupNonce,
		origin,
		development,
		projectRoot,
	))
}

func TestParseEnvironmentStandalonePreservesUpstreamBehavior(t *testing.T) {
	config, err := ParseEnvironment(func(string) string { return "" }, nil)
	if err != nil {
		t.Fatalf("ParseEnvironment: %v", err)
	}
	if config.Embedded {
		t.Fatal("standalone Wave must not enter the Hyprlane trust boundary")
	}
	if !config.AllowsOrigin("https://example.com") {
		t.Fatal("the fork must preserve standalone Wave behavior")
	}
	if !config.AllowsOutbound("wave-cloud", "https://api.waveterm.dev") {
		t.Fatal("the fork must preserve standalone Wave outbound behavior")
	}
}

func TestParseEnvironmentEmbeddedIsStrictAndOffline(t *testing.T) {
	values := map[string]string{EnvEmbedded: "1"}
	config, err := ParseEnvironment(
		func(name string) string { return values[name] },
		bootstrapJSON("app://bundle", false, "/tmp/project"),
	)
	if err != nil {
		t.Fatalf("ParseEnvironment: %v", err)
	}
	if !config.Embedded {
		t.Fatal("expected embedded policy")
	}
	if !config.AllowsOrigin("app://bundle") {
		t.Fatal("expected exact production origin")
	}
	for _, origin := range []string{"", "null", "app://evil", "http://localhost:5173"} {
		if config.AllowsOrigin(origin) {
			t.Fatalf("unexpected allowed origin %q", origin)
		}
	}
	if config.AllowsOutbound("wave-cloud", "https://api.waveterm.dev") {
		t.Fatal("embedded Wave must be offline by default")
	}
	if config.AllowsTelemetryCollection() {
		t.Fatal("embedded Wave must not collect telemetry")
	}
	for _, backgroundLoop := range []string{"jobs", "wave.ai.config"} {
		if config.AllowsBackgroundLoop(backgroundLoop) {
			t.Fatalf("disabled background loop %q was allowed", backgroundLoop)
		}
	}
	if !config.AllowsController("shell") {
		t.Fatal("local shell controller was denied")
	}
	for _, controller := range []string{"cmd", "tsunami"} {
		if config.AllowsController(controller) {
			t.Fatalf("disabled controller %q was allowed", controller)
		}
	}
	for _, serviceCall := range [][2]string{
		{"block", "SaveTerminalState"},
		{"object", "CreateBlock"},
		{"workspace", "CreateTab"},
	} {
		if !config.AllowsServiceCall(serviceCall[0], serviceCall[1]) {
			t.Fatalf("required service call %s.%s was denied", serviceCall[0], serviceCall[1])
		}
	}
	for _, serviceCall := range [][2]string{
		{"client", "TelemetryUpdate"},
		{"builder", "Start"},
		{"workspace", "Unknown"},
	} {
		if config.AllowsServiceCall(serviceCall[0], serviceCall[1]) {
			t.Fatalf("disabled service call %s.%s was allowed", serviceCall[0], serviceCall[1])
		}
	}
	for _, path := range []string{"/wave/service", "/wave/file", "/wave/stream-file/name"} {
		if !config.AllowsHTTPPath(path) {
			t.Fatalf("required local route %q was denied", path)
		}
	}
	for _, path := range []string{"/api/post-chat-message", "/wave/aichat", "/vdom/app", "/schema/"} {
		if config.AllowsHTTPPath(path) {
			t.Fatalf("disabled route %q was allowed", path)
		}
	}
	for _, command := range []string{
		"sendtelemetry",
		"recordtevent",
		"getwaveaichat",
		"waveaitoolapprove",
		"startbuilder",
		"publishapp",
		"connconnect",
		"wslstatus",
		"getsecrets",
		"jobcontrollerstartjob",
	} {
		if config.AllowsWSHCommand(command) {
			t.Fatalf("disabled WSH command %q was allowed", command)
		}
	}
	for _, command := range []string{
		"connensure",
		"getfullconfig",
		"getwaveaimodeconfig",
		"controllerresync",
		"controllerinput",
		"fileinfo",
		"eventsub",
		"macosversion",
		"remoteprocesslist",
	} {
		if !config.AllowsWSHCommand(command) {
			t.Fatalf("required local WSH command %q was denied", command)
		}
	}
	if config.ProjectRoot != "/tmp/project" {
		t.Fatalf("project root = %q", config.ProjectRoot)
	}
}

func TestStandalonePreservesOptionalBackgroundLoops(t *testing.T) {
	config, err := ParseEnvironment(func(string) string { return "" }, nil)
	if err != nil {
		t.Fatalf("ParseEnvironment: %v", err)
	}
	for _, backgroundLoop := range []string{"jobs", "wave.ai.config"} {
		if !config.AllowsBackgroundLoop(backgroundLoop) {
			t.Fatalf("standalone background loop %q must preserve upstream behavior", backgroundLoop)
		}
	}
}

func TestParseEnvironmentDevOriginRequiresExplicitDevMode(t *testing.T) {
	values := map[string]string{EnvEmbedded: "1"}
	if _, err := ParseEnvironment(
		func(name string) string { return values[name] },
		bootstrapJSON("http://localhost:5173", false, ""),
	); err == nil {
		t.Fatal("development origin must fail closed without explicit dev mode")
	}
	config, err := ParseEnvironment(
		func(name string) string { return values[name] },
		bootstrapJSON("http://localhost:5173", true, ""),
	)
	if err != nil {
		t.Fatalf("ParseEnvironment: %v", err)
	}
	if !config.AllowsOrigin("http://localhost:5173") {
		t.Fatal("expected exact development origin")
	}
	if config.AllowsOrigin("http://127.0.0.1:5173") {
		t.Fatal("development origin must remain exact")
	}
}

func TestInitializeFromEnvironmentScrubsBootstrapValues(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	if _, err := writer.Write(bootstrapJSON("app://bundle", false, "/tmp/project")); err != nil {
		t.Fatalf("write bootstrap: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close bootstrap writer: %v", err)
	}
	t.Setenv(EnvEmbedded, "1")
	t.Setenv(EnvBootstrapFD, strconv.FormatUint(uint64(reader.Fd()), 10))
	config, err := InitializeFromEnvironment()
	if err != nil {
		t.Fatalf("InitializeFromEnvironment: %v", err)
	}
	if !config.Embedded {
		t.Fatal("expected embedded policy")
	}
	for _, name := range bootstrapEnvironmentVariables {
		if value, ok := os.LookupEnv(name); ok {
			t.Fatalf("bootstrap variable %s leaked with value %q", name, value)
		}
	}
}
