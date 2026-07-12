// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { writeFile as writeFileToDisk } from "node:fs/promises"
import { basename } from "node:path"
import { dialog, type BaseWindow } from "electron"

export const MAX_SAVED_SCROLLBACK_BYTES = 16 * 1024 * 1024

type SaveDialogOptions = {
  title: string
  defaultPath: string
  filters: Array<{ name: string; extensions: string[] }>
}

type SaveFileServices = {
  showSaveDialog(
    parent: BaseWindow,
    options: SaveDialogOptions
  ): Promise<{ canceled: boolean; filePath?: string }>
  writeFile(
    filePath: string,
    content: string,
    encoding: "utf8"
  ): Promise<void>
}

const defaultServices: SaveFileServices = {
  showSaveDialog: (parent, options) => dialog.showSaveDialog(parent, options),
  writeFile: (filePath, content, encoding) =>
    writeFileToDisk(filePath, content, encoding),
}

function parseSaveRequest(
  fileName: unknown,
  content: unknown
): { fileName: string; content: string } | null {
  if (
    typeof fileName !== "string" ||
    fileName !== basename(fileName) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:log|txt)$/i.test(fileName) ||
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") > MAX_SAVED_SCROLLBACK_BYTES
  ) {
    return null
  }
  return { fileName, content }
}

/**
 * The renderer supplies only a safe default name and bounded text. The OS
 * save dialog owns the destination, so the sandboxed Wave renderer never
 * receives arbitrary filesystem write access or a chosen path.
 */
export async function saveHostedTextFile(
  parent: BaseWindow,
  fileName: unknown,
  content: unknown,
  services: SaveFileServices = defaultServices
): Promise<boolean> {
  const request = parseSaveRequest(fileName, content)
  if (!request) return false

  const result = await services.showSaveDialog(parent, {
    title: "Save Scrollback",
    defaultPath: request.fileName,
    filters: [{ name: "Text Files", extensions: ["txt", "log"] }],
  })
  if (result.canceled || !result.filePath) return false

  await services.writeFile(result.filePath, request.content, "utf8")
  return true
}
