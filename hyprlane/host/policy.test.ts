// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import {
  HOSTED_WEBVIEW_PARTITION,
  hardenHostedSession,
  prepareHostedWebview,
} from "./policy"

describe("hosted Wave webview policy", () => {
  it("accepts an https page only with a locked-down guest configuration", () => {
    const preferences: Record<string, unknown> = {
      contextIsolation: false,
      nodeIntegration: true,
      preload: "/untrusted/preload.js",
      sandbox: false,
      webSecurity: false,
    }
    const params: Record<string, string> = {
      partition: "persist:user-supplied",
      preload: "/untrusted/preload.js",
      src: "https://github.com/wavetermdev/waveterm",
    }

    expect(prepareHostedWebview(preferences, params)).toBe(true)
    expect(preferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
    })
    expect(preferences).not.toHaveProperty("preload")
    expect(params).toMatchObject({ partition: HOSTED_WEBVIEW_PARTITION })
    expect(params).not.toHaveProperty("preload")
  })

  it.each([
    "app://bundle/wave-core/wave.html",
    "data:text/html,owned",
    "file:///Users/tester/.ssh/config",
    "javascript:alert(1)",
  ])("rejects a privileged or executable webview URL: %s", (src) => {
    expect(prepareHostedWebview({}, { src })).toBe(false)
  })
})

describe("hosted Wave session policy", () => {
  it("allows clipboard writes only from the trusted Wave surface", () => {
    type PermissionCheck = (
      contents: unknown,
      permission: string,
      requestingOrigin: string
    ) => boolean
    type PermissionRequest = (
      contents: { getURL(): string },
      permission: string,
      callback: (granted: boolean) => void
    ) => void
    const handlers: {
      check: PermissionCheck | null
      request: PermissionRequest | null
    } = { check: null, request: null }
    const session = {
      setPermissionCheckHandler(handler: PermissionCheck | null) {
        handlers.check = handler
      },
      setPermissionRequestHandler(handler: PermissionRequest | null) {
        handlers.request = handler
      },
      on: () => undefined,
      removeListener: () => undefined,
    }

    const cleanup = hardenHostedSession(session as never)
    expect(
      handlers.check?.(null, "clipboard-sanitized-write", "app://bundle")
    ).toBe(true)
    expect(
      handlers.check?.(
        null,
        "clipboard-sanitized-write",
        "https://example.com"
      )
    ).toBe(false)
    expect(handlers.check?.(null, "clipboard-read", "app://bundle")).toBe(
      false
    )

    const grants: boolean[] = []
    handlers.request?.(
      { getURL: () => "app://bundle/wave-core/wave.html" },
      "clipboard-sanitized-write",
      (granted: boolean) => grants.push(granted)
    )
    handlers.request?.(
      { getURL: () => "https://example.com" },
      "clipboard-sanitized-write",
      (granted: boolean) => grants.push(granted)
    )
    expect(grants).toEqual([true, false])
    cleanup()
  })
})
