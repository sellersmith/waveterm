// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

type ReviewedImport = Readonly<{
  importer: string
  source: string
}>

type FeatureSubstitution = Readonly<{
  allowedImports: readonly ReviewedImport[]
  replacement: string
  target: string
}>

export type FeatureResolutionAuditEntry = Readonly<{
  importer: string
  outcome: "rejected" | "substituted"
  reason?: "unexpected-importer" | "unreviewed-source"
  replacement: string
  source: string
  target: string
}>

export type FeatureResolutionAudit = Readonly<{
  contract: readonly FeatureSubstitution[]
  resolutions: readonly FeatureResolutionAuditEntry[]
  schemaVersion: 1
}>

export type WaveFeatureResolver = Plugin &
  Readonly<{
    getResolutionAudit(): FeatureResolutionAudit
    resolveFeatureId(source: string, importer?: string): string | null
  }>

const endpointImporters = [
  "frontend/app/element/markdown-util.ts",
  "frontend/app/store/global.ts",
  "frontend/app/store/wos.ts",
  "frontend/app/store/wshrpcutil-base.ts",
  "frontend/app/store/wshrpcutil.ts",
  "frontend/app/view/term/termsticker.tsx",
  "frontend/app/view/vdom/vdom-model.tsx",
  "frontend/util/waveutil.ts",
] as const

export const WAVE_FEATURE_SUBSTITUTIONS: readonly FeatureSubstitution[] = [
  {
    target: "frontend/app/block/blockregistry.ts",
    replacement: "hyprlane/entry/terminal-blockregistry.ts",
    allowedImports: [
      {
        source: "./blockregistry",
        importer: "frontend/app/block/block.tsx",
      },
    ],
  },
  {
    target: "frontend/app/modals/modalregistry.tsx",
    replacement: "hyprlane/entry/terminal-modalregistry.tsx",
    allowedImports: [
      {
        source: "./modalregistry",
        importer: "frontend/app/modals/modalsrenderer.tsx",
      },
    ],
  },
  {
    target: "frontend/app/modals/modalsrenderer.tsx",
    replacement: "hyprlane/entry/terminal-modalsrenderer.tsx",
    allowedImports: [
      {
        source: "@/app/modals/modalsrenderer",
        importer: "frontend/app/workspace/workspace.tsx",
      },
    ],
  },
  {
    target: "frontend/app/aipanel/aipanel.tsx",
    replacement: "hyprlane/entry/disabled-aipanel.tsx",
    allowedImports: [
      {
        source: "@/app/aipanel/aipanel",
        importer: "frontend/app/workspace/workspace.tsx",
      },
    ],
  },
  {
    target: "frontend/app/workspace/widgets.tsx",
    replacement: "hyprlane/entry/disabled-widgets.tsx",
    allowedImports: [
      {
        source: "@/app/workspace/widgets",
        importer: "frontend/app/workspace/workspace.tsx",
      },
    ],
  },
  {
    target: "frontend/util/endpoints.ts",
    replacement: "hyprlane/entry/endpoints.ts",
    allowedImports: endpointImporters.map((importer) => ({
      source: "@/util/endpoints",
      importer,
    })),
  },
]

const knownExtensions = [".tsx", ".ts", ".jsx", ".js"] as const

function stripQuery(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? value
}

function slash(value: string): string {
  return value.split(sep).join("/")
}

function withoutKnownExtension(value: string): string {
  for (const extension of knownExtensions) {
    if (value.endsWith(extension)) {
      return value.slice(0, -extension.length)
    }
  }
  return value
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function normalizeImporter(projectRoot: string, importer?: string): string {
  if (importer == null) {
    return "<entry>"
  }
  const cleanImporter = stripQuery(importer)
  const importerPath = cleanImporter.startsWith("file:")
    ? fileURLToPath(cleanImporter)
    : cleanImporter
  if (!isAbsolute(importerPath)) {
    return slash(importerPath)
  }
  return slash(relative(projectRoot, importerPath))
}

function canonicalTargetForImport(
  projectRoot: string,
  source: string,
  importer?: string
): string | null {
  const cleanSource = stripQuery(source)
  let sourcePath: string
  if (cleanSource.startsWith("@/")) {
    sourcePath = slash(
      relative(
        projectRoot,
        resolve(projectRoot, "frontend", cleanSource.slice(2))
      )
    )
  } else if (cleanSource.startsWith(".")) {
    if (importer == null) {
      return null
    }
    const normalizedImporter = normalizeImporter(projectRoot, importer)
    if (normalizedImporter === "<entry>") {
      return null
    }
    sourcePath = slash(
      relative(
        projectRoot,
        resolve(projectRoot, dirname(normalizedImporter), cleanSource)
      )
    )
  } else if (isAbsolute(cleanSource) || cleanSource.startsWith("file:")) {
    const absoluteSource = cleanSource.startsWith("file:")
      ? fileURLToPath(cleanSource)
      : cleanSource
    sourcePath = slash(relative(projectRoot, absoluteSource))
  } else {
    return null
  }

  const sourceBase = withoutKnownExtension(sourcePath)
  return (
    WAVE_FEATURE_SUBSTITUTIONS.find(
      (entry) => withoutKnownExtension(entry.target) === sourceBase
    )?.target ?? null
  )
}

function compareAuditEntries(
  left: FeatureResolutionAuditEntry,
  right: FeatureResolutionAuditEntry
): number {
  return compareStrings(JSON.stringify(left), JSON.stringify(right))
}

function sortedContract(): readonly FeatureSubstitution[] {
  return WAVE_FEATURE_SUBSTITUTIONS.map((entry) => ({
    ...entry,
    allowedImports: [...entry.allowedImports].sort((left, right) =>
      compareStrings(JSON.stringify(left), JSON.stringify(right))
    ),
  })).sort((left, right) => compareStrings(left.target, right.target))
}

export function serializeFeatureResolutionAudit(
  audit: FeatureResolutionAudit
): string {
  return `${JSON.stringify(audit, null, 2)}\n`
}

export function createWaveFeatureResolver(options: {
  projectRoot: string
}): WaveFeatureResolver {
  const projectRoot = resolve(options.projectRoot)
  const resolutionEntries = new Map<string, FeatureResolutionAuditEntry>()

  const getResolutionAudit = (): FeatureResolutionAudit => ({
    schemaVersion: 1,
    contract: sortedContract(),
    resolutions: [...resolutionEntries.values()].sort(compareAuditEntries),
  })

  const resolveFeatureId = (
    source: string,
    importer?: string
  ): string | null => {
    const target = canonicalTargetForImport(projectRoot, source, importer)
    if (target == null) {
      return null
    }
    const substitution = WAVE_FEATURE_SUBSTITUTIONS.find(
      (entry) => entry.target === target
    )
    if (substitution == null) {
      return null
    }

    const cleanSource = stripQuery(source)
    const normalizedImporter = normalizeImporter(projectRoot, importer)
    const allowedImport = substitution.allowedImports.find(
      (entry) => entry.importer === normalizedImporter
    )
    const replacement = resolve(projectRoot, substitution.replacement)

    if (allowedImport == null) {
      const auditEntry: FeatureResolutionAuditEntry = {
        source: cleanSource,
        importer: normalizedImporter,
        target,
        replacement: substitution.replacement,
        outcome: "rejected",
        reason: "unexpected-importer",
      }
      resolutionEntries.set(JSON.stringify(auditEntry), auditEntry)
      throw new Error(
        `Unexpected Wave feature import ${cleanSource} targeting ${target} from ${normalizedImporter}`
      )
    }
    if (allowedImport.source !== cleanSource) {
      const auditEntry: FeatureResolutionAuditEntry = {
        source: cleanSource,
        importer: normalizedImporter,
        target,
        replacement: substitution.replacement,
        outcome: "rejected",
        reason: "unreviewed-source",
      }
      resolutionEntries.set(JSON.stringify(auditEntry), auditEntry)
      throw new Error(
        `Unreviewed source spelling ${cleanSource} targeting ${target} from ${normalizedImporter}`
      )
    }

    const auditEntry: FeatureResolutionAuditEntry = {
      source: cleanSource,
      importer: normalizedImporter,
      target,
      replacement: substitution.replacement,
      outcome: "substituted",
    }
    resolutionEntries.set(JSON.stringify(auditEntry), auditEntry)
    return replacement
  }

  return {
    name: "hyprlane-wave-feature-resolver",
    enforce: "pre",
    resolveFeatureId,
    getResolutionAudit,
    resolveId(source, importer) {
      return resolveFeatureId(source, importer)
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "feature-resolution-audit.json",
        source: serializeFeatureResolutionAudit(getResolutionAudit()),
      })
    },
  }
}
