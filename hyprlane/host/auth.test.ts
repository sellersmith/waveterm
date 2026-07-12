// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest"
import { installAuthKeyInjection } from "./auth"
import { normalizeWaveBackend } from "./backend"

describe("Wave session authentication", () => {
  it("injects the startup key only for the two exact backend origins", () => {
    type Listener = (
      details: { url: string; requestHeaders: Record<string, string> },
      callback: (response: { requestHeaders: Record<string, string> }) => void
    ) => void
    const registration: { listener: Listener | null } = { listener: null }
    const onBeforeSendHeaders = vi.fn((_filter, nextListener) => {
      registration.listener = nextListener
    })
    const cleanup = installAuthKeyInjection(
      { webRequest: { onBeforeSendHeaders } } as never,
      normalizeWaveBackend({
        webUrl: "http://127.0.0.1:4123",
        wsUrl: "ws://127.0.0.1:4567",
        authKey: "k".repeat(64),
      })
    )

    const exact = vi.fn()
    registration.listener?.(
      {
        url: "http://127.0.0.1:4123/wave/service",
        requestHeaders: {},
      },
      exact
    )
    expect(exact).toHaveBeenCalledWith({
      requestHeaders: { "X-AuthKey": "k".repeat(64) },
    })

    const attacker = vi.fn()
    registration.listener?.(
      {
        url: "http://127.0.0.1:41230/wave/service",
        requestHeaders: {},
      },
      attacker
    )
    expect(attacker).toHaveBeenCalledWith({ requestHeaders: {} })

    cleanup()
    expect(onBeforeSendHeaders).toHaveBeenLastCalledWith(null)
  })
})
