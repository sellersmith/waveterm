// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path"
import { defineConfig } from "vite"

export default defineConfig({
  // A host-only library must never inherit Wave's public assets (including
  // product branding and commercially licensed icon files).
  publicDir: false,
  build: {
    target: "node24",
    outDir: resolve(__dirname, "../../dist/hyprlane/host"),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "../host/probe.ts"),
      formats: ["es"],
      fileName: () => "index.mjs",
    },
    rollupOptions: {
      external: ["electron"],
    },
  },
})
