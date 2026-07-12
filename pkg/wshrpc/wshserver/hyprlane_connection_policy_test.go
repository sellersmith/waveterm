// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package wshserver

import "testing"

func TestEmbeddedConnectionEnsureAllowsOnlyLocalConnections(t *testing.T) {
	for _, test := range []struct {
		name       string
		embedded   bool
		connection string
		wantError  bool
	}{
		{name: "embedded local", embedded: true, connection: "local"},
		{name: "embedded empty local", embedded: true},
		{name: "embedded ssh", embedded: true, connection: "ssh://example", wantError: true},
		{name: "embedded wsl", embedded: true, connection: "wsl://Ubuntu", wantError: true},
		{name: "standalone ssh", connection: "ssh://example"},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateConnectionEnsurePolicy(test.embedded, test.connection)
			if (err != nil) != test.wantError {
				t.Fatalf("validateConnectionEnsurePolicy() error = %v, wantError %v", err, test.wantError)
			}
		})
	}
}
