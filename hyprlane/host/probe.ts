// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0
//
// Phase 6A.0 probe only. This proves that a fork-local ESM host can share the
// embedding application's Electron instance. It deliberately does not create
// Wave surfaces or import Wave's process-global emain entry.

import { app, BaseWindow } from "electron"

type StartOptions = { parentWindowId: number }

export function createWaveCoreHost() {
  let started = false

  return {
    async start(options: StartOptions) {
      if (started) throw new Error("probe host already started")
      if (!app.isReady()) throw new Error("Electron app is not ready")
      if (!BaseWindow.fromId(options.parentWindowId)) {
        throw new Error("parent BaseWindow not found")
      }
      started = true
    },
    async createSurface(): Promise<number> {
      throw new Error("Phase 6A.0 probe has no Wave surface")
    },
    async setSurfaceState(): Promise<void> {
      throw new Error("Phase 6A.0 probe has no Wave surface")
    },
    async destroySurface(): Promise<void> {},
    async shutdown(): Promise<void> {
      started = false
    },
  }
}
