// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path"
import type { Plugin } from "vite"

const tailwindImport = '@import "tailwindcss";'
const upstreamTailwindSetup = resolve(
  import.meta.dirname,
  "../../frontend/tailwindsetup.css"
)

export function injectWaveFrontendTailwindSource(source: string): string {
  if (!source.includes(tailwindImport)) {
    throw new Error("Wave Tailwind entry no longer imports tailwindcss")
  }

  return source.replace(tailwindImport, `${tailwindImport}\n\n@source ".";`)
}

/**
 * Wave's renderer is hosted from hyprlane/entry, while its Tailwind classes
 * live under frontend/. Tailwind v4 otherwise scans only the host entry and
 * silently omits upstream utilities. Inject the scan directive at build time
 * so the pinned upstream source stays untouched.
 */
export function tailwindSourceAdapter(): Plugin {
  return {
    name: "hyprlane-wave-tailwind-source",
    enforce: "pre",
    transform(source, id) {
      if (id.split("?", 1)[0] !== upstreamTailwindSetup) return null
      return { code: injectWaveFrontendTailwindSource(source), map: null }
    },
  }
}
