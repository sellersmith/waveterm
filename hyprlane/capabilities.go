// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

// Package hyprlane contains immutable policy inputs embedded into the
// Wave-derived binaries. The signed artifact also ships the source JSON for
// audit/provenance, but runtime authorization reads these compiled bytes so no
// environment, remote config, or product renderer can broaden the policy.
package hyprlane

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
)

//go:embed capabilities.json
var capabilityPolicyJSON []byte

func CapabilityPolicyJSON() []byte {
	return append([]byte(nil), capabilityPolicyJSON...)
}

func CapabilityPolicySHA256() string {
	digest := sha256.Sum256(capabilityPolicyJSON)
	return hex.EncodeToString(digest[:])
}
