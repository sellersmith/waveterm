// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { normalizeWaveBackend } from "./backend"
import { buildSurfaceCsp, installHostedProtocol, SURFACE_URL } from "./protocol"

describe("hosted Wave CSP", () => {
  it("loads the full renderer build entry", () => {
    expect(SURFACE_URL).toBe("app://bundle/wave-core/wave.html")
  })

  it("allows only the exact backend HTTP and WebSocket ports", () => {
    const csp = buildSurfaceCsp(
      normalizeWaveBackend({
        webUrl: "http://127.0.0.1:4123",
        wsUrl: "ws://127.0.0.1:4567",
        authKey: "a".repeat(64),
      })
    )

    expect(csp).toContain(
      "connect-src 'self' http://127.0.0.1:4123 ws://127.0.0.1:4567"
    )
    expect(csp).not.toContain("127.0.0.1:*")
    expect(csp).not.toContain("connect-src *")
  })

  it("serves a root-resolved Vite font only from the immutable assets folder", async () => {
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "hyprlane-wave-protocol-")
    )
    const fontName = "Phosphor-test.woff2"
    const fontBytes = new Uint8Array([1, 2, 3, 4])
    await mkdir(join(artifactRoot, "renderer", "assets"), {
      recursive: true,
    })
    await writeFile(
      join(artifactRoot, "renderer", "assets", fontName),
      fontBytes
    )

    let handler:
      | ((request: { method: string; url: string }) => Promise<Response>)
      | undefined
    const session = {
      protocol: {
        handle: (
          scheme: string,
          next: (request: { method: string; url: string }) => Promise<Response>
        ) => {
          expect(scheme).toBe("app")
          handler = next
        },
        unhandle: () => undefined,
      },
    }

    try {
      const cleanup = installHostedProtocol(session as never, artifactRoot)
      if (!handler) throw new Error("hosted app protocol handler was not set")
      const response = await handler({
        method: "GET",
        url: `app://bundle/wave-core/${fontName}`,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("font/woff2")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(fontBytes)
      cleanup()
    } finally {
      await rm(artifactRoot, { recursive: true, force: true })
    }
  })
})
