// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { HostedWorkspaceSurface } from "./workspace-surface"

const initialState = {
  bounds: { x: 0, y: 0, width: 1_000, height: 700 },
  visible: true,
  focus: true,
}

describe("hosted Wave workspace surface", () => {
  it("warms the target tab before hiding the current renderer and reuses it", async () => {
    const events: string[] = []
    const surfaces = new Map<
      string,
      {
        load(): Promise<void>
        setState(state: { visible: boolean }): void
        destroy(): void
      }
    >()
    const workspace = new HostedWorkspaceSurface({
      id: 7,
      workspaceId: "workspace-1",
      initialInit: {
        tabId: "tab-1",
        clientId: "client-1",
        windowId: "window-1",
        activate: true,
      },
      createChild: (init) => {
        const child = {
          async load() {
            events.push(`load:${init.tabId}`)
          },
          setState(state: { visible: boolean }) {
            events.push(`visible:${init.tabId}:${state.visible}`)
          },
          destroy() {
            events.push(`destroy:${init.tabId}`)
          },
        }
        surfaces.set(init.tabId, child)
        return child
      },
      onAction: async () => null,
      onInvalidated: () => undefined,
    })

    await workspace.load()
    workspace.setState(initialState)
    events.length = 0

    await workspace.activate({
      tabId: "tab-2",
      clientId: "client-1",
      windowId: "window-1",
      activate: true,
    })
    expect(events).toEqual([
      "load:tab-2",
      "visible:tab-1:false",
      "visible:tab-2:true",
    ])

    events.length = 0
    await workspace.activate({
      tabId: "tab-1",
      clientId: "client-1",
      windowId: "window-1",
      activate: true,
    })
    expect(events).toEqual(["visible:tab-2:false", "visible:tab-1:true"])
    expect(surfaces.size).toBe(2)
  })

  it("drops the old renderer cache only when a local workspace switch completes", async () => {
    const events: string[] = []
    const workspace = new HostedWorkspaceSurface({
      id: 7,
      workspaceId: "workspace-1",
      initialInit: {
        tabId: "tab-1",
        clientId: "client-1",
        windowId: "window-1",
        activate: true,
      },
      createChild: (init) => ({
        async load() {
          events.push(`load:${init.tabId}`)
        },
        setState(state: { visible: boolean }) {
          events.push(`visible:${init.tabId}:${state.visible}`)
        },
        destroy() {
          events.push(`destroy:${init.tabId}`)
        },
      }),
      onAction: async () => null,
      onInvalidated: () => undefined,
    })

    await workspace.load()
    workspace.setState(initialState)
    events.length = 0

    await workspace.activate(
      {
        tabId: "tab-2",
        clientId: "client-1",
        windowId: "window-1",
        activate: true,
      },
      undefined,
      "workspace-2"
    )

    expect(workspace.workspaceId).toBe("workspace-2")
    expect(events).toEqual([
      "visible:tab-1:false",
      "destroy:tab-1",
      "load:tab-2",
      "visible:tab-2:true",
    ])
  })
})
