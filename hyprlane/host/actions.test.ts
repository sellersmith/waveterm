// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { parseHostedWaveAction } from "./actions"

describe("hosted Wave action boundary", () => {
  const workspaceId = "workspace-1"

  it("allows only canonical native tab and local-workspace actions", () => {
    expect(parseHostedWaveAction("create-tab", [], workspaceId)).toEqual({
      kind: "create-tab",
    })
    expect(
      parseHostedWaveAction("set-active-tab", ["tab-1"], workspaceId)
    ).toEqual({ kind: "set-active-tab", tabId: "tab-1" })
    expect(
      parseHostedWaveAction(
        "close-tab",
        [workspaceId, "tab-1", true],
        workspaceId
      )
    ).toEqual({ kind: "close-tab", tabId: "tab-1", confirmClose: true })
    expect(parseHostedWaveAction("create-workspace", [], workspaceId)).toEqual(
      { kind: "create-workspace" }
    )
    expect(
      parseHostedWaveAction("switch-workspace", ["workspace-2"], workspaceId)
    ).toEqual({ kind: "switch-workspace", workspaceId: "workspace-2" })
    expect(
      parseHostedWaveAction("delete-workspace", ["workspace-2"], workspaceId)
    ).toEqual({ kind: "delete-workspace", workspaceId: "workspace-2" })
  })

  it("rejects arbitrary service calls and cross-workspace tab actions", () => {
    expect(
      parseHostedWaveAction("workspace.CreateTab", [], workspaceId)
    ).toBeNull()
    expect(
      parseHostedWaveAction("create-tab", ["unexpected"], workspaceId)
    ).toBeNull()
    expect(
      parseHostedWaveAction("set-active-tab", ["../other-tab"], workspaceId)
    ).toBeNull()
    expect(
      parseHostedWaveAction(
        "close-tab",
        ["workspace-2", "tab-1", false],
        workspaceId
      )
    ).toBeNull()
    expect(
      parseHostedWaveAction("switch-workspace", ["../other"], workspaceId)
    ).toBeNull()
    expect(
      parseHostedWaveAction("delete-workspace", [workspaceId, "extra"], workspaceId)
    ).toBeNull()
  })
})
