// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import {
  ACTION_CHANNEL,
  CONTEXT_MENU_CLICK_CHANNEL,
  CONTEXT_MENU_SHOW_CHANNEL,
  NATIVE_PASTE_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  SAVE_TEXT_FILE_CHANNEL,
  STATUS_CHANNEL,
  WAVE_INIT_CHANNEL,
  WAVE_SERVER_WEB_ENDPOINT,
  WAVE_SERVER_WS_ENDPOINT,
  type HostedPreloadConfig,
} from "../shared/ipc"

export { WAVE_SERVER_WEB_ENDPOINT, WAVE_SERVER_WS_ENDPOINT }

export type PreloadIpc = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void
  ): unknown
  send(channel: string, ...args: unknown[]): void
}

function invokeClosed(
  ipc: PreloadIpc,
  action: string,
  args: unknown[] = []
): void {
  void ipc.invoke(ACTION_CHANNEL, action, args).catch(() => undefined)
}

export function createWaveApi(
  config: HostedPreloadConfig,
  ipc: PreloadIpc
): Readonly<Record<string, unknown>> {
  const api = {
    getIsDev: () => false,
    getPlatform: () => config.platform,
    getCursorPoint: () => ({ x: 0, y: 0 }),
    getUserName: () => config.homeDir.split("/").filter(Boolean).at(-1) ?? "",
    getHostName: () => "localhost",
    getDataDir: () => config.dataDir,
    getConfigDir: () => config.configDir,
    getHomeDir: () => config.homeDir,
    getAboutModalDetails: () => ({ version: "0.14.5", buildTime: 0 }),
    getWebviewPreload: () => "",
    getZoomFactor: () => 1,
    getEnv: (name: string) => {
      if (name === WAVE_SERVER_WEB_ENDPOINT) return config.webEndpoint
      if (name === WAVE_SERVER_WS_ENDPOINT) return config.wsEndpoint
      return ""
    },
    onFullScreenChange: () => undefined,
    onZoomFactorChange: () => undefined,
    onUpdaterStatusChange: () => undefined,
    getUpdaterStatus: () => "up-to-date",
    getUpdaterChannel: () => "",
    installAppUpdate: () => undefined,
    onMenuItemAbout: () => undefined,
    updateWindowControlsOverlay: () => undefined,
    onReinjectKey: () => undefined,
    setWebviewFocus: () => undefined,
    registerGlobalWebviewKeys: () => undefined,
    onControlShiftStateUpdate: () => undefined,
    showWorkspaceAppMenu: () => undefined,
    showBuilderAppMenu: () => undefined,
    showContextMenu: (_workspaceId: string, menu: unknown) => {
      ipc.send(CONTEXT_MENU_SHOW_CHANNEL, menu)
    },
    onContextMenuClick: (callback: (id: string | null) => void) => {
      if (typeof callback !== "function") return
      ipc.on(CONTEXT_MENU_CLICK_CHANNEL, (_event, id: unknown) => {
        callback(typeof id === "string" ? id : null)
      })
    },
    downloadFile: () => undefined,
    openExternal: (url: string) => ipc.send(OPEN_EXTERNAL_CHANNEL, url),
    createWorkspace: () => invokeClosed(ipc, "create-workspace"),
    switchWorkspace: (workspaceId: string) =>
      invokeClosed(ipc, "switch-workspace", [workspaceId]),
    deleteWorkspace: (workspaceId: string) =>
      invokeClosed(ipc, "delete-workspace", [workspaceId]),
    setActiveTab: (tabId: string) =>
      invokeClosed(ipc, "set-active-tab", [tabId]),
    createTab: () => invokeClosed(ipc, "create-tab"),
    closeTab: async (
      workspaceId: string,
      tabId: string,
      confirmClose: boolean
    ) => {
      try {
        return (
          (await ipc.invoke(ACTION_CHANNEL, "close-tab", [
            workspaceId,
            tabId,
            confirmClose,
          ])) === true
        )
      } catch {
        return false
      }
    },
    setWindowInitStatus: (status: "ready" | "wave-ready") => {
      if (status === "ready" || status === "wave-ready") {
        ipc.send(STATUS_CHANNEL, status)
      }
    },
    onWaveInit: (callback: (init: unknown) => void) => {
      if (typeof callback !== "function") return
      ipc.on(WAVE_INIT_CHANNEL, (_event, init) => callback(init))
    },
    onBuilderInit: () => undefined,
    sendLog: () => undefined,
    onQuicklook: () => undefined,
    openNativePath: () => undefined,
    captureScreenshot: async () => "",
    setKeyboardChordMode: () => undefined,
    clearWebviewStorage: async () => undefined,
    setWaveAIOpen: () => undefined,
    closeBuilderWindow: () => undefined,
    incrementTermCommands: () => undefined,
    nativePaste: () => ipc.send(NATIVE_PASTE_CHANNEL),
    openBuilder: () => undefined,
    setBuilderWindowAppId: () => undefined,
    doRefresh: () => undefined,
    getPathForFile: () => "",
    saveTextFile: async (fileName: string, content: string) => {
      try {
        return (
          (await ipc.invoke(SAVE_TEXT_FILE_CHANNEL, fileName, content)) === true
        )
      } catch {
        return false
      }
    },
    setIsActive: async () => undefined,
  }
  return Object.freeze(api)
}
