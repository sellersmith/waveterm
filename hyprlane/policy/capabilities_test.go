// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package policy

import (
	"bytes"
	"testing"

	hyprlanecore "github.com/wavetermdev/waveterm/hyprlane"
)

func TestEmbeddedCapabilityPolicyIsPinnedAndDefaultDeny(t *testing.T) {
	policyBytes := hyprlanecore.CapabilityPolicyJSON()
	if len(policyBytes) == 0 {
		t.Fatal("embedded capability policy is empty")
	}
	parsed, err := parseCapabilityPolicy(policyBytes)
	if err != nil {
		t.Fatalf("parseCapabilityPolicy: %v", err)
	}
	if parsed.Profile != "hyprlane-local-core" {
		t.Fatalf("profile = %q", parsed.Profile)
	}
	for _, capability := range []string{
		"workspace", "tabs", "blocks", "layout", "wos", "wsh",
		"terminal.local", "history.local", "files.local", "process.local",
		"webview.browser",
	} {
		if !parsed.enabled[capability] {
			t.Fatalf("required capability %q is disabled", capability)
		}
	}
	for _, capability := range []string{
		"builder", "wave.ai", "remote.ssh", "remote.wsl",
		"tsunami.vdom",
	} {
		if !parsed.defaultOff[capability] {
			t.Fatalf("compiled capability %q is not default-off", capability)
		}
	}
	for _, capability := range []string{
		"wave.cloud", "wave.share", "wave.sync", "telemetry",
		"diagnostics", "updater", "standalone.lifecycle",
	} {
		if !parsed.hardOff[capability] {
			t.Fatalf("capability %q is not hard-off", capability)
		}
	}
	if len(parsed.outboundDestinations) != 0 {
		t.Fatal("initial embedded policy must have no outbound destinations")
	}
	if len(parsed.backgroundLoops) != 0 {
		t.Fatal("initial embedded policy must start no optional background loops")
	}
	if len(parsed.localOptIn) != 0 {
		t.Fatal("initial embedded policy must expose no local opt-ins")
	}
	if len(parsed.serviceCalls) == 0 {
		t.Fatal("initial embedded policy must name exact local service calls")
	}
	if parsed.serviceCalls["client.TelemetryUpdate"] {
		t.Fatal("telemetry service call entered the local-core policy")
	}
}

func TestCapabilityPolicyRejectsUnknownTamperedAndBroadenedInput(t *testing.T) {
	original := hyprlanecore.CapabilityPolicyJSON()
	for name, mutation := range map[string][]byte{
		"unknown field":        bytes.Replace(original, []byte(`"profile"`), []byte(`"unknown":true,"profile"`), 1),
		"wildcard route":       bytes.Replace(original, []byte(`"/wave/file"`), []byte(`"*"`), 1),
		"outbound destination": bytes.Replace(original, []byte(`"outboundDestinations": []`), []byte(`"outboundDestinations":["https://api.waveterm.dev"]`), 1),
		"local opt in":         bytes.Replace(original, []byte(`"localOptIn": []`), []byte(`"localOptIn":["wave.ai"]`), 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseCapabilityPolicy(mutation); err == nil {
				t.Fatal("tampered capability policy was accepted")
			}
		})
	}
}

func TestCapabilityPolicyHashIsStableAndDefensive(t *testing.T) {
	first := hyprlanecore.CapabilityPolicyJSON()
	second := hyprlanecore.CapabilityPolicyJSON()
	if !bytes.Equal(first, second) {
		t.Fatal("embedded capability bytes changed between reads")
	}
	first[0] ^= 0xff
	if bytes.Equal(first, hyprlanecore.CapabilityPolicyJSON()) {
		t.Fatal("callers can mutate embedded capability bytes")
	}
	if len(hyprlanecore.CapabilityPolicySHA256()) != 64 {
		t.Fatal("capability policy digest is not SHA-256 hex")
	}
}
