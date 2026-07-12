// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package wshfs

import "testing"

func TestEmbeddedFilePolicyAllowsOnlyLocalConnection(t *testing.T) {
	for _, test := range []struct {
		name      string
		embedded  bool
		host      string
		wantError bool
	}{
		{name: "local", embedded: true, host: "local"},
		{name: "ssh", embedded: true, host: "ssh://example", wantError: true},
		{name: "wsl", embedded: true, host: "wsl://Ubuntu", wantError: true},
		{name: "standalone", host: "ssh://example"},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateFileConnectionPolicy(test.embedded, test.host)
			if (err != nil) != test.wantError {
				t.Fatalf("validateFileConnectionPolicy error = %v, wantError %v", err, test.wantError)
			}
		})
	}
}
