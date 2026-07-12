// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wconfig/defaultconfig"
)

func TestForkDefaultsDisableOutboundAndPrivilegedUI(t *testing.T) {
	data, err := defaultconfig.ConfigFS.ReadFile("settings.json")
	if err != nil {
		t.Fatalf("read defaults: %v", err)
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("parse defaults: %v", err)
	}
	for _, key := range []string{"telemetry:enabled", "autoupdate:enabled", "waveai:showcloudmodes"} {
		if value, ok := settings[key].(bool); !ok || value {
			t.Fatalf("%s must default false, got %#v", key, settings[key])
		}
	}
	if value, ok := settings["app:hideaibutton"].(bool); !ok || !value {
		t.Fatalf("app:hideaibutton must default true, got %#v", settings["app:hideaibutton"])
	}
	if value := settings["term:osc52"]; value != "focus" {
		t.Fatalf("term:osc52 must default to focus, got %#v", value)
	}
}
