// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { readFile } from "node:fs/promises"
import type { Plugin } from "vite"

type AssetPackage = {
  name: string
  version: string
  license: string
}

type FontAsset = {
  output: string
  package: string
  source: string
}

type CompatibilityManifest = {
  schemaVersion: number
  packages: AssetPackage[]
  fonts: FontAsset[]
  excludedSourceTrees: string[]
  productAssetAliases: Array<{ request: string; replacement: string }>
}

const require = createRequire(import.meta.url)
const sourceManifestPath = resolve(
  import.meta.dirname,
  "../assets/compatibility-assets.json"
)

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function resolveAssetPackageRoot(name: string): string {
  let entryPath: string | null = null
  for (const request of [`${name}/package.json`, name, `${name}/regular`]) {
    try {
      entryPath = require.resolve(request)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        code !== "MODULE_NOT_FOUND" &&
        code !== "ERR_PACKAGE_PATH_NOT_EXPORTED"
      ) {
        throw error
      }
    }
  }
  if (!entryPath) throw new Error(`package entry not found: ${name}`)

  let directory = dirname(entryPath)
  while (true) {
    if (existsSync(resolve(directory, "package.json"))) return directory
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error(`package root not found: ${name}`)
    }
    directory = parent
  }
}

function safePackageName(name: string): string {
  return name.replace(/^@/, "").replaceAll("/", "-")
}

async function readSourceManifest(): Promise<CompatibilityManifest> {
  return JSON.parse(await readFile(sourceManifestPath, "utf8"))
}

export function compatibilityAssetPlugin(): Plugin {
  const phosphorStylePath = require.resolve("@phosphor-icons/web/regular")
  const productMarkPath = resolve(
    import.meta.dirname,
    "../assets/product-mark.svg"
  )

  return {
    name: "hyprlane-compatibility-assets",
    enforce: "pre",
    resolveId(source) {
      if (
        source === "/logos/wave-logo.png" ||
        source === "@/app/asset/logo.svg"
      ) {
        return productMarkPath
      }
      return null
    },
    transform(source, id) {
      if (id.split("?", 1)[0] !== phosphorStylePath) return null
      const woff2Only = source.replace(
        /src:\s*url\("\.\/Phosphor\.woff2"\)[\s\S]*?;/,
        'src: url("./Phosphor.woff2") format("woff2");'
      )
      if (
        woff2Only === source ||
        /Phosphor\.(?:svg|ttf|woff)["')]/.test(woff2Only)
      ) {
        throw new Error("failed to restrict Phosphor assets to WOFF2")
      }
      return { code: woff2Only, map: null }
    },
    async generateBundle() {
      const manifest = await readSourceManifest()
      if (manifest.schemaVersion !== 1) {
        throw new Error("unsupported compatibility asset manifest")
      }

      const files: Record<string, string> = {}
      for (const assetPackage of manifest.packages) {
        const root = resolveAssetPackageRoot(assetPackage.name)
        const installed = JSON.parse(
          await readFile(resolve(root, "package.json"), "utf8")
        )
        if (
          installed.version !== assetPackage.version ||
          installed.license !== assetPackage.license
        ) {
          throw new Error(
            `compatibility package drift: ${assetPackage.name}@${installed.version}`
          )
        }
        const license = await readFile(resolve(root, "LICENSE"))
        const licensePath = `licenses/${safePackageName(assetPackage.name)}-${assetPackage.version}.txt`
        files[licensePath] = sha256(license)
        this.emitFile({
          type: "asset",
          fileName: licensePath,
          source: license,
        })
      }

      for (const font of manifest.fonts) {
        const bytes = await readFile(
          resolve(resolveAssetPackageRoot(font.package), font.source)
        )
        files[font.output] = sha256(bytes)
        this.emitFile({ type: "asset", fileName: font.output, source: bytes })
      }

      const audit = {
        ...manifest,
        files: Object.fromEntries(
          Object.entries(files).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        ),
      }
      this.emitFile({
        type: "asset",
        fileName: "compatibility-assets.json",
        source: `${JSON.stringify(audit, null, 2)}\n`,
      })
    },
  }
}
