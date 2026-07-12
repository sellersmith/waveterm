// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { relative, sep } from "node:path"
import type { Plugin } from "vite"

function normalizeModuleId(id: string): string {
  const cleanId = id.split("?", 1)[0] ?? id
  if (cleanId.startsWith("\0")) {
    return `virtual:${cleanId.slice(1)}`
  }
  const projectPath = relative(process.cwd(), cleanId)
  return projectPath.split(sep).join("/")
}

export function moduleGraphPlugin(role: string): Plugin {
  return {
    name: `hyprlane-${role}-module-graph`,
    generateBundle() {
      const modules = [
        ...new Set([...this.getModuleIds()].map(normalizeModuleId)),
      ].sort()
      this.emitFile({
        type: "asset",
        fileName: "module-graph.json",
        source: `${JSON.stringify({ schemaVersion: 1, role, modules }, null, 2)}\n`,
      })
    },
  }
}
