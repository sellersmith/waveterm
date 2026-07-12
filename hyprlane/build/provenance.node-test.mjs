// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { verifyBuildProvenance } from "./provenance.mjs"

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

async function createRepository() {
  const cwd = await mkdtemp(join(tmpdir(), "wave-provenance-"))
  git(cwd, ["init", "--initial-branch=main"])
  git(cwd, ["config", "user.name", "Hyprlane Test"])
  git(cwd, ["config", "user.email", "test@hyprlane.local"])
  git(cwd, [
    "remote",
    "add",
    "origin",
    "git@github.com:sellersmith/waveterm.git",
  ])
  await mkdir(join(cwd, "hyprlane/host"), { recursive: true })
  const files = {
    "PATCHES.md": "patch stack\n",
    "UPSTREAM.lock": "upstream\n",
    "go.mod": "module example.com/wave\n",
    "go.sum": "",
    "hyprlane/host/index.ts": "export const host = true\n",
    "package-lock.json": "{}\n",
  }
  for (const [path, value] of Object.entries(files)) {
    await writeFile(join(cwd, path), value)
  }
  git(cwd, ["add", "-A"])
  git(cwd, ["commit", "-m", "fixture"])
  const commit = git(cwd, ["rev-parse", "HEAD"])
  git(cwd, ["update-ref", "refs/remotes/origin/main", commit])
  return { cwd, commit }
}

test("verifies a reachable fork commit and exact build source tree", async () => {
  const repository = await createRepository()
  const result = await verifyBuildProvenance({
    cwd: repository.cwd,
    forkCommit: repository.commit,
    upstreamCommit: repository.commit,
    allowLocalSynthetic: false,
    readCanonicalRefs: () =>
      `${repository.commit}\trefs/heads/hyprlane/v0.14.5`,
  })
  assert.equal(result.mode, "committed")
  assert.match(result.sourceTreeSha256, /^[a-f0-9]{64}$/)
})

test("does not trust a forgeable local origin-tracking ref", async () => {
  const repository = await createRepository()
  await assert.rejects(
    verifyBuildProvenance({
      cwd: repository.cwd,
      forkCommit: repository.commit,
      upstreamCommit: repository.commit,
      allowLocalSynthetic: false,
      readCanonicalRefs: () => "",
    }),
    /not advertised by the canonical remote/
  )
})

test("rejects a worktree that differs from the declared commit", async () => {
  const repository = await createRepository()
  await writeFile(
    join(repository.cwd, "hyprlane/host/index.ts"),
    "export const host = false\n"
  )
  await assert.rejects(
    verifyBuildProvenance({
      cwd: repository.cwd,
      forkCommit: repository.commit,
      upstreamCommit: repository.commit,
      allowLocalSynthetic: false,
    }),
    /source tree does not match fork commit/
  )
})

test("requires an explicit local flag for an unreachable synthetic commit", async () => {
  const repository = await createRepository()
  const tree = git(repository.cwd, ["rev-parse", "HEAD^{tree}"])
  const synthetic = git(repository.cwd, [
    "commit-tree",
    tree,
    "-p",
    repository.commit,
    "-m",
    "synthetic",
  ])
  await assert.rejects(
    verifyBuildProvenance({
      cwd: repository.cwd,
      forkCommit: synthetic,
      upstreamCommit: repository.commit,
      allowLocalSynthetic: false,
      readCanonicalRefs: () =>
        `${repository.commit}\trefs/heads/hyprlane/v0.14.5`,
    }),
    /not advertised/
  )
  const result = await verifyBuildProvenance({
    cwd: repository.cwd,
    forkCommit: synthetic,
    upstreamCommit: repository.commit,
    allowLocalSynthetic: true,
    readCanonicalRefs: () =>
      `${repository.commit}\trefs/heads/hyprlane/v0.14.5`,
  })
  assert.equal(result.mode, "local-synthetic")
})

test("rejects a value that is not a real commit object", async () => {
  const repository = await createRepository()
  await assert.rejects(
    verifyBuildProvenance({
      cwd: repository.cwd,
      forkCommit: "0".repeat(40),
      upstreamCommit: repository.commit,
      allowLocalSynthetic: true,
    }),
    /not a commit object/
  )
})

test("supports an exact compiled-source closure instead of a broad directory", async () => {
  const repository = await createRepository()
  await writeFile(join(repository.cwd, "PATCHES.md"), "unrelated dirty file\n")
  const result = await verifyBuildProvenance({
    cwd: repository.cwd,
    forkCommit: repository.commit,
    upstreamCommit: repository.commit,
    allowLocalSynthetic: false,
    sourcePaths: ["go.mod", "hyprlane/host/index.ts"],
    readCanonicalRefs: () =>
      `${repository.commit}\trefs/heads/hyprlane/v0.14.5`,
  })
  assert.equal(result.mode, "committed")
  assert.match(result.sourceTreeSha256, /^[a-f0-9]{64}$/)
})

test("rejects source-closure paths that escape the repository", async () => {
  const repository = await createRepository()
  await assert.rejects(
    verifyBuildProvenance({
      cwd: repository.cwd,
      forkCommit: repository.commit,
      upstreamCommit: repository.commit,
      allowLocalSynthetic: true,
      sourcePaths: ["../outside"],
    }),
    /invalid Wave provenance source closure/
  )
})
