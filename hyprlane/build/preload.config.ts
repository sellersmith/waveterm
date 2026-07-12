// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path"
import { defineConfig } from "vite"
import { moduleGraphPlugin } from "./module-graph-plugin"

export default defineConfig({
  publicDir: false,
  plugins: [moduleGraphPlugin("preload")],
  build: {
    target: "node24",
    outDir: resolve(__dirname, "../../dist/hyprlane/preload"),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "../preload/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    rollupOptions: {
      external: ["electron"],
      output: { inlineDynamicImports: true },
    },
  },
})
