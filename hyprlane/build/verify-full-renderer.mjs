// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const PROHIBITED_ASSET_HASHES = new Set([
  "127111fe32e93fd41e72261944e5e97e54cda388f84986fc0ccc87290c623e1d",
  "2103b3208774f48491c9ffd7c55e493c5ef0aea7b9382778e463f145579f7516",
  "46cd689efd5f2aab43513b0f551064428d54a6a1df819f91c1a8e0d626ed246d",
  "743d1332051f7252dbe76440db67d8db1330cf65998659f6c86cb91f4fe1466c",
  "92a3e010ac3629ba4d67be77c314e8ff7849a311c1fbdd72e7413021b0bc0c7b",
  "aa86f6effeb80bd5cf06d5e0871839fe0d2a45a88e50ea6e1582f59fbfda101d",
  "afb4d16c2b1e90a9268b848377b388df4c8919e91dc0a1368ceb006179d0ccdb",
  "c022e7c2113fb918e246cca7c0f162190ea7b417e878d0f6c7049ed02b5616f2",
  "d5cf1907c78ad9455763e348cadfaa7bdd30e8f15baed78546bb6d9ef3a41600",
  "e3938bd75036851b95a4e98c6533dab4bc652273a00742a2a1c097b3e89fa54b",
])

const REQUIRED_MODULES = [
  "frontend/app/app.tsx",
  "frontend/app/block/block.tsx",
  "frontend/app/store/wos.ts",
  "frontend/app/store/wshrpcutil.ts",
  "frontend/app/tab/tabbar.tsx",
  "frontend/app/view/term/term.tsx",
  "frontend/builder/builder-app.tsx",
  "frontend/layout/index.ts",
  "frontend/wave.ts",
  "hyprlane/assets/fa-compat.ts",
  "hyprlane/entry/wave.html",
  "hyprlane/entry/wave.ts",
]

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

async function listFiles(root) {
  const files = []
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const stat = await lstat(path)
      const artifactPath = relative(root, path).split(sep).join("/")
      if (stat.isSymbolicLink()) {
        throw new Error(`renderer artifact contains symlink: ${artifactPath}`)
      }
      if (stat.isDirectory()) {
        await visit(path)
      } else if (stat.isFile()) {
        files.push(artifactPath)
      } else {
        throw new Error(`unsupported renderer artifact entry: ${artifactPath}`)
      }
    }
  }
  await visit(root)
  return files.sort()
}

export function assertPermittedRendererFile(path, bytes) {
  const normalizedPath = path.toLowerCase()
  if (
    normalizedPath.startsWith("fontawesome/") ||
    normalizedPath.includes("/fontawesome/") ||
    normalizedPath.startsWith("logos/") ||
    normalizedPath.includes("/logos/") ||
    normalizedPath.includes("wave-logo")
  ) {
    throw new Error(`prohibited renderer asset path: ${path}`)
  }
  if (PROHIBITED_ASSET_HASHES.has(sha256(bytes))) {
    throw new Error(`prohibited renderer asset hash: ${path}`)
  }
  if (
    /Font Awesome (?:6 )?Pro|Commercial License/i.test(bytes.toString("utf8"))
  ) {
    throw new Error(`prohibited renderer asset content: ${path}`)
  }
}

export async function verifyFullRendererArtifact(artifactRoot) {
  const root = resolve(artifactRoot)
  const files = await listFiles(root)
  for (const requiredFile of [
    "compatibility-assets.json",
    "module-graph.json",
    "vite-manifest.json",
    "wave.html",
  ]) {
    if (!files.includes(requiredFile)) {
      throw new Error(`missing full renderer file: ${requiredFile}`)
    }
  }

  let totalBytes = 0
  for (const path of files) {
    const bytes = await readFile(resolve(root, path))
    totalBytes += bytes.byteLength
    assertPermittedRendererFile(path, bytes)
  }

  const graph = JSON.parse(await readFile(resolve(root, "module-graph.json")))
  if (
    graph.schemaVersion !== 1 ||
    graph.role !== "renderer" ||
    !Array.isArray(graph.modules)
  ) {
    throw new Error("invalid full renderer module graph")
  }
  for (const moduleId of REQUIRED_MODULES) {
    if (!graph.modules.includes(moduleId)) {
      throw new Error(`missing full renderer dependency: ${moduleId}`)
    }
  }

  const compatibility = JSON.parse(
    await readFile(resolve(root, "compatibility-assets.json"))
  )
  if (
    compatibility.schemaVersion !== 1 ||
    typeof compatibility.files !== "object" ||
    compatibility.files === null
  ) {
    throw new Error("invalid renderer compatibility asset manifest")
  }
  for (const [path, expectedHash] of Object.entries(compatibility.files)) {
    if (!files.includes(path)) {
      throw new Error(`missing renderer compatibility asset: ${path}`)
    }
    const bytes = await readFile(resolve(root, path))
    if (sha256(bytes) !== expectedHash) {
      throw new Error(`renderer compatibility asset hash mismatch: ${path}`)
    }
  }

  return Object.freeze({
    kind: "wave-full-renderer",
    fileCount: files.length,
    moduleCount: graph.modules.length,
    totalBytes,
  })
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await verifyFullRendererArtifact(
    process.argv[2] ?? resolve("dist/hyprlane/renderer")
  )
  console.info(JSON.stringify(result))
}
