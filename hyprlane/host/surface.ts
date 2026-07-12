// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path"
import { BaseWindow, dialog, shell, WebContentsView } from "electron"
import {
  ACTION_CHANNEL,
  BOOTSTRAP_CHANNEL,
  CONFIG_CHANNEL,
  CONTEXT_MENU_CLICK_CHANNEL,
  CONTEXT_MENU_SHOW_CHANNEL,
  LEGACY_READY_CHANNEL,
  NATIVE_PASTE_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  SAVE_TEXT_FILE_CHANNEL,
  STATUS_CHANNEL,
  SURFACE_ACTIVITY_CHANNEL,
  WAVE_INIT_CHANNEL,
  type HostedPreloadConfig,
  type HostedWaveInit,
} from "../shared/ipc"
import type { NormalizedWaveBackend, NormalizedWaveLocalPaths } from "./backend"
import { showHostedContextMenu } from "./context-menu"
import { hardenHostedWebContents } from "./policy"
import { SURFACE_URL } from "./protocol"
import { saveHostedTextFile } from "./save-file"

const RENDERER_READY_TIMEOUT_MS = 15_000
const MAX_EXTERNAL_URL_LENGTH = 8_192
const HYPRLANE_CONTENT_CANVAS_RADIUS = 12

function parseExternalUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EXTERNAL_URL_LENGTH
  ) {
    return null
  }
  try {
    const url = new URL(value)
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

export type HostedSurfaceState = {
  bounds: { x: number; y: number; width: number; height: number }
  visible: boolean
  focus?: boolean
}

function withReadyTimeout(promise: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("hosted Wave renderer did not become ready")),
      RENDERER_READY_TIMEOUT_MS
    )
    timeout.unref?.()
    promise.then(
      () => {
        clearTimeout(timeout)
        resolve()
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

export class HostedSurface {
  readonly id: number
  readonly workspaceId: string
  readonly #parent: BaseWindow
  readonly #view: WebContentsView
  readonly #cleanupPolicy: () => void
  #readyPromise: Promise<void>
  readonly #onInvalidated: (id: number, reason: string) => void
  readonly #preloadConfig: HostedPreloadConfig
  readonly #onAction: (action: unknown, args: unknown) => Promise<boolean>
  #waveInit: HostedWaveInit | null
  #readyResolve: (() => void) | null = null
  #actionTail: Promise<void> = Promise.resolve()
  #initSent = false
  #destroyed = false
  #invalidated = false
  #visible = false
  readonly #configListener = (event: Electron.IpcMainEvent) => {
    if (event.senderFrame !== this.#view.webContents.mainFrame) {
      event.returnValue = null
      return
    }
    event.returnValue = this.#preloadConfig
  }
  readonly #statusListener = (
    event: Electron.IpcMainEvent,
    status: unknown
  ) => {
    if (event.senderFrame !== this.#view.webContents.mainFrame) return
    // The dedicated isolation probe intentionally has no backend or Wave
    // init payload. Wave's bare renderer still reports `ready`; that is the
    // full handshake for this non-product mode.
    if (!this.#waveInit) {
      if (status === "ready") this.#readyResolve?.()
      return
    }
    if (status === "ready" && !this.#initSent) {
      this.#initSent = true
      this.#view.webContents.send(WAVE_INIT_CHANNEL, this.#waveInit)
      // A same-WebContents navigation keeps the host-visible bit, but the
      // newly-created preload bridge starts inactive. Re-publish true after
      // the Wave handshake so its terminal replay gate can drain.
      if (this.#visible) {
        this.#view.webContents.send(SURFACE_ACTIVITY_CHANNEL, true)
      }
      return
    }
    if (status === "wave-ready" && this.#initSent) this.#readyResolve?.()
  }
  readonly #legacyReadyListener = (event: Electron.IpcMainEvent) => {
    if (event.senderFrame !== this.#view.webContents.mainFrame) return
    if (!this.#waveInit) this.#readyResolve?.()
  }
  readonly #contextMenuListener = (
    event: Electron.IpcMainEvent,
    rawMenu: unknown
  ) => {
    this.#assertMainFrame(event)
    try {
      if (!showHostedContextMenu(this.#view.webContents, rawMenu)) {
        this.#view.webContents.send(CONTEXT_MENU_CLICK_CHANNEL, null)
      }
    } catch {
      if (!this.#view.webContents.isDestroyed()) {
        this.#view.webContents.send(CONTEXT_MENU_CLICK_CHANNEL, null)
      }
    }
  }
  readonly #saveTextFileHandler = async (
    event: Electron.IpcMainInvokeEvent,
    fileName: unknown,
    content: unknown
  ) => {
    this.#assertMainFrame(event)
    try {
      return await saveHostedTextFile(this.#parent, fileName, content)
    } catch {
      return false
    }
  }
  readonly #nativePasteListener = (event: Electron.IpcMainEvent) => {
    this.#assertMainFrame(event)
    this.#view.webContents.paste()
  }
  readonly #openExternalListener = (
    event: Electron.IpcMainEvent,
    value: unknown
  ) => {
    this.#assertMainFrame(event)
    const url = parseExternalUrl(value)
    if (!url) return
    void shell.openExternal(url).catch(() => undefined)
  }
  readonly #renderProcessGoneListener = () =>
    this.#invalidate("render-process-gone")
  readonly #unresponsiveListener = () => this.#invalidate("unresponsive")
  readonly #webContentsDestroyedListener = () =>
    this.#invalidate("web-contents-destroyed")

  constructor(options: {
    id: number
    workspaceId: string
    parent: BaseWindow
    artifactRoot: string
    partition: string
    backend?: NormalizedWaveBackend
    paths?: NormalizedWaveLocalPaths
    waveInit?: HostedWaveInit
    onAction?(action: unknown, args: unknown): Promise<boolean>
    onInvalidated(id: number, reason: string): void
  }) {
    this.id = options.id
    this.workspaceId = options.workspaceId
    this.#parent = options.parent
    this.#onInvalidated = options.onInvalidated
    this.#onAction = options.onAction ?? (async () => false)
    const realWaveMode = Boolean(
      options.backend || options.paths || options.waveInit
    )
    if (
      realWaveMode &&
      (!options.backend || !options.paths || !options.waveInit)
    ) {
      throw new Error("incomplete hosted Wave runtime configuration")
    }
    this.#waveInit = options.waveInit ?? null
    this.#preloadConfig = Object.freeze({
      platform: process.platform,
      webEndpoint: options.backend?.webEndpoint ?? "",
      wsEndpoint: options.backend?.wsEndpoint ?? "",
      dataDir: options.paths?.dataDir ?? "",
      configDir: options.paths?.configDir ?? "",
      homeDir: options.paths?.homeDir ?? "",
    })
    this.#view = new WebContentsView({
      webPreferences: {
        preload: join(options.artifactRoot, "preload/index.cjs"),
        partition: options.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: true,
      },
    })
    // Electron clips this native View at the compositor level. Keeping the
    // corner treatment here — rather than patching upstream Wave CSS — lets the
    // hosted workspace sit inside Hyprlane's inset content canvas unchanged.
    this.#view.setBorderRadius(HYPRLANE_CONTENT_CANVAS_RADIUS)
    // Hosted surfaces can remain Chromium Page-Visibility hidden even after
    // WebContentsView.setVisible(true). Xterm's async write buffer must still
    // drain for the host-designated active surface; renderer-side activity
    // coalescing prevents hidden surfaces from doing replay work.
    this.#view.webContents.setBackgroundThrottling(false)
    this.#view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    this.#view.setVisible(false)
    this.#cleanupPolicy = hardenHostedWebContents(this.#view.webContents)
    this.#view.webContents.on(
      "render-process-gone",
      this.#renderProcessGoneListener
    )
    this.#view.webContents.on("unresponsive", this.#unresponsiveListener)
    this.#view.webContents.on("destroyed", this.#webContentsDestroyedListener)
    this.#view.webContents.ipc.handle(BOOTSTRAP_CHANNEL, (event) => {
      this.#assertMainFrame(event)
      return { workspaceId: this.workspaceId, surfaceId: this.id }
    })
    this.#view.webContents.ipc.handle(
      ACTION_CHANNEL,
      async (event, action: unknown, args: unknown) => {
        this.#assertMainFrame(event)
        return this.#enqueueAction(action, args)
      }
    )
    this.#view.webContents.ipc.handle(
      SAVE_TEXT_FILE_CHANNEL,
      this.#saveTextFileHandler
    )
    this.#view.webContents.ipc.on(
      NATIVE_PASTE_CHANNEL,
      this.#nativePasteListener
    )
    this.#view.webContents.ipc.on(
      OPEN_EXTERNAL_CHANNEL,
      this.#openExternalListener
    )
    this.#view.webContents.ipc.on(CONFIG_CHANNEL, this.#configListener)
    this.#view.webContents.ipc.on(
      CONTEXT_MENU_SHOW_CHANNEL,
      this.#contextMenuListener
    )
    this.#view.webContents.ipc.on(STATUS_CHANNEL, this.#statusListener)
    this.#view.webContents.ipc.on(
      LEGACY_READY_CHANNEL,
      this.#legacyReadyListener
    )
    this.#readyPromise = new Promise((resolve) => {
      this.#readyResolve = resolve
    })
  }

  async load(): Promise<void> {
    this.#parent.contentView.addChildView(this.#view)
    // A WebContentsView born hidden behind an already-painted SPA can remain
    // Page-Visibility hidden indefinitely, preventing Wave's first renderer
    // handshake. Briefly paint only a 1×1 surface; never publish it as active
    // to the renderer, and restore the host-owned requested state afterwards.
    this.#view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    this.#view.setVisible(true)
    try {
      await this.#view.webContents.loadURL(SURFACE_URL)
      await withReadyTimeout(this.#readyPromise)
    } finally {
      if (!this.#destroyed) this.#view.setVisible(this.#visible)
    }
  }

  #resetReady(): void {
    this.#readyPromise = new Promise((resolve) => {
      this.#readyResolve = resolve
    })
  }

  async #enqueueAction(action: unknown, args: unknown): Promise<boolean> {
    const task = this.#actionTail.then(async () => {
      if (this.#destroyed) return false
      if (
        action === "close-tab" &&
        Array.isArray(args) &&
        args.length === 3 &&
        args[2] === true
      ) {
        const result = await dialog.showMessageBox(this.#parent, {
          type: "question",
          defaultId: 1,
          cancelId: 0,
          buttons: ["Cancel", "Close Tab"],
          title: "Confirm",
          message: "Are you sure you want to close this tab?",
        })
        if (result.response !== 1) return false
      }
      return (await this.#onAction(action, args)) && !this.#destroyed
    })
    this.#actionTail = task.then(
      () => undefined,
      () => undefined
    )
    return task.catch(() => false)
  }

  setState(state: HostedSurfaceState): void {
    if (this.#destroyed) throw new Error("hosted Wave surface is destroyed")
    this.#view.setBounds(state.bounds)
    this.#view.setVisible(state.visible)
    if (state.visible !== this.#visible) {
      this.#visible = state.visible
      this.#view.webContents.send(SURFACE_ACTIVITY_CHANNEL, this.#visible)
    }
    if (state.visible && state.focus) this.#view.webContents.focus()
  }

  #assertMainFrame(event: { senderFrame: Electron.WebFrameMain | null }): void {
    if (event.senderFrame !== this.#view.webContents.mainFrame) {
      throw new Error("untrusted hosted Wave frame")
    }
  }

  #invalidate(reason: string): void {
    if (this.#destroyed || this.#invalidated) return
    this.#invalidated = true
    this.#onInvalidated(this.id, reason)
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#view.webContents.ipc.removeHandler(BOOTSTRAP_CHANNEL)
    this.#view.webContents.ipc.removeHandler(ACTION_CHANNEL)
    this.#view.webContents.ipc.removeHandler(SAVE_TEXT_FILE_CHANNEL)
    this.#view.webContents.ipc.removeListener(
      NATIVE_PASTE_CHANNEL,
      this.#nativePasteListener
    )
    this.#view.webContents.ipc.removeListener(
      OPEN_EXTERNAL_CHANNEL,
      this.#openExternalListener
    )
    this.#view.webContents.ipc.removeListener(
      CONFIG_CHANNEL,
      this.#configListener
    )
    this.#view.webContents.ipc.removeListener(
      CONTEXT_MENU_SHOW_CHANNEL,
      this.#contextMenuListener
    )
    this.#view.webContents.ipc.removeListener(
      STATUS_CHANNEL,
      this.#statusListener
    )
    this.#view.webContents.ipc.removeListener(
      LEGACY_READY_CHANNEL,
      this.#legacyReadyListener
    )
    this.#readyResolve?.()
    this.#readyResolve = null
    this.#cleanupPolicy()
    this.#view.webContents.removeListener(
      "render-process-gone",
      this.#renderProcessGoneListener
    )
    this.#view.webContents.removeListener(
      "unresponsive",
      this.#unresponsiveListener
    )
    this.#view.webContents.removeListener(
      "destroyed",
      this.#webContentsDestroyedListener
    )
    if (!this.#parent.isDestroyed()) {
      this.#parent.contentView.removeChildView(this.#view)
    }
    if (!this.#view.webContents.isDestroyed()) this.#view.webContents.close()
  }
}
