// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

export const ACTION_CHANNEL = "hyprlane-wave:action"
export const BOOTSTRAP_CHANNEL = "hyprlane-wave:bootstrap"
export const CONFIG_CHANNEL = "hyprlane-wave:config"
export const CONTEXT_MENU_CLICK_CHANNEL = "hyprlane-wave:context-menu-click"
export const CONTEXT_MENU_SHOW_CHANNEL = "hyprlane-wave:context-menu-show"
export const LEGACY_READY_CHANNEL = "hyprlane-wave:ready"
export const NATIVE_PASTE_CHANNEL = "hyprlane-wave:native-paste"
export const OPEN_EXTERNAL_CHANNEL = "hyprlane-wave:open-external"
export const SAVE_TEXT_FILE_CHANNEL = "hyprlane-wave:save-text-file"
export const STATUS_CHANNEL = "hyprlane-wave:window-init-status"
export const SURFACE_ACTIVITY_CHANNEL = "hyprlane-wave:surface-activity"
export const WAVE_INIT_CHANNEL = "hyprlane-wave:wave-init"

export const WAVE_SERVER_WEB_ENDPOINT = "WAVE_SERVER_WEB_ENDPOINT"
export const WAVE_SERVER_WS_ENDPOINT = "WAVE_SERVER_WS_ENDPOINT"

export type HostedPreloadConfig = {
  platform: NodeJS.Platform
  webEndpoint: string
  wsEndpoint: string
  dataDir: string
  configDir: string
  homeDir: string
}

export type HostedWaveInit = {
  tabId: string
  clientId: string
  windowId: string
  activate: boolean
  primaryTabStartup?: boolean
}
