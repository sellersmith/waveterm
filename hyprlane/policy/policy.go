// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

// Package policy owns the process-wide trust-boundary decisions that differ
// between standalone Wave and the Wave-derived core hosted by Hyprlane.
//
// The fork preserves upstream behavior unless the trusted Electron parent
// explicitly starts the binary in embedded mode. Embedded mode is fail-closed:
// it accepts one fixed renderer Origin and permits no outbound capability by
// default. Bootstrap values are cached and removed before any shell is spawned.
package policy

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	hyprlanecore "github.com/wavetermdev/waveterm/hyprlane"
)

const (
	EnvEmbedded    = "HYPRLANE_WAVE_EMBEDDED"
	EnvBootstrapFD = "HYPRLANE_WAVE_BOOTSTRAP_FD"
)

var bootstrapEnvironmentVariables = []string{
	EnvEmbedded,
	EnvBootstrapFD,
}

type Config struct {
	Embedded       bool
	Development    bool
	SchemaVersion  int
	AllowedOrigin  string
	ProjectRoot    string
	AuthKey        string
	StartupNonce   string
	ParentPID      int
	AllowWaveCloud bool
	capabilities   capabilityPolicy
}

func (config Config) AllowsOrigin(origin string) bool {
	if !config.Embedded {
		return true
	}
	return origin != "" && origin == config.AllowedOrigin
}

func (config Config) AllowsOutbound(capability string, destination string) bool {
	if !config.Embedded {
		return true
	}
	return config.capabilities.enabled[capability] &&
		config.capabilities.outboundDestinations[destination]
}

func (config Config) AllowsTelemetryCollection() bool {
	return !config.Embedded
}

func (config Config) AllowsBackgroundLoop(name string) bool {
	if !config.Embedded {
		return true
	}
	return config.capabilities.backgroundLoops[name]
}

func (config Config) AllowsController(name string) bool {
	if !config.Embedded {
		return true
	}
	return config.capabilities.controllers[name]
}

func (config Config) AllowsServiceCall(service string, method string) bool {
	if !config.Embedded {
		return true
	}
	return config.capabilities.serviceCalls[service+"."+method]
}

func (config Config) AllowsHTTPPath(path string) bool {
	if !config.Embedded {
		return true
	}
	if config.capabilities.httpExact[path] {
		return true
	}
	for prefix := range config.capabilities.httpPrefixes {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func (config Config) AllowsWSHCommand(command string) bool {
	if !config.Embedded {
		return true
	}
	return config.capabilities.wshCommands[command]
}

type capabilityPolicyInput struct {
	SchemaVersion        int      `json:"schemaVersion"`
	PolicyVersion        string   `json:"policyVersion"`
	Profile              string   `json:"profile"`
	UpstreamCommit       string   `json:"upstreamCommit"`
	Enabled              []string `json:"enabled"`
	DefaultOff           []string `json:"defaultOff"`
	HardOff              []string `json:"hardOff"`
	Controllers          []string `json:"controllers"`
	Services             []string `json:"services"`
	BackgroundLoops      []string `json:"backgroundLoops"`
	OutboundDestinations []string `json:"outboundDestinations"`
	LocalOptIn           []string `json:"localOptIn"`
	HTTP                 struct {
		Exact    []string `json:"exact"`
		Prefixes []string `json:"prefixes"`
	} `json:"http"`
	WSH struct {
		Commands []string `json:"commands"`
	} `json:"wsh"`
}

type capabilityPolicy struct {
	Profile              string
	enabled              map[string]bool
	defaultOff           map[string]bool
	hardOff              map[string]bool
	httpExact            map[string]bool
	httpPrefixes         map[string]bool
	wshCommands          map[string]bool
	controllers          map[string]bool
	serviceCalls         map[string]bool
	backgroundLoops      map[string]bool
	outboundDestinations map[string]bool
	localOptIn           map[string]bool
}

var capabilityNamePattern = regexp.MustCompile(`^[a-z][a-z0-9.-]{0,63}$`)
var wshCommandPattern = regexp.MustCompile(`^[a-z][a-z0-9]{0,63}$`)
var serviceCallPattern = regexp.MustCompile(`^[a-z][a-z0-9]{0,31}\.[A-Z][A-Za-z0-9]{0,63}$`)

func strictSet(values []string, valid func(string) bool, label string) (map[string]bool, error) {
	set := make(map[string]bool, len(values))
	previous := ""
	for _, value := range values {
		if !valid(value) {
			return nil, fmt.Errorf("invalid capability policy %s value %q", label, value)
		}
		if set[value] {
			return nil, fmt.Errorf("duplicate capability policy %s value %q", label, value)
		}
		if previous != "" && value < previous {
			return nil, fmt.Errorf("capability policy %s must be sorted", label)
		}
		set[value] = true
		previous = value
	}
	return set, nil
}

func parseCapabilityPolicy(data []byte) (capabilityPolicy, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var input capabilityPolicyInput
	if err := decoder.Decode(&input); err != nil {
		return capabilityPolicy{}, fmt.Errorf("decoding capability policy: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return capabilityPolicy{}, fmt.Errorf("capability policy has trailing content")
	}
	if input.SchemaVersion != 1 || input.PolicyVersion != "2026-07-11" ||
		input.Profile != "hyprlane-local-core" ||
		input.UpstreamCommit != "97e560027f494d20fed347b2d6b72b6bcb3e50e0" {
		return capabilityPolicy{}, fmt.Errorf("unsupported capability policy identity")
	}
	capabilityValid := func(value string) bool { return capabilityNamePattern.MatchString(value) }
	pathValid := func(value string) bool {
		return strings.HasPrefix(value, "/wave/") &&
			!strings.ContainsAny(value, "*?#\\")
	}
	enabled, err := strictSet(input.Enabled, capabilityValid, "enabled")
	if err != nil {
		return capabilityPolicy{}, err
	}
	defaultOff, err := strictSet(input.DefaultOff, capabilityValid, "defaultOff")
	if err != nil {
		return capabilityPolicy{}, err
	}
	hardOff, err := strictSet(input.HardOff, capabilityValid, "hardOff")
	if err != nil {
		return capabilityPolicy{}, err
	}
	for capability := range enabled {
		if defaultOff[capability] || hardOff[capability] {
			return capabilityPolicy{}, fmt.Errorf("capability policy sets conflicting states")
		}
	}
	for capability := range defaultOff {
		if hardOff[capability] {
			return capabilityPolicy{}, fmt.Errorf("capability policy sets conflicting states")
		}
	}
	httpExact, err := strictSet(input.HTTP.Exact, pathValid, "http.exact")
	if err != nil {
		return capabilityPolicy{}, err
	}
	httpPrefixes, err := strictSet(input.HTTP.Prefixes, pathValid, "http.prefixes")
	if err != nil {
		return capabilityPolicy{}, err
	}
	wshCommands, err := strictSet(input.WSH.Commands, wshCommandPattern.MatchString, "wsh.commands")
	if err != nil {
		return capabilityPolicy{}, err
	}
	controllers, err := strictSet(input.Controllers, capabilityValid, "controllers")
	if err != nil {
		return capabilityPolicy{}, err
	}
	serviceCalls, err := strictSet(input.Services, serviceCallPattern.MatchString, "services")
	if err != nil {
		return capabilityPolicy{}, err
	}
	backgroundLoops, err := strictSet(input.BackgroundLoops, capabilityValid, "backgroundLoops")
	if err != nil {
		return capabilityPolicy{}, err
	}
	outboundDestinations, err := strictSet(input.OutboundDestinations, func(value string) bool { return false }, "outboundDestinations")
	if err != nil {
		return capabilityPolicy{}, err
	}
	localOptIn, err := strictSet(input.LocalOptIn, capabilityValid, "localOptIn")
	if err != nil {
		return capabilityPolicy{}, err
	}
	if len(enabled) == 0 || len(httpExact) == 0 || len(wshCommands) == 0 ||
		len(controllers) != 1 || !controllers["shell"] || len(serviceCalls) == 0 ||
		len(backgroundLoops) != 0 || len(outboundDestinations) != 0 ||
		len(localOptIn) != 0 {
		return capabilityPolicy{}, fmt.Errorf("capability policy broadens or omits the initial profile")
	}
	return capabilityPolicy{
		Profile:              input.Profile,
		enabled:              enabled,
		defaultOff:           defaultOff,
		hardOff:              hardOff,
		httpExact:            httpExact,
		httpPrefixes:         httpPrefixes,
		wshCommands:          wshCommands,
		controllers:          controllers,
		serviceCalls:         serviceCalls,
		backgroundLoops:      backgroundLoops,
		outboundDestinations: outboundDestinations,
		localOptIn:           localOptIn,
	}, nil
}

type bootstrapConfig struct {
	SchemaVersion  int    `json:"schemaVersion"`
	AuthKey        string `json:"authKey"`
	StartupNonce   string `json:"startupNonce"`
	ParentPID      int    `json:"parentPid"`
	AllowedOrigin  string `json:"allowedOrigin"`
	Development    bool   `json:"development"`
	AllowWaveCloud bool   `json:"allowWaveCloud"`
	ProjectRoot    string `json:"projectRoot"`
}

func ParseEnvironment(getenv func(string) string, bootstrap []byte) (Config, error) {
	embedded := getenv(EnvEmbedded) == "1"
	if !embedded {
		return Config{}, nil
	}

	decoder := json.NewDecoder(bytes.NewReader(bootstrap))
	decoder.DisallowUnknownFields()
	var input bootstrapConfig
	if err := decoder.Decode(&input); err != nil {
		return Config{}, fmt.Errorf("decoding Hyprlane bootstrap: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return Config{}, fmt.Errorf("Hyprlane bootstrap has trailing content")
	}
	authKeyBytes, err := hex.DecodeString(input.AuthKey)
	if err != nil || len(authKeyBytes) < 32 || len(input.AuthKey) != 64 {
		return Config{}, fmt.Errorf("Hyprlane bootstrap authKey must be 256-bit lowercase hex")
	}
	if hex.EncodeToString(authKeyBytes) != input.AuthKey {
		return Config{}, fmt.Errorf("Hyprlane bootstrap authKey must be lowercase hex")
	}
	if input.SchemaVersion != 1 {
		return Config{}, fmt.Errorf("unsupported Hyprlane bootstrap schemaVersion")
	}
	nonceBytes, nonceErr := hex.DecodeString(input.StartupNonce)
	if nonceErr != nil || len(nonceBytes) != 32 || len(input.StartupNonce) != 64 || hex.EncodeToString(nonceBytes) != input.StartupNonce {
		return Config{}, fmt.Errorf("Hyprlane bootstrap startupNonce must be 256-bit lowercase hex")
	}
	if input.ParentPID < 2 {
		return Config{}, fmt.Errorf("Hyprlane bootstrap parentPid is invalid")
	}

	if input.Development {
		if input.AllowedOrigin != "http://localhost:5173" {
			return Config{}, fmt.Errorf(
				"allowedOrigin must be http://localhost:5173 in development",
			)
		}
	} else if input.AllowedOrigin != "app://bundle" {
		return Config{}, fmt.Errorf(
			"allowedOrigin must be app://bundle in production",
		)
	}

	if input.ProjectRoot != "" && !filepath.IsAbs(input.ProjectRoot) {
		return Config{}, fmt.Errorf("projectRoot must be absolute")
	}
	if input.AllowWaveCloud {
		return Config{}, fmt.Errorf("Wave cloud cannot be enabled by the initial embedded policy")
	}
	capabilities, err := parseCapabilityPolicy(hyprlanecore.CapabilityPolicyJSON())
	if err != nil {
		return Config{}, fmt.Errorf("loading embedded capability policy: %w", err)
	}

	return Config{
		Embedded:       true,
		Development:    input.Development,
		SchemaVersion:  input.SchemaVersion,
		AllowedOrigin:  input.AllowedOrigin,
		ProjectRoot:    input.ProjectRoot,
		AuthKey:        input.AuthKey,
		StartupNonce:   input.StartupNonce,
		ParentPID:      input.ParentPID,
		AllowWaveCloud: false,
		capabilities:   capabilities,
	}, nil
}

var (
	configMu          sync.RWMutex
	currentConfig     Config
	configInitialized bool
)

func InitializeFromEnvironment() (Config, error) {
	configMu.Lock()
	defer configMu.Unlock()
	if configInitialized {
		return currentConfig, nil
	}

	var bootstrap []byte
	if os.Getenv(EnvEmbedded) == "1" {
		fd, err := strconv.ParseUint(os.Getenv(EnvBootstrapFD), 10, 32)
		if err != nil || fd < 3 {
			return Config{}, fmt.Errorf("%s must name an inherited descriptor", EnvBootstrapFD)
		}
		file := os.NewFile(uintptr(fd), "hyprlane-wave-bootstrap")
		if file == nil {
			return Config{}, fmt.Errorf("opening Hyprlane bootstrap descriptor")
		}
		bootstrap, err = io.ReadAll(io.LimitReader(file, 4097))
		closeErr := file.Close()
		if err != nil {
			return Config{}, fmt.Errorf("reading Hyprlane bootstrap: %w", err)
		}
		if closeErr != nil {
			return Config{}, fmt.Errorf("closing Hyprlane bootstrap: %w", closeErr)
		}
		if len(bootstrap) > 4096 {
			return Config{}, fmt.Errorf("Hyprlane bootstrap exceeds 4096 bytes")
		}
	}

	config, err := ParseEnvironment(os.Getenv, bootstrap)
	if err != nil {
		return Config{}, err
	}
	for _, name := range bootstrapEnvironmentVariables {
		if err := os.Unsetenv(name); err != nil {
			return Config{}, fmt.Errorf("scrubbing %s: %w", name, err)
		}
	}
	currentConfig = config
	configInitialized = true
	return config, nil
}

func Current() Config {
	configMu.RLock()
	defer configMu.RUnlock()
	return currentConfig
}

func IsEmbedded() bool {
	return Current().Embedded
}

func AllowsOrigin(origin string) bool {
	return Current().AllowsOrigin(origin)
}

func AllowsOutbound(capability string, destination string) bool {
	return Current().AllowsOutbound(capability, destination)
}

func AllowsTelemetryCollection() bool {
	return Current().AllowsTelemetryCollection()
}

func AllowsBackgroundLoop(name string) bool {
	return Current().AllowsBackgroundLoop(name)
}

func AllowsController(name string) bool {
	return Current().AllowsController(name)
}

func AllowsServiceCall(service string, method string) bool {
	return Current().AllowsServiceCall(service, method)
}

func AllowsHTTPPath(path string) bool {
	return Current().AllowsHTTPPath(path)
}

func AllowsWSHCommand(command string) bool {
	return Current().AllowsWSHCommand(command)
}
