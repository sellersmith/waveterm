// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest"
import { MAX_SAVED_SCROLLBACK_BYTES, saveHostedTextFile } from "./save-file"

describe("hosted scrollback save", () => {
  it("writes only to a path selected by the native save dialog", async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePath: "/Users/tester/Desktop/session.log",
    })
    const writeFile = vi.fn().mockResolvedValue(undefined)

    await expect(
      saveHostedTextFile({} as never, "session.log", "scrollback", {
        showSaveDialog,
        writeFile,
      })
    ).resolves.toBe(true)
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "Save Scrollback",
        defaultPath: "session.log",
      })
    )
    expect(writeFile).toHaveBeenCalledWith(
      "/Users/tester/Desktop/session.log",
      "scrollback",
      "utf8"
    )
  })

  it("rejects unsafe names and oversized content before opening a dialog", async () => {
    const showSaveDialog = vi.fn()
    const writeFile = vi.fn()
    const services = { showSaveDialog, writeFile }

    await expect(
      saveHostedTextFile({} as never, "../outside.log", "scrollback", services)
    ).resolves.toBe(false)
    await expect(
      saveHostedTextFile(
        {} as never,
        "session.log",
        "x".repeat(MAX_SAVED_SCROLLBACK_BYTES + 1),
        services
      )
    ).resolves.toBe(false)
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })
})
