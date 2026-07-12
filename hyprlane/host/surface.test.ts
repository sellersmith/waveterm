// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
  ipcListeners: new Map<string, (...args: any[]) => any>(),
  sent: [] as Array<[string, unknown]>,
  menuTemplates: [] as Array<Array<Record<string, any>>>,
  menuPopupOptions: [] as Array<{ callback?: () => void }>,
  mainFrame: { id: "main-frame" },
  added: 0,
  removed: 0,
  backgroundThrottling: [] as boolean[],
  borderRadii: [] as number[],
  loadUrls: [] as string[],
  visibility: [] as boolean[],
  pasted: 0,
  externalUrls: [] as string[],
  dialogResponse: 1,
}))

vi.mock("electron", () => ({
  BaseWindow: class {},
  dialog: {
    showMessageBox: async () => ({ response: fixture.dialogResponse }),
  },
  shell: {
    openExternal: async (url: string) => fixture.externalUrls.push(url),
  },
  Menu: {
    buildFromTemplate: (template: Array<Record<string, any>>) => {
      fixture.menuTemplates.push(template)
      return {
        popup: (options: { callback?: () => void }) =>
          fixture.menuPopupOptions.push(options),
      }
    },
  },
  WebContentsView: class {
    webContents = {
      mainFrame: fixture.mainFrame,
      ipc: {
        handle: (channel: string, handler: (...args: any[]) => any) =>
          fixture.ipcHandlers.set(channel, handler),
        removeHandler: (channel: string) => fixture.ipcHandlers.delete(channel),
        on: (channel: string, listener: (...args: any[]) => any) =>
          fixture.ipcListeners.set(channel, listener),
        removeListener: (channel: string) =>
          fixture.ipcListeners.delete(channel),
      },
      on: vi.fn(),
      removeListener: vi.fn(),
      isDestroyed: () => false,
      close: vi.fn(),
      paste: () => fixture.pasted++,
      focus: vi.fn(),
      setBackgroundThrottling: (enabled: boolean) =>
        fixture.backgroundThrottling.push(enabled),
      loadURL: vi.fn(async (url: string) => fixture.loadUrls.push(url)),
      send: (channel: string, value: unknown) =>
        fixture.sent.push([channel, value]),
    }
    setBounds = vi.fn()
    setBorderRadius = vi.fn((radius: number) => fixture.borderRadii.push(radius))
    setVisible = vi.fn((visible: boolean) => fixture.visibility.push(visible))
  },
}))

vi.mock("./policy", () => ({
  hardenHostedWebContents: () => () => undefined,
}))

import {
  ACTION_CHANNEL,
  CONFIG_CHANNEL,
  CONTEXT_MENU_CLICK_CHANNEL,
  CONTEXT_MENU_SHOW_CHANNEL,
  NATIVE_PASTE_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  SAVE_TEXT_FILE_CHANNEL,
  STATUS_CHANNEL,
  SURFACE_ACTIVITY_CHANNEL,
  WAVE_INIT_CHANNEL,
} from "../shared/ipc"
import { normalizeWaveBackend, normalizeWaveLocalPaths } from "./backend"
import { HostedSurface } from "./surface"

describe("real Wave hosted surface handshake", () => {
  beforeEach(() => {
    fixture.ipcHandlers.clear()
    fixture.ipcListeners.clear()
    fixture.sent.length = 0
    fixture.menuTemplates.length = 0
    fixture.menuPopupOptions.length = 0
    fixture.added = 0
    fixture.removed = 0
    fixture.backgroundThrottling.length = 0
    fixture.borderRadii.length = 0
    fixture.loadUrls.length = 0
    fixture.visibility.length = 0
    fixture.pasted = 0
    fixture.externalUrls.length = 0
    fixture.dialogResponse = 1
  })

  it("sends Wave init only to a ready main frame and resolves on wave-ready", async () => {
    const parent = {
      isDestroyed: () => false,
      contentView: {
        addChildView: () => fixture.added++,
        removeChildView: () => fixture.removed++,
      },
    }
    const backend = normalizeWaveBackend({
      webUrl: "http://127.0.0.1:4123",
      wsUrl: "ws://127.0.0.1:4567",
      authKey: "a".repeat(64),
    })
    const paths = normalizeWaveLocalPaths({
      dataDir: "/private/data",
      configDir: "/private/config",
      homeDir: "/Users/tester",
    })
    const waveInit = {
      tabId: "tab-1",
      clientId: "client-1",
      windowId: "window-1",
      activate: true,
    }
    const surface = new HostedSurface({
      id: 1,
      workspaceId: "workspace-1",
      parent: parent as never,
      artifactRoot: "/artifact",
      partition: "persist:hyprlane-wave",
      backend,
      paths,
      waveInit,
      onInvalidated: vi.fn(),
    })
    expect(fixture.backgroundThrottling).toEqual([false])
    expect(fixture.borderRadii).toEqual([12])

    const configEvent = {
      senderFrame: fixture.mainFrame,
      returnValue: null as unknown,
    }
    const untrustedConfigEvent = {
      senderFrame: {},
      returnValue: "unset" as unknown,
    }
    expect(() =>
      fixture.ipcListeners.get(CONFIG_CHANNEL)?.(untrustedConfigEvent)
    ).not.toThrow()
    expect(untrustedConfigEvent.returnValue).toBeNull()

    fixture.ipcListeners.get(CONFIG_CHANNEL)?.(configEvent)
    expect(configEvent.returnValue).toEqual({
      platform: "darwin",
      webEndpoint: "127.0.0.1:4123",
      wsEndpoint: "127.0.0.1:4567",
      dataDir: "/private/data",
      configDir: "/private/config",
      homeDir: "/Users/tester",
    })
    expect(JSON.stringify(configEvent.returnValue)).not.toContain("aaaa")

    const loading = surface.load()
    let settled = false
    void loading.then(() => {
      settled = true
    })
    await Promise.resolve()
    fixture.ipcListeners.get(STATUS_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      "wave-ready"
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)

    fixture.ipcListeners.get(STATUS_CHANNEL)?.({ senderFrame: {} }, "ready")
    expect(fixture.sent).toEqual([])

    fixture.ipcListeners.get(STATUS_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      "ready"
    )
    expect(fixture.sent).toEqual([[WAVE_INIT_CHANNEL, waveInit]])

    fixture.ipcListeners.get(STATUS_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      "wave-ready"
    )
    await expect(loading).resolves.toBeUndefined()

    surface.setState({
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: false,
    })
    expect(fixture.sent).toEqual([[WAVE_INIT_CHANNEL, waveInit]])
    surface.setState({
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
    })
    surface.setState({
      bounds: { x: 0, y: 0, width: 900, height: 700 },
      visible: true,
    })
    surface.setState({
      bounds: { x: 0, y: 0, width: 900, height: 700 },
      visible: false,
    })
    expect(fixture.sent).toEqual([
      [WAVE_INIT_CHANNEL, waveInit],
      [SURFACE_ACTIVITY_CHANNEL, true],
      [SURFACE_ACTIVITY_CHANNEL, false],
    ])

    await expect(
      fixture.ipcHandlers.get(ACTION_CHANNEL)?.(
        { senderFrame: fixture.mainFrame },
        "create-tab",
        []
      )
    ).resolves.toBe(false)
    await expect(
      fixture.ipcHandlers.get(ACTION_CHANNEL)?.(
        { senderFrame: {} },
        "create-tab",
        []
      )
    ).rejects.toThrow("untrusted")
    await expect(
      fixture.ipcHandlers.get(SAVE_TEXT_FILE_CHANNEL)?.(
        { senderFrame: {} },
        "session.log",
        "scrollback"
      )
    ).rejects.toThrow("untrusted")

    surface.destroy()
    expect(fixture.added).toBe(1)
    expect(fixture.removed).toBe(1)
    expect(fixture.ipcHandlers.has(ACTION_CHANNEL)).toBe(false)
    expect(fixture.ipcHandlers.has(SAVE_TEXT_FILE_CHANNEL)).toBe(false)
    expect(fixture.ipcListeners.has(STATUS_CHANNEL)).toBe(false)

    const abandoned = new HostedSurface({
      id: 2,
      workspaceId: "workspace-1",
      parent: parent as never,
      artifactRoot: "/artifact",
      partition: "persist:hyprlane-wave",
      backend,
      paths,
      waveInit,
      onInvalidated: vi.fn(),
    })
    const abandonedLoad = abandoned.load()
    await Promise.resolve()
    abandoned.destroy()
    await expect(
      Promise.race([
        abandonedLoad.then(() => "resolved"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("timeout"), 10)
        ),
      ])
    ).resolves.toBe("resolved")
  })

  it("settles an isolated renderer probe on its bare ready handshake", async () => {
    const parent = {
      isDestroyed: () => false,
      contentView: {
        addChildView: () => fixture.added++,
        removeChildView: () => fixture.removed++,
      },
    }
    const surface = new HostedSurface({
      id: 4,
      workspaceId: "hyprlane-probe",
      parent: parent as never,
      artifactRoot: "/artifact",
      partition: "persist:hyprlane-wave",
      onInvalidated: vi.fn(),
    })

    const loading = surface.load()
    await Promise.resolve()
    fixture.ipcListeners.get(STATUS_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      "ready"
    )
    await expect(loading).resolves.toBeUndefined()
    expect(fixture.sent).toEqual([])
    surface.destroy()
  })

  it("delegates a native tab action without reloading its renderer", async () => {
    const parent = {
      isDestroyed: () => false,
      contentView: {
        addChildView: () => fixture.added++,
        removeChildView: () => fixture.removed++,
      },
    }
    const backend = normalizeWaveBackend({
      webUrl: "http://127.0.0.1:4123",
      wsUrl: "ws://127.0.0.1:4567",
      authKey: "a".repeat(64),
    })
    const paths = normalizeWaveLocalPaths({
      dataDir: "/private/data",
      configDir: "/private/config",
      homeDir: "/Users/tester",
    })
    const initialInit = {
      tabId: "tab-1",
      clientId: "client-1",
      windowId: "window-1",
      activate: true,
    }
    const surface = new HostedSurface({
      id: 2,
      workspaceId: "workspace-1",
      parent: parent as never,
      artifactRoot: "/artifact",
      partition: "persist:hyprlane-wave",
      backend,
      paths,
      waveInit: initialInit,
      onAction: async () => true,
      onInvalidated: vi.fn(),
    })

    const loading = surface.load()
    await Promise.resolve()
    fixture.ipcListeners.get(STATUS_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      "ready"
    )
    fixture.ipcListeners.get(STATUS_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      "wave-ready"
    )
    await loading
    surface.setState({
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      focus: true,
    })

    await expect(
      fixture.ipcHandlers.get(ACTION_CHANNEL)?.(
        { senderFrame: fixture.mainFrame },
        "create-tab",
        []
      )
    ).resolves.toBe(true)
    expect(fixture.loadUrls).toHaveLength(1)
    expect(fixture.sent).toEqual([
      [WAVE_INIT_CHANNEL, initialInit],
      [SURFACE_ACTIVITY_CHANNEL, true],
    ])
  })

  it("allows only explicit paste and http(s) external links from the trusted frame", async () => {
    const parent = {
      isDestroyed: () => false,
      contentView: {
        addChildView: () => fixture.added++,
        removeChildView: () => fixture.removed++,
      },
    }
    const surface = new HostedSurface({
      id: 3,
      workspaceId: "workspace-1",
      parent: parent as never,
      artifactRoot: "/artifact",
      partition: "persist:hyprlane-wave",
      onInvalidated: vi.fn(),
    })

    expect(() =>
      fixture.ipcListeners.get(NATIVE_PASTE_CHANNEL)?.({
        senderFrame: fixture.mainFrame,
      })
    ).not.toThrow()
    expect(fixture.pasted).toBe(1)

    fixture.ipcListeners.get(OPEN_EXTERNAL_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      "https://docs.waveterm.dev/guide"
    )
    fixture.ipcListeners.get(OPEN_EXTERNAL_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      "file:///private/secret"
    )
    await Promise.resolve()
    expect(fixture.externalUrls).toEqual(["https://docs.waveterm.dev/guide"])

    expect(() =>
      fixture.ipcListeners.get(NATIVE_PASTE_CHANNEL)?.({ senderFrame: {} })
    ).toThrow("untrusted")
    surface.destroy()
  })

  it("restores upstream native context menus without trusting renderer roles", () => {
    const parent = {
      isDestroyed: () => false,
      contentView: {
        addChildView: () => fixture.added++,
        removeChildView: () => fixture.removed++,
      },
    }
    const surface = new HostedSurface({
      id: 5,
      workspaceId: "workspace-1",
      parent: parent as never,
      artifactRoot: "/artifact",
      partition: "persist:hyprlane-wave",
      onInvalidated: vi.fn(),
    })
    const listener = fixture.ipcListeners.get(CONTEXT_MENU_SHOW_CHANNEL)
    const mainEvent = { senderFrame: fixture.mainFrame }

    listener?.(mainEvent, [
      { id: "rename-tab", label: "Rename Tab" },
      { id: "sep-1", type: "separator" },
      {
        id: "advanced-1",
        label: "Advanced",
        type: "submenu",
        submenu: [{ id: "copy-1", role: "copy" }],
      },
    ])
    expect(fixture.menuTemplates).toHaveLength(1)
    expect(fixture.menuTemplates[0][0].label).toBe("Rename Tab")
    fixture.menuTemplates[0][0].click()
    expect(fixture.sent).toEqual([[CONTEXT_MENU_CLICK_CHANNEL, "rename-tab"]])
    fixture.menuPopupOptions[0].callback?.()
    expect(fixture.sent).toHaveLength(1)

    listener?.(mainEvent, [{ id: "bad-1", label: "Quit", role: "quit" }])
    expect(fixture.menuTemplates).toHaveLength(1)
    expect(fixture.sent).toEqual([
      [CONTEXT_MENU_CLICK_CHANNEL, "rename-tab"],
      [CONTEXT_MENU_CLICK_CHANNEL, null],
    ])
    expect(() =>
      listener?.({ senderFrame: {} }, [{ id: "menu-2", label: "Copy" }])
    ).toThrow("untrusted")

    surface.destroy()
    expect(fixture.ipcListeners.has(CONTEXT_MENU_SHOW_CHANNEL)).toBe(false)
  })

  it("accepts Wave terminal submenus that omit the optional submenu type", () => {
    const parent = {
      isDestroyed: () => false,
      contentView: {
        addChildView: () => fixture.added++,
        removeChildView: () => fixture.removed++,
      },
    }
    const surface = new HostedSurface({
      id: 6,
      workspaceId: "workspace-1",
      parent: parent as never,
      artifactRoot: "/artifact",
      partition: "persist:hyprlane-wave",
      onInvalidated: vi.fn(),
    })

    fixture.ipcListeners.get(CONTEXT_MENU_SHOW_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      [
        { id: "paste", label: "Paste" },
        { id: "sep-1", type: "separator" },
        {
          id: "themes",
          label: "Themes",
          submenu: [
            {
              id: "theme-default",
              label: "Default",
              type: "checkbox",
              checked: true,
            },
          ],
        },
      ]
    )

    expect(fixture.menuTemplates).toHaveLength(1)
    expect(fixture.menuTemplates[0][2]).toMatchObject({
      label: "Themes",
      submenu: [{ label: "Default", type: "checkbox", checked: true }],
    })

    fixture.ipcListeners.get(CONTEXT_MENU_SHOW_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      [
        {
          id: "invalid-checkbox-menu",
          label: "Invalid",
          type: "checkbox",
          submenu: [{ id: "child", label: "Child" }],
        },
      ]
    )
    expect(fixture.menuTemplates).toHaveLength(1)
    expect(fixture.sent).toEqual([[CONTEXT_MENU_CLICK_CHANNEL, null]])
    surface.destroy()
  })

  it("briefly reveals a hidden surface while the first Wave handshake loads", async () => {
    const parent = {
      isDestroyed: () => false,
      contentView: {
        addChildView: () => fixture.added++,
        removeChildView: () => fixture.removed++,
      },
    }
    const surface = new HostedSurface({
      id: 3,
      workspaceId: "workspace-1",
      parent: parent as never,
      artifactRoot: "/artifact",
      partition: "persist:hyprlane-wave",
      backend: normalizeWaveBackend({
        webUrl: "http://127.0.0.1:4123",
        wsUrl: "ws://127.0.0.1:4567",
        authKey: "a".repeat(64),
      }),
      paths: normalizeWaveLocalPaths({
        dataDir: "/private/data",
        configDir: "/private/config",
        homeDir: "/Users/tester",
      }),
      waveInit: {
        tabId: "tab-1",
        clientId: "client-1",
        windowId: "window-1",
        activate: true,
      },
      onInvalidated: vi.fn(),
    })
    fixture.visibility.length = 0

    const loading = surface.load()
    await Promise.resolve()
    expect(fixture.visibility).toEqual([true])

    fixture.ipcListeners.get(STATUS_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      "ready"
    )
    fixture.ipcListeners.get(STATUS_CHANNEL)?.(
      { senderFrame: fixture.mainFrame },
      "wave-ready"
    )
    await loading

    expect(fixture.visibility).toEqual([true, false])
  })
})
