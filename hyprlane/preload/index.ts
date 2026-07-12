// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { contextBridge, ipcRenderer } from "electron"
import {
  BOOTSTRAP_CHANNEL,
  CONFIG_CHANNEL,
  LEGACY_READY_CHANNEL,
  type HostedPreloadConfig,
} from "../shared/ipc"
import { createWaveApi } from "./api"
import { createSurfaceActivityBridge } from "./activity"

function readConfig(): HostedPreloadConfig {
  const value = ipcRenderer.sendSync(
    CONFIG_CHANNEL
  ) as Partial<HostedPreloadConfig>
  if (
    !value ||
    typeof value.platform !== "string" ||
    typeof value.webEndpoint !== "string" ||
    typeof value.wsEndpoint !== "string" ||
    typeof value.dataDir !== "string" ||
    typeof value.configDir !== "string" ||
    typeof value.homeDir !== "string"
  ) {
    throw new Error("invalid hosted Wave preload configuration")
  }
  return Object.freeze({
    platform: value.platform,
    webEndpoint: value.webEndpoint,
    wsEndpoint: value.wsEndpoint,
    dataDir: value.dataDir,
    configDir: value.configDir,
    homeDir: value.homeDir,
  })
}

const config = readConfig()
const api = createWaveApi(config, {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) =>
    ipcRenderer.on(channel, (event, ...args) => listener(event, ...args)),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
})
const surfaceActivity = createSurfaceActivityBridge((channel, listener) => {
  ipcRenderer.on(channel, (_event, value) => listener(value))
})

contextBridge.exposeInMainWorld("api", api)

contextBridge.exposeInMainWorld(
  "hyprlaneWave",
  Object.freeze({
    security: Object.freeze({
      contextIsolated: process.contextIsolated,
      sandboxed: process.sandboxed,
    }),
    async bootstrap() {
      const value = await ipcRenderer.invoke(BOOTSTRAP_CHANNEL)
      return JSON.stringify({
        workspaceId: String(value.workspaceId),
        surfaceId: Number(value.surfaceId),
      })
    },
    ready() {
      ipcRenderer.send(LEGACY_READY_CHANNEL)
    },
    isSurfaceActive: surfaceActivity.isSurfaceActive,
    onSurfaceActivityChange: surfaceActivity.onSurfaceActivityChange,
  })
)
