// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import { lstat, readFile, readdir, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { assertPermittedRendererFile } from "./verify-full-renderer.mjs"

const REQUIRED_ENTRIES = Object.freeze({
  host: "host/index.mjs",
  preload: "preload/index.cjs",
  renderer: "renderer/wave.html",
  wavesrv: "app/bin/wavesrv.arm64",
  wsh: "app/bin/wsh-0.14.5-darwin.arm64",
  schema: "app/schema",
})
const REQUIRED_SCHEMA = Object.freeze([
  "aipresets.json",
  "backgrounds.json",
  "connections.json",
  "settings.json",
  "waveai.json",
  "widgets.json",
])
const REQUIRED_HARD_OFF = Object.freeze([
  "diagnostics",
  "standalone.lifecycle",
  "telemetry",
  "updater",
  "wave.cloud",
  "wave.share",
  "wave.sync",
])
const REQUIRED_TS_MODULES = Object.freeze([
  "frontend/app/app.tsx",
  "frontend/app/block/block.tsx",
  "frontend/app/store/wos.ts",
  "frontend/app/store/wps.ts",
  "frontend/app/store/services.ts",
  "frontend/app/store/wshrpcutil.ts",
  "frontend/app/tab/tabbar.tsx",
  "frontend/app/view/term/terminal-replay.ts",
  "frontend/app/view/term/term.tsx",
  "frontend/builder/builder-app.tsx",
  "frontend/layout/index.ts",
  "frontend/wave.ts",
  "hyprlane/entry/wave.ts",
])
const REQUIRED_GO_SOURCES = Object.freeze([
  "cmd/server/main-server.go",
  "cmd/wsh/main-wsh.go",
  "hyprlane/policy/policy.go",
  "hyprlane/sessionpolicy/coordinator.go",
  "pkg/authkey/authkey.go",
  "pkg/blockcontroller/blockcontroller.go",
  "pkg/filestore/blockstore.go",
  "pkg/filestore/blockstore_cache.go",
  "pkg/filestore/terminal_history.go",
  "pkg/service/blockservice/blockservice.go",
  "pkg/shellexec/shellexec.go",
  "pkg/telemetry/telemetry.go",
  "pkg/wcloud/wcloud.go",
  "pkg/web/web.go",
  "pkg/web/ws.go",
  "pkg/wps/wps.go",
  "pkg/wps/wpstypes.go",
  "pkg/wshrpc/wshserver/wshserver.go",
])
const LEGAL_PATHS = Object.freeze([
  "legal/LICENSE",
  "legal/NOTICE",
  "legal/THIRD_PARTY_NOTICES.txt",
  "legal/SBOM.spdx.json",
  "legal/licenses/Inter-OFL-1.1.txt",
  "legal/licenses/JetBrains-Mono-OFL-1.1.txt",
  "legal/licenses/Phosphor-Icons-MIT.txt",
])

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function normalizedPath(path) {
  return path.split(sep).join("/")
}

function assertArtifactPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "..")
  ) {
    throw new Error(`invalid broad Wave artifact path: ${String(path)}`)
  }
}

async function listFiles(root) {
  const files = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const info = await lstat(path)
      const artifactPath = normalizedPath(relative(root, path))
      if (info.isSymbolicLink()) {
        throw new Error(`broad Wave artifact contains symlink: ${artifactPath}`)
      }
      if (info.isDirectory()) {
        await visit(path)
      } else if (info.isFile()) {
        files.push(artifactPath)
      } else {
        throw new Error(
          `broad Wave artifact contains unsupported entry: ${artifactPath}`
        )
      }
    }
  }
  await visit(root)
  return files.sort()
}

async function readJson(root, path) {
  try {
    return JSON.parse(await readFile(resolve(root, path), "utf8"))
  } catch (error) {
    throw new Error(`invalid broad Wave JSON file: ${path}`, { cause: error })
  }
}

function assertSha256(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value ?? "")) {
    throw new Error(`invalid SHA-256 for ${label}`)
  }
}

function inspectMachO(bytes) {
  const invalid = { arm64: false, signatureFlags: 0 }
  if (bytes.byteLength < 32) return invalid
  const littleEndian = bytes.readUInt32LE(0) === 0xfeedfacf
  const bigEndian = bytes.readUInt32BE(0) === 0xfeedfacf
  if (!littleEndian && !bigEndian) return invalid
  const read32 = littleEndian
    ? (offset) => bytes.readUInt32LE(offset)
    : (offset) => bytes.readUInt32BE(offset)
  const arm64 = read32(4) === 0x0100000c
  const commandCount = read32(16)
  if (commandCount > 4096) return invalid
  let commandOffset = 32
  let signatureFlags = 0
  for (let index = 0; index < commandCount; index += 1) {
    if (commandOffset + 8 > bytes.byteLength) break
    const command = read32(commandOffset)
    const commandSize = read32(commandOffset + 4)
    if (commandSize < 8 || commandOffset + commandSize > bytes.byteLength) break
    if (command === 0x1d && commandSize >= 16) {
      const dataOffset = read32(commandOffset + 8)
      const dataSize = read32(commandOffset + 12)
      if (dataOffset + dataSize <= bytes.byteLength && dataSize >= 20) {
        const magic = bytes.readUInt32BE(dataOffset)
        if (magic === 0xfade0cc0) {
          const count = bytes.readUInt32BE(dataOffset + 8)
          for (let item = 0; item < Math.min(count, 64); item += 1) {
            const indexOffset = dataOffset + 12 + item * 8
            if (indexOffset + 8 > dataOffset + dataSize) break
            const blobOffset = dataOffset + bytes.readUInt32BE(indexOffset + 4)
            if (
              blobOffset + 16 <= dataOffset + dataSize &&
              bytes.readUInt32BE(blobOffset) === 0xfade0c02
            ) {
              signatureFlags = bytes.readUInt32BE(blobOffset + 12)
              break
            }
          }
        }
      }
    }
    commandOffset += commandSize
  }
  return { arm64, signatureFlags }
}

function assertMachOArm64(bytes, path) {
  const machO = inspectMachO(bytes)
  if (!machO.arm64) {
    throw new Error(`binary architecture mismatch: ${path}`)
  }
  if ((machO.signatureFlags & 0x20002) !== 0x20002) {
    throw new Error(`binary lacks a linker ad-hoc signature: ${path}`)
  }
}

function assertManifestShape(manifest, allowLocalSynthetic) {
  if (
    manifest.kind !== "hyprlane-wave-broad-core" ||
    manifest.schemaVersion !== 3 ||
    manifest.hostApiVersion !== 1 ||
    manifest.upstreamCommit !== "97e560027f494d20fed347b2d6b72b6bcb3e50e0" ||
    !/^[a-f0-9]{40}$/.test(manifest.forkCommit ?? "") ||
    manifest.target?.platform !== "darwin" ||
    manifest.target?.arch !== "arm64" ||
    manifest.target?.electron !== "42.4.1" ||
    manifest.target?.chrome !== "148.0.7778.265" ||
    manifest.target?.node !== "24.16.0" ||
    manifest.target?.nodeModuleAbi !== "146" ||
    typeof manifest.files !== "object" ||
    manifest.files === null ||
    typeof manifest.fileMetadata !== "object" ||
    manifest.fileMetadata === null
  ) {
    throw new Error("invalid broad Wave core manifest")
  }
  const provenance = manifest.provenance
  if (
    !provenance ||
    !["committed", "local-synthetic"].includes(provenance.mode) ||
    typeof provenance.releaseEligible !== "boolean" ||
    typeof provenance.dirty !== "boolean" ||
    !Number.isSafeInteger(provenance.sourceFileCount) ||
    provenance.sourceFileCount < 1
  ) {
    throw new Error("invalid broad Wave provenance")
  }
  assertSha256(provenance.sourceTreeSha256, "source provenance")
  if (provenance.mode === "local-synthetic") {
    if (
      !allowLocalSynthetic ||
      !provenance.dirty ||
      provenance.releaseEligible ||
      manifest.build?.profile !== "development"
    ) {
      throw new Error(
        "local-synthetic broad Wave artifact requires explicit development verification"
      )
    }
  } else if (
    provenance.dirty ||
    !provenance.releaseEligible ||
    manifest.build?.profile !== "release"
  ) {
    throw new Error("committed broad Wave artifact is not release eligible")
  }
  if (
    manifest.build?.toolchains?.node !== "22.17.0" ||
    manifest.build?.toolchains?.npm !== "10.9.2" ||
    manifest.build?.toolchains?.go !== "1.25.6"
  ) {
    throw new Error("broad Wave artifact toolchain mismatch")
  }
  for (const lock of ["packageLockSha256", "goModSha256", "goSumSha256"]) {
    assertSha256(manifest.sourceLocks?.[lock], `source lock ${lock}`)
    if (manifest.build?.[lock] !== manifest.sourceLocks[lock]) {
      throw new Error(`broad Wave source lock mismatch: ${lock}`)
    }
  }
}

function assertSourceMetadata(files, label) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error(`invalid ${label} source closure`)
  }
  for (const [path, metadata] of Object.entries(files)) {
    assertArtifactPath(path)
    assertSha256(metadata?.sha256, `${label} source ${path}`)
    if (!Number.isSafeInteger(metadata?.size) || metadata.size < 0) {
      throw new Error(`invalid ${label} source size: ${path}`)
    }
  }
}

function sourceTreeHash(goClosure, typescriptClosure) {
  const files = {
    ...goClosure.workspaceSources,
    ...typescriptClosure.workspaceSources,
  }
  const hash = createHash("sha256")
  for (const [path, metadata] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    hash.update(path)
    hash.update("\0")
    hash.update(metadata.sha256)
    hash.update("\n")
  }
  return hash.digest("hex")
}

async function assertClosures(root, manifest, declaredFiles) {
  if (
    manifest.closures?.typescript !== "closure/typescript.json" ||
    manifest.closures?.go !== "closure/go.json"
  ) {
    throw new Error("invalid broad Wave closure entries")
  }
  const [typescriptClosure, goClosure] = await Promise.all([
    readJson(root, manifest.closures.typescript),
    readJson(root, manifest.closures.go),
  ])
  if (
    typescriptClosure.schemaVersion !== 1 ||
    goClosure.schemaVersion !== 1 ||
    goClosure.toolchain !== "go1.25.6" ||
    goClosure.target?.platform !== "darwin" ||
    goClosure.target?.arch !== "arm64"
  ) {
    throw new Error("invalid broad Wave dependency closure")
  }
  assertSourceMetadata(
    typescriptClosure.workspaceSources,
    "TypeScript workspace"
  )
  assertSourceMetadata(
    typescriptClosure.dependencySources,
    "TypeScript dependency"
  )
  assertSourceMetadata(goClosure.workspaceSources, "Go workspace")
  assertSourceMetadata(goClosure.dependencySources, "Go dependency")

  for (const role of ["host", "preload", "renderer"]) {
    const modules = typescriptClosure.roles?.[role]
    if (
      !Array.isArray(modules) ||
      modules.some((module) => typeof module !== "string")
    ) {
      throw new Error(`invalid ${role} TypeScript module closure`)
    }
    const artifactGraph = await readJson(root, `${role}/module-graph.json`)
    if (
      artifactGraph.schemaVersion !== 1 ||
      artifactGraph.role !== role ||
      JSON.stringify(artifactGraph.modules) !== JSON.stringify(modules)
    ) {
      throw new Error(`TypeScript module closure mismatch: ${role}`)
    }
  }
  for (const moduleId of REQUIRED_TS_MODULES) {
    if (!typescriptClosure.roles.renderer.includes(moduleId)) {
      throw new Error(`missing broad Wave renderer dependency: ${moduleId}`)
    }
  }
  for (const source of REQUIRED_GO_SOURCES) {
    if (!goClosure.workspaceSources[source]) {
      throw new Error(`missing broad Wave Go source dependency: ${source}`)
    }
  }
  for (const [name, expected] of Object.entries({
    wavesrv: true,
    wsh: false,
  })) {
    const target = goClosure.targets?.[name]
    if (
      !target ||
      target.cgo !== expected ||
      !Array.isArray(target.packages) ||
      target.packages.length < 50
    ) {
      throw new Error(`invalid broad Wave Go target closure: ${name}`)
    }
  }
  if (!Array.isArray(goClosure.modules) || goClosure.modules.length < 20) {
    throw new Error("incomplete broad Wave Go module closure")
  }
  if (
    sourceTreeHash(goClosure, typescriptClosure) !==
    manifest.provenance.sourceTreeSha256
  ) {
    throw new Error("broad Wave source closure provenance mismatch")
  }
  if (
    new Set([
      ...Object.keys(goClosure.workspaceSources),
      ...Object.keys(typescriptClosure.workspaceSources),
    ]).size !== manifest.provenance.sourceFileCount
  ) {
    throw new Error("broad Wave source closure file count mismatch")
  }
  if (
    goClosure.workspaceSources["go.mod"]?.sha256 !==
      manifest.sourceLocks.goModSha256 ||
    goClosure.workspaceSources["go.sum"]?.sha256 !==
      manifest.sourceLocks.goSumSha256 ||
    typescriptClosure.workspaceSources["package-lock.json"]?.sha256 !==
      manifest.sourceLocks.packageLockSha256
  ) {
    throw new Error("broad Wave source lock does not match dependency closure")
  }
  for (const path of Object.values(manifest.closures)) {
    if (!declaredFiles.includes(path)) {
      throw new Error(`missing declared broad Wave closure: ${path}`)
    }
  }
}

async function assertCapabilities(root, manifest) {
  const declaration = manifest.capabilities
  if (
    declaration?.path !== "capabilities.json" ||
    declaration.profile !== "hyprlane-local-core" ||
    typeof declaration.policyVersion !== "string"
  ) {
    throw new Error("invalid broad Wave capability declaration")
  }
  assertSha256(declaration.sha256, "capability declaration")
  const bytes = await readFile(resolve(root, declaration.path))
  if (
    sha256(bytes) !== declaration.sha256 ||
    declaration.sha256 !== manifest.files[declaration.path]
  ) {
    throw new Error("broad Wave capability SHA-256 mismatch")
  }
  const capabilities = JSON.parse(bytes.toString("utf8"))
  if (
    capabilities.schemaVersion !== 1 ||
    capabilities.profile !== declaration.profile ||
    capabilities.policyVersion !== declaration.policyVersion ||
    capabilities.upstreamCommit !== manifest.upstreamCommit ||
    !Array.isArray(capabilities.outboundDestinations) ||
    capabilities.outboundDestinations.length !== 0 ||
    !Array.isArray(capabilities.backgroundLoops) ||
    capabilities.backgroundLoops.length !== 0 ||
    !Array.isArray(capabilities.controllers) ||
    JSON.stringify(capabilities.controllers) !== JSON.stringify(["shell"])
  ) {
    throw new Error("unsafe broad Wave capability policy")
  }
  for (const capability of REQUIRED_HARD_OFF) {
    if (!capabilities.hardOff?.includes(capability)) {
      throw new Error(`missing hard-off Wave capability: ${capability}`)
    }
  }
  if (
    !Array.isArray(capabilities.services) ||
    capabilities.services.length === 0 ||
    JSON.stringify(capabilities.services) !==
      JSON.stringify([...new Set(capabilities.services)].sort()) ||
    capabilities.services.some(
      (service) =>
        typeof service !== "string" ||
        !/^[a-z][a-z0-9]*\.[A-Z][A-Za-z0-9]*$/.test(service) ||
        /^(?:ai|builder|connection|secret|telemetry|wcloud)\./.test(service)
    )
  ) {
    throw new Error("unsafe broad Wave service capability policy")
  }
  for (const service of [
    "block.SaveTerminalState",
    "client.GetClientData",
    "object.CreateBlock",
    "workspace.GetWorkspace",
  ]) {
    if (!capabilities.services.includes(service)) {
      throw new Error(`missing broad Wave service capability: ${service}`)
    }
  }
}

async function assertLegal(root, manifest, declaredFiles) {
  const expected = {
    license: "legal/LICENSE",
    notice: "legal/NOTICE",
    thirdPartyNotices: "legal/THIRD_PARTY_NOTICES.txt",
    sbom: "legal/SBOM.spdx.json",
  }
  if (JSON.stringify(manifest.legal) !== JSON.stringify(expected)) {
    throw new Error("invalid broad Wave legal manifest")
  }
  for (const path of LEGAL_PATHS) {
    if (!declaredFiles.includes(path)) {
      throw new Error(`missing broad Wave legal payload: ${path}`)
    }
  }
  const [license, notice, thirdParty, sbom] = await Promise.all([
    readFile(resolve(root, expected.license), "utf8"),
    readFile(resolve(root, expected.notice), "utf8"),
    readFile(resolve(root, expected.thirdPartyNotices), "utf8"),
    readJson(root, expected.sbom),
  ])
  if (
    !license.includes("Apache License") ||
    !notice.includes("Command Line Inc.") ||
    !thirdParty.includes("Inter variable font") ||
    !thirdParty.includes("JetBrains Mono") ||
    !thirdParty.includes("Phosphor Icons") ||
    sbom.spdxVersion !== "SPDX-2.3" ||
    sbom.dataLicense !== "CC0-1.0" ||
    !Array.isArray(sbom.packages) ||
    sbom.packages.length < 100 ||
    !sbom.packages.some((item) => item.name === "Hyprlane Wave-derived core") ||
    !sbom.packages.some((item) => item.name === "@phosphor-icons/web")
  ) {
    throw new Error("incomplete broad Wave legal payload or SBOM")
  }
}

async function assertBinaries(root, manifest) {
  if (!Array.isArray(manifest.binaries) || manifest.binaries.length !== 2) {
    throw new Error("invalid broad Wave binary manifest")
  }
  for (const path of [REQUIRED_ENTRIES.wavesrv, REQUIRED_ENTRIES.wsh]) {
    const metadata = manifest.binaries.find((item) => item.path === path)
    if (
      !metadata ||
      metadata.platform !== "darwin" ||
      metadata.arch !== "arm64" ||
      metadata.format !== "mach-o-64" ||
      metadata.mode !== "0755" ||
      metadata.signature !== "adhoc-linker" ||
      metadata.sha256 !== manifest.files[path]
    ) {
      throw new Error(`binary metadata mismatch: ${path}`)
    }
    const bytes = await readFile(resolve(root, path))
    const info = await stat(resolve(root, path))
    assertMachOArm64(bytes, path)
    if ((info.mode & 0o111) === 0) {
      throw new Error(`broad Wave binary is not executable: ${path}`)
    }
  }
}

async function assertPrivilegedPolicies(root) {
  const host = await readFile(resolve(root, REQUIRED_ENTRIES.host), "utf8")
  const preload = await readFile(
    resolve(root, REQUIRED_ENTRIES.preload),
    "utf8"
  )
  for (const value of [host, preload]) {
    if (
      /api\.waveterm\.dev|https?:\/\/(?!127\.0\.0\.1)/i.test(value) ||
      /webSecurity\s*:\s*(?:false|!1)/.test(value) ||
      /nodeIntegration\s*:\s*(?:true|!0)/.test(value) ||
      /contextIsolation\s*:\s*(?:false|!1)/.test(value) ||
      /sandbox\s*:\s*(?:false|!1)/.test(value)
    ) {
      throw new Error("unsafe Electron flag or active external endpoint")
    }
  }
  if (/webviewTag\s*:\s*(?:true|!0)/.test(preload)) {
    throw new Error("hosted Wave preload may not enable webviewTag")
  }
  for (const requiredPolicy of [
    "default-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ]) {
    if (!host.includes(requiredPolicy)) {
      throw new Error(`missing hosted Wave policy: ${requiredPolicy}`)
    }
  }
  if (
    !/(?:webviewTag\s*:\s*true|webviewTag\s*:\s*!0)/.test(host) ||
    !/(?:nodeIntegration\s*:\s*false|nodeIntegration\s*:\s*!1)/.test(host) ||
    !/(?:contextIsolation\s*:\s*true|contextIsolation\s*:\s*!0)/.test(host) ||
    !/(?:sandbox\s*:\s*true|sandbox\s*:\s*!0)/.test(host) ||
    !/(?:webSecurity\s*:\s*true|webSecurity\s*:\s*!0)/.test(host)
  ) {
    throw new Error("missing safe Electron webPreferences")
  }
  for (const guestGuard of [
    /function prepareHostedWebview\(/,
    /delete preferences\.preload/,
    /delete params\.preload/,
    /nodeIntegrationInSubFrames\s*:\s*(?:false|!1)/,
    /params\.partition\s*=\s*HOSTED_WEBVIEW_PARTITION/,
    /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*["']deny["']\s*\}\)\)/,
    /will-attach-webview/,
    /did-attach-webview/,
  ]) {
    if (!guestGuard.test(host)) {
      throw new Error("missing hardened hosted webview guard")
    }
  }
  if (
    /require\([^"']|\bcreateRequire\b|\beval\s*\(|\bFunction\s*\(/.test(preload)
  ) {
    throw new Error("unsafe hosted Wave preload loading primitive")
  }
}

export async function verifySurfaceArtifact(artifactRoot, options = {}) {
  const root = resolve(artifactRoot)
  const manifest = await readJson(root, "manifest.json")
  assertManifestShape(manifest, options.allowLocalSynthetic === true)
  if (
    manifest.signing?.artifactBinarySignature !== "adhoc-linker" ||
    manifest.signing?.releaseBinarySignature !== "developer-id-application" ||
    manifest.signing?.releaseManifestStage !==
      "after-nested-signing-before-outer-app-seal"
  ) {
    throw new Error("invalid broad Wave signing policy")
  }
  const declaredFiles = Object.keys(manifest.files).sort()
  for (const path of declaredFiles) {
    assertArtifactPath(path)
    assertSha256(manifest.files[path], path)
  }
  if (
    JSON.stringify(Object.keys(manifest.fileMetadata).sort()) !==
    JSON.stringify(declaredFiles)
  ) {
    throw new Error("broad Wave file metadata does not match declared files")
  }
  for (const [role, path] of Object.entries(REQUIRED_ENTRIES)) {
    if (manifest.entries?.[role] !== path) {
      throw new Error(`invalid broad Wave ${role} entry`)
    }
    if (role !== "schema" && !declaredFiles.includes(path)) {
      throw new Error(`missing broad Wave ${role} entry`)
    }
  }
  for (const schemaName of REQUIRED_SCHEMA) {
    const path = `app/schema/${schemaName}`
    if (!declaredFiles.includes(path)) {
      throw new Error(`missing broad Wave schema file: ${schemaName}`)
    }
  }

  const actualFiles = await listFiles(root)
  const expectedFiles = [...declaredFiles, "manifest.json"].sort()
  for (const path of actualFiles) {
    if (!expectedFiles.includes(path)) {
      throw new Error(`undeclared broad Wave artifact file: ${path}`)
    }
  }
  for (const path of expectedFiles) {
    if (!actualFiles.includes(path)) {
      throw new Error(`missing broad Wave artifact file: ${path}`)
    }
  }

  let totalBytes = 0
  for (const path of declaredFiles) {
    const absolutePath = resolve(root, path)
    const bytes = await readFile(absolutePath)
    const info = await stat(absolutePath)
    totalBytes += bytes.byteLength
    if (sha256(bytes) !== manifest.files[path]) {
      throw new Error(`broad Wave artifact hash mismatch: ${path}`)
    }
    const metadata = manifest.fileMetadata[path]
    if (
      metadata?.size !== bytes.byteLength ||
      metadata?.mode !== (info.mode & 0o777).toString(8).padStart(4, "0")
    ) {
      throw new Error(`broad Wave artifact metadata mismatch: ${path}`)
    }
    if (path.startsWith("renderer/")) {
      assertPermittedRendererFile(path.slice("renderer/".length), bytes)
    }
  }

  await Promise.all([
    assertClosures(root, manifest, declaredFiles),
    assertCapabilities(root, manifest),
    assertLegal(root, manifest, declaredFiles),
    assertBinaries(root, manifest),
    assertPrivilegedPolicies(root),
  ])
  return Object.freeze({
    kind: manifest.kind,
    fileCount: declaredFiles.length,
    manifestSha256: sha256(await readFile(resolve(root, "manifest.json"))),
    totalBytes,
  })
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await verifySurfaceArtifact(
    process.argv[2] ?? resolve("dist/hyprlane"),
    { allowLocalSynthetic: process.env.HYPRLANE_WAVE_LOCAL_SYNTHETIC === "1" }
  )
  console.info(JSON.stringify(result))
}
