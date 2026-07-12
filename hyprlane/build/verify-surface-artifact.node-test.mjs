// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { verifySurfaceArtifact } from "./verify-surface-artifact.mjs"

const builtArtifact = resolve("dist/hyprlane")
const temporaryRoots = []

async function copyArtifact() {
  const root = await mkdtemp(join(tmpdir(), "wave-broad-verifier-"))
  temporaryRoots.push(root)
  await cp(builtArtifact, root, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  })
  return root
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

async function readManifest(root) {
  return JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))
}

async function writeManifest(root, manifest) {
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

async function declareBytes(root, path, bytes, mutateManifest) {
  await writeFile(join(root, path), bytes)
  const manifest = await readManifest(root)
  const info = await lstat(join(root, path))
  manifest.files[path] = sha256(bytes)
  manifest.fileMetadata[path] = {
    size: bytes.byteLength,
    mode: (info.mode & 0o777).toString(8).padStart(4, "0"),
  }
  mutateManifest?.(manifest)
  await writeManifest(root, manifest)
}

test.after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))
  )
})

test("accepts the explicit development broad-core artifact", async () => {
  const result = await verifySurfaceArtifact(builtArtifact, {
    allowLocalSynthetic: true,
  })
  assert.equal(result.kind, "hyprlane-wave-broad-core")
  assert.ok(result.fileCount > 100)
  assert.ok(result.totalBytes > 40 * 1024 * 1024)
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/)
})

test("rejects local-synthetic provenance without an explicit development gate", async () => {
  await assert.rejects(
    verifySurfaceArtifact(builtArtifact),
    /requires explicit development verification/
  )
})

test("rejects undeclared files", async () => {
  const root = await copyArtifact()
  await writeFile(join(root, "renderer/undeclared.js"), "export {}\n")
  await assert.rejects(
    verifySurfaceArtifact(root, { allowLocalSynthetic: true }),
    /undeclared broad Wave artifact file/
  )
})

test("rejects changed declared bytes", async () => {
  const root = await copyArtifact()
  await writeFile(join(root, "preload/index.cjs"), "changed\n")
  await assert.rejects(
    verifySurfaceArtifact(root, { allowLocalSynthetic: true }),
    /hash mismatch/
  )
})

test("rejects symlinks", async () => {
  const root = await copyArtifact()
  const path = join(root, "legal/licenses/Phosphor-Icons-MIT.txt")
  await unlink(path)
  await symlink("../NOTICE", path)
  await assert.rejects(
    verifySurfaceArtifact(root, { allowLocalSynthetic: true }),
    /symlink/
  )
})

test("rejects a missing upstream NOTICE", async () => {
  const root = await copyArtifact()
  await unlink(join(root, "legal/NOTICE"))
  await assert.rejects(
    verifySurfaceArtifact(root, { allowLocalSynthetic: true }),
    /missing broad Wave artifact file|missing broad Wave legal payload/
  )
})

test("rejects prohibited Wave trademark assets even when declared", async () => {
  const root = await copyArtifact()
  await declareBytes(
    root,
    "renderer/assets/wave-logo.png",
    Buffer.from("synthetic logo")
  )
  await assert.rejects(
    verifySurfaceArtifact(root, { allowLocalSynthetic: true }),
    /prohibited renderer asset path/
  )
})

test("rejects a capability SHA mismatch", async () => {
  const root = await copyArtifact()
  const manifest = await readManifest(root)
  manifest.capabilities.sha256 = "0".repeat(64)
  await writeManifest(root, manifest)
  await assert.rejects(
    verifySurfaceArtifact(root, { allowLocalSynthetic: true }),
    /capability SHA-256 mismatch/
  )
})

test("rejects a non-arm64 binary even when its new hash is declared", async () => {
  const root = await copyArtifact()
  const path = "app/bin/wavesrv.arm64"
  const bytes = await readFile(join(root, path))
  bytes.writeUInt32LE(0x01000007, 4)
  await declareBytes(root, path, bytes, (manifest) => {
    const binary = manifest.binaries.find((item) => item.path === path)
    binary.sha256 = sha256(bytes)
  })
  await assert.rejects(
    verifySurfaceArtifact(root, { allowLocalSynthetic: true }),
    /binary architecture mismatch/
  )
})

test("rejects unsafe Electron flags even when re-hashed", async () => {
  const root = await copyArtifact()
  const path = "host/index.mjs"
  const bytes = Buffer.from(
    `${await readFile(join(root, path), "utf8")}\nconst unsafe = { nodeIntegration: true }\n`
  )
  await declareBytes(root, path, bytes)
  await assert.rejects(
    verifySurfaceArtifact(root, { allowLocalSynthetic: true }),
    /unsafe Electron flag/
  )
})

test("rejects an active privileged external endpoint even when re-hashed", async () => {
  const root = await copyArtifact()
  const path = "host/index.mjs"
  const bytes = Buffer.from(
    `${await readFile(join(root, path), "utf8")}\nconst endpoint = "https://api.waveterm.dev"\n`
  )
  await declareBytes(root, path, bytes)
  await assert.rejects(
    verifySurfaceArtifact(root, { allowLocalSynthetic: true }),
    /active external endpoint/
  )
})

test("rejects a source lock that diverges from the compiled closure", async () => {
  const root = await copyArtifact()
  const manifest = await readManifest(root)
  manifest.sourceLocks.goModSha256 = "1".repeat(64)
  manifest.build.goModSha256 = "1".repeat(64)
  await writeManifest(root, manifest)
  await assert.rejects(
    verifySurfaceArtifact(root, { allowLocalSynthetic: true }),
    /source lock does not match dependency closure/
  )
})
