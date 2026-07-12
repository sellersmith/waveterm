// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { resolve } from "node:path"
import test from "node:test"
import {
  assertPermittedRendererFile,
  verifyFullRendererArtifact,
} from "./verify-full-renderer.mjs"

test("verifies the built full renderer and audited dependency closure", async () => {
  const result = await verifyFullRendererArtifact(
    resolve(import.meta.dirname, "../../dist/hyprlane/renderer")
  )

  assert.equal(result.kind, "wave-full-renderer")
  assert.ok(result.fileCount > 80)
  assert.ok(result.moduleCount > 6000)
  assert.ok(result.totalBytes > 20 * 1024 * 1024)
})

test("rejects prohibited commercial and trademark assets", () => {
  assert.throws(
    () =>
      assertPermittedRendererFile(
        "fontawesome/css/solid.min.css",
        Buffer.from("ok")
      ),
    /prohibited renderer asset path/
  )
  assert.throws(
    () =>
      assertPermittedRendererFile(
        "assets/styles.css",
        Buffer.from("Font Awesome Pro 6.7.2 Commercial License")
      ),
    /prohibited renderer asset content/
  )
  assert.throws(
    () =>
      assertPermittedRendererFile("assets/wave-logo.png", Buffer.from("ok")),
    /prohibited renderer asset path/
  )
})
