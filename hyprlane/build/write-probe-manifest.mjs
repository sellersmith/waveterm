// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { verifyBuildProvenance } from "./provenance.mjs"

const root = resolve("dist/hyprlane")
const entry = "host/index.mjs"
const entryBytes = await readFile(resolve(root, entry))
const packageLockBytes = await readFile(resolve("package-lock.json"))
const toolchains = JSON.parse(
  await readFile(resolve("hyprlane/toolchains.json"), "utf8")
)
const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex")
const npmVersion = execFileSync("npm", ["--version"], {
  encoding: "utf8",
}).trim()
const forkCommit = process.env.HYPRLANE_WAVE_FORK_COMMIT ?? ""
const provenance = await verifyBuildProvenance({
  cwd: resolve("."),
  forkCommit,
  upstreamCommit: "97e560027f494d20fed347b2d6b72b6bcb3e50e0",
  allowLocalSynthetic:
    process.env.HYPRLANE_WAVE_LOCAL_SYNTHETIC === "1",
})

if (process.versions.node !== toolchains.node || npmVersion !== toolchains.npm) {
  throw new Error(
    `Wave probe toolchain mismatch: Node ${process.versions.node}, npm ${npmVersion}`
  )
}

const manifest = {
  kind: "host-probe",
  schemaVersion: 1,
  hostApiVersion: 1,
  upstreamCommit: "97e560027f494d20fed347b2d6b72b6bcb3e50e0",
  forkCommit,
  provenance,
  target: {
    platform: "darwin",
    arch: "arm64",
    electron: "42.4.1",
    chrome: "148.0.7778.265",
    node: "24.16.0",
    nodeModuleAbi: "146",
  },
  build: {
    node: process.versions.node,
    npm: npmVersion,
    packageLockSha256: sha256(packageLockBytes),
  },
  entry,
  files: { [entry]: sha256(entryBytes) },
}

await writeFile(
  resolve(root, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
)
