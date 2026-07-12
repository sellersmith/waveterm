// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import test from "node:test"

const projectRoot = resolve(import.meta.dirname, "../..")

async function readProjectFile(path: string): Promise<string> {
  return readFile(resolve(projectRoot, path), "utf8")
}

test("the Hyprlane entry loads the unmodified upstream Wave renderer", async () => {
  const [html, entry, iconStyles, tailwindCompatibilityStyles, tailwindSourceAdapter] =
    await Promise.all([
    readProjectFile("hyprlane/entry/wave.html"),
    readProjectFile("hyprlane/entry/wave.ts"),
    readProjectFile("hyprlane/assets/fa-compat.css"),
    readProjectFile("hyprlane/assets/tailwind-v3-compat.css"),
    readProjectFile("hyprlane/build/tailwind-source-adapter.ts"),
  ])

  assert.match(html, /<title>Hyprlane<\/title>/)
  assert.match(html, /src="\.\/wave\.ts"/)
  assert.doesNotMatch(html, /fontawesome|\/logos\/|Wave Terminal/i)
  assert.match(entry, /import\s+["']\.\.\/\.\.\/frontend\/wave["']/)
  assert.match(entry, /installFaCompatibility/)
  assert.match(entry, /fa-compat\.css/)
  assert.match(entry, /tailwind-v3-compat\.css/)
  assert.match(iconStyles, /@keyframes hyprlane-icon-spin/)
  assert.doesNotMatch(iconStyles, /font.?awesome|wave/i)
  assert.match(tailwindCompatibilityStyles, /\.flex-grow\s*\{/)
  assert.match(tailwindCompatibilityStyles, /\.flex-grow-\\\[2\\\]\s*\{/)
  assert.match(tailwindSourceAdapter, /frontend\/tailwindsetup\.css/)
  assert.match(tailwindSourceAdapter, /@source\s+["']\.["']/)
})

test("the embedded host does not swallow native Wave tab clicks", async () => {
  const app = await readProjectFile("frontend/app/app.tsx")
  assert.match(app, /hyprlaneWave != null/)
  assert.match(app, /PLATFORM !== "darwin"/)
})

test("the dedicated renderer build keeps upstream build compatibility without copying public", async () => {
  const [config, tsconfigSource] = await Promise.all([
    readProjectFile("hyprlane/build/renderer.config.ts"),
    readProjectFile("hyprlane/tsconfig.json"),
  ])
  const tsconfig = JSON.parse(tsconfigSource)

  assert.match(config, /publicDir:\s*false/)
  assert.match(config, /wave\.html/)
  assert.match(config, /@tailwindcss\/vite/)
  assert.match(config, /@vitejs\/plugin-react-swc/)
  assert.match(config, /vite-plugin-svgr/)
  assert.match(config, /vite-plugin-image-optimizer/)
  assert.match(config, /compatibilityAssetPlugin/)
  assert.match(config, /tailwindSourceAdapter/)
  assert.match(config, /moduleGraphPlugin\("renderer"\)/)
  assert.doesNotMatch(config, /"@":\s*resolve\(projectRoot,\s*"frontend"\)/)
  assert.ok(tsconfig.exclude.includes("entry/wave.ts"))
})

test("compatibility assets are pinned to permitted packages", async () => {
  const [manifestSource, packageSource, productMark] = await Promise.all([
    readProjectFile("hyprlane/assets/compatibility-assets.json"),
    readProjectFile("package.json"),
    readProjectFile("hyprlane/assets/product-mark.svg"),
  ])
  const manifest = JSON.parse(manifestSource)
  const packageJson = JSON.parse(packageSource)
  const expectedPackages = {
    "@fontsource-variable/inter": ["5.2.8", "OFL-1.1"],
    "@fontsource/jetbrains-mono": ["5.2.8", "OFL-1.1"],
    "@phosphor-icons/web": ["2.1.2", "MIT"],
  }

  assert.equal(manifest.schemaVersion, 1)
  for (const [name, [version, license]] of Object.entries(expectedPackages)) {
    assert.equal(packageJson.devDependencies[name], version)
    assert.deepEqual(
      manifest.packages.find((entry: { name: string }) => entry.name === name),
      { name, version, license }
    )
  }

  const expectedFontOutputs = [
    "fonts/hacknerdmono-bold.ttf",
    "fonts/hacknerdmono-bolditalic.ttf",
    "fonts/hacknerdmono-italic.ttf",
    "fonts/hacknerdmono-regular.ttf",
    "fonts/inter-variable.woff2",
    "fonts/jetbrains-mono-v13-latin-200.woff2",
    "fonts/jetbrains-mono-v13-latin-700.woff2",
    "fonts/jetbrains-mono-v13-latin-regular.woff2",
  ]
  assert.deepEqual(
    manifest.fonts.map((entry: { output: string }) => entry.output).sort(),
    expectedFontOutputs
  )
  assert.deepEqual(manifest.excludedSourceTrees.sort(), [
    "public/fontawesome/**",
    "public/logos/**",
  ])
  assert.deepEqual(manifest.productAssetAliases, [
    {
      request: "/logos/wave-logo.png",
      replacement: "hyprlane/assets/product-mark.svg",
    },
    {
      request: "@/app/asset/logo.svg",
      replacement: "hyprlane/assets/product-mark.svg",
    },
  ])
  assert.doesNotMatch(productMark, /wave|font.?awesome/i)
})

test("compatibility package roots resolve through restrictive exports", async () => {
  const { resolveAssetPackageRoot } = await import("./compatibility-assets")
  for (const packageName of [
    "@fontsource-variable/inter",
    "@fontsource/jetbrains-mono",
    "@phosphor-icons/web",
  ]) {
    const packageJson = JSON.parse(
      await readFile(
        resolve(resolveAssetPackageRoot(packageName), "package.json"),
        "utf8"
      )
    )
    assert.equal(packageJson.name, packageName)
  }
})

test("every static upstream fa icon resolves to a permitted Phosphor glyph", async () => {
  const { needsPhosphorClassRepair, resolvePhosphorClass } =
    await import("../assets/fa-compat")
  const phosphorCss = await readProjectFile(
    "node_modules/@phosphor-icons/web/src/regular/style.css"
  )
  const utilityClasses = new Set([
    "fa-brands",
    "fa-fw",
    "fa-kit",
    "fa-light",
    "fa-regular",
    "fa-sharp",
    "fa-solid",
    "fa-spin",
    "fa-stack",
    "fa-stack-1x",
  ])
  const scan = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true })
    const paths = await Promise.all(
      entries.map(async (entry) => {
        const path = resolve(directory, entry.name)
        if (entry.isDirectory()) return scan(path)
        return /\.(?:css|scss|ts|tsx)$/.test(entry.name) ? [path] : []
      })
    )
    return paths.flat()
  }
  const iconNames = new Set<string>()
  for (const path of await scan(resolve(projectRoot, "frontend"))) {
    const source = await readFile(path, "utf8")
    for (const match of source.matchAll(/\bfa-[a-z0-9-]+\b/g)) {
      if (!utilityClasses.has(match[0])) iconNames.add(match[0])
    }
  }

  assert.ok(iconNames.size > 75)
  for (const iconName of iconNames) {
    const phosphorClass = resolvePhosphorClass(iconName)
    assert.match(phosphorClass, /^ph ph-[a-z0-9-]+$/)
    const glyphName = phosphorClass.slice("ph ph-".length)
    assert.ok(
      phosphorCss.includes(`.ph.ph-${glyphName}:before`),
      `${iconName} mapped to missing Phosphor glyph ${glyphName}`
    )
  }

  for (const [iconName, expectedClass] of [
    ["fa-square-terminal", "ph ph-terminal"],
    ["fa-wave-logo-solid", "ph ph-squares-four"],
  ]) {
    const phosphorClass = resolvePhosphorClass(iconName)
    assert.equal(phosphorClass, expectedClass)
    const glyphName = phosphorClass.slice("ph ph-".length)
    assert.ok(
      phosphorCss.includes(`.ph.ph-${glyphName}:before`),
      `${iconName} mapped to missing Phosphor glyph ${glyphName}`
    )
  }

  assert.equal(
    needsPhosphorClassRepair(["fa-plus"], "ph-plus", "ph-plus"),
    true
  )
  assert.equal(
    needsPhosphorClassRepair(
      ["fa-plus", "ph", "ph-plus"],
      "ph-plus",
      "ph-plus"
    ),
    false
  )
  assert.equal(
    needsPhosphorClassRepair([], undefined, null),
    false,
    "a non-icon class mutation must not trigger a self-observed repair"
  )
})

test("a normal class mutation settles without self-observer churn", async () => {
  const { installFaCompatibility } = await import("../assets/fa-compat")
  const observer: {
    callback?: (records: Array<Record<string, unknown>>) => void
  } = {}
  const pendingRecords: Array<Record<string, unknown>> = []

  class FakeElement {
    readonly tokens = new Set<string>()
    readonly classList = {
      [Symbol.iterator]: () => this.tokens[Symbol.iterator](),
      add: (...tokens: string[]) => {
        for (const token of tokens) this.tokens.add(token)
        pendingRecords.push({
          type: "attributes",
          target: this,
          addedNodes: [],
        })
      },
      remove: (...tokens: string[]) => {
        for (const token of tokens) this.tokens.delete(token)
        // DOMTokenList.remove produces a class mutation even if the token was
        // absent, which is the real renderer loop this regression protects.
        pendingRecords.push({
          type: "attributes",
          target: this,
          addedNodes: [],
        })
      },
    }
    querySelectorAll(): FakeElement[] {
      return []
    }
  }

  class FakeMutationObserver {
    constructor(callback: (records: Array<Record<string, unknown>>) => void) {
      observer.callback = callback
    }
    observe(): void {}
    disconnect(): void {
      delete observer.callback
    }
  }

  const previousElement = globalThis.Element
  const previousMutationObserver = globalThis.MutationObserver
  Object.assign(globalThis, {
    Element: FakeElement,
    MutationObserver: FakeMutationObserver,
  })
  try {
    const documentElement = new FakeElement()
    const stop = installFaCompatibility({
      documentElement,
    } as unknown as Document)
    pendingRecords.length = 0

    const ordinaryElement = new FakeElement()
    ordinaryElement.classList.add("is-transparent")
    let observerTurns = 0
    while (pendingRecords.length > 0 && observerTurns < 5) {
      observerTurns += 1
      const records = pendingRecords.splice(0)
      observer.callback?.(records)
    }

    assert.equal(observerTurns, 1)
    assert.equal(
      pendingRecords.length,
      0,
      "observer repair must not emit another normal class mutation"
    )
    stop()
  } finally {
    Object.assign(globalThis, {
      Element: previousElement,
      MutationObserver: previousMutationObserver,
    })
  }
})
