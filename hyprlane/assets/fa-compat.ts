// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

const PHOSPHOR_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "angle-down": "caret-down",
  "arrow-up-right-from-square": "arrow-square-out",
  bars: "list",
  box: "package",
  "chevron-down": "caret-down",
  "chevron-right": "caret-right",
  "chevron-up": "caret-up",
  "circle-exclamation": "warning-circle",
  "circle-xmark": "x-circle",
  "clock-rotate-left": "clock-counter-clockwise",
  cog: "gear",
  "computer-mouse": "mouse",
  dev: "code",
  discord: "discord-logo",
  ellipsis: "dots-three",
  "ellipsis-vertical": "dots-three-vertical",
  "external-link": "arrow-square-out",
  "face-smile": "smiley",
  "file-import": "file-arrow-down",
  "file-pen": "note-pencil",
  github: "github-logo",
  "info-circle": "info",
  "link-slash": "link-break",
  "list-tree": "tree-structure",
  "network-wired": "network",
  "pen-to-square": "note-pencil",
  "people-group": "users-three",
  refresh: "arrow-clockwise",
  rotate: "arrow-clockwise",
  "rotate-left": "arrow-counter-clockwise",
  "rotate-right": "arrow-clockwise",
  slash: "prohibit",
  "sort-down": "caret-down",
  "sort-up": "caret-up",
  sparkles: "sparkle",
  "square-terminal": "terminal",
  "table-columns": "columns",
  times: "x",
  "triangle-exclamation": "warning",
  wifi: "wifi-high",
  windows: "windows-logo",
  "wave-logo-solid": "squares-four",
  xmark: "x",
  "xmark-large": "x",
})

const STYLE_CLASSES = new Set([
  "fa-brands",
  "fa-fw",
  "fa-kit",
  "fa-light",
  "fa-regular",
  "fa-sharp",
  "fa-solid",
  "fa-spin",
  "fa-stack",
  "fa-stack-1x",
])

export function resolvePhosphorClass(faClass: string): string {
  if (!/^fa-[a-z0-9-]+$/.test(faClass) || STYLE_CLASSES.has(faClass)) {
    throw new Error(`not an icon class: ${faClass}`)
  }
  const sourceName = faClass.slice(3)
  const glyphName = PHOSPHOR_ALIASES[sourceName] ?? sourceName
  return `ph ph-${glyphName}`
}

function iconClassFor(element: Element): string | null {
  for (const className of element.classList) {
    if (/^fa-[a-z0-9-]+$/.test(className) && !STYLE_CLASSES.has(className)) {
      return className
    }
  }
  return null
}

export function needsPhosphorClassRepair(
  classNames: Iterable<string>,
  previous: string | null | undefined,
  next: string | null
): boolean {
  if ((previous ?? null) !== next) return true
  if (!next) return false
  const current = new Set(classNames)
  return !current.has("ph") || !current.has(next)
}

export function installFaCompatibility(
  documentRoot: Document = document
): () => void {
  const generatedClass = new WeakMap<Element, string>()

  const apply = (element: Element) => {
    const previous = generatedClass.get(element) ?? null
    const iconClass = iconClassFor(element)
    const next = iconClass
      ? resolvePhosphorClass(iconClass).split(" ")[1]
      : null
    if (!needsPhosphorClassRepair(element.classList, previous, next)) return
    if (previous) element.classList.remove(previous)
    if (next) {
      element.classList.add("ph", next)
      generatedClass.set(element, next)
    } else {
      element.classList.remove("ph")
      generatedClass.delete(element)
    }
  }

  const scan = (node: Node) => {
    if (!(node instanceof Element)) return
    apply(node)
    for (const child of node.querySelectorAll("[class*='fa-']")) apply(child)
  }

  scan(documentRoot.documentElement)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") apply(record.target as Element)
      for (const node of record.addedNodes) scan(node)
    }
  })
  observer.observe(documentRoot.documentElement, {
    attributeFilter: ["class"],
    attributes: true,
    childList: true,
    subtree: true,
  })
  return () => observer.disconnect()
}
