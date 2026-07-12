// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import { BaseWindow, dialog, session, type Session } from "electron"
import { installAuthKeyInjection } from "./auth"
import {
  callWaveService,
  getWaveWorkspaces,
  getWaveWorkspaceTabs,
  normalizeWaveBackend,
  normalizeWaveLocalPaths,
  resolveWaveSurface,
  type NormalizedWaveBackend,
  type NormalizedWaveLocalPaths,
  type WaveBackendOptions,
  type WaveLocalPaths,
} from "./backend"
import { parseHostedWaveAction } from "./actions"
import { HOSTED_WEBVIEW_PARTITION, hardenHostedSession } from "./policy"
import { installHostedProtocol } from "./protocol"
import { HostedSurface, type HostedSurfaceState } from "./surface"
import {
  HostedWorkspaceSurface,
  type WorkspaceActionOutcome,
} from "./workspace-surface"

const PARTITION = "persist:hyprlane-wave"
const MAX_SURFACES = 16

export function createWaveCoreHost(options: { artifactRoot: string }) {
  let parent: BaseWindow | null = null
  let partitionSession: Session | null = null
  let backend: NormalizedWaveBackend | null = null
  let paths: NormalizedWaveLocalPaths | null = null
  let cleanupAuth: (() => void) | null = null
  let cleanupProtocol: (() => void) | null = null
  let cleanupSessionPolicy: (() => void) | null = null
  let cleanupWebviewSessionPolicy: (() => void) | null = null
  let nextSurfaceId = 1
  const surfaces = new Map<number, HostedWorkspaceSurface>()

  return {
    async start(startOptions: {
      parentWindowId: number
      backend?: WaveBackendOptions
      paths?: WaveLocalPaths
    }) {
      if (process.platform !== "darwin") {
        throw new Error("hosted Wave surface is macOS-only")
      }
      if (parent) throw new Error("hosted Wave host already started")
      const candidate = BaseWindow.fromId(startOptions.parentWindowId)
      if (!candidate || candidate.isDestroyed()) {
        throw new Error("parent BaseWindow not found")
      }
      if (Boolean(startOptions.backend) !== Boolean(startOptions.paths)) {
        throw new Error(
          "Wave backend and local paths must be provided together"
        )
      }
      const nextBackend = startOptions.backend
        ? normalizeWaveBackend(startOptions.backend)
        : null
      const nextPaths = startOptions.paths
        ? normalizeWaveLocalPaths(startOptions.paths)
        : null
      const nextSession = session.fromPartition(PARTITION)
      const nextSessionPolicyCleanup = hardenHostedSession(nextSession)
      const nextWebviewSession = session.fromPartition(HOSTED_WEBVIEW_PARTITION)
      const nextWebviewSessionPolicyCleanup =
        hardenHostedSession(nextWebviewSession)
      let nextAuthCleanup: (() => void) | null = null
      let nextProtocolCleanup: (() => void) | null = null
      try {
        nextAuthCleanup = nextBackend
          ? installAuthKeyInjection(nextSession, nextBackend)
          : null
        nextProtocolCleanup = installHostedProtocol(
          nextSession,
          options.artifactRoot,
          nextBackend ?? undefined
        )
      } catch (error) {
        nextProtocolCleanup?.()
        nextAuthCleanup?.()
        nextSessionPolicyCleanup()
        nextWebviewSessionPolicyCleanup()
        throw error
      }
      parent = candidate
      partitionSession = nextSession
      cleanupSessionPolicy = nextSessionPolicyCleanup
      cleanupWebviewSessionPolicy = nextWebviewSessionPolicyCleanup
      cleanupAuth = nextAuthCleanup
      cleanupProtocol = nextProtocolCleanup
      backend = nextBackend
      paths = nextPaths
    },

    async createSurface(surfaceOptions: { workspaceId: string }) {
      if (!parent || !partitionSession) {
        throw new Error("hosted Wave host is not started")
      }
      if (surfaces.size >= MAX_SURFACES) {
        throw new Error("hosted Wave surface limit reached")
      }
      const resolved = backend
        ? await resolveWaveSurface(backend, surfaceOptions.workspaceId)
        : null
      const id = nextSurfaceId++
      let surface: HostedWorkspaceSurface
      const runAction = async (
        rawAction: unknown,
        rawArgs: unknown
      ): Promise<WorkspaceActionOutcome | null> => {
        if (!backend) return null
        const action = parseHostedWaveAction(
          rawAction,
          rawArgs,
          surface.workspaceId
        )
        if (!action) return null
        if (
          action.kind === "set-active-tab" ||
          action.kind === "close-tab"
        ) {
          const workspace = await getWaveWorkspaceTabs(
            backend,
            surface.workspaceId
          )
          if (!workspace.tabIds.includes(action.tabId)) return null
          if (action.kind === "close-tab" && workspace.tabIds.length < 2) {
            return null
          }
        }
        if (action.kind === "create-tab") {
          const tabId = await callWaveService<string>(
            backend,
            "workspace",
            "CreateTab",
            [surface.workspaceId, "", true]
          )
          if (typeof tabId !== "string" || !tabId) return null
          // Upstream's native window owner activates a newly-created tab
          // before attaching its WebContents. The explicit service call keeps
          // that controller lifecycle when Hyprlane reuses one hosted view.
          await callWaveService(backend, "workspace", "SetActiveTab", [
            surface.workspaceId,
            tabId,
          ])
        } else if (action.kind === "set-active-tab") {
          await callWaveService(backend, "workspace", "SetActiveTab", [
            surface.workspaceId,
            action.tabId,
          ])
        } else if (action.kind === "close-tab") {
          await callWaveService(backend, "workspace", "CloseTab", [
            surface.workspaceId,
            action.tabId,
            true,
          ])
        } else {
          const workspaceList = await getWaveWorkspaces(backend)
          const current = await resolveWaveSurface(
            backend,
            surface.workspaceId
          )
          let nextWorkspaceId: string | null = null

          if (action.kind === "create-workspace") {
            const createdWorkspaceId = await callWaveService<unknown>(
              backend,
              "workspace",
              "CreateWorkspace",
              ["", "", "", true]
            )
            if (
              typeof createdWorkspaceId !== "string" ||
              !createdWorkspaceId
            ) {
              return null
            }
            nextWorkspaceId = createdWorkspaceId
          } else {
            if (
              !workspaceList.some(
                (workspace) => workspace.workspaceId === action.workspaceId
              )
            ) {
              return null
            }
            if (action.kind === "delete-workspace") {
              // Never let a destructive workspace action strand the single
              // hosted window. The native Wave UI only presents saved local
              // workspaces here, so a replacement is guaranteed before delete.
              if (
                action.workspaceId === surface.workspaceId &&
                workspaceList.length < 2
              ) {
                return null
              }
              const result = await dialog.showMessageBox(parent!, {
                type: "warning",
                defaultId: 0,
                cancelId: 1,
                buttons: ["Delete Workspace", "Cancel"],
                title: "Delete workspace?",
                message: "Deleting this workspace also deletes its contents.",
              })
              if (result.response !== 0) return null
              const fallbackWorkspaceId = await callWaveService<unknown>(
                backend,
                "workspace",
                "DeleteWorkspace",
                [action.workspaceId]
              )
              if (action.workspaceId !== surface.workspaceId) {
                return { init: current.init }
              }
              if (
                typeof fallbackWorkspaceId !== "string" ||
                !fallbackWorkspaceId
              ) {
                return null
              }
              nextWorkspaceId = fallbackWorkspaceId
            } else {
              nextWorkspaceId = action.workspaceId
            }
          }

          if (nextWorkspaceId !== surface.workspaceId) {
            await callWaveService(backend, "window", "SwitchWorkspace", [
              current.init.windowId,
              nextWorkspaceId,
            ])
          }
          const next = await resolveWaveSurface(backend, nextWorkspaceId)
          return {
            init: next.init,
            ...(next.workspaceId === surface.workspaceId
              ? {}
              : { workspaceId: next.workspaceId }),
          }
        }
        const next = await resolveWaveSurface(backend, surface.workspaceId)
        return {
          init: next.init,
          ...(action.kind === "close-tab" ? { evictTabId: action.tabId } : {}),
        }
      }
      surface = new HostedWorkspaceSurface({
        id,
        workspaceId: resolved?.workspaceId ?? surfaceOptions.workspaceId,
        initialInit: resolved?.init ?? {
          tabId: "",
          clientId: "",
          windowId: "",
          activate: false,
        },
        onAction: runAction,
        createChild(init, onAction, onInvalidated) {
          return new HostedSurface({
            id,
            workspaceId: surface.workspaceId,
            parent: parent!,
            artifactRoot: options.artifactRoot,
            partition: PARTITION,
            backend: backend ?? undefined,
            paths: paths ?? undefined,
            // The isolated host probe has no Wave backend. It exercises the
            // renderer boundary through the preload's legacy-ready handshake,
            // so it must not be mistaken for a partially configured real
            // Wave renderer.
            waveInit: backend ? init : undefined,
            onAction,
            onInvalidated(_surfaceId, reason) {
              onInvalidated(reason)
            },
          })
        },
        onInvalidated(surfaceId) {
          if (surfaces.get(surfaceId) !== surface) return
          surfaces.delete(surfaceId)
          surface.destroy()
        },
      })
      // Reserve before load so an invalidation fired by a renderer that dies
      // while readiness is settling cannot be ignored and published afterward.
      surfaces.set(id, surface)
      try {
        await surface.load()
        if (surfaces.get(id) !== surface) {
          throw new Error("hosted Wave surface invalidated during load")
        }
        return id
      } catch (error) {
        if (surfaces.get(id) === surface) surfaces.delete(id)
        surface.destroy()
        throw error
      }
    },

    async setSurfaceState(id: number, state: HostedSurfaceState) {
      const surface = surfaces.get(id)
      if (!surface) throw new Error("hosted Wave surface not found")
      surface.setState(state)
    },

    async destroySurface(id: number) {
      const surface = surfaces.get(id)
      if (!surface) return
      surfaces.delete(id)
      surface.destroy()
    },

    async shutdown() {
      for (const surface of surfaces.values()) surface.destroy()
      surfaces.clear()
      cleanupProtocol?.()
      cleanupProtocol = null
      cleanupAuth?.()
      cleanupAuth = null
      cleanupSessionPolicy?.()
      cleanupSessionPolicy = null
      cleanupWebviewSessionPolicy?.()
      cleanupWebviewSessionPolicy = null
      partitionSession = null
      backend = null
      paths = null
      parent = null
    },
  }
}
