// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { lstat, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { relative, resolve, sep } from "node:path"

const SOURCE_PATHS = [
  "PATCHES.md",
  "UPSTREAM.lock",
  "go.mod",
  "go.sum",
  "hyprlane",
  "package-lock.json",
]
const CANONICAL_ORIGIN = "https://github.com/sellersmith/waveterm.git"

function git(cwd, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function gitSucceeds(cwd, args) {
  try {
    git(cwd, args)
    return true
  } catch {
    return false
  }
}

function readCanonicalRemoteRefs() {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  }
  for (const key of Object.keys(env)) {
    if (
      key === "GIT_DIR" ||
      key === "GIT_WORK_TREE" ||
      key === "GIT_CONFIG_COUNT" ||
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_")
    ) {
      delete env[key]
    }
  }
  return execFileSync("git", ["ls-remote", CANONICAL_ORIGIN], {
    cwd: tmpdir(),
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function refsAdvertiseCommit(refs, commit) {
  return refs
    .trim()
    .split("\n")
    .filter(Boolean)
    .some((line) => line.split(/\s+/, 1)[0] === commit)
}

async function listWorktreeSourceFiles(cwd, sourcePaths = SOURCE_PATHS) {
  const files = []
  const visit = async (path) => {
    const stat = await lstat(path)
    const sourcePath = relative(cwd, path).split(sep).join("/")
    if (stat.isSymbolicLink()) {
      throw new Error(`Wave build source contains symlink: ${sourcePath}`)
    }
    if (stat.isDirectory()) {
      const entries = await readdir(path)
      for (const entry of entries.sort()) {
        await visit(resolve(path, entry))
      }
      return
    }
    if (!stat.isFile()) {
      throw new Error(`Wave build source contains special file: ${sourcePath}`)
    }
    files.push(sourcePath)
  }
  for (const sourcePath of [...new Set(sourcePaths)].sort()) {
    await visit(resolve(cwd, sourcePath))
  }
  return [...new Set(files)].sort()
}

function listCommitSourceFiles(cwd, commit, sourcePaths = SOURCE_PATHS) {
  return git(cwd, [
    "ls-tree",
    "-r",
    "--name-only",
    commit,
    "--",
    ...[...new Set(sourcePaths)].sort(),
  ])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort()
}

export async function verifyBuildProvenance(options) {
  const cwd = resolve(options.cwd)
  const { forkCommit, upstreamCommit, allowLocalSynthetic } = options
  if (
    !/^[a-f0-9]{40}$/.test(forkCommit) ||
    !gitSucceeds(cwd, ["cat-file", "-e", `${forkCommit}^{commit}`])
  ) {
    throw new Error("Wave fork SHA is not a commit object")
  }
  if (
    !/^[a-f0-9]{40}$/.test(upstreamCommit) ||
    !gitSucceeds(cwd, [
      "merge-base",
      "--is-ancestor",
      upstreamCommit,
      forkCommit,
    ])
  ) {
    throw new Error(
      "Wave fork commit does not descend from the pinned upstream"
    )
  }

  const sourcePaths = options.sourcePaths ?? SOURCE_PATHS
  if (
    !Array.isArray(sourcePaths) ||
    sourcePaths.length === 0 ||
    sourcePaths.some(
      (path) =>
        typeof path !== "string" ||
        path.length === 0 ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((part) => part === "" || part === "..")
    )
  ) {
    throw new Error("invalid Wave provenance source closure")
  }
  const worktreeFiles = await listWorktreeSourceFiles(cwd, sourcePaths)
  const commitFiles = listCommitSourceFiles(cwd, forkCommit, sourcePaths)
  if (worktreeFiles.join("\n") !== commitFiles.join("\n")) {
    throw new Error("Wave build source tree does not match fork commit")
  }

  const sourceTreeHash = createHash("sha256")
  for (const path of worktreeFiles) {
    const worktreeBytes = await readFile(resolve(cwd, path))
    const commitBytes = git(cwd, ["show", `${forkCommit}:${path}`], null)
    if (!Buffer.isBuffer(commitBytes) || !worktreeBytes.equals(commitBytes)) {
      throw new Error("Wave build source tree does not match fork commit")
    }
    sourceTreeHash.update(path)
    sourceTreeHash.update("\0")
    sourceTreeHash.update(
      createHash("sha256").update(worktreeBytes).digest("hex")
    )
    sourceTreeHash.update("\n")
  }

  let originUrl = ""
  try {
    originUrl = git(cwd, ["remote", "get-url", "origin"]).trim()
  } catch {
    // Local probe commits intentionally have no canonical origin yet.
  }
  let committed = false
  if (originUrl === CANONICAL_ORIGIN) {
    try {
      const readRefs = options.readCanonicalRefs ?? readCanonicalRemoteRefs
      committed = refsAdvertiseCommit(readRefs(), forkCommit)
    } catch {
      // A build without a verifiable canonical remote is synthetic, even when
      // its local origin-tracking refs claim otherwise.
    }
  }
  if (!committed && !allowLocalSynthetic) {
    throw new Error(
      "Wave fork commit is not advertised by the canonical remote"
    )
  }

  return Object.freeze({
    mode: committed ? "committed" : "local-synthetic",
    sourceTreeSha256: sourceTreeHash.digest("hex"),
  })
}
