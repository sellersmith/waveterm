// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

export type HostedWaveAction =
  | { kind: "create-tab" }
  | { kind: "set-active-tab"; tabId: string }
  | { kind: "close-tab"; tabId: string; confirmClose: boolean }
  | { kind: "create-workspace" }
  | { kind: "switch-workspace"; workspaceId: string }
  | { kind: "delete-workspace"; workspaceId: string }

function isWaveObjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  )
}

/**
 * The sandboxed renderer may ask the host to perform only the small set of
 * native tab actions that upstream Wave normally routes through Electron.
 * All workspace ownership checks remain in the host before a service call.
 */
export function parseHostedWaveAction(
  action: unknown,
  args: unknown,
  workspaceId: string
): HostedWaveAction | null {
  if (!Array.isArray(args)) return null
  if (action === "create-tab" && args.length === 0) {
    return { kind: "create-tab" }
  }
  if (action === "create-workspace" && args.length === 0) {
    return { kind: "create-workspace" }
  }
  if (
    action === "switch-workspace" &&
    args.length === 1 &&
    isWaveObjectId(args[0])
  ) {
    return { kind: "switch-workspace", workspaceId: args[0] }
  }
  if (
    action === "delete-workspace" &&
    args.length === 1 &&
    isWaveObjectId(args[0])
  ) {
    return { kind: "delete-workspace", workspaceId: args[0] }
  }
  if (
    action === "set-active-tab" &&
    args.length === 1 &&
    isWaveObjectId(args[0])
  ) {
    return { kind: "set-active-tab", tabId: args[0] }
  }
  if (
    action === "close-tab" &&
    args.length === 3 &&
    args[0] === workspaceId &&
    isWaveObjectId(args[1]) &&
    typeof args[2] === "boolean"
  ) {
    return { kind: "close-tab", tabId: args[1], confirmClose: args[2] }
  }
  return null
}
