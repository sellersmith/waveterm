// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path"
import { defineConfig } from "vite"
import { moduleGraphPlugin } from "./module-graph-plugin"

export default defineConfig({
  publicDir: false,
  plugins: [moduleGraphPlugin("host")],
  build: {
    target: "node24",
    outDir: resolve(__dirname, "../../dist/hyprlane/host"),
    emptyOutDir: true,
    ssr: resolve(__dirname, "../host/index.ts"),
    rollupOptions: {
      external: ["electron"],
      output: { entryFileNames: "index.mjs", inlineDynamicImports: true },
    },
  },
})
