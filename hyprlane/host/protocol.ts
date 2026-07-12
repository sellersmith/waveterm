// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises"
import { extname, relative, resolve } from "node:path"
import type { Session } from "electron"
import type { NormalizedWaveBackend } from "./backend"

export const SURFACE_URL = "app://bundle/wave-core/wave.html"

export function buildSurfaceCsp(backend?: NormalizedWaveBackend): string {
  const connectSource = backend
    ? `'self' ${backend.webOrigin} ${backend.wsOrigin}`
    : "'none'"
  const imageSource = backend ? ` ${backend.webOrigin}` : ""
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${imageSource}`,
    "font-src 'self' data:",
    `connect-src ${connectSource}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ")
}

export const SURFACE_CSP = buildSurfaceCsp()

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
}

function isRootStaticAssetRequest(requestedPath: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requestedPath) &&
    !requestedPath.includes("/")
  )
}

function candidateRendererFiles(
  rendererRoot: string,
  requestedPath: string
): string[] {
  const direct = resolve(rendererRoot, requestedPath)
  if (!isRootStaticAssetRequest(requestedPath)) return [direct]

  // Vite emits immutable font files under `assets/`, but an upstream runtime
  // stylesheet can resolve its relative font URL against the document root.
  // Serve only a single safe basename from that immutable directory; never
  // turn this into a second path-resolution surface.
  return [direct, resolve(rendererRoot, "assets", requestedPath)]
}

export function installHostedProtocol(
  partitionSession: Session,
  artifactRoot: string,
  backend?: NormalizedWaveBackend
): () => void {
  const rendererRoot = resolve(artifactRoot, "renderer")
  partitionSession.protocol.handle("app", async (request) => {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 })
    }

    const url = new URL(request.url)
    if (url.host !== "bundle" || !url.pathname.startsWith("/wave-core/")) {
      return new Response("not found", { status: 404 })
    }

    let requestedPath: string
    try {
      requestedPath = decodeURIComponent(
        url.pathname.slice("/wave-core/".length) || "wave.html"
      )
    } catch {
      return new Response("bad request", { status: 400 })
    }
    const candidates = candidateRendererFiles(rendererRoot, requestedPath)
    for (const filePath of candidates) {
      const relativePath = relative(rendererRoot, filePath)
      if (
        relativePath === ".." ||
        relativePath.startsWith(
          `..${process.platform === "win32" ? "\\" : "/"}`
        )
      ) {
        return new Response("bad request", { status: 400 })
      }

      try {
        const bytes = await readFile(filePath)
        const headers: Record<string, string> = {
          "cache-control": "no-store",
          "content-type":
            CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
        }
        if (extname(filePath) === ".html") {
          headers["content-security-policy"] = buildSurfaceCsp(backend)
        }
        return new Response(new Uint8Array(bytes), { headers })
      } catch {
        // Try the constrained `assets/` fallback for a root static request.
      }
    }
    return new Response("not found", { status: 404 })
  })

  return () => partitionSession.protocol.unhandle("app")
}
