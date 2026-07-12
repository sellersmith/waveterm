// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

// Kept as a compatibility entrypoint for the original hosted-surface spike.
// A manifest can no longer be minted independently of the backend, closures,
// capabilities, legal payload, and binary architecture checks.

import { buildBroadArtifact } from "./build-broad-artifact.mjs"

const result = await buildBroadArtifact()
console.info(JSON.stringify(result))
