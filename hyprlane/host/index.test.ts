// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  invalidateNextLoad: true,
  destroyedSurfaceIds: [] as number[],
  installedBackend: null as unknown,
  surfaceOptions: [] as unknown[],
  protocolErrorNext: false,
  authCleanupCount: 0,
  sessionCleanupCount: 0,
  backendCalls: [] as Array<{ service: string; method: string; args: unknown[] }>,
}))

vi.mock("electron", () => ({
  BaseWindow: {
    fromId: () => ({
      isDestroyed: () => false,
    }),
  },
  session: {
    fromPartition: () => ({}),
  },
}))

vi.mock("./policy", () => ({
  HOSTED_WEBVIEW_PARTITION: "persist:hyprlane-wave-web",
  hardenHostedSession: () => () => fixture.sessionCleanupCount++,
}))

vi.mock("./protocol", () => ({
  installHostedProtocol: (
    _session: unknown,
    _root: string,
    backend: unknown
  ) => {
    if (fixture.protocolErrorNext) {
      fixture.protocolErrorNext = false
      throw new Error("protocol install failed")
    }
    fixture.installedBackend = backend
    return () => undefined
  },
}))

vi.mock("./auth", () => ({
  installAuthKeyInjection: () => () => fixture.authCleanupCount++,
}))

vi.mock("./backend", () => ({
  normalizeWaveBackend: (backend: unknown) => backend,
  normalizeWaveLocalPaths: (paths: unknown) => paths,
  callWaveService: async (
    _backend: unknown,
    service: string,
    method: string,
    args: unknown[]
  ) => {
    fixture.backendCalls.push({ service, method, args })
    if (service === "workspace" && method === "CreateWorkspace") {
      return "workspace-2"
    }
    return undefined
  },
  getWaveWorkspaces: async () => [
    { workspaceId: "workspace-2", windowId: null },
  ],
  getWaveWorkspaceTabs: async () => ({
    workspaceId: "wave-workspace",
    activeTabId: "wave-tab",
    tabIds: ["wave-tab"],
  }),
  resolveWaveSurface: async (_backend: unknown, workspaceId: string) => ({
    workspaceId:
      workspaceId === "workspace-2" ? "workspace-2" : "wave-workspace",
    init: {
      tabId: workspaceId === "workspace-2" ? "wave-tab-2" : "wave-tab",
      clientId: "wave-client",
      windowId: "wave-window",
      activate: true,
    },
  }),
}))

vi.mock("./surface", () => ({
  HostedSurface: class {
    readonly id: number
    readonly onInvalidated: (id: number, reason: string) => void
    destroyed = false

    constructor(options: {
      id: number
      onInvalidated(id: number, reason: string): void
    }) {
      this.id = options.id
      this.onInvalidated = options.onInvalidated
      fixture.surfaceOptions.push(options)
    }

    async load() {
      if (!fixture.invalidateNextLoad) return
      fixture.invalidateNextLoad = false
      this.onInvalidated(this.id, "render-process-gone")
    }

    setState() {}

    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      fixture.destroyedSurfaceIds.push(this.id)
    }
  },
}))

import { createWaveCoreHost } from "./index"

describe("hosted surface publication", () => {
  beforeEach(() => {
    fixture.invalidateNextLoad = true
    fixture.destroyedSurfaceIds.length = 0
    fixture.installedBackend = null
    fixture.surfaceOptions.length = 0
    fixture.protocolErrorNext = false
    fixture.authCleanupCount = 0
    fixture.sessionCleanupCount = 0
    fixture.backendCalls.length = 0
  })

  it("never publishes a surface invalidated while load is settling", async () => {
    const host = createWaveCoreHost({ artifactRoot: "/artifact" })
    await host.start({ parentWindowId: 1 })

    await expect(
      host.createSurface({ workspaceId: "invalidated" })
    ).rejects.toThrow("invalidated during load")
    await expect(
      host.setSurfaceState(1, {
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        visible: false,
      })
    ).rejects.toThrow("hosted Wave surface not found")

    await expect(
      host.createSurface({ workspaceId: "replacement" })
    ).resolves.toBe(2)
    expect(fixture.destroyedSurfaceIds).toContain(1)
    await host.shutdown()
  })

  it("passes the resolved backend, local paths and Wave init to a surface", async () => {
    fixture.invalidateNextLoad = false
    const host = createWaveCoreHost({ artifactRoot: "/artifact" })
    const backend = {
      webUrl: "http://127.0.0.1:4123",
      wsUrl: "ws://127.0.0.1:4567",
      authKey: "a".repeat(64),
    }
    const paths = {
      dataDir: "/private/data",
      configDir: "/private/config",
      homeDir: "/Users/tester",
    }
    await host.start({ parentWindowId: 1, backend, paths })

    await expect(
      host.createSurface({ workspaceId: "requested-workspace" })
    ).resolves.toBe(1)

    expect(fixture.installedBackend).toBe(backend)
    expect(fixture.surfaceOptions[0]).toMatchObject({
      backend,
      paths,
      workspaceId: "wave-workspace",
      waveInit: {
        tabId: "wave-tab",
        clientId: "wave-client",
        windowId: "wave-window",
      },
    })
    await host.shutdown()
  })

  it("keeps the isolated renderer probe out of real Wave mode", async () => {
    fixture.invalidateNextLoad = false
    const host = createWaveCoreHost({ artifactRoot: "/artifact" })
    await host.start({ parentWindowId: 1 })

    await expect(
      host.createSurface({ workspaceId: "hyprlane-probe" })
    ).resolves.toBe(1)

    expect(fixture.surfaceOptions[0]).toMatchObject({
      backend: undefined,
      paths: undefined,
      workspaceId: "hyprlane-probe",
    })
    expect(fixture.surfaceOptions[0]).toHaveProperty("waveInit", undefined)
    await host.shutdown()
  })

  it("switches a newly created local workspace through the host service boundary", async () => {
    fixture.invalidateNextLoad = false
    const host = createWaveCoreHost({ artifactRoot: "/artifact" })
    const backend = {
      webUrl: "http://127.0.0.1:4123",
      wsUrl: "ws://127.0.0.1:4567",
      authKey: "a".repeat(64),
    }
    const paths = {
      dataDir: "/private/data",
      configDir: "/private/config",
      homeDir: "/Users/tester",
    }
    await host.start({ parentWindowId: 1, backend, paths })
    await host.createSurface({ workspaceId: "default" })

    const firstChild = fixture.surfaceOptions[0] as {
      onAction(action: unknown, args: unknown): Promise<boolean>
    }
    await expect(firstChild.onAction("create-workspace", [])).resolves.toBe(
      true
    )

    expect(fixture.backendCalls).toEqual([
      {
        service: "workspace",
        method: "CreateWorkspace",
        args: ["", "", "", true],
      },
      {
        service: "window",
        method: "SwitchWorkspace",
        args: ["wave-window", "workspace-2"],
      },
    ])
    expect(fixture.surfaceOptions).toHaveLength(2)
    expect(fixture.surfaceOptions[1]).toMatchObject({
      workspaceId: "workspace-2",
      waveInit: { tabId: "wave-tab-2" },
    })
    await host.shutdown()
  })

  it("rolls back a partial start and remains restartable", async () => {
    const host = createWaveCoreHost({ artifactRoot: "/artifact" })
    const options = {
      parentWindowId: 1,
      backend: {
        webUrl: "http://127.0.0.1:4123",
        wsUrl: "ws://127.0.0.1:4567",
        authKey: "a".repeat(64),
      },
      paths: {
        dataDir: "/private/data",
        configDir: "/private/config",
        homeDir: "/Users/tester",
      },
    }
    fixture.protocolErrorNext = true

    await expect(host.start(options)).rejects.toThrow("protocol install failed")
    expect(fixture.authCleanupCount).toBe(1)
    expect(fixture.sessionCleanupCount).toBe(2)
    await expect(host.start(options)).resolves.toBeUndefined()
    await host.shutdown()
  })
})
