// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest"
import {
  callWaveService,
  getWaveWorkspaces,
  getWaveWorkspaceTabs,
  normalizeWaveBackend,
  resolveWaveSurface,
} from "./backend"

const backend = normalizeWaveBackend({
  webUrl: "http://127.0.0.1:4123",
  wsUrl: "ws://127.0.0.1:4567",
  authKey: "a".repeat(64),
})

describe("Wave backend boundary", () => {
  it("accepts only port-exact loopback endpoints and a long startup key", () => {
    expect(backend.webOrigin).toBe("http://127.0.0.1:4123")
    expect(backend.wsOrigin).toBe("ws://127.0.0.1:4567")
    expect(() =>
      normalizeWaveBackend({
        webUrl: "http://localhost:4123",
        wsUrl: "ws://127.0.0.1:4567",
        authKey: "a".repeat(64),
      })
    ).toThrow("127.0.0.1")
    expect(() =>
      normalizeWaveBackend({
        webUrl: "http://127.0.0.1:4123",
        wsUrl: "ws://127.0.0.1:*",
        authKey: "short",
      })
    ).toThrow()
  })

  it("authenticates main-process service calls without returning the key", async () => {
    const captured: {
      input?: string | URL
      request?: RequestInit
    } = {}
    const fetchImpl = vi.fn(
      async (input: string | URL, request?: RequestInit) => {
        captured.input = input
        captured.request = request
        return new Response(JSON.stringify({ data: { oid: "client-1" } }), {
          headers: { "content-type": "application/json" },
        })
      }
    )

    await expect(
      callWaveService(backend, "client", "GetClientData", [], fetchImpl)
    ).resolves.toEqual({ oid: "client-1" })

    expect(String(captured.input)).toBe(
      "http://127.0.0.1:4123/wave/service?service=client&method=GetClientData"
    )
    expect(captured.request?.headers).toMatchObject({
      "content-type": "application/json",
      origin: "app://bundle",
      "x-authkey": "a".repeat(64),
    })
    expect(JSON.parse(String(captured.request?.body))).toEqual({
      service: "client",
      method: "GetClientData",
      args: [],
      uicontext: null,
    })
  })

  it("resolves the active Wave tab through client, window and workspace services", async () => {
    const replies = [
      { data: { oid: "client-1", windowids: ["window-1"] } },
      {
        data: {
          oid: "window-1",
          workspaceid: "workspace-1",
        },
      },
      {
        data: {
          oid: "workspace-1",
          activetabid: "tab-1",
          tabids: ["tab-1"],
        },
      },
    ]
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(replies.shift()))
    )

    await expect(
      resolveWaveSurface(backend, "workspace-1", fetchImpl)
    ).resolves.toEqual({
      workspaceId: "workspace-1",
      init: {
        tabId: "tab-1",
        clientId: "client-1",
        windowId: "window-1",
        activate: true,
        primaryTabStartup: true,
      },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it("fails closed when native bootstrap has not created a window", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { oid: "client-1", windowids: [] } })
        )
    )

    await expect(
      resolveWaveSurface(backend, "default", fetchImpl)
    ).rejects.toThrow("Wave has no window to host")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("returns only a complete workspace-owned tab set", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              oid: "workspace-1",
              activetabid: "tab-2",
              tabids: ["tab-1", "tab-2"],
            },
          })
        )
    )
    await expect(
      getWaveWorkspaceTabs(backend, "workspace-1", fetchImpl)
    ).resolves.toEqual({
      workspaceId: "workspace-1",
      activeTabId: "tab-2",
      tabIds: ["tab-1", "tab-2"],
    })
  })

  it("returns only validated local workspace identities", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { workspaceid: "workspace-1", windowid: "window-1" },
              { workspaceid: "workspace-2", windowid: "" },
            ],
          })
        )
    )

    await expect(getWaveWorkspaces(backend, fetchImpl)).resolves.toEqual([
      { workspaceId: "workspace-1", windowId: "window-1" },
      { workspaceId: "workspace-2", windowId: null },
    ])
  })

  it("fails closed when the workspace has no valid active tab", async () => {
    const replies = [
      { data: { oid: "client-1", windowids: ["window-1"] } },
      { data: { oid: "window-1", workspaceid: "workspace-1" } },
      {
        data: {
          oid: "workspace-1",
          activetabid: "missing-tab",
          tabids: ["tab-1"],
        },
      },
    ]
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(replies.shift()))
    )

    await expect(
      resolveWaveSurface(backend, "default", fetchImpl)
    ).rejects.toThrow("active tab is not present")
  })
})
