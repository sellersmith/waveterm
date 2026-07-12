// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"os"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/hyprlane/policy"
)

func environmentMap(environment []string) map[string]string {
	result := make(map[string]string, len(environment))
	for _, entry := range environment {
		key := entry
		value := ""
		for idx, char := range entry {
			if char == '=' {
				key = entry[:idx]
				value = entry[idx+1:]
				break
			}
		}
		result[key] = value
	}
	return result
}

func TestEmbeddedLocalShellEnvironmentUsesStrictAllowlist(t *testing.T) {
	source := map[string]string{
		"PATH":                          "/custom/bin:/usr/bin",
		"HOME":                          "/Users/tester",
		"LANG":                          "en_US.UTF-8",
		"AWS_SECRET_ACCESS_KEY":         "planted-cloud-secret",
		"DATABASE_URL":                  "postgres://planted-secret",
		"WAVETERM_AUTH_KEY":             "planted-wave-auth-secret",
		policy.EnvEmbedded:              "1",
		policy.EnvBootstrapFD:           "42",
		"HYPRLANE_UNRELATED_TEST_VALUE": "planted-hyprlane-secret",
	}
	environ := func() []string {
		result := make([]string, 0, len(source))
		for key, value := range source {
			result = append(result, key+"="+value)
		}
		return result
	}
	getenv := func(key string) string { return source[key] }

	environment := buildLocalShellEnvironment(
		policy.Config{Embedded: true},
		environ,
		getenv,
	)
	values := environmentMap(environment)

	if values["PATH"] != source["PATH"] {
		t.Fatalf("PATH = %q, want %q", values["PATH"], source["PATH"])
	}
	if values["HOME"] != source["HOME"] {
		t.Fatalf("HOME = %q, want %q", values["HOME"], source["HOME"])
	}
	if values["TERM"] == "" {
		t.Fatal("TERM must always be present")
	}
	for _, forbidden := range []string{
		"AWS_SECRET_ACCESS_KEY",
		"DATABASE_URL",
		"WAVETERM_AUTH_KEY",
		policy.EnvEmbedded,
		policy.EnvBootstrapFD,
		"HYPRLANE_UNRELATED_TEST_VALUE",
	} {
		if value, ok := values[forbidden]; ok {
			t.Fatalf("embedded shell leaked %s=%q", forbidden, value)
		}
	}
}

func TestStandaloneLocalShellEnvironmentPreservesUpstreamEnvironment(t *testing.T) {
	upstreamEnvironment := []string{
		"PATH=/custom/bin",
		"WAVE_STANDALONE_EXTENSION=value",
	}

	environment := buildLocalShellEnvironment(
		policy.Config{},
		func() []string { return upstreamEnvironment },
		func(string) string { return "" },
	)

	if !slices.Equal(environment, upstreamEnvironment) {
		t.Fatalf("environment = %q, want upstream environment %q", environment, upstreamEnvironment)
	}
	upstreamEnvironment[0] = "mutated"
	if environment[0] == "mutated" {
		t.Fatal("environment must not alias the process environment slice")
	}
}

func TestEmbeddedLocalShellCwdUsesProjectRootOrHome(t *testing.T) {
	homeDir := t.TempDir()
	projectRoot := t.TempDir()
	requestedCwd := t.TempDir()
	nonDirectoryProjectRoot := homeDir + "/not-a-directory"
	if err := os.WriteFile(nonDirectoryProjectRoot, []byte("file"), 0o600); err != nil {
		t.Fatalf("writing non-directory project root: %v", err)
	}

	tests := []struct {
		name   string
		config policy.Config
		want   string
	}{
		{
			name: "cached project root wins over renderer supplied cwd",
			config: policy.Config{
				Embedded:    true,
				ProjectRoot: projectRoot,
			},
			want: projectRoot,
		},
		{
			name:   "home is used when project root is absent",
			config: policy.Config{Embedded: true},
			want:   homeDir,
		},
		{
			name: "home is used when cached project root disappeared",
			config: policy.Config{
				Embedded:    true,
				ProjectRoot: projectRoot + "/missing",
			},
			want: homeDir,
		},
		{
			name: "home is used when cached project root is not a directory",
			config: policy.Config{
				Embedded:    true,
				ProjectRoot: nonDirectoryProjectRoot,
			},
			want: homeDir,
		},
		{
			name:   "standalone Wave keeps its requested cwd",
			config: policy.Config{},
			want:   requestedCwd,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := resolveLocalShellCwd(
				test.config,
				requestedCwd,
				homeDir,
			)
			if got != test.want {
				t.Fatalf("cwd = %q, want %q", got, test.want)
			}
		})
	}
}
