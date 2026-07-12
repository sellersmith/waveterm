// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest"
import { SURFACE_ACTIVITY_CHANNEL } from "../shared/ipc"
import { createSurfaceActivityBridge } from "./activity"

describe("hosted surface activity preload bridge", () => {
  it("starts fail-closed, publishes trusted booleans, and unsubscribes", () => {
    const fixture: { receive?: (value: unknown) => void } = {}
    const bridge = createSurfaceActivityBridge((channel, listener) => {
      expect(channel).toBe(SURFACE_ACTIVITY_CHANNEL)
      fixture.receive = listener
    })
    const listener = vi.fn()
    const unsubscribe = bridge.onSurfaceActivityChange(listener)

    expect(Object.isFrozen(bridge)).toBe(true)
    expect(bridge.isSurfaceActive()).toBe(false)
    fixture.receive?.(true)
    expect(bridge.isSurfaceActive()).toBe(true)
    expect(listener).toHaveBeenLastCalledWith(true)

    fixture.receive?.("true")
    expect(bridge.isSurfaceActive()).toBe(false)
    expect(listener).toHaveBeenLastCalledWith(false)
    fixture.receive?.(false)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    unsubscribe()
    fixture.receive?.(true)
    expect(bridge.isSurfaceActive()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("rejects non-function renderer subscribers", () => {
    const bridge = createSurfaceActivityBridge(() => undefined)
    expect(() =>
      bridge.onSurfaceActivityChange(null as unknown as () => void)
    ).toThrow("listener must be a function")
  })
})
