// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import type { Session, WebContents } from "electron"
import { SURFACE_URL } from "./protocol"

export const HOSTED_WEBVIEW_PARTITION = "persist:hyprlane-wave-web"
const HOSTED_SURFACE_ORIGIN = "app://bundle"
const CLIPBOARD_WRITE_PERMISSION = "clipboard-sanitized-write"

type HostedWebviewPreferences = {
  contextIsolation?: boolean
  nodeIntegration?: boolean
  nodeIntegrationInSubFrames?: boolean
  preload?: unknown
  sandbox?: boolean
  webSecurity?: boolean
}

function isAllowedHostedWebviewUrl(value: string | undefined): boolean {
  if (value === "" || value === "about:blank") return true
  try {
    const url = new URL(value ?? "")
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

/**
 * WebView's preload runs with Node enabled by default. The hosted Wave
 * renderer may open a user-selected web page, so discard every renderer-
 * supplied privilege and place the guest in its own hardened session.
 */
export function prepareHostedWebview(
  preferences: HostedWebviewPreferences,
  params: Record<string, string>
): boolean {
  if (!isAllowedHostedWebviewUrl(params.src)) return false

  delete preferences.preload
  delete params.preload
  Object.assign(preferences, {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
  })
  params.partition = HOSTED_WEBVIEW_PARTITION
  return true
}

export function hardenHostedSession(partitionSession: Session): () => void {
  partitionSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      permission === CLIPBOARD_WRITE_PERMISSION &&
      requestingOrigin === HOSTED_SURFACE_ORIGIN
  )
  partitionSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      callback(
        permission === CLIPBOARD_WRITE_PERMISSION &&
          webContents.getURL() === SURFACE_URL
      )
    }
  )
  const denyDownload = (event: Electron.Event) => event.preventDefault()
  partitionSession.on("will-download", denyDownload)

  return () => {
    partitionSession.removeListener("will-download", denyDownload)
    partitionSession.setPermissionCheckHandler(null)
    partitionSession.setPermissionRequestHandler(null)
  }
}

export function hardenHostedWebContents(webContents: WebContents): () => void {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  const denyUnexpectedNavigation = (
    details: Electron.Event<Electron.WebContentsWillNavigateEventParams>
  ) => {
    if (details.url !== SURFACE_URL) details.preventDefault()
  }
  const denyUnexpectedFrameNavigation = (
    details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>
  ) => {
    if (!details.isMainFrame || details.url !== SURFACE_URL) {
      details.preventDefault()
    }
  }
  const configureWebview = (
    event: Electron.Event,
    preferences: Electron.WebPreferences,
    params: Record<string, string>
  ) => {
    if (!prepareHostedWebview(preferences, params)) event.preventDefault()
  }
  const hardenWebview = (_event: Electron.Event, guest: WebContents) => {
    guest.setWindowOpenHandler(() => ({ action: "deny" }))
    const denyUnsafeGuestNavigation = (
      details: Electron.Event<Electron.WebContentsWillNavigateEventParams>
    ) => {
      if (!isAllowedHostedWebviewUrl(details.url)) details.preventDefault()
    }
    guest.on("will-navigate", denyUnsafeGuestNavigation)
    guest.on("will-frame-navigate", denyUnsafeGuestNavigation)
  }

  webContents.on("will-navigate", denyUnexpectedNavigation)
  webContents.on("will-frame-navigate", denyUnexpectedFrameNavigation)
  webContents.on("will-attach-webview", configureWebview)
  webContents.on("did-attach-webview", hardenWebview)

  return () => {
    webContents.removeListener("will-navigate", denyUnexpectedNavigation)
    webContents.removeListener(
      "will-frame-navigate",
      denyUnexpectedFrameNavigation
    )
    webContents.removeListener("will-attach-webview", configureWebview)
    webContents.removeListener("did-attach-webview", hardenWebview)
  }
}
