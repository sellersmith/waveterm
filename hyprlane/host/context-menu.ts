// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { Menu, type MenuItemConstructorOptions, type WebContents } from "electron"
import { CONTEXT_MENU_CLICK_CHANNEL } from "../shared/ipc"

const MAX_CONTEXT_MENU_DEPTH = 6
const MAX_CONTEXT_MENU_ITEMS = 512
const MAX_CONTEXT_MENU_TEXT_LENGTH = 512

const MENU_TYPES = new Set([
  "separator",
  "normal",
  "submenu",
  "checkbox",
  "radio",
  "header",
])
const MENU_ROLES = new Set(["copy", "cut", "paste"])

export type HostedContextMenuItem = {
  id: string
  label?: string
  role?: "copy" | "cut" | "paste"
  type?: "separator" | "normal" | "submenu" | "checkbox" | "radio" | "header"
  submenu?: HostedContextMenuItem[]
  checked?: boolean
  visible?: boolean
  enabled?: boolean
  sublabel?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMenuId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  )
}

function parseText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > MAX_CONTEXT_MENU_TEXT_LENGTH) {
    return null
  }
  return value
}

function parseMenuItems(
  value: unknown,
  depth: number,
  seenIds: Set<string>,
  itemCount: { value: number }
): HostedContextMenuItem[] | null {
  if (!Array.isArray(value) || depth > MAX_CONTEXT_MENU_DEPTH) return null
  const items: HostedContextMenuItem[] = []
  for (const rawItem of value) {
    if (!isRecord(rawItem) || ++itemCount.value > MAX_CONTEXT_MENU_ITEMS) {
      return null
    }
    if (!isMenuId(rawItem.id) || seenIds.has(rawItem.id)) return null
    seenIds.add(rawItem.id)

    const label = parseText(rawItem.label)
    const sublabel = parseText(rawItem.sublabel)
    if (label === null || sublabel === null) return null
    const type = rawItem.type
    if (type !== undefined && (typeof type !== "string" || !MENU_TYPES.has(type))) {
      return null
    }
    const role = rawItem.role
    if (role !== undefined && (typeof role !== "string" || !MENU_ROLES.has(role))) {
      return null
    }
    if (
      (rawItem.checked !== undefined && typeof rawItem.checked !== "boolean") ||
      (rawItem.visible !== undefined && typeof rawItem.visible !== "boolean") ||
      (rawItem.enabled !== undefined && typeof rawItem.enabled !== "boolean")
    ) {
      return null
    }
    let submenu: HostedContextMenuItem[] | undefined
    if (rawItem.submenu !== undefined) {
      const parsedSubmenu = parseMenuItems(
        rawItem.submenu,
        depth + 1,
        seenIds,
        itemCount
      )
      if (parsedSubmenu === null) return null
      submenu = parsedSubmenu
    }
    if (type === "submenu" && !submenu) return null
    // Wave's own menu serializer leaves `type` undefined for several valid
    // terminal submenus (Themes, Font Size, Cursor, etc.). Electron accepts
    // that shape, so accept it here too. A non-submenu type with children is
    // still invalid at this untrusted renderer boundary.
    if (submenu !== undefined && type !== undefined && type !== "submenu") {
      return null
    }
    if (type !== "separator" && label === undefined && role === undefined) {
      return null
    }
    items.push({
      id: rawItem.id,
      ...(label === undefined ? {} : { label }),
      ...(role === undefined ? {} : { role: role as HostedContextMenuItem["role"] }),
      ...(type === undefined ? {} : { type: type as HostedContextMenuItem["type"] }),
      ...(submenu === undefined ? {} : { submenu }),
      ...(rawItem.checked === undefined ? {} : { checked: rawItem.checked }),
      ...(rawItem.visible === undefined ? {} : { visible: rawItem.visible }),
      ...(rawItem.enabled === undefined ? {} : { enabled: rawItem.enabled }),
      ...(sublabel === undefined ? {} : { sublabel }),
    })
  }
  return items
}

/**
 * Context-menu definitions originate in a sandboxed renderer. Keep this
 * narrow: the renderer may describe presentation and its own callback id,
 * but it cannot request arbitrary Electron roles or a main-process action.
 */
export function parseHostedContextMenu(
  value: unknown
): HostedContextMenuItem[] | null {
  return parseMenuItems(value, 0, new Set(), { value: 0 })
}

function toTemplate(
  items: readonly HostedContextMenuItem[],
  onClick: (id: string) => void
): MenuItemConstructorOptions[] {
  return items.map((item) => ({
    ...(item.label === undefined ? {} : { label: item.label }),
    ...(item.role === undefined ? {} : { role: item.role }),
    ...(item.type === undefined ? {} : { type: item.type }),
    ...(item.submenu === undefined
      ? {}
      : { submenu: toTemplate(item.submenu, onClick) }),
    ...(item.checked === undefined ? {} : { checked: item.checked }),
    ...(item.visible === undefined ? {} : { visible: item.visible }),
    ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
    ...(item.sublabel === undefined ? {} : { sublabel: item.sublabel }),
    click: () => onClick(item.id),
  }))
}

export function showHostedContextMenu(
  contents: WebContents,
  rawMenu: unknown
): boolean {
  const menuItems = parseHostedContextMenu(rawMenu)
  if (!menuItems || contents.isDestroyed()) return false

  let selected = false
  const notify = (id: string | null) => {
    if (!contents.isDestroyed()) contents.send(CONTEXT_MENU_CLICK_CHANNEL, id)
  }
  const menu = Menu.buildFromTemplate(
    toTemplate(menuItems, (id) => {
      selected = true
      notify(id)
    })
  )
  menu.popup({
    callback: () => {
      if (!selected) notify(null)
    },
  })
  return true
}
