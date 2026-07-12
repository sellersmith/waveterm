// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest"
import {
  CONTEXT_MENU_CLICK_CHANNEL,
  CONTEXT_MENU_SHOW_CHANNEL,
  NATIVE_PASTE_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  SAVE_TEXT_FILE_CHANNEL,
} from "../shared/ipc"
import {
  createWaveApi,
  WAVE_SERVER_WEB_ENDPOINT,
  WAVE_SERVER_WS_ENDPOINT,
} from "./api"

describe("hosted Wave preload API", () => {
  it("is frozen and exposes only the two allowlisted environment values", () => {
    const api = createWaveApi(
      {
        platform: "darwin",
        webEndpoint: "127.0.0.1:4123",
        wsEndpoint: "127.0.0.1:4567",
        dataDir: "/private/data",
        configDir: "/private/config",
        homeDir: "/Users/tester",
      },
      {
        invoke: vi.fn(),
        on: vi.fn(),
        send: vi.fn(),
      }
    ) as Record<string, unknown>

    expect(Object.isFrozen(api)).toBe(true)
    expect(api).not.toHaveProperty("getAuthKey")
    expect(
      (api.getEnv as (name: string) => string)(WAVE_SERVER_WEB_ENDPOINT)
    ).toBe("127.0.0.1:4123")
    expect(
      (api.getEnv as (name: string) => string)(WAVE_SERVER_WS_ENDPOINT)
    ).toBe("127.0.0.1:4567")
    expect((api.getEnv as (name: string) => string)("WAVETERM_AUTH_KEY")).toBe(
      ""
    )
    expect((api.getEnv as (name: string) => string)("PATH")).toBe("")
  })

  it("fails unsupported Wave tab and workspace actions closed", async () => {
    const invoke = vi.fn(async () => false)
    const api = createWaveApi(
      {
        platform: "darwin",
        webEndpoint: "127.0.0.1:4123",
        wsEndpoint: "127.0.0.1:4567",
        dataDir: "/private/data",
        configDir: "/private/config",
        homeDir: "/Users/tester",
      },
      { invoke, on: vi.fn(), send: vi.fn() }
    ) as Record<string, (...args: unknown[]) => unknown>

    api.createTab()
    api.setActiveTab("tab-2")
    api.switchWorkspace("workspace-2")
    await expect(api.closeTab("workspace-1", "tab-1", false)).resolves.toBe(
      false
    )
    expect(invoke).toHaveBeenCalledTimes(4)
  })

  it("forwards only serializable native context-menu definitions", () => {
    const send = vi.fn()
    const on = vi.fn()
    const api = createWaveApi(
      {
        platform: "darwin",
        webEndpoint: "127.0.0.1:4123",
        wsEndpoint: "127.0.0.1:4567",
        dataDir: "/private/data",
        configDir: "/private/config",
        homeDir: "/Users/tester",
      },
      { invoke: vi.fn(), on, send }
    ) as Record<string, (...args: unknown[]) => unknown>
    const menu = [{ id: "menu-1", label: "Rename Tab" }]
    const callback = vi.fn()

    api.showContextMenu("spoofed-workspace", menu)
    api.onContextMenuClick(callback)

    expect(send).toHaveBeenCalledWith(CONTEXT_MENU_SHOW_CHANNEL, menu)
    expect(on).toHaveBeenCalledWith(
      CONTEXT_MENU_CLICK_CHANNEL,
      expect.any(Function)
    )
    const listener = on.mock.calls[0][1] as (
      event: unknown,
      id: unknown
    ) => void
    listener({}, "menu-1")
    listener({}, null)
    expect(callback).toHaveBeenNthCalledWith(1, "menu-1")
    expect(callback).toHaveBeenNthCalledWith(2, null)
  })

  it("forwards a scrollback save only through the dedicated host channel", async () => {
    const invoke = vi.fn().mockResolvedValue(true)
    const api = createWaveApi(
      {
        platform: "darwin",
        webEndpoint: "127.0.0.1:4123",
        wsEndpoint: "ws://127.0.0.1:4567",
        dataDir: "/private/data",
        configDir: "/private/config",
        homeDir: "/Users/tester",
      },
      { invoke, on: vi.fn(), send: vi.fn() }
    ) as Record<string, unknown>

    await expect(
      (api.saveTextFile as (fileName: string, content: string) => Promise<boolean>)(
        "session.log",
        "scrollback"
      )
    ).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith(
      SAVE_TEXT_FILE_CHANNEL,
      "session.log",
      "scrollback"
    )
  })

  it("uses dedicated one-way channels for explicit paste and external links", () => {
    const send = vi.fn()
    const api = createWaveApi(
      {
        platform: "darwin",
        webEndpoint: "127.0.0.1:4123",
        wsEndpoint: "127.0.0.1:4567",
        dataDir: "/private/data",
        configDir: "/private/config",
        homeDir: "/Users/tester",
      },
      { invoke: vi.fn(), on: vi.fn(), send }
    ) as Record<string, (...args: unknown[]) => unknown>

    api.nativePaste()
    api.openExternal("https://docs.waveterm.dev")

    expect(send).toHaveBeenNthCalledWith(1, NATIVE_PASTE_CHANNEL)
    expect(send).toHaveBeenNthCalledWith(
      2,
      OPEN_EXTERNAL_CHANNEL,
      "https://docs.waveterm.dev"
    )
  })
})
