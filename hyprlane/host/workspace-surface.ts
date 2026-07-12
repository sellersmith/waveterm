// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import type { HostedWaveInit } from "../shared/ipc"
import type { HostedSurfaceState } from "./surface"

export type WorkspaceActionOutcome = Readonly<{
  evictTabId?: string
  init: HostedWaveInit
  workspaceId?: string
}>

export type WorkspaceSurfaceChild = {
  destroy(): void
  load(): Promise<void>
  setState(state: HostedSurfaceState): void
}

type WorkspaceSurfaceOptions = {
  createChild(
    init: HostedWaveInit,
    onAction: (action: unknown, args: unknown) => Promise<boolean>,
    onInvalidated: (reason: string) => void
  ): WorkspaceSurfaceChild
  id: number
  initialInit: HostedWaveInit
  onAction: (
    action: unknown,
    args: unknown
  ) => Promise<WorkspaceActionOutcome | null>
  onInvalidated: (id: number, reason: string) => void
  workspaceId: string
}

const hiddenState = (state: HostedSurfaceState): HostedSurfaceState => ({
  bounds: state.bounds,
  visible: false,
})

/**
 * Wave treats a tab renderer's static tab id as immutable. Keep one sandboxed
 * renderer per native Wave tab, preload a newly selected renderer while the
 * current one remains painted, then swap visibility without navigating either.
 */
export class HostedWorkspaceSurface {
  readonly id: number
  #workspaceId: string
  readonly #createChild: WorkspaceSurfaceOptions["createChild"]
  #destroyed = false
  readonly #initialInit: HostedWaveInit
  readonly #onAction: WorkspaceSurfaceOptions["onAction"]
  readonly #onInvalidated: WorkspaceSurfaceOptions["onInvalidated"]
  #activeTabId: string | null = null
  #actionTail: Promise<void> = Promise.resolve()
  readonly #children = new Map<string, WorkspaceSurfaceChild>()
  #state: HostedSurfaceState = {
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    visible: false,
  }

  constructor(options: WorkspaceSurfaceOptions) {
    this.id = options.id
    this.#workspaceId = options.workspaceId
    this.#createChild = options.createChild
    this.#initialInit = options.initialInit
    this.#onAction = options.onAction
    this.#onInvalidated = options.onInvalidated
  }

  get workspaceId(): string {
    return this.#workspaceId
  }

  async load(): Promise<void> {
    if (this.#destroyed) throw new Error("hosted Wave surface is destroyed")
    await this.#activate(this.#initialInit)
  }

  setState(state: HostedSurfaceState): void {
    if (this.#destroyed) throw new Error("hosted Wave surface is destroyed")
    this.#state = {
      bounds: { ...state.bounds },
      visible: state.visible,
      ...(state.focus === undefined ? {} : { focus: state.focus }),
    }
    const active = this.#active()
    if (active) active.setState(this.#state)
  }

  async activate(
    init: HostedWaveInit,
    evictTabId?: string,
    workspaceId?: string
  ): Promise<void> {
    if (this.#destroyed) throw new Error("hosted Wave surface is destroyed")
    if (workspaceId && workspaceId !== this.#workspaceId) {
      this.#replaceWorkspace(workspaceId)
    }
    await this.#activate(init, evictTabId)
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    for (const child of this.#children.values()) child.destroy()
    this.#children.clear()
    this.#activeTabId = null
  }

  #active(): WorkspaceSurfaceChild | null {
    return this.#activeTabId
      ? (this.#children.get(this.#activeTabId) ?? null)
      : null
  }

  #replaceWorkspace(workspaceId: string): void {
    this.#active()?.setState(hiddenState(this.#state))
    for (const child of this.#children.values()) child.destroy()
    this.#children.clear()
    this.#activeTabId = null
    this.#workspaceId = workspaceId
  }

  async #activate(init: HostedWaveInit, evictTabId?: string): Promise<void> {
    const previous = this.#active()
    const next = await this.#ensureChild(init)
    if (this.#destroyed) return

    if (next !== previous) {
      previous?.setState(hiddenState(this.#state))
      this.#activeTabId = init.tabId
      next.setState(this.#state)
    } else {
      next.setState(this.#state)
    }

    if (evictTabId && evictTabId !== init.tabId) {
      const evicted = this.#children.get(evictTabId)
      if (evicted) evicted.destroy()
      this.#children.delete(evictTabId)
    }
  }

  async #ensureChild(init: HostedWaveInit): Promise<WorkspaceSurfaceChild> {
    const cached = this.#children.get(init.tabId)
    if (cached) return cached

    let child: WorkspaceSurfaceChild
    child = this.#createChild(
      init,
      (action, args) => this.#enqueueAction(action, args),
      (reason) => {
        if (this.#children.get(init.tabId) !== child) return
        this.#children.delete(init.tabId)
        child.destroy()
        if (this.#activeTabId === init.tabId) {
          this.#onInvalidated(this.id, reason)
        }
      }
    )
    this.#children.set(init.tabId, child)
    await child.load()
    if (this.#children.get(init.tabId) !== child) {
      throw new Error("hosted Wave surface invalidated during load")
    }
    return child
  }

  #enqueueAction(action: unknown, args: unknown): Promise<boolean> {
    const task = this.#actionTail.then(async () => {
      if (this.#destroyed) return false
      const outcome = await this.#onAction(action, args)
      if (!outcome || this.#destroyed) return false
      await this.activate(
        outcome.init,
        outcome.evictTabId,
        outcome.workspaceId
      )
      return true
    })
    this.#actionTail = task.then(
      () => undefined,
      () => undefined
    )
    return task.catch(() => false)
  }
}
