// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import {
  createWaveFeatureResolver,
  serializeFeatureResolutionAudit,
} from "./feature-resolver"

const projectRoot = "/workspace/waveterm"

test("substitutes only the six reviewed Wave feature modules", () => {
  const resolver = createWaveFeatureResolver({ projectRoot })
  const cases = [
    {
      source: "./blockregistry",
      importer: "frontend/app/block/block.tsx",
      replacement: "hyprlane/entry/terminal-blockregistry.ts",
    },
    {
      source: "./modalregistry",
      importer: "frontend/app/modals/modalsrenderer.tsx",
      replacement: "hyprlane/entry/terminal-modalregistry.tsx",
    },
    {
      source: "@/app/modals/modalsrenderer",
      importer: "frontend/app/workspace/workspace.tsx",
      replacement: "hyprlane/entry/terminal-modalsrenderer.tsx",
    },
    {
      source: "@/app/aipanel/aipanel",
      importer: "frontend/app/workspace/workspace.tsx",
      replacement: "hyprlane/entry/disabled-aipanel.tsx",
    },
    {
      source: "@/app/workspace/widgets",
      importer: "frontend/app/workspace/workspace.tsx",
      replacement: "hyprlane/entry/disabled-widgets.tsx",
    },
    {
      source: "@/util/endpoints",
      importer: "frontend/app/store/wos.ts",
      replacement: "hyprlane/entry/endpoints.ts",
    },
  ]

  for (const entry of cases) {
    const result = resolver.resolveFeatureId(
      entry.source,
      `${projectRoot}/${entry.importer}?direct`
    )
    assert.equal(result, `${projectRoot}/${entry.replacement}`)
  }

  assert.deepEqual(
    resolver
      .getResolutionAudit()
      .contract.map((entry) => entry.target)
      .sort(),
    [
      "frontend/app/aipanel/aipanel.tsx",
      "frontend/app/block/blockregistry.ts",
      "frontend/app/modals/modalregistry.tsx",
      "frontend/app/modals/modalsrenderer.tsx",
      "frontend/app/workspace/widgets.tsx",
      "frontend/util/endpoints.ts",
    ]
  )
})

test("allows the relative blockregistry import only from block.tsx", () => {
  const resolver = createWaveFeatureResolver({ projectRoot })

  assert.equal(
    resolver.resolveFeatureId(
      "./blockregistry",
      `${projectRoot}/frontend/app/block/block.tsx`
    ),
    `${projectRoot}/hyprlane/entry/terminal-blockregistry.ts`
  )
  assert.throws(
    () =>
      resolver.resolveFeatureId(
        "./blockregistry",
        `${projectRoot}/frontend/app/block/blockframe.tsx`
      ),
    /unexpected Wave feature import.*blockregistry.*blockframe/is
  )
  assert.throws(
    () =>
      resolver.resolveFeatureId(
        "@\/app\/block\/blockregistry",
        `${projectRoot}/frontend/app/block/block.tsx`
      ),
    /unreviewed source spelling/i
  )
})

test("fails closed when another Wave surface imports a substituted module", () => {
  const resolver = createWaveFeatureResolver({ projectRoot })

  assert.throws(
    () =>
      resolver.resolveFeatureId(
        "@/app/aipanel/aipanel",
        `${projectRoot}/frontend/builder/builder-workspace.tsx`
      ),
    /unexpected Wave feature import/i
  )
  assert.throws(
    () =>
      resolver.resolveFeatureId(
        "@/app/workspace/widgets",
        `${projectRoot}/frontend/preview/previews/widgets.preview.tsx`
      ),
    /unexpected Wave feature import/i
  )
  assert.throws(
    () =>
      resolver.resolveFeatureId(
        "@/app/modals/modalsrenderer",
        `${projectRoot}/frontend/builder/builder-app.tsx`
      ),
    /unexpected Wave feature import/i
  )
})

test("canonicalizes alias traversal before applying the substitution contract", () => {
  const resolver = createWaveFeatureResolver({ projectRoot })

  assert.throws(
    () =>
      resolver.resolveFeatureId(
        "@/app/workspace/../aipanel/aipanel",
        `${projectRoot}/frontend/app/workspace/workspace.tsx`
      ),
    /unreviewed source spelling/i
  )
})

test("keeps the endpoint adapter importer allowlist exact", () => {
  const resolver = createWaveFeatureResolver({ projectRoot })
  const allowedImporters = [
    "frontend/app/element/markdown-util.ts",
    "frontend/app/store/global.ts",
    "frontend/app/store/wos.ts",
    "frontend/app/store/wshrpcutil-base.ts",
    "frontend/app/store/wshrpcutil.ts",
    "frontend/app/view/term/termsticker.tsx",
    "frontend/app/view/vdom/vdom-model.tsx",
    "frontend/util/waveutil.ts",
  ]

  for (const importer of allowedImporters) {
    assert.equal(
      resolver.resolveFeatureId(
        "@/util/endpoints",
        `${projectRoot}/${importer}`
      ),
      `${projectRoot}/hyprlane/entry/endpoints.ts`
    )
  }

  assert.throws(
    () =>
      resolver.resolveFeatureId(
        "@/util/endpoints",
        `${projectRoot}/frontend/app/aipanel/waveai-model.tsx`
      ),
    /unexpected Wave feature import/i
  )
  assert.throws(
    () =>
      resolver.resolveFeatureId(
        "@/util/endpoints",
        `${projectRoot}/frontend/app/view/preview/preview-streaming.tsx`
      ),
    /unexpected Wave feature import/i
  )
})

test("records rejected resolutions without making the audit order-dependent", () => {
  const first = createWaveFeatureResolver({ projectRoot })
  const second = createWaveFeatureResolver({ projectRoot })
  const resolutions = [
    [
      "@/app/aipanel/aipanel",
      `${projectRoot}/frontend/app/workspace/workspace.tsx`,
    ],
    [
      "@/app/aipanel/aipanel",
      `${projectRoot}/frontend/builder/builder-workspace.tsx`,
    ],
    [
      "./blockregistry",
      `${projectRoot}/frontend/app/block/block.tsx`,
    ],
  ] as const

  for (const [source, importer] of resolutions) {
    try {
      first.resolveFeatureId(source, importer)
    } catch {
      // Rejections remain present in the audit before the build fails.
    }
  }
  for (const [source, importer] of [...resolutions].reverse()) {
    try {
      second.resolveFeatureId(source, importer)
    } catch {
      // Rejections remain present in the audit before the build fails.
    }
  }

  assert.equal(
    serializeFeatureResolutionAudit(first.getResolutionAudit()),
    serializeFeatureResolutionAudit(second.getResolutionAudit())
  )
  assert.deepEqual(
    first
      .getResolutionAudit()
      .resolutions.map((entry) => entry.outcome)
      .sort(),
    ["rejected", "substituted", "substituted"]
  )
})

test("emits the deterministic resolution audit as a build artifact", () => {
  const resolver = createWaveFeatureResolver({ projectRoot })
  resolver.resolveFeatureId(
    "./blockregistry",
    `${projectRoot}/frontend/app/block/block.tsx`
  )
  const emitted: unknown[] = []

  assert.equal(typeof resolver.generateBundle, "function")
  if (typeof resolver.generateBundle !== "function") {
    return
  }
  resolver.generateBundle.call(
    {
      emitFile(file: unknown) {
        emitted.push(file)
        return "audit"
      },
    } as never,
    {} as never,
    {} as never,
    false
  )

  assert.deepEqual(emitted, [
    {
      type: "asset",
      fileName: "feature-resolution-audit.json",
      source: serializeFeatureResolutionAudit(resolver.getResolutionAudit()),
    },
  ])
})

test("ignores unrelated imports and does not add them to the audit", () => {
  const resolver = createWaveFeatureResolver({ projectRoot })

  assert.equal(
    resolver.resolveFeatureId(
      "react",
      `${projectRoot}/frontend/app/workspace/workspace.tsx`
    ),
    null
  )
  assert.deepEqual(resolver.getResolutionAudit().resolutions, [])
})
