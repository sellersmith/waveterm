// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { SURFACE_ACTIVITY_CHANNEL } from "../shared/ipc"

export type SurfaceActivityBridge = Readonly<{
  isSurfaceActive(): boolean
  onSurfaceActivityChange(listener: (active: boolean) => void): () => void
}>

export function createSurfaceActivityBridge(
  register: (channel: string, listener: (value: unknown) => void) => void
): SurfaceActivityBridge {
  let active = false
  const listeners = new Set<(active: boolean) => void>()

  register(SURFACE_ACTIVITY_CHANNEL, (value) => {
    const nextActive = value === true
    if (nextActive === active) return
    active = nextActive
    for (const listener of [...listeners]) listener(active)
  })

  return Object.freeze({
    isSurfaceActive() {
      return active
    },
    onSurfaceActivityChange(listener: (active: boolean) => void) {
      if (typeof listener !== "function") {
        throw new TypeError("surface activity listener must be a function")
      }
      let subscribed = true
      listeners.add(listener)
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(listener)
      }
    },
  })
}
