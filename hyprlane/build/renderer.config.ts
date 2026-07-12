// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react-swc"
import { resolve } from "node:path"
import { defineConfig } from "vite"
import { ViteImageOptimizer } from "vite-plugin-image-optimizer"
import svgr from "vite-plugin-svgr"
import tsconfigPaths from "vite-tsconfig-paths"
import { compatibilityAssetPlugin } from "./compatibility-assets"
import { moduleGraphPlugin } from "./module-graph-plugin"
import { tailwindSourceAdapter } from "./tailwind-source-adapter"

const projectRoot = resolve(__dirname, "../..")

export default defineConfig({
  base: "./",
  publicDir: false,
  plugins: [
    compatibilityAssetPlugin(),
    tsconfigPaths({ root: projectRoot }),
    { ...ViteImageOptimizer(), apply: "build" },
    svgr({
      svgrOptions: {
        exportType: "default",
        ref: true,
        svgo: false,
        titleProp: true,
      },
      include: "**/*.svg",
    }),
    react({}),
    tailwindSourceAdapter(),
    tailwindcss(),
    moduleGraphPlugin("renderer"),
  ],
  root: resolve(__dirname, "../entry"),
  build: {
    target: "chrome148",
    outDir: resolve(__dirname, "../../dist/hyprlane/renderer"),
    emptyOutDir: true,
    sourcemap: false,
    manifest: "vite-manifest.json",
    rollupOptions: {
      input: resolve(__dirname, "../entry/wave.html"),
      output: {
        manualChunks(id) {
          const path = id.replaceAll("\\", "/")
          if (
            path.includes("node_modules/monaco") ||
            path.includes("node_modules/@monaco")
          ) {
            return "monaco"
          }
          if (
            path.includes("node_modules/mermaid") ||
            path.includes("node_modules/@mermaid")
          ) {
            return "mermaid"
          }
          if (
            path.includes("node_modules/katex") ||
            path.includes("node_modules/@katex")
          ) {
            return "katex"
          }
          if (
            path.includes("node_modules/shiki") ||
            path.includes("node_modules/@shiki")
          ) {
            return "shiki"
          }
          if (
            path.includes("node_modules/cytoscape") ||
            path.includes("node_modules/@cytoscape")
          ) {
            return "cytoscape"
          }
          return undefined
        },
      },
    },
  },
  optimizeDeps: {
    include: ["monaco-yaml/yaml.worker.js"],
  },
  css: {
    preprocessorOptions: {
      scss: {
        silenceDeprecations: ["mixed-decls"],
      },
    },
  },
})
