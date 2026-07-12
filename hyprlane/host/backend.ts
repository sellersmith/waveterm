// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, resolve } from "node:path"
import type { HostedWaveInit } from "../shared/ipc"

export const SURFACE_ORIGIN = "app://bundle"

export type WaveBackendOptions = {
  webUrl: string
  wsUrl: string
  authKey: string
}

export type WaveLocalPaths = {
  dataDir: string
  configDir: string
  homeDir: string
}

export type NormalizedWaveBackend = Readonly<{
  webOrigin: string
  wsOrigin: string
  webEndpoint: string
  wsEndpoint: string
  authKey: string
}>

export type NormalizedWaveLocalPaths = Readonly<WaveLocalPaths>

export type ResolvedWaveSurface = {
  workspaceId: string
  init: HostedWaveInit
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

type WaveServiceReturn<T> = {
  data?: T
  error?: string
}

type WaveClient = {
  oid?: unknown
  windowids?: unknown
}

type WaveWindow = {
  oid?: unknown
  workspaceid?: unknown
}

type WaveWorkspace = {
  oid?: unknown
  activetabid?: unknown
  tabids?: unknown
}

type WaveWorkspaceListServiceEntry = {
  workspaceid?: unknown
  windowid?: unknown
}

export type WaveWorkspaceTabs = Readonly<{
  workspaceId: string
  activeTabId: string
  tabIds: readonly string[]
}>

export type WaveWorkspaceListEntry = Readonly<{
  workspaceId: string
  windowId: string | null
}>

function normalizeEndpoint(raw: string, protocol: "http:" | "ws:"): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`invalid Wave ${protocol.slice(0, -1)} endpoint`)
  }
  if (url.protocol !== protocol) {
    throw new Error(`Wave endpoint must use ${protocol}`)
  }
  if (url.hostname !== "127.0.0.1") {
    throw new Error("Wave endpoint must bind to 127.0.0.1")
  }
  const port = Number(url.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Wave endpoint must include an exact port")
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Wave endpoint must be an origin without credentials")
  }
  return url
}

export function normalizeWaveBackend(
  options: WaveBackendOptions
): NormalizedWaveBackend {
  const web = normalizeEndpoint(options.webUrl, "http:")
  const ws = normalizeEndpoint(options.wsUrl, "ws:")
  if (!/^[\x21-\x7e]{32,512}$/.test(options.authKey)) {
    throw new Error("Wave startup auth key must contain at least 32 bytes")
  }
  return Object.freeze({
    webOrigin: web.origin,
    wsOrigin: ws.origin,
    webEndpoint: web.host,
    wsEndpoint: ws.host,
    authKey: options.authKey,
  })
}

export function normalizeWaveLocalPaths(
  paths: WaveLocalPaths
): NormalizedWaveLocalPaths {
  const normalized = Object.fromEntries(
    Object.entries(paths).map(([key, value]) => {
      if (typeof value !== "string" || !isAbsolute(value)) {
        throw new Error(`Wave ${key} must be an absolute path`)
      }
      return [key, resolve(value)]
    })
  ) as WaveLocalPaths
  return Object.freeze(normalized)
}

function assertServiceName(value: string, label: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(value)) {
    throw new Error(`invalid Wave ${label}`)
  }
}

export async function callWaveService<T>(
  backend: NormalizedWaveBackend,
  service: string,
  method: string,
  args: unknown[],
  fetchImpl: FetchLike = fetch
): Promise<T> {
  assertServiceName(service, "service")
  assertServiceName(method, "method")
  const url = new URL("/wave/service", backend.webOrigin)
  url.searchParams.set("service", service)
  url.searchParams.set("method", method)
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: SURFACE_ORIGIN,
      "x-authkey": backend.authKey,
    },
    body: JSON.stringify({ service, method, args, uicontext: null }),
  })
  if (!response.ok) {
    throw new Error(
      `Wave ${service}.${method} failed with HTTP ${response.status}`
    )
  }
  const result = (await response.json()) as WaveServiceReturn<T>
  if (typeof result.error === "string" && result.error) {
    throw new Error(`Wave ${service}.${method} failed: ${result.error}`)
  }
  return result.data as T
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Wave ${label} is missing`)
  }
  return value
}

export async function getWaveWorkspaceTabs(
  backend: NormalizedWaveBackend,
  workspaceId: string,
  fetchImpl: FetchLike = fetch
): Promise<WaveWorkspaceTabs> {
  const expectedWorkspaceId = requiredString(workspaceId, "workspace id")
  const workspace = await callWaveService<WaveWorkspace>(
    backend,
    "workspace",
    "GetWorkspace",
    [expectedWorkspaceId],
    fetchImpl
  )
  if (requiredString(workspace?.oid, "workspace id") !== expectedWorkspaceId) {
    throw new Error("Wave returned a workspace for the wrong id")
  }
  const activeTabId = requiredString(workspace?.activetabid, "active tab id")
  if (!Array.isArray(workspace?.tabids)) {
    throw new Error("Wave workspace has no tab list")
  }
  const tabIds = workspace.tabids.map((value) => requiredString(value, "tab id"))
  if (!tabIds.includes(activeTabId)) {
    throw new Error("Wave active tab is not present in its workspace")
  }
  return Object.freeze({
    workspaceId: expectedWorkspaceId,
    activeTabId,
    tabIds: Object.freeze(tabIds),
  })
}

/**
 * Workspace switching is available only for local workspaces returned by the
 * Wave backend. Validate every identity before it can reach the hosted action
 * boundary; a renderer-provided object id is never enough on its own.
 */
export async function getWaveWorkspaces(
  backend: NormalizedWaveBackend,
  fetchImpl: FetchLike = fetch
): Promise<readonly WaveWorkspaceListEntry[]> {
  const entries = await callWaveService<unknown>(
    backend,
    "workspace",
    "ListWorkspaces",
    [],
    fetchImpl
  )
  if (!Array.isArray(entries)) {
    throw new Error("Wave workspace list is invalid")
  }
  const seen = new Set<string>()
  const workspaces = entries.map((value) => {
    const entry = value as WaveWorkspaceListServiceEntry
    const workspaceId = requiredString(entry?.workspaceid, "workspace id")
    if (seen.has(workspaceId)) {
      throw new Error("Wave workspace list contains a duplicate id")
    }
    seen.add(workspaceId)
    const rawWindowId = entry?.windowid
    if (rawWindowId !== "" && rawWindowId !== undefined) {
      return Object.freeze({
        workspaceId,
        windowId: requiredString(rawWindowId, "workspace window id"),
      })
    }
    return Object.freeze({ workspaceId, windowId: null })
  })
  return Object.freeze(workspaces)
}

export async function resolveWaveSurface(
  backend: NormalizedWaveBackend,
  requestedWorkspaceId: string,
  fetchImpl: FetchLike = fetch
): Promise<ResolvedWaveSurface> {
  const requested = requiredString(requestedWorkspaceId, "workspace id")
  const client = await callWaveService<WaveClient>(
    backend,
    "client",
    "GetClientData",
    [],
    fetchImpl
  )
  const clientId = requiredString(client?.oid, "client id")
  if (!Array.isArray(client?.windowids) || client.windowids.length === 0) {
    throw new Error("Wave has no window to host")
  }

  let selectedWindow: WaveWindow | null = null
  for (const value of client.windowids) {
    const windowId = requiredString(value, "window id")
    const candidate = await callWaveService<WaveWindow>(
      backend,
      "window",
      "GetWindow",
      [windowId],
      fetchImpl
    )
    const candidateWorkspaceId = requiredString(
      candidate?.workspaceid,
      "window workspace id"
    )
    if (requested === "default" || candidateWorkspaceId === requested) {
      selectedWindow = candidate
      break
    }
  }
  if (!selectedWindow) {
    throw new Error(`Wave workspace is not attached to a window: ${requested}`)
  }

  const windowId = requiredString(selectedWindow.oid, "window id")
  const workspaceId = requiredString(
    selectedWindow.workspaceid,
    "window workspace id"
  )
  const workspace = await getWaveWorkspaceTabs(backend, workspaceId, fetchImpl)

  return {
    workspaceId,
    init: {
      tabId: workspace.activeTabId,
      clientId,
      windowId,
      activate: true,
      primaryTabStartup: true,
    },
  }
}
