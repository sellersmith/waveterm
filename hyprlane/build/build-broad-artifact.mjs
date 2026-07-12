// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { verifyBuildProvenance } from "./provenance.mjs"

const PROJECT_ROOT = resolve(import.meta.dirname, "../..")
const ARTIFACT_ROOT = resolve(PROJECT_ROOT, "dist/hyprlane")
const UPSTREAM_COMMIT = "97e560027f494d20fed347b2d6b72b6bcb3e50e0"
const WAVE_VERSION = "0.14.5"
const TARGET = Object.freeze({
  platform: "darwin",
  arch: "arm64",
  electron: "42.4.1",
  chrome: "148.0.7778.265",
  node: "24.16.0",
  nodeModuleAbi: "146",
})
const REQUIRED_SCHEMA = Object.freeze([
  "aipresets.json",
  "backgrounds.json",
  "connections.json",
  "settings.json",
  "waveai.json",
  "widgets.json",
])

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: options.env,
  })
}

function normalizedPath(path) {
  return path.split(sep).join("/")
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"))
}

async function copyChecked(source, destination, mode) {
  const sourcePath = resolve(PROJECT_ROOT, source)
  const sourceStat = await lstat(sourcePath)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`build input must be a regular file: ${source}`)
  }
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(sourcePath, destination)
  if (mode !== undefined) await chmod(destination, mode)
}

async function listRegularFiles(root) {
  const files = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        throw new Error(
          `artifact contains symlink: ${normalizedPath(relative(root, path))}`
        )
      }
      if (info.isDirectory()) {
        await visit(path)
      } else if (info.isFile()) {
        files.push(normalizedPath(relative(root, path)))
      } else {
        throw new Error(`artifact contains unsupported entry: ${path}`)
      }
    }
  }
  await visit(root)
  return files.sort()
}

function scrubbedBuildEnv(overrides = {}) {
  const env = {}
  for (const key of [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "USER",
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return {
    ...env,
    CI: "1",
    GOTOOLCHAIN: "go1.25.6",
    GOFLAGS: "-mod=readonly",
    // The broad Wave renderer pulls Monaco, Shiki, and the complete upstream
    // feature graph into one production build. Node's default old-space limit
    // can terminate Vite before it writes a manifest on macOS, leaving a
    // half-built artifact. Keep this deterministic for local and CI builds.
    NODE_OPTIONS: "--max-old-space-size=8192",
    SOURCE_DATE_EPOCH: run(
      "git",
      ["show", "-s", "--format=%ct", UPSTREAM_COMMIT],
      { capture: true }
    ).trim(),
    TZ: "UTC",
    ...overrides,
  }
}

function assertToolchains(toolchains) {
  const npmVersion = run("npm", ["--version"], { capture: true }).trim()
  const goVersion = run("go", ["env", "GOVERSION"], {
    capture: true,
    env: scrubbedBuildEnv(),
  }).trim()
  if (
    process.versions.node !== toolchains.node ||
    npmVersion !== toolchains.npm ||
    goVersion !== `go${toolchains.go}`
  ) {
    throw new Error(
      `toolchain mismatch: Node ${process.versions.node}, npm ${npmVersion}, Go ${goVersion}`
    )
  }
  if (process.platform !== TARGET.platform || process.arch !== TARGET.arch) {
    throw new Error("broad Wave core must be built on macOS arm64")
  }
  return { node: process.versions.node, npm: npmVersion, go: toolchains.go }
}

function buildTimeFromEpoch(epoch) {
  const date = new Date(Number(epoch) * 1000)
  const value = date.toISOString().replace(/[-:T]/g, "").slice(0, 12)
  if (!/^\d{12}$/.test(value)) throw new Error("invalid source date epoch")
  return value
}

async function buildBinaries(buildEnv) {
  const binRoot = resolve(ARTIFACT_ROOT, "app/bin")
  await mkdir(binRoot, { recursive: true })
  const buildTime = buildTimeFromEpoch(buildEnv.SOURCE_DATE_EPOCH)
  const ldflags = `-s -w -X main.BuildTime=${buildTime} -X main.WaveVersion=${WAVE_VERSION}`
  const common = ["build", "-trimpath", "-buildvcs=false", "-ldflags", ldflags]

  run(
    "go",
    [
      ...common,
      "-tags",
      "osusergo,sqlite_omit_load_extension",
      "-o",
      resolve(binRoot, "wavesrv.arm64"),
      "cmd/server/main-server.go",
    ],
    {
      env: { ...buildEnv, CGO_ENABLED: "1", GOARCH: "arm64", GOOS: "darwin" },
    }
  )
  run(
    "go",
    [
      ...common,
      "-o",
      resolve(binRoot, `wsh-${WAVE_VERSION}-darwin.arm64`),
      "cmd/wsh/main-wsh.go",
    ],
    {
      env: { ...buildEnv, CGO_ENABLED: "0", GOARCH: "arm64", GOOS: "darwin" },
    }
  )
  await chmod(resolve(binRoot, "wavesrv.arm64"), 0o755)
  await chmod(resolve(binRoot, `wsh-${WAVE_VERSION}-darwin.arm64`), 0o755)
}

function parseGoList(value) {
  const trimmed = value.trim()
  if (!trimmed) return []
  return JSON.parse(`[${trimmed.replace(/\n}\n{/g, "\n},\n{")}]`)
}

async function hashSourceFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`compiled source is not a regular file: ${path}`)
  }
  const bytes = await readFile(path)
  return { sha256: sha256(bytes), size: bytes.byteLength }
}

async function goTargetClosure(target, buildEnv) {
  const env = {
    ...buildEnv,
    CGO_ENABLED: target.cgo ? "1" : "0",
    GOARCH: "arm64",
    GOOS: "darwin",
  }
  const args = ["list", "-deps", "-json"]
  if (target.tags.length) args.push("-tags", target.tags.join(","))
  args.push(target.entry)
  const packages = parseGoList(run("go", args, { capture: true, env }))
  const result = []
  const workspaceSources = {}
  const dependencySources = {}
  const modules = new Map()
  const fileFields = [
    "CFiles",
    "CXXFiles",
    "CgoFiles",
    "EmbedFiles",
    "FFiles",
    "GoFiles",
    "HFiles",
    "MFiles",
    "SFiles",
    "SwigCXXFiles",
    "SwigFiles",
    "SysoFiles",
  ]

  for (const packageInfo of packages) {
    const compiledFiles = [
      ...new Set(
        fileFields.flatMap((field) =>
          Array.isArray(packageInfo[field]) ? packageInfo[field] : []
        )
      ),
    ].sort()
    const files = []
    for (const name of compiledFiles) {
      const absolutePath = resolve(packageInfo.Dir, name)
      const metadata = await hashSourceFile(absolutePath)
      let sourcePath
      if (
        absolutePath === PROJECT_ROOT ||
        absolutePath.startsWith(`${PROJECT_ROOT}${sep}`)
      ) {
        sourcePath = normalizedPath(relative(PROJECT_ROOT, absolutePath))
        workspaceSources[sourcePath] = metadata
      } else if (packageInfo.Module?.Dir) {
        sourcePath = `${packageInfo.Module.Path}@${packageInfo.Module.Version || "local"}/${normalizedPath(relative(packageInfo.Module.Dir, absolutePath))}`
        dependencySources[sourcePath] = metadata
      } else if (packageInfo.Standard) {
        sourcePath = `go${buildEnv.GOTOOLCHAIN.slice(2)}/${packageInfo.ImportPath}/${name}`
        dependencySources[sourcePath] = metadata
      } else {
        throw new Error(
          `compiled Go source has no provenance root: ${absolutePath}`
        )
      }
      files.push(sourcePath)
    }

    if (packageInfo.Module) {
      const moduleInfo = packageInfo.Module.Replace ?? packageInfo.Module
      const key = `${moduleInfo.Path}@${moduleInfo.Version || "local"}`
      modules.set(key, {
        path: moduleInfo.Path,
        version: moduleInfo.Version || "local",
        sum: moduleInfo.Sum || "",
        goModSum: moduleInfo.GoModSum || "",
        replacedFrom: packageInfo.Module.Replace
          ? `${packageInfo.Module.Path}@${packageInfo.Module.Version || "local"}`
          : null,
      })
    }
    result.push({
      importPath: packageInfo.ImportPath,
      module:
        packageInfo.Module?.Path ?? (packageInfo.Standard ? "go:stdlib" : null),
      standard: Boolean(packageInfo.Standard),
      files,
    })
  }
  result.sort((a, b) => a.importPath.localeCompare(b.importPath))
  return {
    cgo: target.cgo,
    entry: target.entry,
    packages: result,
    tags: target.tags,
    modules: [...modules.values()].sort((a, b) =>
      `${a.path}@${a.version}`.localeCompare(`${b.path}@${b.version}`)
    ),
    workspaceSources,
    dependencySources,
  }
}

async function createGoClosure(buildEnv) {
  const targets = {}
  const workspaceSources = {}
  const dependencySources = {}
  const modules = new Map()
  for (const target of [
    {
      name: "wavesrv",
      entry: "./cmd/server/main-server.go",
      cgo: true,
      tags: ["osusergo", "sqlite_omit_load_extension"],
    },
    {
      name: "wsh",
      entry: "./cmd/wsh/main-wsh.go",
      cgo: false,
      tags: [],
    },
  ]) {
    const closure = await goTargetClosure(target, buildEnv)
    targets[target.name] = {
      cgo: closure.cgo,
      entry: closure.entry,
      packages: closure.packages,
      tags: closure.tags,
    }
    Object.assign(workspaceSources, closure.workspaceSources)
    Object.assign(dependencySources, closure.dependencySources)
    for (const moduleInfo of closure.modules) {
      modules.set(`${moduleInfo.path}@${moduleInfo.version}`, moduleInfo)
    }
  }
  for (const path of ["go.mod", "go.sum"]) {
    workspaceSources[path] = await hashSourceFile(resolve(PROJECT_ROOT, path))
  }
  return {
    schemaVersion: 1,
    toolchain: buildEnv.GOTOOLCHAIN,
    target: TARGET,
    modules: [...modules.values()].sort((a, b) =>
      `${a.path}@${a.version}`.localeCompare(`${b.path}@${b.version}`)
    ),
    targets,
    workspaceSources: Object.fromEntries(
      Object.entries(workspaceSources).sort(([a], [b]) => a.localeCompare(b))
    ),
    dependencySources: Object.fromEntries(
      Object.entries(dependencySources).sort(([a], [b]) => a.localeCompare(b))
    ),
  }
}

async function scanBuildInputs() {
  const inputs = [
    "PATCHES.md",
    "UPSTREAM.lock",
    "hyprlane/capabilities.json",
    "hyprlane/toolchains.json",
    "hyprlane/tsconfig.json",
    "package.json",
    "package-lock.json",
  ]
  const scan = async (directory) => {
    const entries = await readdir(resolve(PROJECT_ROOT, directory), {
      withFileTypes: true,
    })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) await scan(path)
      else if (entry.isFile()) inputs.push(path)
      else throw new Error(`unsupported build input: ${path}`)
    }
  }
  await scan("hyprlane/build")
  await scan("hyprlane/legal")
  return [...new Set(inputs)].sort()
}

async function snapshotWorkspaceSources() {
  const files = {}
  const excludedDirectories = new Set([
    ".git",
    "coverage",
    "dist",
    "node_modules",
  ])
  const visit = async (sourcePath) => {
    const absolutePath = resolve(PROJECT_ROOT, sourcePath)
    const info = await lstat(absolutePath)
    if (info.isSymbolicLink()) {
      throw new Error(`workspace build source contains symlink: ${sourcePath}`)
    }
    if (info.isDirectory()) {
      const entries = await readdir(absolutePath, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
          continue
        }
        await visit(`${sourcePath}/${entry.name}`)
      }
      return
    }
    if (!info.isFile()) {
      throw new Error(
        `workspace build source contains special file: ${sourcePath}`
      )
    }
    files[sourcePath] = sha256(await readFile(absolutePath))
  }
  for (const sourcePath of [
    "PATCHES.md",
    "UPSTREAM.lock",
    "cmd",
    "db",
    "frontend",
    "go.mod",
    "go.sum",
    "hyprlane",
    "package-lock.json",
    "package.json",
    "pkg",
    "schema",
    "tsunami",
  ]) {
    await visit(sourcePath)
  }
  return files
}

async function assertWorkspaceStayedQuiet(before) {
  const after = await snapshotWorkspaceSources()
  const beforePaths = Object.keys(before).sort()
  const afterPaths = Object.keys(after).sort()
  if (JSON.stringify(beforePaths) !== JSON.stringify(afterPaths)) {
    throw new Error("workspace source file set changed during broad Wave build")
  }
  for (const path of beforePaths) {
    if (before[path] !== after[path]) {
      throw new Error(
        `workspace source changed during broad Wave build: ${path}`
      )
    }
  }
}

async function createTypescriptClosure() {
  const roles = {}
  const workspaceSources = {}
  const dependencySources = {}
  for (const role of ["host", "preload", "renderer"]) {
    const graph = await readJson(
      resolve(ARTIFACT_ROOT, role, "module-graph.json")
    )
    if (
      graph.schemaVersion !== 1 ||
      graph.role !== role ||
      !Array.isArray(graph.modules)
    ) {
      throw new Error(`invalid ${role} module graph`)
    }
    roles[role] = [...graph.modules].sort()
    for (const moduleId of graph.modules) {
      if (moduleId.startsWith("virtual:")) continue
      if (
        moduleId.includes("\\") ||
        moduleId.split("/").some((part) => part === "..")
      ) {
        throw new Error(`module graph escapes source root: ${moduleId}`)
      }
      const path = resolve(PROJECT_ROOT, moduleId)
      let info
      try {
        info = await lstat(path)
      } catch {
        continue
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(
          `module graph source is not a regular file: ${moduleId}`
        )
      }
      const metadata = await hashSourceFile(path)
      if (moduleId.startsWith("node_modules/")) {
        dependencySources[moduleId] = metadata
      } else {
        workspaceSources[moduleId] = metadata
      }
    }
  }
  for (const path of await scanBuildInputs()) {
    workspaceSources[path] = await hashSourceFile(resolve(PROJECT_ROOT, path))
  }
  return {
    schemaVersion: 1,
    roles,
    workspaceSources: Object.fromEntries(
      Object.entries(workspaceSources).sort(([a], [b]) => a.localeCompare(b))
    ),
    dependencySources: Object.fromEntries(
      Object.entries(dependencySources).sort(([a], [b]) => a.localeCompare(b))
    ),
  }
}

function spdxId(prefix, value) {
  const label = value.replace(/[^A-Za-z0-9.-]+/g, "-").slice(0, 80)
  return `SPDXRef-${prefix}-${label}-${sha256(value).slice(0, 12)}`
}

function nodePackageName(packagePath, packageInfo) {
  if (typeof packageInfo.name === "string" && packageInfo.name) {
    return packageInfo.name
  }
  const marker = "node_modules/"
  const index = packagePath.lastIndexOf(marker)
  if (index < 0) return packagePath || "waveterm"
  const suffix = packagePath.slice(index + marker.length)
  const parts = suffix.split("/")
  return parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

async function createSbom(goClosure, sourceTreeSha256) {
  const packageLock = await readJson(resolve(PROJECT_ROOT, "package-lock.json"))
  const packages = []
  const relationships = []
  const rootId = "SPDXRef-Package-Hyprlane-Wave-Core"
  packages.push({
    SPDXID: rootId,
    name: "Hyprlane Wave-derived core",
    versionInfo: WAVE_VERSION,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "Apache-2.0",
    licenseDeclared: "Apache-2.0",
    copyrightText:
      "Copyright 2025 Command Line Inc.; modifications copyright 2026 Hyprlane",
  })

  for (const [path, packageInfo] of Object.entries(
    packageLock.packages ?? {}
  )) {
    if (!path || !path.includes("node_modules/") || !packageInfo.version)
      continue
    const name = nodePackageName(path, packageInfo)
    const identity = `npm:${name}@${packageInfo.version}:${path}`
    const id = spdxId("NPM", identity)
    packages.push({
      SPDXID: id,
      name,
      versionInfo: packageInfo.version,
      downloadLocation: packageInfo.resolved ?? "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: packageInfo.license ?? "NOASSERTION",
      licenseDeclared: packageInfo.license ?? "NOASSERTION",
      copyrightText: "NOASSERTION",
      externalRefs: packageInfo.integrity
        ? [
            {
              referenceCategory: "PACKAGE-MANAGER",
              referenceType: "purl",
              referenceLocator: `pkg:npm/${encodeURIComponent(name)}@${packageInfo.version}`,
              comment: `package-lock integrity ${packageInfo.integrity}`,
            },
          ]
        : undefined,
    })
    relationships.push({
      spdxElementId: rootId,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: id,
    })
  }

  for (const moduleInfo of goClosure.modules) {
    if (moduleInfo.path === "github.com/wavetermdev/waveterm") continue
    const identity = `go:${moduleInfo.path}@${moduleInfo.version}`
    const id = spdxId("GO", identity)
    packages.push({
      SPDXID: id,
      name: moduleInfo.path,
      versionInfo: moduleInfo.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:golang/${moduleInfo.path}@${moduleInfo.version}`,
        },
      ],
      comment: moduleInfo.sum ? `go.sum ${moduleInfo.sum}` : undefined,
    })
    relationships.push({
      spdxElementId: rootId,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: id,
    })
  }

  packages.sort((a, b) => a.SPDXID.localeCompare(b.SPDXID))
  relationships.sort((a, b) =>
    a.relatedSpdxElement.localeCompare(b.relatedSpdxElement)
  )
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "Hyprlane Wave-derived core",
    documentNamespace: `https://hyprlane.local/sbom/wave-core/${sourceTreeSha256}`,
    creationInfo: {
      created: new Date(
        Number(scrubbedBuildEnv().SOURCE_DATE_EPOCH) * 1000
      ).toISOString(),
      creators: ["Organization: Hyprlane", "Tool: hyprlane-broad-artifact"],
      licenseListVersion: "3.27.0",
    },
    documentDescribes: [rootId],
    packages,
    relationships,
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
  return { files, sha256: hash.digest("hex") }
}

async function createProvenance(sourceFiles, sourceSha256) {
  const forkCommit =
    process.env.HYPRLANE_WAVE_FORK_COMMIT ??
    run("git", ["rev-parse", "HEAD"], { capture: true }).trim()
  const allowLocalSynthetic = process.env.HYPRLANE_WAVE_LOCAL_SYNTHETIC === "1"
  if (allowLocalSynthetic) {
    run("git", ["cat-file", "-e", `${forkCommit}^{commit}`], {
      capture: true,
    })
    run("git", ["merge-base", "--is-ancestor", UPSTREAM_COMMIT, forkCommit], {
      capture: true,
    })
    return {
      forkCommit,
      provenance: {
        dirty: true,
        mode: "local-synthetic",
        releaseEligible: false,
        sourceFileCount: Object.keys(sourceFiles).length,
        sourceTreeSha256: sourceSha256,
      },
    }
  }
  const provenance = await verifyBuildProvenance({
    cwd: PROJECT_ROOT,
    forkCommit,
    upstreamCommit: UPSTREAM_COMMIT,
    allowLocalSynthetic: false,
    sourcePaths: Object.keys(sourceFiles),
  })
  if (provenance.sourceTreeSha256 !== sourceSha256) {
    throw new Error(
      "committed provenance does not match compiled source closure"
    )
  }
  return {
    forkCommit,
    provenance: {
      ...provenance,
      dirty: false,
      releaseEligible: true,
      sourceFileCount: Object.keys(sourceFiles).length,
    },
  }
}

async function writeLegalPayload() {
  const sources = await readJson(
    resolve(PROJECT_ROOT, "hyprlane/legal/legal-sources.json")
  )
  if (sources.schemaVersion !== 1 || !Array.isArray(sources.files)) {
    throw new Error("invalid legal source manifest")
  }
  for (const item of sources.files) {
    await copyChecked(
      item.source,
      resolve(ARTIFACT_ROOT, "legal", item.output),
      0o644
    )
  }
}

function inspectMachO(bytes) {
  if (bytes.byteLength < 32) return { arm64: false, signatureFlags: 0 }
  const littleMagic = bytes.readUInt32LE(0) === 0xfeedfacf
  const bigMagic = bytes.readUInt32BE(0) === 0xfeedfacf
  if (!littleMagic && !bigMagic) {
    return { arm64: false, signatureFlags: 0 }
  }
  const read32 = littleMagic
    ? (offset) => bytes.readUInt32LE(offset)
    : (offset) => bytes.readUInt32BE(offset)
  const arm64 = read32(4) === 0x0100000c
  const commandCount = read32(16)
  if (commandCount > 4096) return { arm64: false, signatureFlags: 0 }
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

async function binaryMetadata(path) {
  const absolutePath = resolve(ARTIFACT_ROOT, path)
  const bytes = await readFile(absolutePath)
  const info = await stat(absolutePath)
  const machO = inspectMachO(bytes)
  if (!machO.arm64) {
    throw new Error(`binary is not a thin arm64 Mach-O executable: ${path}`)
  }
  if ((machO.signatureFlags & 0x20002) !== 0x20002) {
    throw new Error(`binary lacks a linker ad-hoc signature: ${path}`)
  }
  if ((info.mode & 0o111) === 0) {
    throw new Error(`binary is not executable: ${path}`)
  }
  return {
    path,
    platform: "darwin",
    arch: "arm64",
    format: "mach-o-64",
    mode: (info.mode & 0o777).toString(8).padStart(4, "0"),
    signature: "adhoc-linker",
    sha256: sha256(bytes),
    size: bytes.byteLength,
  }
}

async function createManifest(options) {
  const paths = (await listRegularFiles(ARTIFACT_ROOT)).filter(
    (path) => path !== "manifest.json"
  )
  const files = {}
  const fileMetadata = {}
  for (const path of paths) {
    const absolutePath = resolve(ARTIFACT_ROOT, path)
    const bytes = await readFile(absolutePath)
    const info = await stat(absolutePath)
    files[path] = sha256(bytes)
    fileMetadata[path] = {
      size: bytes.byteLength,
      mode: (info.mode & 0o777).toString(8).padStart(4, "0"),
    }
  }
  const capabilitiesPath = "capabilities.json"
  const capabilities = await readJson(resolve(ARTIFACT_ROOT, capabilitiesPath))
  const sourceLocks = {
    packageLockSha256: sha256(
      await readFile(resolve(PROJECT_ROOT, "package-lock.json"))
    ),
    goModSha256: sha256(await readFile(resolve(PROJECT_ROOT, "go.mod"))),
    goSumSha256: sha256(await readFile(resolve(PROJECT_ROOT, "go.sum"))),
  }
  const manifest = {
    kind: "hyprlane-wave-broad-core",
    schemaVersion: 3,
    hostApiVersion: 1,
    upstreamCommit: UPSTREAM_COMMIT,
    forkCommit: options.forkCommit,
    provenance: options.provenance,
    target: TARGET,
    build: {
      profile:
        options.provenance.mode === "local-synthetic"
          ? "development"
          : "release",
      sourceDateEpoch: Number(options.buildEnv.SOURCE_DATE_EPOCH),
      toolchains: options.toolchains,
      ...sourceLocks,
    },
    sourceLocks,
    capabilities: {
      path: capabilitiesPath,
      sha256: files[capabilitiesPath],
      profile: capabilities.profile,
      policyVersion: capabilities.policyVersion,
    },
    entries: {
      host: "host/index.mjs",
      preload: "preload/index.cjs",
      renderer: "renderer/wave.html",
      wavesrv: "app/bin/wavesrv.arm64",
      wsh: `app/bin/wsh-${WAVE_VERSION}-darwin.arm64`,
      schema: "app/schema",
    },
    closures: {
      typescript: "closure/typescript.json",
      go: "closure/go.json",
    },
    legal: {
      license: "legal/LICENSE",
      notice: "legal/NOTICE",
      thirdPartyNotices: "legal/THIRD_PARTY_NOTICES.txt",
      sbom: "legal/SBOM.spdx.json",
    },
    signing: {
      artifactBinarySignature: "adhoc-linker",
      releaseBinarySignature: "developer-id-application",
      releaseManifestStage: "after-nested-signing-before-outer-app-seal",
    },
    binaries: [
      await binaryMetadata("app/bin/wavesrv.arm64"),
      await binaryMetadata(`app/bin/wsh-${WAVE_VERSION}-darwin.arm64`),
    ],
    files,
    fileMetadata,
  }
  await writeFile(resolve(ARTIFACT_ROOT, "manifest.json"), stableJson(manifest))
  return manifest
}

export async function buildBroadArtifact() {
  process.chdir(PROJECT_ROOT)
  const toolchains = await readJson(
    resolve(PROJECT_ROOT, "hyprlane/toolchains.json")
  )
  const actualToolchains = assertToolchains(toolchains)
  const buildEnv = scrubbedBuildEnv()
  const sourceSnapshot = await snapshotWorkspaceSources()
  await rm(ARTIFACT_ROOT, { recursive: true, force: true })
  await mkdir(ARTIFACT_ROOT, { recursive: true, mode: 0o755 })

  const vite = resolve(PROJECT_ROOT, "node_modules/.bin/vite")
  for (const config of ["host", "preload", "renderer"]) {
    run(vite, ["build", "--config", `hyprlane/build/${config}.config.ts`], {
      env: buildEnv,
    })
  }
  await buildBinaries(buildEnv)

  for (const schemaName of REQUIRED_SCHEMA) {
    await copyChecked(
      `schema/${schemaName}`,
      resolve(ARTIFACT_ROOT, "app/schema", schemaName),
      0o644
    )
  }
  await copyChecked(
    "hyprlane/capabilities.json",
    resolve(ARTIFACT_ROOT, "capabilities.json"),
    0o644
  )
  await writeLegalPayload()

  const [goClosure, typescriptClosure] = await Promise.all([
    createGoClosure(buildEnv),
    createTypescriptClosure(),
  ])
  await mkdir(resolve(ARTIFACT_ROOT, "closure"), { recursive: true })
  await writeFile(
    resolve(ARTIFACT_ROOT, "closure/go.json"),
    stableJson(goClosure)
  )
  await writeFile(
    resolve(ARTIFACT_ROOT, "closure/typescript.json"),
    stableJson(typescriptClosure)
  )

  const sourceTree = sourceTreeHash(goClosure, typescriptClosure)
  const { forkCommit, provenance } = await createProvenance(
    sourceTree.files,
    sourceTree.sha256
  )
  const sbom = await createSbom(goClosure, sourceTree.sha256)
  await writeFile(
    resolve(ARTIFACT_ROOT, "legal/SBOM.spdx.json"),
    stableJson(sbom)
  )
  const manifest = await createManifest({
    buildEnv,
    forkCommit,
    provenance,
    toolchains: actualToolchains,
  })
  try {
    await assertWorkspaceStayedQuiet(sourceSnapshot)
  } catch (error) {
    await rm(resolve(ARTIFACT_ROOT, "manifest.json"), { force: true })
    throw error
  }
  return {
    artifactRoot: ARTIFACT_ROOT,
    fileCount: Object.keys(manifest.files).length,
    manifestSha256: sha256(
      await readFile(resolve(ARTIFACT_ROOT, "manifest.json"))
    ),
    totalBytes: Object.values(manifest.fileMetadata).reduce(
      (total, file) => total + file.size,
      0
    ),
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await buildBroadArtifact()
  console.info(stableJson(result).trim())
}
